// src/controller/queue.ts
//
// M4 durable work-item claim (R7/R8). `claimNextWorkItem` is the single place a
// QUEUED WorkItem is moved to RUNNING with a fresh random lease token. It runs
// entirely inside one `BEGIN IMMEDIATE` transaction and COMMITs before any
// caller-side effect can begin, so a claim is never observed half-applied and a
// crash before commit leaves the item QUEUED (re-claimable). SQLite is the only
// correct mutex here; in-process locks never provide correctness.
//
// Capacity semantics (R8: default maxConcurrentGlobal=3, maxConcurrentPerRepo=1):
//   - A claimed, in-flight WorkItem occupies one capacity slot. Slots are held by
//     the RUNNING and WAITING states — an item that has been claimed (RUNNING) or
//     is awaiting review/CI while retaining its session (WAITING).
//   - QUEUED is the set of items still waiting for a slot and therefore never
//     counts toward capacity (counting it would deadlock a flood). PAUSED_WORK,
//     BLOCKED and FAILED_HOLD do not hold a run slot: PAUSED_WORK re-enters the
//     QUEUE on resume, BLOCKED waits on a dependency, FAILED_HOLD awaits an
//     explicit human cleanup — none is actively running.
//   - Per-repo capacity is read from the repository row (`max_concurrent_per_repo`,
//     seeded from config, default 1). The global cap defaults to the config default
//     (3) and can be supplied by the reconcile caller from its config.
//
// Candidates are ordered by `priority DESC` then `created_at ASC` (the queue index
// `ix_work_items_state_priority`), and the highest-priority item whose repo still
// has capacity is claimed. Stale `controller_leases` rows are expired inside the
// claim transaction so reclaimed resource keys never leak capacity. SQLITE_BUSY is
// classified transient (isBusyError) and retried with a bounded backoff — it is
// never treated as correctness-by-mutex and never silently passed.

import { randomUUID } from "node:crypto";
import type { TissueDb, SqlValue } from "../db/open.ts";
import { runWrite, isBusyError } from "../db/open.ts";
import { setWorkItemState, expireLeases } from "../db/repositories.ts";
import { recordTransition } from "../domain/transitions.ts";
import { DEFAULT_MAX_CONCURRENT_GLOBAL } from "../config/types.ts";

/** Default claim lease TTL (ms). A crashed claimant's slot frees after this. */
export const DEFAULT_CLAIM_LEASE_TTL_MS = 5 * 60_000;

/** Number of bounded transient-SQLITE_BUSY retry attempts around a claim. */
export const CLAIM_BUSY_MAX_ATTEMPTS = 5;
/** Synchronous inter-attempt pause (ms) between busy retries. */
const CLAIM_BUSY_RETRY_PAUSE_MS = 15;

/** A successfully claimed (leased) WorkItem, returned AFTER its transaction commits. */
export interface WorkClaim {
  workItemId: string;
  repoId: string;
  leaseToken: string;
  /** UTC ISO-8601 instant at which this claim's lease expires. */
  leaseUntil: string;
  priority: number;
}

export interface ClaimOptions {
  /** Global cap on concurrent claimed items; defaults to the config default (3). */
  globalLimit?: number;
  /** Claim lease TTL in ms; defaults to DEFAULT_CLAIM_LEASE_TTL_MS. */
  leaseTtlMs?: number;
  /** Bounded SQLITE_BUSY retry attempts; defaults to CLAIM_BUSY_MAX_ATTEMPTS. */
  busyMaxAttempts?: number;
}

/** States that occupy a capacity slot (claimed + retained in-flight). */
const CAPACITY_HOLDING_STATES = ["RUNNING", "WAITING"] as const;
const CAPACITY_HOLDING_PLACEHOLDERS = CAPACITY_HOLDING_STATES.map(() => "?").join(", ");

interface CandidateRow {
  id: string;
  repo_id: string;
  priority: number;
  created_at: string;
  max_concurrent_per_repo: number;
  repo_running: SqlValue;
  global_running: SqlValue;
}

/** Synchronous bounded sleep (Atomics.wait is legal on the main thread). */
function busyPause(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* best-effort pause */
  }
}

/** True when the row still has room under both its repo cap and the global cap. */
function fitsCapacity(row: CandidateRow, globalLimit: number): boolean {
  const repoRunning = Number(row.repo_running);
  const globalRunning = Number(row.global_running);
  return repoRunning < row.max_concurrent_per_repo && globalRunning < globalLimit;
}

/**
 * Claim the next eligible QUEUED WorkItem (priority then creation) whose repo and
 * the global queue still have capacity, moving it QUEUED → RUNNING with a fresh
 * random lease inside one `BEGIN IMMEDIATE` transaction. Returns `null` when no
 * candidate fits (capacity exhausted everywhere). The returned claim is durable
 * only after this function returns (the COMMIT already happened).
 */
export function claimNextWorkItem(
  db: TissueDb,
  now: Date = new Date(),
  opts: ClaimOptions = {},
): WorkClaim | null {
  const globalLimit = opts.globalLimit ?? DEFAULT_MAX_CONCURRENT_GLOBAL;
  const leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_CLAIM_LEASE_TTL_MS;
  const maxAttempts = opts.busyMaxAttempts ?? CLAIM_BUSY_MAX_ATTEMPTS;

  const attempt = (): WorkClaim | null =>
    runWrite(db, (tx) => {
      // Reclaim resource keys whose leases have lapsed (cheap, idempotent).
      expireLeases(tx, now);

      const capacityParams: SqlValue[] = [...CAPACITY_HOLDING_STATES];
      const candidates = tx.sql.all<CandidateRow>(
        `SELECT wi.id, wi.repo_id, wi.priority, wi.created_at,
                r.max_concurrent_per_repo,
                (SELECT COUNT(*) FROM work_items w
                   WHERE w.repo_id = wi.repo_id
                     AND w.state IN (${CAPACITY_HOLDING_PLACEHOLDERS})) AS repo_running,
                (SELECT COUNT(*) FROM work_items w
                   WHERE w.state IN (${CAPACITY_HOLDING_PLACEHOLDERS})) AS global_running
           FROM work_items wi
           JOIN repositories r ON r.id = wi.repo_id
          WHERE wi.state = 'QUEUED'
            AND (r.config_managed = 0 OR r.capability_state = 'ready')
          ORDER BY wi.priority DESC, wi.created_at ASC
          LIMIT 100`,
        ...capacityParams,
        ...capacityParams,
      );

      // Iterate the candidates in priority-then-creation order (the single SELECT
      // above sees one consistent capacity snapshot) and claim the FIRST whose
      // repo still has per-repo capacity AND whose claim keeps the global count
      // under the cap. Only when NO candidate fits do we return null — a saturated
      // repo at the top of the queue must never starve a capacity-eligible
      // lower-priority item in another repo while global capacity is free.
      for (const candidate of candidates) {
        if (!fitsCapacity(candidate, globalLimit)) continue;
        const leaseToken = randomUUID();
        const leaseUntil = new Date(now.getTime() + leaseTtlMs).toISOString();
        setWorkItemState(tx, candidate.id, "RUNNING", {
          leaseToken,
          leaseUntil,
          blockedBy: null,
        });
        recordTransition(
          tx,
          { type: "work_item", id: candidate.id },
          "QUEUED",
          "RUNNING",
          "claim",
          {
            repo_id: candidate.repo_id,
            priority: candidate.priority,
            lease_token: leaseToken,
            lease_until: leaseUntil,
            global_limit: globalLimit,
          },
          "controller.queue.claimNextWorkItem",
        );
        return {
          workItemId: candidate.id,
          repoId: candidate.repo_id,
          leaseToken,
          leaseUntil,
          priority: candidate.priority,
        };
      }
      return null;
    });

  let lastError: unknown = null;
  for (let attemptNo = 0; attemptNo < maxAttempts; attemptNo++) {
    try {
      return attempt();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      lastError = err;
      if (attemptNo + 1 < maxAttempts) busyPause(CLAIM_BUSY_RETRY_PAUSE_MS);
    }
  }
  // Bounded retries exhausted while still busy — surface it, never pass silently.
  throw lastError;
}
