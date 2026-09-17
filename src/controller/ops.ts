// Shared operator operations. CLI handlers are adapters only; all durable mutations
// and inspection queries live here so daemon/reconcile/CLI cannot diverge.
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeDb, openTissueDb, runWrite, type TissueDb } from "../db/open.ts";
import {
  getRepository,
  getRepositoryById,
  getWorkItem,
  housekeepingCounters,
  listHousekeepingActions,
  listRecentTransitions,
  listRepositories,
  listSessions,
  listWorktreesByWorkItem,
  listPullRequestsByWorkItem,
  statusSummary,
  updateTriageState,
  setWorkItemState,
  type RepositoryRow,
  type WorkItemRow,
} from "../db/repositories.ts";
import { recordTransition } from "../domain/transitions.ts";
import { enqueueIssue } from "./enqueue.ts";
import { unpauseTriage } from "./triage.ts";
import { cleanupWorktree, type WorktreeIdentity } from "./worktrees.ts";
import { redactResidentEndpoint, resolveSourceAgentsDir, validateTissueAgentDefinitions } from "../runtime/resident.ts";
import { assertRegistryMount, listMarkerSessionIds, resolveSessionRegistryDir } from "./session-registry.ts";
import type { TissueConfig } from "../config/types.ts";
import type { JsonLogger } from "../logging/jsonl.ts";

export class OperationError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function dbFor(config: TissueConfig, stateDir: string): TissueDb {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return openTissueDb(join(stateDir, "tissue.db"), { retentionDays: config.retentionDays });
}

export interface OpsContext { config: TissueConfig; stateDir: string; logger: JsonLogger; }

export function withDb<T>(ctx: OpsContext, fn: (db: TissueDb) => T): T {
  const db = dbFor(ctx.config, ctx.stateDir);
  try { return fn(db); } finally { closeDb(db); }
}

function readinessReasons(capabilityJson: string | null): string[] {
  if (!capabilityJson) return [];
  try {
    const parsed = JSON.parse(capabilityJson) as { readiness?: { reasons?: unknown }; error?: unknown };
    if (Array.isArray(parsed.readiness?.reasons)) return parsed.readiness.reasons.filter((r): r is string => typeof r === "string");
    if (typeof parsed.error === "string") return [parsed.error];
  } catch { /* surfaced as no reasons; readiness state still fails closed */ }
  return [];
}

/** Redacted per-repository readiness view shared by status and doctor. */
function repositoryReadiness(db: TissueDb): Array<Record<string, unknown>> {
  return listRepositories(db).map((repo) => ({
    id: repo.id,
    enabled: repo.enabled === 1,
    configManaged: repo.config_managed === 1,
    capability: repo.capability_state ?? "unknown",
    ready: repo.capability_state === "ready",
    checkedAt: repo.capability_checked_at ?? null,
    reasons: readinessReasons(repo.capability_json),
  }));
}

/** Credential-free resident-endpoint status; never echoes the URL or a secret. */
function opencodeStatus(): Record<string, unknown> {
  const raw = process.env.TISSUE_OPENCODE_URL;
  const hasUsername = process.env.OPENCODE_SERVER_USERNAME !== undefined && process.env.OPENCODE_SERVER_USERNAME !== "";
  const hasPassword = process.env.OPENCODE_SERVER_PASSWORD !== undefined && process.env.OPENCODE_SERVER_PASSWORD !== "";
  return {
    configured: typeof raw === "string" && raw.length > 0,
    endpoint: raw ? redactResidentEndpoint(raw) : null,
    authConfigured: hasUsername || hasPassword,
    capability: "not_probed",
  };
}

/**
 * Test/ops seams for the read-only registry view. Production reads `process.env`
 * and the real `/proc/self/mountinfo`; the mount-table override exists so the
 * deterministic registry tests (and the CLI doctor test) can assert the mount
 * state without a real container mount.
 */
export interface RegistryOpsOptions {
  /** Registry environment view; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Mount-table path forwarded to `assertRegistryMount`; defaults to `/proc/self/mountinfo`. */
  mountInfoPath?: string;
}

/** Env override for the mount-table path (container-free doctor/status tests). */
const REGISTRY_MOUNTINFO_ENV = "TISSUE_SESSION_REGISTRY_MOUNTINFO";

/**
 * Read-only registry view for `doctor`/`status`: the mount-assertion state and
 * the marker count. No marker contents and no secrets cross this boundary.
 *
 * `prunedAtStartup` is re-derived read-only: the marker ids that have no
 * `opencode_sessions` row are exactly the set the startup prune removes. Doctor
 * is a separate process and persists no startup state (no cache/sentinel), so it
 * reports this deterministic prune set rather than an in-memory startup result.
 */
function registryView(db: TissueDb, opts?: RegistryOpsOptions): {
  dir: string;
  mountAsserted: boolean;
  writable: boolean;
  realMount: boolean;
  overridden: boolean;
  markerCount: number;
  prunedAtStartup: string[];
} {
  const env = opts?.env ?? process.env;
  const mountInfoPath = opts?.mountInfoPath ?? process.env[REGISTRY_MOUNTINFO_ENV];
  const dir = resolveSessionRegistryDir(env);
  const mount = assertRegistryMount(dir, mountInfoPath !== undefined ? { mountInfoPath } : {});
  const markers = listMarkerSessionIds(dir);
  const known = new Set(listSessions(db).map((session) => session.id));
  return {
    dir,
    mountAsserted: mount.ok,
    writable: mount.writable,
    realMount: mount.realMount,
    // Self-announcing override: true whenever a non-default mount table is in
    // effect (an explicit opts.mountInfoPath or the env seam), false on the
    // default production path. The mount assertion is ADR-005's compensating
    // control for the plugin's deliberate fail-open, so an active override must
    // be externally observable rather than able to silence the assertion
    // invisibly.
    overridden: mountInfoPath !== undefined,
    markerCount: markers.length,
    prunedAtStartup: markers.filter((id) => !known.has(id)),
  };
}

export function statusOperation(ctx: OpsContext, opts?: RegistryOpsOptions): Record<string, unknown> {
  return withDb(ctx, (db) => {
    const summary = statusSummary(db);
    const wal = `${db.path}-wal`;
    let walBytes = 0;
    try { walBytes = statSync(wal).size; } catch { /* WAL may not exist yet. */ }
    const active = Object.entries(summary.workItems)
      .filter(([state]) => ["QUEUED", "RUNNING", "WAITING", "PAUSED_WORK", "BLOCKED", "FAILED_HOLD"].includes(state))
      .reduce((n, [, count]) => n + Number(count), 0);
    return {
      ...summary,
      failedHold: summary.workItems.FAILED_HOLD ?? 0,
      capacity: { globalLimit: ctx.config.maxConcurrentGlobal, active, available: Math.max(0, ctx.config.maxConcurrentGlobal - active) },
      leases: { active: summary.activeLeases },
      sessions: listSessions(db),
      lastReconcile: listRecentTransitions(db, 100).find((t) => t.event === "reconcile") ?? null,
      wal: { path: wal, bytes: walBytes, growthBytes: walBytes },
      housekeeping: housekeepingCounters(db),
      transitions: listRecentTransitions(db, 100),
      repositories: summary.repositories,
      repositoryReadiness: repositoryReadiness(db),
      opencode: opencodeStatus(),
      registry: registryView(db, opts),
      gh: { binary: "/usr/bin/gh", authenticated: null, version: null, capability: "not_probed" },
    };
  });
}

export function inspectOperation(ctx: OpsContext, scope?: string): Record<string, unknown> {
  return withDb(ctx, (db) => {
    const repo = scope?.includes("/") ? (() => { const [owner, name] = scope.split("/", 2); return owner && name ? getRepository(db, owner, name) : undefined; })() : undefined;
    const wi = scope && !repo ? getWorkItem(db, scope) : undefined;
    if (scope && !repo && !wi) throw new OperationError("NOT_FOUND", `unknown repository or work item '${scope}'`, 4);
    const workItems = wi ? [wi] : repo ? db.sql.all<WorkItemRow>("SELECT * FROM work_items WHERE repo_id = ? ORDER BY created_at", repo.id) : db.sql.all<WorkItemRow>("SELECT * FROM work_items ORDER BY created_at");
    return {
      scope: scope ?? null,
      repository: repo ?? null,
      workItems: workItems.map((item) => ({ ...item, sessions: listSessions(db).filter((s) => s.work_item_id === item.id), worktrees: listWorktreesByWorkItem(db, item.id), pullRequests: listPullRequestsByWorkItem(db, item.id) })),
      inbox: db.sql.all("SELECT state, COUNT(*) AS count FROM inbox GROUP BY state"),
      pullRequests: workItems.flatMap((item) => listPullRequestsByWorkItem(db, item.id)),
      checks: db.sql.all("SELECT effect_key, state, attempt FROM side_effects WHERE effect_key LIKE 'check:%' ORDER BY id DESC"),
      protection: repo?.protection_json ? JSON.parse(repo.protection_json) : null,
    };
  });
}

export function historyOperation(ctx: OpsContext, scope?: string): Record<string, unknown> {
  return withDb(ctx, (db) => ({
    scope: scope ?? null,
    transitions: scope ? db.sql.all("SELECT * FROM state_transitions WHERE entity_id = ? ORDER BY id DESC", scope) : listRecentTransitions(db, 100),
    housekeeping: listHousekeepingActions(db, 100),
  }));
}

export function enqueueOperation(ctx: OpsContext, owner: string, name: string, number: number): Record<string, unknown> {
  return withDb(ctx, (db) => {
    const repo = getRepository(db, owner, name);
    if (!repo) throw new OperationError("NOT_FOUND", `unknown repository '${owner}/${name}'`, 4);
    return { ...enqueueIssue(db, { id: repo.id }, number) };
  });
}

function repoFor(db: TissueDb, target: string): RepositoryRow | undefined {
  const parts = target.split("/");
  return parts.length === 2 ? getRepository(db, parts[0]!, parts[1]!) : getRepositoryById(db, target);
}

export function pauseOperation(ctx: OpsContext, target: string): Record<string, unknown> {
  return withDb(ctx, (db) => {
    const repo = repoFor(db, target);
    if (repo) return runWrite(db, (tx) => {
      if (repo.triage_state !== "PAUSED_TRIAGE") recordTransition(tx, { type: "triage", id: repo.id }, repo.triage_state, "PAUSED_TRIAGE", "pause_triage", { explicit: true }, "human:pause");
      updateTriageState(tx, repo.id, { state: "PAUSED_TRIAGE" });
      return { target, state: "PAUSED_TRIAGE" };
    });
    const wi = getWorkItem(db, target);
    if (!wi) throw new OperationError("NOT_FOUND", `unknown target '${target}'`, 4);
    if (wi.state === "PAUSED_WORK") return { target, state: wi.state, changed: false };
    return runWrite(db, (tx) => { recordTransition(tx, { type: "work_item", id: wi.id }, wi.state, "PAUSED_WORK", "pause_work", { explicit: true }, "human:pause"); setWorkItemState(tx, wi.id, "PAUSED_WORK"); return { target, state: "PAUSED_WORK", changed: true }; });
  });
}

export function resumeOperation(ctx: OpsContext, target: string): Record<string, unknown> {
  return withDb(ctx, (db) => {
    const repo = repoFor(db, target);
    if (repo) { const changed = unpauseTriage(db, repo.id); return { target, state: "IDLE", changed }; }
    const wi = getWorkItem(db, target);
    if (!wi) throw new OperationError("NOT_FOUND", `unknown target '${target}'`, 4);
    if (wi.state !== "PAUSED_WORK") return { target, state: wi.state, changed: false };
    return runWrite(db, (tx) => { recordTransition(tx, { type: "work_item", id: wi.id }, "PAUSED_WORK", "QUEUED", "resume_work", { explicit: true }, "human:resume"); setWorkItemState(tx, wi.id, "QUEUED"); return { target, state: "QUEUED", changed: true }; });
  });
}

export const unpauseOperation = resumeOperation;

export async function cleanupOperation(ctx: OpsContext, workItemId: string): Promise<Record<string, unknown>> {
  const db = dbFor(ctx.config, ctx.stateDir);
  const emit = (status: "success" | "failure", reason: string): void => {
    // This is deliberately ERROR-level human-inspect telemetry for both outcomes.
    // Only identifiers and fixed reason/status values cross the logging boundary.
    ctx.logger.error("cleanup.human_inspect", { operation: "cleanup", workItemId, status, reason });
  };
  try {
    const wi = getWorkItem(db, workItemId);
    if (!wi) { emit("failure", "not_found"); throw new OperationError("NOT_FOUND", `unknown work item '${workItemId}'`, 4); }
    if (wi.state !== "FAILED_HOLD") { emit("failure", "invalid_state"); throw new OperationError("INVALID_STATE", `cleanup requires FAILED_HOLD, got '${wi.state}'`, 1); }
    const repo = getRepositoryById(db, wi.repo_id);
    if (!repo) { emit("failure", "inconsistent_repository"); throw new OperationError("INCONSISTENT", `work item '${workItemId}' has no repository`, 1); }
    try {
      const row = listWorktreesByWorkItem(db, workItemId).find((item) => item.state === "ACTIVE" || item.state === "CLEANING");
      if (row) {
        const identity: WorktreeIdentity = { workItemId, mainDir: repo.local_dir, worktreeDir: row.path, branch: row.branch, headSha: null, repoSlug: `${repo.owner}-${repo.name}` };
        await cleanupWorktree(identity, "explicit-failed-hold");
      }
      runWrite(db, (tx) => { recordTransition(tx, { type: "work_item", id: workItemId }, "FAILED_HOLD", "FAILED", "cleanup", { explicit: true, noWorktree: !listWorktreesByWorkItem(db, workItemId).some((item) => item.state === "ACTIVE" || item.state === "CLEANING") }, "human:cleanup"); setWorkItemState(tx, workItemId, "FAILED"); });
      emit("success", "explicit_cleanup");
      return { workItemId, state: "FAILED", explicit: true };
    } catch (error) {
      emit("failure", "cleanup_failed");
      throw error;
    }
  } finally { closeDb(db); }
}

export function doctorOperation(ctx: OpsContext, opts?: RegistryOpsOptions): Record<string, unknown> {
  // Fail closed: validate the DEPLOYED definitions the resident service reads, and
  // compare them against the checked-in source so a stale deployment is reported.
  const agents = validateTissueAgentDefinitions({ sourceDir: resolveSourceAgentsDir() });
  return withDb(ctx, (db) => {
    const registry = registryView(db, opts);
    return {
      // The registry mount assertion is the compensating control for the plugin's
      // deliberate fail-open, so a failed assertion is a doctor failure (L11/L13).
      ok: agents.ok && registry.mountAsserted,
      database: { path: db.path, wal: true },
      repositories: ctx.config.repos.map((r) => {
        const id = `${r.owner}/${r.name}`;
        const row = getRepository(db, r.owner, r.name);
        return {
          id,
          enabled: r.enabled,
          capability: row?.capability_state ?? "unknown",
          ready: row?.capability_state === "ready",
          reasons: readinessReasons(row?.capability_json ?? null),
        };
      }),
      stateDir: ctx.stateDir,
      agents,
      registry,
      opencode: opencodeStatus(),
    };
  });
}

export function smokeOperation(ctx: OpsContext): Record<string, unknown> { return { ok: true, checks: doctorOperation(ctx) }; }
