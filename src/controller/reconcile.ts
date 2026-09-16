// src/controller/reconcile.ts
//
// The single reconcile business path (DD "Recovery and startup reconciliation",
// CONTRACTS `runReconcilePass`). Startup is NOT a blind restart; every pass is an
// ordered, level-triggered, idempotent P0-P6 sweep that re-derives reality from
// durable state and external truth before resuming the normal loop. The `daemon`,
// `tick`, and `reconcile` CLI family all dispatch through this one function — no
// second business path.
//
//   P0  open DB / migrations (WAL, FK, FULL, busy timeout, migration-first)
//   P1  repository + gh capability checks
//   P2  authoritative session census (idle/busy/retry/missing/incomplete/wedged):
//       classifications are applied as durable recovery (applySessionCensusRecovery)
//   P3  worktree/branch/PR/lease/effect reconcile + terminal-leftover cleanup
//   P4  drift pass (drift.ts)
//   P5  terminal-unattached housekeeping
//   P6  resume idempotent normal loop (+ stale-PROMPTING crash recovery), gated on
//       resident OpenCode dependency health: when the P2 census could not be taken
//       prompt-dependent resume is withheld in full (reconcile.p6_gated), while
//       P1/P3/P4/P5 stay OpenCode-independent so safe local reconciliation always runs.
//
// Production topology is resident-only: one s6-supervised Tissue daemon connects
// to an already-running OpenCode service via TISSUE_OPENCODE_URL. Tissue never
// spawns or owns an OpenCode process and there is no serve-lifecycle phase.
// Fault-injection boundaries: ingest, prompt-before-completion, reparent,
// drift-fail, cleanup.

import { join } from "node:path";

import { ARTIFACT_OWNING_WORK_ITEM_STATES, isLegalTransition } from "../domain/state-machine.ts";
import { recordTransition } from "../domain/transitions.ts";
import { closeDb, openTissueDb, runWrite, type TissueDb } from "../db/open.ts";
import {
  appendTransition,
  expireLeases,
  getRepositoryById,
  getWorkItem,
  listDueSideEffects,
  listRepositories,
  listSessions,
  listWorkItemsByStates,
  setSessionState,
  setWorkItemState,
  updateTriageState,
  type SessionRow,
} from "../db/repositories.ts";
import { GhClient } from "../integrations/gh-client.ts";
import { OpenCodeHttp } from "../integrations/opencode-http.ts";
import { OpenCodeDriver } from "../integrations/opencode-driver.ts";
import { parseProviderModel, validateResidentOpenCodeEndpoint } from "../runtime/resident.ts";
import type { JsonLogger } from "../logging/jsonl.ts";
import type { TissueConfig } from "../config/types.ts";
import { GhEffectTransport, executeVerifiedEffect } from "./effects.ts";
import { GitGhDriftScanner, scanAndAdoptDrift, type DriftResult } from "./drift.ts";
import { cleanupTerminalLeftovers } from "./terminal-cleanup.ts";
import { runTerminalUnattachedHousekeeping, type HousekeepingRunResult } from "./housekeeping.ts";
import { runTriageRepo, type TriageRunSummary } from "./triage.ts";
import type { SessionDriver, SessionStatus } from "./session-driver.ts";
import { cleanupWorktree, verifyRepository, type RepoCapability, type WorktreeIdentity } from "./worktrees.ts";
import { persistRepositoryCapability, synchronizeConfiguredRepositories } from "../db/repositories.ts";


export interface ReconcileContext {
  config: TissueConfig;
  logger: JsonLogger;
  /** Optional pre-opened DB (tests); when omitted P0 opens the configured state dir. */
  db?: TissueDb;
  /** State directory holding `tissue.db` (defaults to TISSUE_STATE_DIR or `.tissue`). */
  stateDir?: string;
  /** Injectable dependencies (tests); production defaults built when omitted. */
  deps?: ReconcileDeps;
  /** Shared resident OpenCode driver from the daemon assembly. */
  driver?: SessionDriver;
  /** Authenticated GitHub client from the daemon assembly; injectable only for boundary tests. */
  gh?: GhClient;
}

export type ReconcilePhaseId = "P0" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6";

export type ReconcileBoundary = "ingest" | "prompt_before_completion" | "reparent" | "drift_fail" | "cleanup" | "recovery";

export interface PhaseReport {
  phase: ReconcilePhaseId;
  ok: boolean;
  skipped: boolean;
  detail?: unknown;
  error?: string;
}

export interface ReconcileReport {
  startedAt: string;
  finishedAt: string;
  phases: PhaseReport[];
  /**
   * Fail-closed resident-dependency health carried across the reconcile -> daemon
   * seam (Daemon Seam Dependency-Health Policy). It is true only when P2 completed
   * authoritatively — the explicit resident health probe answered, the census was
   * taken, and the recovery policy applied — and false whenever P0 or P2 failed, so
   * an unknown or broken dependency never reads as healthy. A completed census that
   * reports per-session `missing`/`wedged`/`incomplete` entries still reads true:
   * those are observed per-WorkItem outcomes, not service unavailability.
   * `runDaemon` seeds the normal loop's health from this field.
   */
  residentOpenCodeAvailable: boolean;
}

export type SessionClassification = "idle" | "busy" | "retry" | "missing" | "incomplete" | "wedged";

export interface SessionCensusEntry {
  sessionId: string;
  kind: string;
  repoId: string | null;
  workItemId: string | null;
  classification: SessionClassification;
  detail?: string;
}

/**
 * Resident-dependency health derived from P2 (Dependency-Health Policy).
 * `openCodeAvailable` is true only when P2 completed: the explicit resident health
 * probe (independent of durable session count) answered, the census was taken, and
 * `applySessionCensusRecovery` applied. It is false when any of those failed, i.e.
 * the service was unobservable or the authoritative P2 work did not complete, so an
 * empty census or a partially-applied pass can never establish health. A completed
 * census that lists per-session `missing`/`wedged`/`incomplete` sessions still
 * counts as available: those are per-WorkItem outcomes the census successfully
 * observed, not service unavailability. The flag gates P6 prompt-dependent resume
 * only; it never suppresses local reconciliation.
 */
export interface SessionDependencyHealth {
  openCodeAvailable: boolean;
}

export interface ReconcileDeps {
  now(): Date;
  openDb(): TissueDb;
  closeDb(db: TissueDb): void;
  verifyRepos(db: TissueDb, config: TissueConfig): Promise<Array<{ repoId: string; ok: boolean; capability?: RepoCapability; error?: string }>>;
  /**
   * Explicit resident OpenCode health probe (P2), independent of the number of
   * durable sessions: it contacts the service and REJECTS when it is unreachable.
   * An empty session census must never establish health on its own, so this runs
   * before the census and fails the phase closed.
   */
  probeResident(): Promise<void>;
  censusSessions(db: TissueDb): Promise<SessionCensusEntry[]>;
  reconcileArtifacts(db: TissueDb): Promise<{ expiredLeases: number; effects: number; cleaned: string[]; retained: string[] }>;
  scanDrift(db: TissueDb): Promise<Array<{ workItemId: string; result: DriftResult }>>;
  housekeep(db: TissueDb, now: Date): Promise<HousekeepingRunResult>;
  resumeNormalLoop(
    db: TissueDb,
    health: SessionDependencyHealth,
  ): Promise<{ recovered: string[]; claimed: string | null; gated?: boolean }>;
  injectFault?(boundary: ReconcileBoundary): Promise<void> | void;
}

/** W_WEDGE = 2 x W_turn (T8 precommit): beyond this a non-idle session is wedged. */
export const W_WEDGE_MS = 240_000;

const ALL_PHASES: ReconcilePhaseId[] = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"];

/**
 * Ordered idempotent P0-P6 reconcile pass. Never throws for an operational
 * failure: each phase is reported ok/failed and later phases still run, so a
 * transient gh/network failure cannot hide the housekeeping/drift work.
 *
 * P2 is authoritative, not diagnostic: its census classifications are applied as
 * durable controller recovery via `applySessionCensusRecovery` (session loss never
 * leaves a WorkItem indefinitely dispatchable), and the unappliable remainder is
 * surfaced in the P2 `detail` for operators.
 *
 * P6 is gated on resident dependency health: when the P2 census could not be taken
 * the gate withholds prompt-dependent resume in full, but only after P1/P3/P4/P5
 * (all OpenCode-independent) have run, so safe local reconciliation is never lost.
 *
 * The same health is exposed additively on the returned report as
 * `residentOpenCodeAvailable` so it can cross the reconcile -> daemon seam: the
 * `runDaemon` loop seeds its gate from it and re-probes every iteration. It is
 * false whenever P0 or P2 failed (fail closed) and true only when the P2 census
 * resolved.
 */
export async function runReconcilePass(ctx: ReconcileContext): Promise<ReconcileReport> {
  const deps = ctx.deps ?? defaultReconcileDeps(ctx);
  const phases: PhaseReport[] = [];
  const startedAt = new Date().toISOString();
  let db: TissueDb | null = null;
  // Resident OpenCode dependency health derived from the P2 census (P3 gate).
  let openCodeAvailable = false;

  const record = async (phase: ReconcilePhaseId, fn: () => Promise<unknown> | unknown): Promise<boolean> => {
    try {
      const detail = await fn();
      phases.push({ phase, ok: true, skipped: false, detail });
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      phases.push({ phase, ok: false, skipped: false, error });
      ctx.logger.error("reconcile.phase_failed", { phase, error });
      return false;
    }
  };

  try {
    const p0ok = await record("P0", () => {
      db = deps.openDb();
      return { path: db.path };
    });

    if (!p0ok || db === null) {
      for (const phase of ALL_PHASES.slice(1)) {
        phases.push({ phase, ok: false, skipped: true });
      }
    } else {
      const open = db;
      await record("P1", () => deps.verifyRepos(open, ctx.config));
      await record("P2", async () => {
        // 1. Explicit resident-health probe, independent of the durable session
        //    count: an empty census must never read as "the service answered".
        await deps.probeResident();
        // 2. Real census over the durable session mappings.
        const census = await deps.censusSessions(open);
        // 3. Apply the recovery policy (authoritative, not diagnostic).
        await deps.injectFault?.("recovery");
        const recovery = applySessionCensusRecovery(open, census, ctx.logger);
        // Health is published only after ALL of P2 succeeded. If the probe, the
        // census, or the recovery throws, P2 is recorded failed and the dependency
        // stays unsafe to resume, so P6 never receives a healthy signal from a
        // broken P2 (fail closed).
        openCodeAvailable = true;
        return { census, recovery };
      });
      await record("P3", async () => {
        await deps.injectFault?.("cleanup");
        return deps.reconcileArtifacts(open);
      });
      await record("P4", async () => {
        await deps.injectFault?.("drift_fail");
        return deps.scanDrift(open);
      });
      await record("P5", () => deps.housekeep(open, deps.now()));
      await record("P6", async () => {
        await deps.injectFault?.("ingest");
        await deps.injectFault?.("reparent");
        await deps.injectFault?.("prompt_before_completion");
        return deps.resumeNormalLoop(open, { openCodeAvailable });
      });
    }
  } finally {
    if (db !== null) {
      try {
        deps.closeDb(db);
      } catch (err) {
        ctx.logger.warn("reconcile.close_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const report: ReconcileReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    residentOpenCodeAvailable: openCodeAvailable,
    phases,
  };
  ctx.logger.info("reconcile.report", {
    phases: phases.map((p) => ({ phase: p.phase, ok: p.ok, skipped: p.skipped })),
    failed: phases.filter((p) => !p.ok && !p.skipped).map((p) => p.phase),
  });
  return report;
}

/**
 * Classify a session census. `busy`/`retry` beyond W_WEDGE becomes `wedged`; a
 * resolution session whose WorkItem is terminal/missing is `incomplete`.
 *
 * Classification semantics are unchanged; the P2 closure feeds the returned
 * entries to `applySessionCensusRecovery`, which turns them into explicit durable
 * controller actions.
 */
export async function classifySessionCensus(
  db: TissueDb,
  statusOf: (sessionId: string) => Promise<SessionStatus>,
  now: Date,
): Promise<SessionCensusEntry[]> {
  const sessions: SessionRow[] = listSessions(db);
  const out: SessionCensusEntry[] = [];
  for (const session of sessions) {
    const status = await statusOf(session.id);
    let classification: SessionClassification;
    let detail: string | undefined;
    if (status === "missing") {
      classification = "missing";
    } else if (status === "idle") {
      classification = "idle";
    } else {
      const age = now.getTime() - Date.parse(session.updated_at);
      if (Number.isFinite(age) && age > W_WEDGE_MS) {
        classification = "wedged";
        detail = `non-idle ${status} for ${age}ms`;
      } else {
        classification = status;
      }
    }
    if (session.kind === "resolution" && session.work_item_id !== null && classification !== "missing") {
      const wi = db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", session.work_item_id);
      if (!wi || (["COMPLETED", "REJECTED", "FAILED"] as readonly string[]).includes(wi.state)) {
        classification = "incomplete";
        detail = "resolution session is mapped to a terminal or missing WorkItem";
      }
    }
    out.push({
      sessionId: session.id,
      kind: session.kind,
      repoId: session.repo_id,
      workItemId: session.work_item_id,
      classification,
      ...(detail ? { detail } : {}),
    });
  }
  return out;
}

export type SessionRecoveryActionName =
  | "work_item_failed_hold"
  | "work_item_failed_hold_absorbed"
  | "work_item_failed_hold_observed"
  | "triage_session_released"
  | "session_retained"
  | "no_action";

export interface SessionRecoveryAction {
  sessionId: string;
  kind: string;
  repoId: string | null;
  workItemId: string | null;
  classification: SessionClassification;
  action: SessionRecoveryActionName;
  detail?: string;
}

/** The classification-derived reason recorded in durable session-loss evidence. */
function sessionLossReason(entry: SessionCensusEntry): Record<string, unknown> {
  return {
    reason: entry.classification === "wedged" ? "session_wedged" : "session_missing",
    session_id: entry.sessionId,
    classification: entry.classification,
  };
}

/**
 * Apply the Normative Recovery Policy: the single authority that turns P2 session
 * census classifications into explicit durable controller actions.
 *
 * It NEVER creates, deletes, prompts, or otherwise mutates an OpenCode session and
 * never calls `insertSession`/`createRealSession` or any driver/HTTP method. It only
 * writes durable Tissue state through `runWrite`, using existing legal FSM edges and
 * `appendTransition` evidence rows (never an illegal `recordTransition` triple):
 *   - resolution `missing`/`wedged` whose owner is RUNNING/WAITING is held to
 *     FAILED_HOLD via the existing legal `wedge` edge with leases cleared;
 *   - an already-FAILED_HOLD owner absorbs a `session_loss_absorbed` evidence row;
 *   - an unknown or non-holdable owner records `session_loss_observed` and changes
 *     no entity state;
 *   - resolution `incomplete` with an ACTIVE session retains the mapping
 *     (ACTIVE -> RETAINED, `session_retained`);
 *   - triage `missing`/`wedged` releases the owning repository's session mapping
 *     (`triage_session_released`) so the existing triage contract re-creates one.
 * Session, inbox, and prior transition rows are preserved untouched, and a lost
 * resolution session is never replaced. Idempotent across passes.
 */
export function applySessionCensusRecovery(
  db: TissueDb,
  census: SessionCensusEntry[],
  logger?: JsonLogger,
): SessionRecoveryAction[] {
  const actions: SessionRecoveryAction[] = [];
  for (const entry of census) {
    let action: SessionRecoveryActionName = "no_action";
    let detail: string | undefined;
    let humanInspect = false;

    if (entry.kind === "resolution" && (entry.classification === "missing" || entry.classification === "wedged")) {
      const workItem = entry.workItemId ? getWorkItem(db, entry.workItemId) : undefined;
      const evidence = sessionLossReason(entry);
      if (workItem && workItem.state === "FAILED_HOLD") {
        // Absorb: durable evidence only, never re-enter FAILED_HOLD.
        runWrite(db, (tx) =>
          appendTransition(tx, {
            entity_type: "work_item",
            entity_id: workItem.id,
            from_state: workItem.state,
            to_state: workItem.state,
            event: "session_loss_absorbed",
            reason_json: JSON.stringify(evidence),
            actor: "controller.reconcile",
          }),
        );
        action = "work_item_failed_hold_absorbed";
      } else if (workItem && isLegalTransition("work_item", workItem.state, "FAILED_HOLD", "wedge")) {
        runWrite(db, (tx) => {
          recordTransition(
            tx,
            { type: "work_item", id: workItem.id },
            workItem.state,
            "FAILED_HOLD",
            "wedge",
            evidence,
            "controller.reconcile",
          );
          setWorkItemState(tx, workItem.id, "FAILED_HOLD", { leaseToken: null, leaseUntil: null });
        });
        action = "work_item_failed_hold";
      } else {
        // Unknown owner or a non-holdable state: evidence only, no state change.
        humanInspect = true;
        detail = "owner_work_item_unknown_or_not_holdable";
        const sessionState =
          db.sql.get<{ state: string }>("SELECT state FROM opencode_sessions WHERE id = ?", entry.sessionId)?.state ??
          "ACTIVE";
        runWrite(db, (tx) =>
          appendTransition(tx, {
            entity_type: workItem ? "work_item" : "session",
            entity_id: workItem ? workItem.id : entry.sessionId,
            from_state: workItem ? workItem.state : sessionState,
            to_state: workItem ? workItem.state : sessionState,
            event: "session_loss_observed",
            reason_json: JSON.stringify({ ...evidence, work_item_id: entry.workItemId }),
            actor: "controller.reconcile",
          }),
        );
        action = "work_item_failed_hold_observed";
      }
    } else if (entry.kind === "resolution" && entry.classification === "incomplete") {
      const sessionState = db.sql.get<{ state: string }>(
        "SELECT state FROM opencode_sessions WHERE id = ?",
        entry.sessionId,
      )?.state;
      if (sessionState === "ACTIVE") {
        // Retain the mapping as history (R20); the terminal WorkItem is untouched.
        runWrite(db, (tx) => {
          recordTransition(
            tx,
            { type: "session", id: entry.sessionId },
            "ACTIVE",
            "RETAINED",
            "session_retained",
            { reason: "resolution_session_work_item_terminal", work_item_id: entry.workItemId },
            "controller.reconcile",
          );
          setSessionState(tx, entry.sessionId, "RETAINED");
        });
        action = "session_retained";
      }
    } else if (entry.kind === "triage" && (entry.classification === "missing" || entry.classification === "wedged")) {
      const repo = entry.repoId ? getRepositoryById(db, entry.repoId) : undefined;
      if (repo && repo.triage_session_id === entry.sessionId) {
        const evidence = { ...sessionLossReason(entry), repo_id: repo.id };
        runWrite(db, (tx) => {
          appendTransition(tx, {
            entity_type: "triage",
            entity_id: repo.id,
            from_state: repo.triage_state,
            to_state: repo.triage_state,
            event: "triage_session_released",
            reason_json: JSON.stringify(evidence),
            actor: "controller.reconcile",
          });
          // Release only the mapping; the triage contract owns the pump fields.
          updateTriageState(tx, repo.id, { sessionId: null });
        });
        action = "triage_session_released";
      }
    }

    actions.push({
      sessionId: entry.sessionId,
      kind: entry.kind,
      repoId: entry.repoId,
      workItemId: entry.workItemId,
      classification: entry.classification,
      action,
      ...(detail ? { detail } : {}),
    });

    if (action !== "no_action") {
      logger?.warn("reconcile.session_recovered", {
        session_id: entry.sessionId,
        kind: entry.kind,
        repo_id: entry.repoId,
        work_item_id: entry.workItemId,
        classification: entry.classification,
        action,
        human_inspect: humanInspect,
      });
    }
  }
  return actions;
}

/** Recover TRIAGE repos left in PROMPTING by a crashed prior pass (Plan A L2(5)). */
export async function recoverStalePrompting(
  db: TissueDb,
  logger: JsonLogger | undefined,
  driver: SessionDriver,
): Promise<string[]> {
  const recovered: string[] = [];
  for (const repo of listRepositories(db)) {
    if (repo.enabled !== 1 || repo.triage_state !== "PROMPTING") continue;
    const summary: TriageRunSummary = await runTriageRepo(db, repo.id, driver, new Date());
    recovered.push(`${repo.id}:${summary.reason ?? "recovered"}`);
    logger?.warn("reconcile.stale_prompting_recovered", {
      repoId: repo.id,
      outcome: summary.reason,
      triageState: summary.triageState,
    });
  }
  return recovered;
}
function defaultReconcileDeps(ctx: ReconcileContext): ReconcileDeps {
  const stateDir = ctx.stateDir ?? process.env.TISSUE_STATE_DIR ?? ".tissue";
  const dbPath = join(stateDir, "tissue.db");
  const gh = ctx.gh ?? new GhClient();
  const endpoint = process.env.TISSUE_OPENCODE_URL;
  const triage = ctx.config.agents.triage;
  // A caller-supplied driver already validated the endpoint when credentials were attached.
  const driver = ctx.driver ?? (() => {
    if (!endpoint) throw new Error("TISSUE_OPENCODE_URL is required; resident OpenCode service is not configured");
    const resumeEndpoint = validateResidentOpenCodeEndpoint(endpoint);
    const http = new OpenCodeHttp({
      baseUrl: resumeEndpoint.toString(),
      ...(process.env.OPENCODE_SERVER_USERNAME !== undefined ? { username: process.env.OPENCODE_SERVER_USERNAME } : {}),
      ...(process.env.OPENCODE_SERVER_PASSWORD !== undefined ? { password: process.env.OPENCODE_SERVER_PASSWORD } : {}),
    });
    return new OpenCodeDriver({
      http,
      ...(triage?.agent !== undefined ? { triageAgent: triage.agent } : {}),
      ...(triage?.model !== undefined ? { triageModel: parseProviderModel(triage.model) } : {}),
    });
  })();
  return {
    now: () => new Date(),
    openDb: () => ctx.db ?? openTissueDb(dbPath, { retentionDays: ctx.config.retentionDays }),
    closeDb: (db) => {
      if (ctx.db !== db) closeDb(db);
    },
    verifyRepos: async (db, config) => {
      synchronizeConfiguredRepositories(db, config, new Date());
      const out: Array<{ repoId: string; ok: boolean; capability?: RepoCapability; error?: string }> = [];
      for (const repo of config.repos) {
        if (!repo.enabled) continue;
        try {
          const capability = await verifyRepository(repo, gh);
          persistRepositoryCapability(db, `${repo.owner}/${repo.name}`, { state: capability.readiness.ready ? "ready" : "not_ready", capability }, new Date());
          out.push({ repoId: `${repo.owner}/${repo.name}`, ok: capability.readiness.ready, capability, ...(capability.readiness.ready ? {} : { error: capability.readiness.reasons.join("; ") }) });
        } catch (err) {
          persistRepositoryCapability(db, `${repo.owner}/${repo.name}`, { state: "unknown", capability: { error: err instanceof Error ? err.message : String(err) } }, new Date());
          out.push({
            repoId: `${repo.owner}/${repo.name}`,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return out;
    },
    // Production never owns an OpenCode process; there is no serve-lifecycle slot.
    //
    // P2 health is probed explicitly and independently of the durable session
    // count: `listSessions` contacts the resident service whether or not any
    // session rows exist, and rejects when the service is unreachable. A driver
    // that cannot probe fails closed rather than letting an empty census look
    // healthy.
    probeResident: async () => {
      const candidate = driver as { listSessions?: (directory?: string) => Promise<unknown> };
      if (typeof candidate.listSessions !== "function") {
        throw new Error(
          "no resident OpenCode health probe is available on the configured session driver; refusing to assume the dependency is healthy",
        );
      }
      await candidate.listSessions();
    },
    censusSessions: async (db) => classifySessionCensus(db, (id) => driver.getSessionStatus(id), new Date()),
    reconcileArtifacts: async (db) => {
      const now = new Date();
      const expired = expireLeases(db, now);
      const transport = new GhEffectTransport({ gh });
      let effects = 0;
      for (const effect of listDueSideEffects(db, now)) {
        await executeVerifiedEffect(db, effect.id, transport, { now });
        effects += 1;
      }
      const cleanup = await cleanupTerminalLeftovers(db, {
        logger: ctx.logger,
        now,
        removeWorktree: (identity: WorktreeIdentity, mode: "merged" | "explicit-failed-hold") =>
          cleanupWorktree(identity, mode),
      });
      return {
        expiredLeases: typeof expired === "number" ? expired : 0,
        effects,
        cleaned: cleanup.cleanedWorktrees,
        retained: cleanup.humanInspect.map((leftover) => `${leftover.kind}:${leftover.id}`),
      };
    },
    scanDrift: async (db) => {
      const scanner = new GitGhDriftScanner(gh);
      const out: Array<{ workItemId: string; result: DriftResult }> = [];
      for (const wi of listWorkItemsByStates(db, [...ARTIFACT_OWNING_WORK_ITEM_STATES])) {
        out.push({ workItemId: wi.id, result: await scanAndAdoptDrift(db, wi.id, scanner, { logger: ctx.logger }) });
      }
      return out;
    },
    housekeep: async (db, now) => runTerminalUnattachedHousekeeping(db, now, ctx.logger),
    resumeNormalLoop: async (db, health) => {
      if (!health.openCodeAvailable) {
        // Withhold prompt-dependent resume in full while the resident dependency
        // is unobservable; the census failure already surfaces on P2.
        ctx.logger.warn("reconcile.p6_gated", {
          reason: "opencode_unavailable",
          withheld: "stale_prompting_recovery",
        });
        return { recovered: [], claimed: null, gated: true };
      }
      const recovered = await recoverStalePrompting(db, ctx.logger, driver);
      // The queue/normal loop is driven by the daemon (Phase 4) which owns the
      // session driver; startup reconcile only guarantees a consistent state.
      return { recovered, claimed: null, gated: false };
    },
  };
}

