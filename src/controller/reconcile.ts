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
//   P2  real session census (idle/busy/retry/missing/incomplete/wedged)
//   P3  worktree/branch/PR/lease/effect reconcile + terminal-leftover cleanup
//   P4  drift pass (drift.ts)
//   P5  terminal-unattached housekeeping
//   P6  resume idempotent normal loop (+ stale-PROMPTING crash recovery)
//
// Production topology is resident-only: one s6-supervised Tissue daemon connects
// to an already-running OpenCode service via TISSUE_OPENCODE_URL. Tissue never
// spawns or owns an OpenCode process and there is no serve-lifecycle phase.
// Fault-injection boundaries: ingest, prompt-before-completion, reparent,
// drift-fail, cleanup.

import { join } from "node:path";

import { ARTIFACT_OWNING_WORK_ITEM_STATES } from "../domain/state-machine.ts";
import { closeDb, openTissueDb, type TissueDb } from "../db/open.ts";
import {
  expireLeases,
  listDueSideEffects,
  listRepositories,
  listSessions,
  listWorkItemsByStates,
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

export type ReconcileBoundary = "ingest" | "prompt_before_completion" | "reparent" | "drift_fail" | "cleanup";

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

export interface ReconcileDeps {
  now(): Date;
  openDb(): TissueDb;
  closeDb(db: TissueDb): void;
  verifyRepos(db: TissueDb, config: TissueConfig): Promise<Array<{ repoId: string; ok: boolean; capability?: RepoCapability; error?: string }>>;
  censusSessions(db: TissueDb): Promise<SessionCensusEntry[]>;
  reconcileArtifacts(db: TissueDb): Promise<{ expiredLeases: number; effects: number; cleaned: string[]; retained: string[] }>;
  scanDrift(db: TissueDb): Promise<Array<{ workItemId: string; result: DriftResult }>>;
  housekeep(db: TissueDb, now: Date): Promise<HousekeepingRunResult>;
  resumeNormalLoop(db: TissueDb): Promise<{ recovered: string[]; claimed: string | null }>;
  injectFault?(boundary: ReconcileBoundary): Promise<void> | void;
}

/** W_WEDGE = 2 x W_turn (T8 precommit): beyond this a non-idle session is wedged. */
export const W_WEDGE_MS = 240_000;

const ALL_PHASES: ReconcilePhaseId[] = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"];

/**
 * Ordered idempotent P0-P6 reconcile pass. Never throws for an operational
 * failure: each phase is reported ok/failed and later phases still run, so a
 * transient gh/network failure cannot hide the housekeeping/drift work.
 */
export async function runReconcilePass(ctx: ReconcileContext): Promise<ReconcileReport> {
  const deps = ctx.deps ?? defaultReconcileDeps(ctx);
  const phases: PhaseReport[] = [];
  const startedAt = new Date().toISOString();
  let db: TissueDb | null = null;

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
      await record("P2", () => deps.censusSessions(open));
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
        return deps.resumeNormalLoop(open);
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

  const report: ReconcileReport = { startedAt, finishedAt: new Date().toISOString(), phases };
  ctx.logger.info("reconcile.report", {
    phases: phases.map((p) => ({ phase: p.phase, ok: p.ok, skipped: p.skipped })),
    failed: phases.filter((p) => !p.ok && !p.skipped).map((p) => p.phase),
  });
  return report;
}

/**
 * Classify a session census. `busy`/`retry` beyond W_WEDGE becomes `wedged`; a
 * resolution session whose WorkItem is terminal/missing is `incomplete`.
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
    resumeNormalLoop: async (db) => {
      const recovered = await recoverStalePrompting(db, ctx.logger, driver);
      // The queue/normal loop is driven by the daemon (Phase 4) which owns the
      // session driver; startup reconcile only guarantees a consistent state.
      return { recovered, claimed: null };
    },
  };
}

