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
import { applyEnvelope, EnvelopeValidationError, type AgentEnvelope } from "../../src/domain/envelopes.ts";
import type { TissueConfig } from "../../src/config/types.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "xiaden/nomarr";
const CONFIG: TissueConfig = { pollIntervalSeconds: 300, maxConcurrentGlobal: 3, retentionDays: 30, agents: {}, repos: [] };
// Plan J: the real driver writes ses_* markers; give it a writable temp registry.
const REGISTRY_DIR = mkdtempSync(join(tmpdir(), "tissue-r19-registry-"));

// Each test gets a clean marker namespace while preserving a writable registry root.
function resetRegistry(): void {
  for (const entry of readdirSync(REGISTRY_DIR)) rmSync(join(REGISTRY_DIR, entry), { force: true });
}

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
      verifyRepos: async () => [], probeResident: async () => {}, censusSessions: async () => [],
      reconcileArtifacts: async () => ({ expiredLeases: 0, effects: 0, cleaned: [], retained: [] }),
      scanDrift: async () => [], housekeep: async () => ({ checked: 0, terminalMarked: 0, pruned: 0, issueIds: [], at: new Date().toISOString(), counters: { terminalMarked: 0, pruned: 0, lastAt: null }, lastAction: null }),
      resumeNormalLoop: async () => ({ recovered: [], claimed: null }), injectFault: (boundary) => { faults.push(boundary); },
    };
    const report = await runReconcilePass({ config: CONFIG, logger: new JsonLogger(new CapturingSink().writeable()), db: t.db, deps });
    assert.deepEqual(faults, ["recovery", "cleanup", "drift_fail", "ingest", "reparent", "prompt_before_completion"]);
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
      setWorkItemState(tx, wi.id, "QUEUED");
      recordTransition(tx, { type: "work_item", id: wi.id }, "PAUSED_WORK", "QUEUED", "resume_work", null, "test");
      setWorkItemState(tx, wi.id, "RUNNING");
      recordTransition(tx, { type: "work_item", id: wi.id }, "QUEUED", "RUNNING", "claim", null, "test");
      setWorkItemState(tx, wi.id, "AWAITING_DECISION");
      recordTransition(tx, { type: "work_item", id: wi.id }, "RUNNING", "AWAITING_DECISION", "await_decision", null, "test");
      setWorkItemState(tx, wi.id, "RUNNING");
      recordTransition(tx, { type: "work_item", id: wi.id }, "AWAITING_DECISION", "RUNNING", "decision_received", null, "test");
    });
    assert.equal(getWorkItem(t.db, wi.id)?.state, "RUNNING");
    assert.equal(repoB.id, "xiaden/b");
    assert.equal(listTransitions(t.db, "work_item", wi.id).length, 5);
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
  resetRegistry();
  const driver = new OpenCodeDriver({ http, db: t.db, registryDir: REGISTRY_DIR });
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

test("R19 resolution envelopes keep awaiting decision distinct from dependency deferral and deduplicate durably", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const dependency = insertIssue(t.db, {
      id: "issue-r19-dependency",
      repo_id: repo.id,
      number: 1901,
      title: "dependency",
      state: "TRIAGE_PENDING",
      updated_at: "2026-09-10T00:00:00.000Z",
    });
    const awaiting = insertWorkItem(t.db, { id: "wi-r19-awaiting", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const deferred = insertWorkItem(t.db, { id: "wi-r19-deferred", repo_id: repo.id, state: "RUNNING", base_branch: "main" });

    const awaitingResult = runWrite(t.db, (tx) => applyEnvelope(tx, {
      kind: "resolution",
      envelope_id: "env-r19-awaiting",
      work_item_id: awaiting.id,
      outcome: "awaiting_decision",
      reason: "human decision required",
    }));
    assert.equal(awaitingResult.status, "applied");
    assert.equal(getWorkItem(t.db, awaiting.id)?.state, "AWAITING_DECISION");
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM work_item_dependencies WHERE dependent_work_item_id = ?", awaiting.id)?.c, 0);

    const deferredEnvelope: AgentEnvelope = {
      kind: "resolution",
      envelope_id: "env-r19-deferred",
      work_item_id: deferred.id,
      outcome: "deferred",
      dependency: { kind: "issue", id: dependency.id },
    };
    const deferredResult = runWrite(t.db, (tx) => applyEnvelope(tx, deferredEnvelope));
    assert.equal(deferredResult.status, "applied");
    assert.equal(getWorkItem(t.db, deferred.id)?.state, "DEFERRED");
    const relation = t.db.sql.get<{ dependency_issue_id: string | null; dependency_work_item_id: string | null }>(
      "SELECT dependency_issue_id, dependency_work_item_id FROM work_item_dependencies WHERE dependent_work_item_id = ?",
      deferred.id,
    );
    assert.equal(relation?.dependency_issue_id, dependency.id);
    assert.equal(relation?.dependency_work_item_id, null);

    const duplicate = runWrite(t.db, (tx) => applyEnvelope(tx, deferredEnvelope));
    assert.equal(duplicate.status, "noop_duplicate");
    assert.equal(getWorkItem(t.db, deferred.id)?.state, "DEFERRED");
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM work_item_dependencies WHERE dependent_work_item_id = ?", deferred.id)?.c, 1);
    assert.equal(listTransitions(t.db, "work_item", deferred.id).filter((row) => row.event === "defer").length, 1);
    assert.equal(listTransitions(t.db, "work_item", deferred.id).filter((row) => row.event === "noop_duplicate_envelope").length, 1);

    for (const table of ["opencode_sessions", "worktrees", "pull_requests", "side_effects"]) {
      assert.equal(t.db.sql.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c, 0, `${table} remains empty`);
    }
  } finally { t.cleanup(); }
});

test("R19 invalid resolution dependency contracts reject atomically without audit or relation effects", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const wiMissing = insertWorkItem(t.db, { id: "wi-r19-missing", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const wiExtra = insertWorkItem(t.db, { id: "wi-r19-extra", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const wiBlocked = insertWorkItem(t.db, { id: "wi-r19-blocked", repo_id: repo.id, state: "RUNNING", base_branch: "main" });

    assert.throws(() => runWrite(t.db, (tx) => applyEnvelope(tx, {
      kind: "resolution", envelope_id: "env-r19-missing", work_item_id: wiMissing.id, outcome: "deferred",
    })), EnvelopeValidationError);
    assert.throws(() => runWrite(t.db, (tx) => applyEnvelope(tx, {
      kind: "resolution", envelope_id: "env-r19-extra", work_item_id: wiExtra.id, outcome: "awaiting_decision",
      dependency: { kind: "issue", id: "issue-r19-unrelated" },
    })), EnvelopeValidationError);
    assert.throws(() => runWrite(t.db, (tx) => applyEnvelope(tx, {
      kind: "resolution", envelope_id: "env-r19-legacy-blocked", work_item_id: wiBlocked.id, outcome: "blocked" as never,
    })), EnvelopeValidationError);

    for (const wi of [wiMissing, wiExtra, wiBlocked]) {
      assert.equal(getWorkItem(t.db, wi.id)?.state, "RUNNING");
      assert.equal(listTransitions(t.db, "work_item", wi.id).length, 0);
      assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM work_item_dependencies WHERE dependent_work_item_id = ?", wi.id)?.c, 0);
    }
    for (const table of ["opencode_sessions", "worktrees", "pull_requests", "side_effects"]) {
      assert.equal(t.db.sql.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c, 0, `${table} remains empty`);
    }
  } finally { t.cleanup(); }
});

test("R19 deleted resolution session: census is missing, reconcile holds FAILED_HOLD, session preserved", async () => {
  // The census is computed with the REAL driver over the pessimistic server, then
  // fed through the real reconcile pass: a genuinely missing real session must be
  // interpreted into explicit durable recovery, never a fabricated completion or
  // a fabricated replacement session.
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const t = createTestDb();
  resetRegistry();
  const driver = new OpenCodeDriver({ http, db: t.db, registryDir: REGISTRY_DIR });
  try {
    const repo = seedRepository(t.db);
    const wi = insertWorkItem(t.db, { id: "wi-census-loss", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const ref = await driver.createRealSession("resolution", "/lost", {
      repoId: repo.id,
      directory: "/lost",
      kind: "resolution",
      workItemId: wi.id,
    });
    server.deleteSession(ref.sessionId);

    const census = await classifySessionCensus(t.db, (id) => driver.getSessionStatus(id), new Date());
    assert.equal(
      census.find((entry) => entry.sessionId === ref.sessionId)?.classification,
      "missing",
      "a deleted real session classifies missing, never a fabricated completion",
    );

    const deps: ReconcileDeps = {
      now: () => new Date(), openDb: () => t.db, closeDb: () => {},
      verifyRepos: async () => [], probeResident: async () => {}, censusSessions: async () => census,
      reconcileArtifacts: async () => ({ expiredLeases: 0, effects: 0, cleaned: [], retained: [] }),
      scanDrift: async () => [],
      housekeep: async () => ({ checked: 0, terminalMarked: 0, pruned: 0, issueIds: [], at: new Date().toISOString(), counters: { terminalMarked: 0, pruned: 0, lastAt: null }, lastAction: null }),
      resumeNormalLoop: async () => ({ recovered: [], claimed: null }),
    };
    const report = await runReconcilePass({ config: CONFIG, logger: new JsonLogger(new CapturingSink().writeable()), db: t.db, deps });
    assert.equal(report.phases.find((phase) => phase.phase === "P2")?.ok, true);

    assert.equal(
      getWorkItem(t.db, wi.id)?.state,
      "FAILED_HOLD",
      "the lost resolution session never leaves the WorkItem indefinitely dispatchable",
    );
    // The real session mapping is preserved; no fabricated replacement session.
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM opencode_sessions")?.c, 1);
    assert.equal(
      t.db.sql.get<{ state: string }>("SELECT state FROM opencode_sessions WHERE id = ?", ref.sessionId)?.state,
      "ACTIVE",
    );
  } finally {
    t.cleanup();
    await server.close();
  }
});
