// src/runtime/daemon.ts
//
// A' Supervised Reconcile Daemon (DD selected architecture). This is the
// resident, level-triggered controller loop:
//
//   reconcile (ordered P0-P6, once at startup)
//     -> normal-loop pass: poll + ingest (durable backstop) -> triage -> promote
//        READY->QUEUED -> claimNextWorkItem -> ensure resolution assembly
//        (disposable worktree + real OpenCode session) -> relayOldestInbox ->
//        execute verified effects
//     -> wait for an SSE WAKE HINT or the next jittered polling deadline
//
// SSE is a WAKE HINT ONLY. No controller decision reads an SSE event as durable
// truth: every pass reads SQLite and the GitHub/OpenCode APIs directly, and the
// polling backstop guarantees progress even when SSE is silent or dead (RG-5).
//
// There is NO external queue (R8): the durable `work_items` table plus
// `claimNextWorkItem` is the queue. There is NO D' machinery here: no
// `turn_in_flight` ledger, no detached-child reaping, no alternate
// `opencode run` shell. Sessions are real `ses_...` identities created by
// OpenCode; completion is grounded in RG-3/RG-4/RG-6 transcript observation
// (HTTP 204 / idle alone is never delivery).

import { TISSUE_RESOLVE_AGENT, TISSUE_TRIAGE_AGENT } from "../config/types.ts";
import type { TissueConfig, RepositoryConfig, ProviderModel } from "../config/types.ts";
import type { JsonLogger } from "../logging/jsonl.ts";
import { runWrite } from "../db/open.ts";
import type { TissueDb } from "../db/open.ts";
import {
  getActiveResolutionSession,
  getRepositoryById,
  insertWorktree,
  listDueSideEffects,
  listRepositories,
  listWorkItemsByStates,
  setWorkItemHeadBranch,
  setWorkItemState,
  synchronizeConfiguredRepositories,
  assertDispatchReady,
} from "../db/repositories.ts";
import type { RepositoryRow, WorkItemRow } from "../db/repositories.ts";
import { ingestRepositorySnapshot } from "../controller/ingest.ts";
import type { IngestResult } from "../controller/ingest.ts";
import { pollRepository } from "../controller/poll.ts";
import type { GhSnapshot } from "../controller/poll.ts";
import { claimNextWorkItem } from "../controller/queue.ts";
import type { WorkClaim } from "../controller/queue.ts";
import { relayOldestInbox } from "../controller/inbox-relay.ts";
import type { RelayDriver } from "../controller/inbox-relay.ts";
import { runTriageRepo } from "../controller/triage.ts";
import { fetchBoundedIssueBody, BODY_LIMIT_DEFAULT } from "../controller/intake.ts";
import { createWorktree, worktreeBranchFor } from "../controller/worktrees.ts";
import type { RealSessionRef, SessionDriver, SessionMetadata } from "../controller/session-driver.ts";
import { executeVerifiedEffect, GhEffectTransport } from "../controller/effects.ts";
import { recordTransition } from "../domain/transitions.ts";
import type { SessionDependencyHealth } from "../controller/reconcile.ts";
import { parseProviderModel } from "./resident.ts";
import type { GhClient } from "../integrations/gh-client.ts";

// ---- resolution assembly ---------------------------------------------------------

/** Narrow session port the daemon needs to assemble a real resolution session. */
export interface ResolutionSessionDriver {
  createRealSession(
    kind: "resolution",
    directory: string,
    metadata: SessionMetadata,
  ): Promise<RealSessionRef>;
}

/** OpenCodeDriver satisfies both: it creates real sessions AND drives the relay. */
export type DaemonResolutionDriver = ResolutionSessionDriver & RelayDriver;

export interface ResolutionAssembly {
  workItemId: string;
  repoId: string;
  branch: string;
  worktreeDir: string;
  sessionId: string;
}

export interface ResolutionAssemblyOptions {
  agent?: string;
  /** Native provider/model identity; never a silently selected model. */
  model?: ProviderModel;
}

/** Map a durable repository row onto the createWorktree `RepositoryConfig` view. */
export function repoConfigFromRow(row: RepositoryRow): RepositoryConfig {
  return {
    owner: row.owner,
    name: row.name,
    remote: row.remote,
    localDir: row.local_dir,
    targetOwner: row.target_owner || row.owner,
    targetName: row.target_name || row.name,
    pushOwner: row.push_owner || row.target_owner || row.owner,
    pushName: row.push_name || row.target_name || row.name,
    ...(row.push_remote ? { pushRemote: row.push_remote } : {}),
    enabled: row.enabled === 1,
    pollIntervalSeconds: row.poll_interval_seconds,
    maxConcurrentPerRepo: row.max_concurrent_per_repo,
    baseBranch: row.base_branch ?? "main",
    labels: parseLabels(row.labels_json),
    autoMerge: row.auto_merge === 1,
    priority: row.priority,
    ...(row.baseline_at ? { baselineBefore: row.baseline_at } : {}),
  };
}

function parseLabels(labelsJson: string | null): string[] {
  if (!labelsJson) return [];
  try {
    const parsed = JSON.parse(labelsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Ensure the WorkItem's disposable worktree + single durable resolution session
 * exist. Idempotent: an existing ACTIVE resolution session is adopted, and an
 * existing ACTIVE worktree row is reused only when its directory is recorded.
 */
export async function ensureResolutionAssembly(
  db: TissueDb,
  workItem: WorkItemRow,
  repoId: string,
  repo: RepositoryConfig,
  driver: ResolutionSessionDriver,
  opts: ResolutionAssemblyOptions = {},
): Promise<ResolutionAssembly> {
  const existing = getActiveResolutionSession(db, workItem.id);
  if (existing) {
    return {
      workItemId: workItem.id,
      repoId,
      branch: workItem.head_branch ?? worktreeBranchFor(workItem.id),
      worktreeDir: existing.directory,
      sessionId: existing.id,
    };
  }

  const identity = await createWorktree(repo, workItem.id);
  const worktreeId = `wt-${workItem.id}`;
  runWrite(db, (tx) => {
    insertWorktree(tx, {
      id: worktreeId,
      work_item_id: workItem.id,
      path: identity.worktreeDir,
      branch: identity.branch,
      state: "ACTIVE",
    });
    setWorkItemHeadBranch(tx, workItem.id, identity.branch);
  });

  const ref = await driver.createRealSession("resolution", identity.worktreeDir, {
    repoId,
    directory: identity.worktreeDir,
    kind: "resolution",
    workItemId: workItem.id,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });

  return {
    workItemId: workItem.id,
    repoId,
    branch: identity.branch,
    worktreeDir: identity.worktreeDir,
    sessionId: ref.sessionId,
  };
}

// ---- normal loop -----------------------------------------------------------------

export interface NormalLoopTriageResult {
  ran: boolean;
  reason?: string;
}

/**
 * External/IO boundary of one normal-loop pass. Everything here is injected so
 * the loop itself is pure orchestration over durable state; tests fake only this
 * transport/IO boundary, never the DB or the state machine.
 */
export interface NormalLoopIo {
  now(): Date;
  logger: JsonLogger;
  pollRepository(repo: RepositoryRow): Promise<GhSnapshot>;
  ingest(db: TissueDb, snapshot: GhSnapshot): IngestResult;
  runTriage(db: TissueDb, repoId: string, now: Date): Promise<NormalLoopTriageResult>;
  claimNext(db: TissueDb, now: Date): WorkClaim | null;
  ensureResolution(db: TissueDb, claim: WorkClaim, now: Date): Promise<ResolutionAssembly | null>;
  relay(db: TissueDb, workItemId: string, now: Date): Promise<{ status: string }>;
  executeEffects(db: TissueDb, now: Date): Promise<number>;
}

export interface NormalLoopError {
  phase: string;
  error: string;
}

export interface NormalLoopSummary {
  reposPolled: number;
  issuesIngested: number;
  triageRuns: number;
  promoted: number;
  claimed: string[];
  relays: Array<{ workItemId: string; status: string }>;
  effects: number;
  errors: NormalLoopError[];
  /** True when resident-dependency unavailability withheld prompt-dependent phases. */
  gated: boolean;
  /** Why the pass was gated (`opencode_unavailable`); present only when gated. */
  gateReason?: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Promote READY WorkItems to QUEUED inside one BEGIN IMMEDIATE transaction.
 * This is the only normal-loop transition into the queue: triage leaves a
 * WorkItem READY, and the daemon (the queue's owner) promotes it so
 * `claimNextWorkItem` can act. Idempotent — a second pass finds no READY items.
 */
export function promoteReadyWorkItems(db: TissueDb): number {
  const ready = listWorkItemsByStates(db, ["READY"]);
  if (ready.length === 0) return 0;
  let promoted = 0;
  runWrite(db, (tx) => {
    for (const workItem of ready) {
      const repo = getRepositoryById(tx, workItem.repo_id);
      if (!repo || repo.enabled !== 1) continue;
      if (repo.config_managed === 1 && repo.capability_state !== "ready") continue;
      recordTransition(
        tx,
        { type: "work_item", id: workItem.id },
        "READY",
        "QUEUED",
        "queue",
        { repo_id: workItem.repo_id, priority: repo.priority },
        "controller.daemon.normalLoop",
      );
      setWorkItemState(tx, workItem.id, "QUEUED");
      promoted += 1;
    }
  });
  return promoted;
}

/**
 * One level-triggered normal-loop pass. Never throws operationally: each phase
 * records its error and later phases still run, so one failing repository or
 * effect cannot starve the rest of the loop. When the optional resident
 * dependency `health` is explicitly `false`, the prompt-dependent phases
 * (triage, claim + ensure-resolution, relay) are skipped together while polling,
 * promotion, and effects still run.
 */
export async function runNormalLoopPass(
  db: TissueDb,
  config: TissueConfig,
  io: NormalLoopIo,
  health?: SessionDependencyHealth,
): Promise<NormalLoopSummary> {
  const now = io.now();
  synchronizeConfiguredRepositories(db, config, now);
  const errors: NormalLoopError[] = [];
  let reposPolled = 0;
  let issuesIngested = 0;
  let triageRuns = 0;
  // Fail closed: an explicit unhealthy signal withholds every prompt-dependent
  // phase together; an absent signal (`undefined`) is not gated and preserves
  // prior behavior.
  const dependencyGated = health !== undefined && health.openCodeAvailable === false;

  for (const repo of listRepositories(db)) {
    if (repo.enabled !== 1) continue;
    try {
      if (repo.config_managed === 1) assertDispatchReady(db, repo.id, "poll");
      const snapshot = await io.pollRepository(repo);
      const result = io.ingest(db, snapshot);
      reposPolled += 1;
      issuesIngested += result.issuesNew;
    } catch (err) {
      errors.push({ phase: `poll:${repo.id}`, error: messageOf(err) });
    }
    if (!dependencyGated) {
      try {
        if (repo.config_managed === 1) assertDispatchReady(db, repo.id, "triage");
        const triage = await io.runTriage(db, repo.id, now);
        if (triage.ran) triageRuns += 1;
      } catch (err) {
        errors.push({ phase: `triage:${repo.id}`, error: messageOf(err) });
      }
    }
  }

  const promoted = promoteReadyWorkItems(db);

  // Claim and ensure-resolution are gated together: never claim a WorkItem that
  // cannot get a session while the resident dependency is unhealthy.
  const claimed: string[] = [];
  if (!dependencyGated) {
    for (;;) {
      let claim: WorkClaim | null;
      try {
        claim = io.claimNext(db, now);
      } catch (err) {
        errors.push({ phase: "claim", error: messageOf(err) });
        break;
      }
      if (!claim) break;
      claimed.push(claim.workItemId);
      try {
        await io.ensureResolution(db, claim, now);
      } catch (err) {
        errors.push({ phase: `ensure:${claim.workItemId}`, error: messageOf(err) });
      }
    }
  }

  const relays: Array<{ workItemId: string; status: string }> = [];
  if (!dependencyGated) {
    for (const workItem of listWorkItemsByStates(db, ["RUNNING", "WAITING"])) {
      try {
        const wiRepo = getRepositoryById(db, workItem.repo_id);
        if (wiRepo?.config_managed === 1) assertDispatchReady(db, wiRepo.id, "dispatch");
        const result = await io.relay(db, workItem.id, now);
        relays.push({ workItemId: workItem.id, status: result.status });
      } catch (err) {
        errors.push({ phase: `relay:${workItem.id}`, error: messageOf(err) });
      }
    }
  }

  let effects = 0;
  try {
    effects = await io.executeEffects(db, now);
  } catch (err) {
    errors.push({ phase: "effects", error: messageOf(err) });
  }

  const summary: NormalLoopSummary = {
    reposPolled,
    issuesIngested,
    triageRuns,
    promoted,
    claimed,
    relays,
    effects,
    errors,
    gated: dependencyGated,
    ...(dependencyGated ? { gateReason: "opencode_unavailable" } : {}),
  };
  if (dependencyGated) {
    // Exactly one observable warning per pass; OpenCode-independent work above
    // still ran, so safe local reconciliation is never lost.
    io.logger.warn("daemon.dependency_gated", {
      reason: "opencode_unavailable",
      withheld: ["triage", "claim", "ensure_resolution", "relay"],
    });
  }
  io.logger.info("daemon.normal_loop", {
    repos_polled: reposPolled,
    issues_ingested: issuesIngested,
    triage_runs: triageRuns,
    promoted,
    claimed: claimed.length,
    relays: relays.length,
    effects,
    errors: errors.length,
    gated: dependencyGated,
  });
  return summary;
}

// ---- production normal-loop IO ---------------------------------------------------

/** Real GitHub + OpenCode ports the daemon drives. */
export interface DaemonRuntime {
  gh: GhClient;
  triageDriver: SessionDriver;
  resolutionDriver: DaemonResolutionDriver;
  /** Injectable clock for deterministic production-assembly tests. */
  now?: () => Date;
}

/** Parse a configured `provider/model` value, failing closed (never auto-selecting a model). */
function parseProviderModelOrThrow(value: string): ProviderModel {
  return parseProviderModel(value);
}

/** Best-effort repository attribution from a side-effect payload (owner/name). */
function effectRepoId(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as { owner?: unknown; name?: unknown };
    if (typeof payload.owner === "string" && typeof payload.name === "string") return `${payload.owner}/${payload.name}`;
  } catch {
    /* malformed payload cannot be attributed; execution stays the caller's decision */
  }
  return null;
}

/** Wire the normal-loop IO to the real controller modules (no behavior here). */
export function defaultNormalLoopIo(
  config: TissueConfig,
  logger: JsonLogger,
  runtime: DaemonRuntime,
): NormalLoopIo {
  const now = runtime.now ?? (() => new Date());
  return {
    now,
    logger,
    pollRepository: (repo) =>
      pollRepository(
        { id: repo.id, owner: repo.owner, name: repo.name, baselineAt: repo.baseline_at },
        { watermark: repo.poll_watermark },
        runtime.gh,
      ).then((result) => result.snapshot),
    ingest: (db, snapshot) => ingestRepositorySnapshot(db, snapshot),
    runTriage: async (db, repoId, at) => {
      const repoRow = getRepositoryById(db, repoId);
      const triage = config.agents.triage;
      const summary = await runTriageRepo(db, repoId, runtime.triageDriver, at, {
        // Mandatory dedicated identity: never the resident OpenCode default agent.
        agent: triage?.agent ?? TISSUE_TRIAGE_AGENT,
        ...(triage?.model !== undefined ? { model: parseProviderModelOrThrow(triage.model) } : {}),
        ...(repoRow
          ? {
              fetchIssueBody: (issue: { number: number }) =>
                fetchBoundedIssueBody(
                  runtime.gh,
                  repoRow.owner,
                  repoRow.name,
                  issue.number,
                  BODY_LIMIT_DEFAULT,
                ).then((bounded) => bounded.body),
            }
          : {}),
      });
      return { ran: summary.ran, ...(summary.reason !== undefined ? { reason: summary.reason } : {}) };
    },
    claimNext: (db, at) => claimNextWorkItem(db, at, { globalLimit: config.maxConcurrentGlobal }),
    ensureResolution: async (db, claim) => {
      const workItem = db.sql.get<WorkItemRow>("SELECT * FROM work_items WHERE id = ?", claim.workItemId);
      const repoRow = getRepositoryById(db, claim.repoId);
      if (!workItem || !repoRow) return null;
      const resolution = config.agents.resolution;
      return ensureResolutionAssembly(
        db,
        workItem,
        claim.repoId,
        repoConfigFromRow(repoRow),
        runtime.resolutionDriver,
        {
          agent: resolution?.agent ?? TISSUE_RESOLVE_AGENT,
          ...(resolution?.model !== undefined ? { model: parseProviderModelOrThrow(resolution.model) } : {}),
        },
      );
    },
    relay: async (db, workItemId, at) => {
      const resolution = config.agents.resolution;
      const result = await relayOldestInbox(db, workItemId, runtime.resolutionDriver, {
        now: at,
        logger,
        // Same-session inbox deliveries reuse the dedicated resolution identity.
        agent: resolution?.agent ?? TISSUE_RESOLVE_AGENT,
        ...(resolution?.model !== undefined ? { model: parseProviderModelOrThrow(resolution.model) } : {}),
      });
      return { status: result.status };
    },
    executeEffects: async (db, at) => {
      const transport = new GhEffectTransport({ gh: runtime.gh });
      let executed = 0;
      for (const effect of listDueSideEffects(db, at)) {
        const repoId = effectRepoId(effect.payload_json);
        const repoRow = repoId ? getRepositoryById(db, repoId) : undefined;
        if (repoRow?.config_managed === 1) assertDispatchReady(db, repoRow.id, "effect");
        await executeVerifiedEffect(db, effect.id, transport, { now: at });
        executed += 1;
      }
      return executed;
    },
  };
}

// ---- wake hint (SSE is a hint, never truth) --------------------------------------

export type WakeStatus = "connected" | "reconnecting" | "stopped";

/** A one-way wake signal + liveness status; carries NO controller truth. */
export interface WakeHint {
  start(): void;
  waitForWakeOrTimeout(timeoutMs: number): Promise<"wake" | "timeout">;
  status(): WakeStatus;
  close(): Promise<void>;
}

/** One SSE connection attempt; the iterable ends/throws when the stream drops. */
export interface WakeStreamSource {
  openStream(): AsyncIterable<unknown>;
}

export interface SseWakeHintOptions {
  source: WakeStreamSource;
  logger: JsonLogger;
  sleep(ms: number): Promise<void>;
  heartbeatTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  random?(): number;
  /** Called after a reconnect backoff to trigger a durable status resync. */
  onResync?(): void;
}

export const DEFAULT_SSE_HEARTBEAT_MS = 30_000;
export const DEFAULT_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_RECONNECT_MAX_MS = 30_000;

/** Full jitter over [0, baseMs); deterministic when a random source is injected. */
export function jitteredDelayMs(baseMs: number, random: () => number = Math.random): number {
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.floor(r * Math.max(0, baseMs));
}

/** Capped exponential backoff under full jitter for SSE reconnect (RG-5). */
export function reconnectDelayMs(
  attempt: number,
  baseMs: number = DEFAULT_RECONNECT_BASE_MS,
  maxMs: number = DEFAULT_RECONNECT_MAX_MS,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.max(1, jitteredDelayMs(exponential, random));
}

/**
 * Supervised SSE wake hint with a heartbeat watchdog. A silent stream (no event
 * within `heartbeatTimeoutMs`) is treated as dead and reconnected with jittered
 * backoff; a reconnect fires `onResync` so the controller re-reads durable
 * status instead of trusting a missed event. Events only call `waitForWake`.
 */
export class SseWakeHint implements WakeHint {
  private readonly opts: SseWakeHintOptions;
  private readonly heartbeat: number;
  private running = false;
  private state: WakeStatus = "stopped";
  private readonly waiters = new Set<() => void>();
  private loopPromise: Promise<void> | null = null;
  private readonly closeSignal: Promise<void>;
  private signalClose: () => void = () => {};

  constructor(opts: SseWakeHintOptions) {
    this.opts = opts;
    this.heartbeat = opts.heartbeatTimeoutMs ?? DEFAULT_SSE_HEARTBEAT_MS;
    this.closeSignal = new Promise<void>((resolve) => {
      this.signalClose = resolve;
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = "reconnecting";
    this.loopPromise = this.loop().catch(() => {
      /* loop handles its own errors; never crash the daemon */
    });
  }

  status(): WakeStatus {
    return this.state;
  }

  waitForWakeOrTimeout(timeoutMs: number): Promise<"wake" | "timeout"> {
    if (!this.running) return Promise.resolve("timeout");
    return new Promise<"wake" | "timeout">((resolve) => {
      let settled = false;
      const finish = (value: "wake" | "timeout"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(value);
      };
      const waiter = (): void => finish("wake");
      const timer = setTimeout(() => finish("timeout"), Math.max(1, timeoutMs));
      this.waiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    this.running = false;
    this.state = "stopped";
    this.signalClose();
    for (const waiter of [...this.waiters]) waiter();
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        /* already contained */
      }
    }
  }

  private emitWake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private async loop(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      try {
        await this.consumeOne();
      } catch (err) {
        this.opts.logger.debug("daemon.sse_disconnected", { error: messageOf(err) });
      }
      if (!this.running) break;
      this.state = "reconnecting";
      const delay = reconnectDelayMs(attempt, this.opts.reconnectBaseMs, this.opts.reconnectMaxMs, this.opts.random);
      attempt += 1;
      // A disconnected stream invalidates any event we may have missed. Resync
      // before the retry sleep so durable state is refreshed even if shutdown
      // races with the reconnect backoff.
      this.opts.onResync?.();
      // Backoff sleeps are interruptible so close() never waits out a long delay.
      await Promise.race([this.opts.sleep(delay), this.closeSignal]);
      if (!this.running) break;
    }
    this.state = "stopped";
  }

  private async consumeOne(): Promise<void> {
    const iterator = this.opts.source.openStream()[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = iterator.next();
        const timeout = this.opts.sleep(this.heartbeat).then(() => "heartbeat" as const);
        const closed = this.closeSignal.then(() => "closed" as const);
        const outcome = await Promise.race([
          next.then((result) => ({ kind: "next" as const, result })),
          timeout.then(() => ({ kind: "heartbeat" as const })),
          closed.then(() => ({ kind: "closed" as const })),
        ]);
        if (outcome.kind === "closed") return;
        if (outcome.kind === "heartbeat") throw new Error("sse heartbeat timeout");
        if (outcome.result.done) return;
        if (!this.running) return;
        this.state = "connected";
        this.emitWake();
      }
    } finally {
      if (typeof iterator.return === "function") {
        try {
          await iterator.return();
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

// ---- daemon loop -----------------------------------------------------------------

/**
 * Resident-dependency health carried across the reconcile -> daemon seam. The
 * production `ReconcileReport` structurally satisfies this shape (it exposes
 * `residentOpenCodeAvailable`); a legacy/void reconcile stub leaves the field
 * undefined, which means "not gated" and preserves prior behavior.
 */
export interface DaemonReconcileResult {
  residentOpenCodeAvailable?: boolean;
}

export interface DaemonContext {
  config: TissueConfig;
  logger: JsonLogger;
  db: TissueDb;
  /** Ordered P0-P6 startup reconcile, run exactly once before the loop. */
  reconcile(): Promise<DaemonReconcileResult | void>;
  /**
   * Optional fail-closed resident-dependency probe. Re-evaluated at the start of
   * every iteration so a restored service resumes prompt-dependent work without a
   * daemon restart; a rejected probe is treated as unhealthy (never rethrown).
   */
  checkResidentHealth?(): Promise<boolean>;
  normalLoop: NormalLoopIo;
  wakeHint?: WakeHint;
  sleep(ms: number): Promise<void>;
  random?(): number;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  /** Test/ops bound: stop after N passes. Unset means run until aborted. */
  maxIterations?: number;
}

export interface DaemonRunReport {
  reconciled: true;
  iterations: number;
  passes: NormalLoopSummary[];
}

/**
 * Run the resident daemon: reconcile once, then loop normal passes gated by an
 * SSE wake hint or a jittered polling deadline. The polling deadline is the
 * correctness backstop; SSE only shortens the wait. Never depends on SSE for
 * progress.
 *
 * Resident dependency health crosses the reconcile -> daemon seam: the
 * reconcile result seeds the loop's gate, and an optional
 * `DaemonContext.checkResidentHealth()` re-probes at the start of every
 * iteration so a restored service resumes prompt-dependent work without a
 * restart. A rejected probe fails closed (unhealthy) and is never rethrown. The
 * daemon keeps polling while unhealthy and never exits on unavailability.
 */
export async function runDaemon(ctx: DaemonContext): Promise<DaemonRunReport> {
  const seeded = (await ctx.reconcile())?.residentOpenCodeAvailable;
  ctx.logger.info("daemon.reconciled", { resident_opencode_available: seeded });
  ctx.wakeHint?.start();

  const passes: NormalLoopSummary[] = [];
  let iterations = 0;
  // Seeded from reconcile; `undefined` (legacy/void reconcile with no probe)
  // means not gated, preserving prior behavior.
  let openCodeAvailable: boolean | undefined = seeded;
  try {
    while (!ctx.signal?.aborted) {
      if (ctx.maxIterations !== undefined && iterations >= ctx.maxIterations) break;
      iterations += 1;
      if (ctx.checkResidentHealth) {
        try {
          openCodeAvailable = await ctx.checkResidentHealth();
        } catch {
          openCodeAvailable = false;
        }
      }
      passes.push(
        await runNormalLoopPass(
          ctx.db,
          ctx.config,
          ctx.normalLoop,
          openCodeAvailable === undefined ? undefined : { openCodeAvailable },
        ),
      );
      if (ctx.signal?.aborted) break;
      if (ctx.maxIterations !== undefined && iterations >= ctx.maxIterations) break;

      const pollMs = ctx.pollIntervalMs ?? ctx.config.pollIntervalSeconds * 1000;
      const jitter = jitteredDelayMs(Math.min(pollMs, 5_000), ctx.random);
      const delay = Math.max(1, pollMs - jitter);
      if (ctx.wakeHint) {
        const reason = await ctx.wakeHint.waitForWakeOrTimeout(delay);
        ctx.logger.debug("daemon.tick", { reason });
      } else {
        await ctx.sleep(delay);
      }
    }
  } finally {
    await ctx.wakeHint?.close();
  }
  return { reconciled: true, iterations, passes };
}
