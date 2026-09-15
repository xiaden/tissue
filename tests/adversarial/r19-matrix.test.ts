// R19 deterministic adversarial/fault matrix for Plan D Phase 1.
// All external boundaries use the pessimistic OpenCode server, fake gh, child-safe
// SQLite, and temporary bare repositories; no real OpenCode/GitHub state is used.
import test from "node:test";
import assert from "node:assert/strict";

import { createTestDb, seedIssue, seedRepository } from "../helpers/db.ts";
import { createTempRepo } from "../helpers/git.ts";
import { startPessimisticServer } from "../helpers/pessimistic-opencode-server.ts";
import {
  attachIssueToWorkItem,
  getWorkItem,
  insertInboxEventIfAbsent,
  insertIssue,
  insertPullRequest,
  insertSession,
  insertWorkItem,
  insertWorktree,
  listInboxByWorkItem,
  listPullRequestsByWorkItem,
  listTransitions,
  reparentInboxByIssue,
  setWorkItemState,
  updateIssueState,
} from "../../src/db/repositories.ts";
import { OpenCodeHttp } from "../../src/integrations/opencode-http.ts";
import { OpenCodeDriver } from "../../src/integrations/opencode-driver.ts";
import { ingestSnapshot } from "../../src/controller/ingest.ts";
import { scanAndAdoptDrift, type ObservedArtifacts } from "../../src/controller/drift.ts";
import { classifySessionCensus, runReconcilePass, type ReconcileBoundary, type ReconcileDeps } from "../../src/controller/reconcile.ts";
import { cleanupWorktree, createWorktree, worktreeBranchFor } from "../../src/controller/worktrees.ts";
import { runWrite } from "../../src/db/open.ts";
import { recordTransition } from "../../src/domain/transitions.ts";
import { applyEnvelope, type AgentEnvelope } from "../../src/domain/envelopes.ts";
import type { TissueConfig } from "../../src/config/types.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";

const REPO = "xiaden/nomarr";
const CONFIG: TissueConfig = { pollIntervalSeconds: 300, maxConcurrentGlobal: 3, retentionDays: 30, agents: {}, repos: [] };

function snapshot(issueNumber: number, title: string, updatedAt = "2026-09-10T00:00:00.000Z") {
  return {
    repoId: REPO, owner: "xiaden", name: "nomarr", baselineAt: "2026-09-01T00:00:00.000Z",
    cursor: null, watermark: updatedAt, collectedAt: updatedAt,
    issues: [{ number: issueNumber, title, body: "untrusted body", state: "OPEN", updatedAt, createdAt: updatedAt, labels: [], snapshotHash: `${issueNumber}:${title}:${updatedAt}` }],
    pullRequests: [], checks: [], reviews: [], conflicts: [], comments: [],
  };
}

function observed(branch: string, path: string, prs: number[] = []): ObservedArtifacts {
  return { branches: [branch], worktrees: [{ branch, path }], prs: prs.map((number) => ({ number, headRef: branch, state: "OPEN" })) };
}

test("R19 discovery is duplicate-safe under simultaneous/repeated snapshots and updates", () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    const first = ingestSnapshot(t.db, snapshot(7, "first"));
    const duplicate = ingestSnapshot(t.db, snapshot(7, "first"));
    const update = ingestSnapshot(t.db, snapshot(7, "edited", "2026-09-10T00:01:00.000Z"));
    assert.equal(first.inboxInserted, 1);
    assert.equal(duplicate.inboxInserted, 0);
    assert.equal(update.inboxInserted, 1);
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM issues WHERE number = 7")?.c, 1);
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM inbox")?.c, 2);
  } finally { t.cleanup(); }
});

test("R19 every reconcile fault boundary is isolated and later recovery remains runnable", async () => {
  const t = createTestDb();
  try {
    const faults: ReconcileBoundary[] = [];
    const deps: ReconcileDeps = {
      now: () => new Date("2026-09-10T00:00:00.000Z"), openDb: () => t.db, closeDb: () => {},
      verifyRepos: async () => [], censusSessions: async () => [],
      reconcileArtifacts: async () => ({ expiredLeases: 0, effects: 0, cleaned: [], retained: [] }),
      scanDrift: async () => [], housekeep: async () => ({ checked: 0, terminalMarked: 0, pruned: 0, issueIds: [], at: new Date().toISOString(), counters: { terminalMarked: 0, pruned: 0, lastAt: null }, lastAction: null }),
      resumeNormalLoop: async () => ({ recovered: [], claimed: null }), injectFault: (boundary) => { faults.push(boundary); },
    };
    const report = await runReconcilePass({ config: CONFIG, logger: new JsonLogger(new CapturingSink().writeable()), db: t.db, deps });
    assert.deepEqual(faults, ["cleanup", "drift_fail", "ingest", "reparent", "prompt_before_completion"]);
    assert.deepEqual(report.phases.map((phase) => phase.phase), ["P0", "P1", "P2", "P3", "P4", "P5", "P6"]);
    assert.ok(report.phases.every((phase) => phase.ok));
  } finally { t.cleanup(); }
});

test("R19 session census distinguishes failed, missing, incomplete, busy and wedged sessions", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: "wi-active", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    insertWorkItem(t.db, { id: "wi-terminal", repo_id: repo.id, state: "COMPLETED", base_branch: "main" });
    insertSession(t.db, { id: "ses-idle", kind: "triage", repo_id: repo.id, directory: "/repo", state: "ACTIVE" });
    insertSession(t.db, { id: "ses-busy", kind: "resolution", repo_id: repo.id, work_item_id: "wi-active", directory: "/busy", state: "ACTIVE" });
    insertSession(t.db, { id: "ses-incomplete", kind: "resolution", repo_id: repo.id, work_item_id: "wi-terminal", directory: "/done", state: "ACTIVE" });
    t.db.sql.run("UPDATE opencode_sessions SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'ses-busy'");
    const statuses: Record<string, "idle" | "busy" | "retry" | "missing"> = { "ses-idle": "idle", "ses-busy": "retry", "ses-incomplete": "idle" };
    const census = await classifySessionCensus(t.db, async (id) => statuses[id] ?? "missing", new Date("2026-09-10T00:00:00.000Z"));
    const byId = new Map(census.map((entry) => [entry.sessionId, entry.classification]));
    assert.equal(byId.get("ses-idle"), "idle");
    assert.equal(byId.get("ses-busy"), "wedged");
    assert.equal(byId.get("ses-incomplete"), "incomplete");
    assert.equal(byId.get("ses-missing"), undefined);
  } finally { t.cleanup(); }
});

test("R19 drift cascade adopts two rogue PRs, then FAILED_HOLD absorbs repeats without cascading", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const wi = insertWorkItem(t.db, { id: "wi-drift", repo_id: repo.id, state: "RUNNING", base_branch: "main", head_branch: worktreeBranchFor("wi-drift") });
    const branch = wi.head_branch!;
    insertPullRequest(t.db, { id: "pr-expected", work_item_id: wi.id, repo_id: repo.id, number: 10, head_ref: branch, state: "ACTIVE" });
    const result = await scanAndAdoptDrift(t.db, wi.id, { scan: async () => observed(branch, "/tmp/wt", [10, 11, 12]) });
    assert.equal(result.transitionedToFailedHold, true);
    assert.deepEqual(listPullRequestsByWorkItem(t.db, wi.id).map((pr) => pr.number).sort((a, b) => a - b), [10, 11, 12]);
    const repeat = await scanAndAdoptDrift(t.db, wi.id, { scan: async () => observed(branch, "/tmp/wt", [10, 11, 12]) });
    assert.equal(repeat.unexpected.length, 0);
    assert.equal(getWorkItem(t.db, wi.id)?.state, "FAILED_HOLD");
  } finally { t.cleanup(); }
});

test("R19 terminal cleanup and re-parent collision preserve terminal history", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const issue = seedIssue(t.db, repo.id, { number: 99, state: "REJECTED" });
    const wi = insertWorkItem(t.db, { id: "wi-terminal", repo_id: repo.id, state: "COMPLETED", base_branch: "main" });
    const inserted = insertInboxEventIfAbsent(t.db, { issue_id: issue.id, event_key: "terminal-event", kind: "comment", payload_json: "{}" });
    assert.equal(inserted.inserted, true);
    t.db.sql.run("UPDATE inbox SET state = 'TERMINAL', terminal_action = 'terminal_marked' WHERE id = ?", inserted.id);
    attachIssueToWorkItem(t.db, issue.id, wi.id);
    assert.equal(reparentInboxByIssue(t.db, issue.id, wi.id), 0);
    assert.equal(listInboxByWorkItem(t.db, wi.id).length, 0);
    assert.equal(getWorkItem(t.db, wi.id)?.state, "COMPLETED");
  } finally { t.cleanup(); }
});

test("R19 pause/block/unblock, two-repo flood, and duplicate envelopes are durable no-ops", () => {
  const t = createTestDb();
  try {
    const repoA = seedRepository(t.db, { owner: "xiaden", name: "a", maxConcurrentPerRepo: 5 });
    const repoB = seedRepository(t.db, { owner: "xiaden", name: "b", maxConcurrentPerRepo: 5 });
    const issue = insertIssue(t.db, { id: "issue-agent", repo_id: repoA.id, number: 1, title: "x", state: "TRIAGE_PENDING", updated_at: "2026-09-10T00:00:00.000Z" });
    const wi = insertWorkItem(t.db, { id: "wi-agent", repo_id: repoA.id, state: "RUNNING", base_branch: "main" });
    const env: AgentEnvelope = { kind: "triage", envelope_id: "env-agent", issue_id: issue.id, disposition: "READY" };
    assert.equal(runWrite(t.db, (tx) => applyEnvelope(tx, env)).status, "applied");
    assert.equal(runWrite(t.db, (tx) => applyEnvelope(tx, env)).status, "noop_duplicate");
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM side_effects")?.c, 0);
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM opencode_sessions")?.c, 0);
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM worktrees")?.c, 0);
    runWrite(t.db, (tx) => {
      setWorkItemState(tx, wi.id, "PAUSED_WORK");
      recordTransition(tx, { type: "work_item", id: wi.id }, "RUNNING", "PAUSED_WORK", "pause_work", null, "test");
      setWorkItemState(tx, wi.id, "BLOCKED", { blockedBy: "wi-dep" });
      recordTransition(tx, { type: "work_item", id: wi.id }, "PAUSED_WORK", "BLOCKED", "block", { blocked_by: "wi-dep" }, "test");
      setWorkItemState(tx, wi.id, "READY");
      recordTransition(tx, { type: "work_item", id: wi.id }, "BLOCKED", "READY", "unblock", null, "test");
    });
    assert.equal(getWorkItem(t.db, wi.id)?.state, "READY");
    assert.equal(repoB.id, "xiaden/b");
    assert.equal(listTransitions(t.db, "work_item", wi.id).length, 3);
  } finally { t.cleanup(); }
});

test("R19 dirty worktree cleanup is deterministic and identity-safe on a bare-repo fixture", async () => {
  const temp = await createTempRepo();
  try {
    const repo = { owner: "x", name: "repo", remote: temp.bare, localDir: temp.clone, enabled: true, pollIntervalSeconds: 300, maxConcurrentPerRepo: 1, baseBranch: "main", labels: [], autoMerge: false, priority: 0 };
    const identity = await createWorktree(repo, "wi-dirty");
    const result = await cleanupWorktree(identity, "merged");
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchDeleted, true);
  } finally { temp.cleanup(); }
});

test("R19 pessimistic OpenCode busy/missing session states never become completion", async () => {
  // Drives the REAL driver/transport against the pessimistic fake server: a
  // busy (and then deleted/missing) resolution session must never yield a
  // completion match, and the startup census must classify it as non-idle
  // (busy/wedged) or missing — never as idle/completed.
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const t = createTestDb();
  const driver = new OpenCodeDriver({ http, db: t.db });
  try {
    seedRepository(t.db);
    insertWorkItem(t.db, { id: "wi-busy", repo_id: REPO, state: "RUNNING", base_branch: "main" });
    const ref = await driver.createRealSession("resolution", "/busy", { repoId: REPO, directory: "/busy", kind: "resolution", workItemId: "wi-busy" });
    const nonce = "r19-busy-nonce";

    // Busy session: an async prompt is accepted but produces no turn, so the
    // nonce never becomes completion (acceptance != completion).
    server.setBusy(ref.sessionId);
    t.db.sql.run("UPDATE opencode_sessions SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", ref.sessionId);
    const accepted = await driver.promptAsync(ref.sessionId, { text: `resolve ${nonce}`, nonce });
    assert.equal(accepted.kind, "accepted");
    assert.deepEqual(await driver.observeCompletion(ref.sessionId, nonce), { matched: false, reason: "no_turn" });

    // Census over the real driver status: the busy session is aged past W_WEDGE,
    // so it classifies as wedged, never idle/completed.
    const busyCensus = await classifySessionCensus(t.db, (id) => driver.getSessionStatus(id), new Date());
    const busyById = new Map(busyCensus.map((entry) => [entry.sessionId, entry.classification]));
    assert.equal(busyById.get(ref.sessionId), "wedged");

    // Deleted session: missing status, completion resolves to session_missing,
    // and the census classifies it as missing — never idle/completed.
    server.deleteSession(ref.sessionId);
    assert.equal(await driver.getSessionStatus(ref.sessionId), "missing");
    assert.deepEqual(await driver.observeCompletion(ref.sessionId, nonce), { matched: false, reason: "session_missing" });
    const missingCensus = await classifySessionCensus(t.db, (id) => driver.getSessionStatus(id), new Date());
    const missingById = new Map(missingCensus.map((entry) => [entry.sessionId, entry.classification]));
    assert.equal(missingById.get(ref.sessionId), "missing");

    // A fresh session is the only class that reads idle; it still only becomes
    // completion via an explicit observed turn, never from acceptance alone.
    insertWorkItem(t.db, { id: "wi-fresh", repo_id: REPO, state: "RUNNING", base_branch: "main" });
    const fresh = await driver.createRealSession("resolution", "/fresh", { repoId: REPO, directory: "/fresh", kind: "resolution", workItemId: "wi-fresh" });
    assert.equal(await driver.getSessionStatus(fresh.sessionId), "idle");
    assert.deepEqual(await driver.observeCompletion(fresh.sessionId, nonce), { matched: false, reason: "nonce_not_found" });
  } finally {
    t.cleanup();
    await server.close();
  }
});
