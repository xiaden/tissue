// tests/integration/p3-reconcile.test.ts
//
// Phase 3 (Tissue C) integration coverage: drift adoption, terminal-leftover
// cleanup, terminal-unattached housekeeping, and the ordered P0-P6 reconcile
// pass with its five fault-injection boundaries. All external reality is
// injected (scanner / removeWorktree / reconcile deps); no real remote, gh, or
// OpenCode state is ever touched.
//
// TASK-tissue-G Phase 1 spec-first coverage (authoritative P2 session-loss
// recovery per classification and the P6 resident-dependency gate):
//   - a `resolution` census entry classified `missing`/`wedged` holds its
//     RUNNING/WAITING WorkItem to FAILED_HOLD (event `wedge`, lease cleared,
//     session row preserved) and `incomplete` retains the session mapping;
//   - a `triage` entry classified `missing`/`wedged` releases the repository's
//     `triage_session_id` without mutating the triage pump;
//   - a failed P2 census (resident OpenCode unavailable) still runs the
//     OpenCode-independent P3/P4/P5 phases while P6 prompt-dependent resume is
//     gated (`detail.gated === true`, `reconcile.p6_gated`), leaving the pump
//     state untouched.

import test from "node:test";
import assert from "node:assert/strict";

import { createTestDb, seedRepository, seedIssue, REPO_ID } from "../helpers/db.ts";
import type { TissueDb } from "../../src/db/open.ts";
import {
  attachIssueToWorkItem,
  getRepositoryById,
  getWorkItem,
  housekeepingCounters,
  insertInboxEvent,
  insertPullRequest,
  insertSession,
  insertWorkItem,
  insertWorktree,
  listPullRequestsByWorkItem,
  listTransitions,
  listWorktreesByWorkItem,
  reparentInboxByIssue,
  updateTriageState,
  type InboxRow,
} from "../../src/db/repositories.ts";
import { scanAndAdoptDrift, type DriftScanner, type ObservedArtifacts } from "../../src/controller/drift.ts";
import { cleanupTerminalLeftovers } from "../../src/controller/terminal-cleanup.ts";
import { runTerminalUnattachedHousekeeping } from "../../src/controller/housekeeping.ts";
import {
  classifySessionCensus,
  recoverStalePrompting,
  runReconcilePass,
  type ReconcileBoundary,
  type ReconcileDeps,
  type SessionCensusEntry,
} from "../../src/controller/reconcile.ts";
import { enqueueIssue } from "../../src/controller/enqueue.ts";
import { worktreeBranchFor, type CleanupResult, type WorktreeIdentity } from "../../src/controller/worktrees.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import type { TissueConfig } from "../../src/config/types.ts";
import { ScriptedTriageDriver } from "../helpers/session-driver.ts";
import type { SessionDriver } from "../../src/controller/session-driver.ts";
import { GhClient } from "../../src/integrations/gh-client.ts";

function fakeScanner(observed: ObservedArtifacts): DriftScanner {
  return { scan: async () => observed };
}

function cleanupResult(identity: WorktreeIdentity, mode: "merged" | "explicit-failed-hold"): CleanupResult {
  return {
    workItemId: identity.workItemId,
    mainDir: identity.mainDir,
    worktreeDir: identity.worktreeDir,
    branch: identity.branch,
    mode,
    worktreeRemoved: true,
    worktreeForced: false,
    branchDeleted: true,
  };
}

// ---------------------------------------------------------------------------
// P3-S1  drift scan + whole-diff adoption
// ---------------------------------------------------------------------------

test("drift: adopts the entire unexpected diff including two rogue PRs in one failure transition", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-1";
    const branch = worktreeBranchFor(wi);
    const path = `/workspace/nomarr-worktrees/${wi}`;
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });
    insertPullRequest(db, {
      id: "pr-101",
      work_item_id: wi,
      repo_id: REPO_ID,
      number: 101,
      head_ref: branch,
      state: "ACTIVE",
    });
    insertWorktree(db, { id: "wt-1", work_item_id: wi, path, branch, state: "ACTIVE" });

    const scanner = fakeScanner({
      branches: [branch],
      worktrees: [{ path, branch }],
      prs: [
        { number: 101, headRef: branch, state: "OPEN" },
        { number: 102, headRef: branch, state: "OPEN" },
        { number: 103, headRef: branch, state: "OPEN" },
      ],
    });

    const res = await scanAndAdoptDrift(db, wi, scanner);
    assert.equal(res.transitionedToFailedHold, true);
    assert.equal(res.alreadyFailedHold, false);
    // one adopted branch + two rogue PRs
    assert.equal(res.unexpected.length, 3);
    assert.equal(getWorkItem(db, wi)?.state, "FAILED_HOLD");
    assert.equal(getWorkItem(db, wi)?.head_branch, branch);

    const prs = listPullRequestsByWorkItem(db, wi);
    assert.equal(prs.length, 3);
    const rogue = prs.filter((p) => p.origin === "rogue");
    assert.deepEqual(
      rogue.map((p) => p.number).sort((a, b) => a - b),
      [102, 103],
    );
    assert.ok(rogue.every((p) => p.state === "ROGUE"));
    // the one ACTIVE PR invariant is preserved (rogues are evidence, not ACTIVE)
    assert.equal(prs.filter((p) => p.state === "ACTIVE").length, 1);

    // Idempotent: every artifact is now canonical, so a repeat adopts nothing.
    const again = await scanAndAdoptDrift(db, wi, scanner);
    assert.equal(again.unexpected.length, 0);
    assert.equal(again.alreadyFailedHold, true);
    assert.equal(getWorkItem(db, wi)?.state, "FAILED_HOLD");
  } finally {
    cleanup();
  }
});

test("drift: already-FAILED_HOLD owner absorbs and logs unexpected artifacts without re-entering", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-2";
    const branch = worktreeBranchFor(wi);
    insertWorkItem(db, {
      id: wi,
      repo_id: REPO_ID,
      state: "FAILED_HOLD",
      base_branch: "main",
      head_branch: branch,
    });
    insertPullRequest(db, {
      id: "pr-201",
      work_item_id: wi,
      repo_id: REPO_ID,
      number: 201,
      head_ref: branch,
      state: "ACTIVE",
    });

    const res = await scanAndAdoptDrift(
      db,
      wi,
      fakeScanner({
        branches: [branch],
        worktrees: [],
        prs: [
          { number: 201, headRef: branch, state: "OPEN" },
          { number: 202, headRef: branch, state: "OPEN" },
          { number: 203, headRef: branch, state: "OPEN" },
        ],
      }),
    );

    assert.equal(res.alreadyFailedHold, true);
    assert.equal(res.transitionedToFailedHold, false);
    assert.equal(res.adopted.length, 0);
    assert.equal(res.absorbed.length, 2);
    assert.equal(getWorkItem(db, wi)?.state, "FAILED_HOLD");
    const transitions = listTransitions(db, "work_item", wi);
    assert.equal(transitions.filter((t) => t.event === "drift_absorbed").length, 1);
    // No re-entry: the only FAILED_HOLD row is the self-loop absorb evidence,
    // never a transition INTO FAILED_HOLD from another state.
    assert.equal(
      transitions.filter((t) => t.to_state === "FAILED_HOLD" && t.from_state !== "FAILED_HOLD").length,
      0,
    );
  } finally {
    cleanup();
  }
});

test("drift: terminal history (COMPLETED) is never relabelled as FAILED_HOLD", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-3";
    const branch = worktreeBranchFor(wi);
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "COMPLETED", base_branch: "main", head_branch: branch });
    const res = await scanAndAdoptDrift(
      db,
      wi,
      fakeScanner({
        branches: [branch],
        worktrees: [{ path: "/rogue", branch }],
        prs: [{ number: 301, headRef: branch, state: "OPEN" }],
      }),
    );
    assert.equal(res.scanned, false);
    assert.equal(res.unexpected.length, 0);
    assert.equal(getWorkItem(db, wi)?.state, "COMPLETED");
    assert.equal(listTransitions(db, "work_item", wi).length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// P3-S2  terminal leftover cleanup
// ---------------------------------------------------------------------------

test("terminal cleanup: removes leftover worktree/branch without relabelling and retains history", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-10";
    const branch = worktreeBranchFor(wi);
    const path = `/workspace/nomarr-worktrees/${wi}`;
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "COMPLETED", base_branch: "main", head_branch: branch });
    insertWorktree(db, { id: "wt-10", work_item_id: wi, path, branch, state: "ACTIVE" });
    insertPullRequest(db, {
      id: "pr-10",
      work_item_id: wi,
      repo_id: REPO_ID,
      number: 10,
      head_ref: branch,
      state: "ACTIVE",
    });
    const issue = seedIssue(db, REPO_ID, { number: 10, state: "MERGED" });
    attachIssueToWorkItem(db, issue.id, wi);
    insertSession(db, {
      id: "ses_retained",
      kind: "resolution",
      repo_id: REPO_ID,
      work_item_id: wi,
      directory: path,
      state: "RETAINED",
    });

    const res = await cleanupTerminalLeftovers(db, {
      now: new Date(),
      removeWorktree: async (identity, mode) => cleanupResult(identity, mode),
    });

    assert.equal(res.cleanedWorktrees.length, 1);
    assert.equal(res.removedBranches.length, 1);
    assert.equal(listWorktreesByWorkItem(db, wi)[0]?.state, "CLEANED");
    // NEVER relabel completed history.
    assert.equal(getWorkItem(db, wi)?.state, "COMPLETED");
    assert.equal(listTransitions(db, "work_item", wi).filter((t) => t.to_state === "FAILED_HOLD").length, 0);
    // Retained: PR, issue link, session mapping.
    assert.equal(listPullRequestsByWorkItem(db, wi).length, 1);
    assert.ok(res.humanInspect.some((h) => h.kind === "pull_request"));
    assert.equal(
      db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM opencode_sessions WHERE id = 'ses_retained'")?.c,
      1,
    );
    assert.equal(
      db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM issue_work_items WHERE work_item_id = ?", wi)?.c,
      1,
    );
  } finally {
    cleanup();
  }
});

test("terminal cleanup: failed retry emits human-inspect and leaves terminal history untouched", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-11";
    const branch = worktreeBranchFor(wi);
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "FAILED", base_branch: "main", head_branch: branch });
    insertWorktree(db, { id: "wt-11", work_item_id: wi, path: `/w/${wi}`, branch, state: "ACTIVE" });

    const res = await cleanupTerminalLeftovers(db, {
      now: new Date(),
      removeWorktree: async () => {
        throw new Error("worktree locked");
      },
    });

    assert.equal(res.errors.length, 1);
    assert.ok(res.humanInspect.some((h) => h.kind === "worktree"));
    assert.equal(listWorktreesByWorkItem(db, wi)[0]?.state, "CLEANING");
    assert.equal(getWorkItem(db, wi)?.state, "FAILED");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// P3-S3  terminal-unattached housekeeping
// ---------------------------------------------------------------------------

test("housekeeping: terminal-marks NULL-WorkItem inbox rows, exposes counters, repeat is a no-op", () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const issue = seedIssue(db, REPO_ID, { number: 55, state: "REJECTED" });
    insertInboxEvent(db, {
      issue_id: issue.id,
      event_key: "e-rejected",
      kind: "issue_comment",
      payload_json: "{}",
      work_item_id: null,
    });

    const first = runTerminalUnattachedHousekeeping(db, new Date("2026-09-10T00:00:00.000Z"));
    assert.equal(first.terminalMarked, 1);
    assert.equal(first.counters.terminalMarked, 1);
    assert.ok(first.lastAction !== null);
    assert.equal(first.lastAction?.action, "terminal_marked");

    const row = db.sql.get<InboxRow>("SELECT * FROM inbox WHERE event_key = 'e-rejected'");
    assert.equal(row?.state, "TERMINAL");
    assert.equal(row?.terminal_action, "terminal_marked");
    assert.ok(row?.retention_deadline);

    const second = runTerminalUnattachedHousekeeping(db, new Date("2026-09-11T00:00:00.000Z"));
    assert.equal(second.terminalMarked, 0);
    assert.equal(second.counters.terminalMarked, 1);
    assert.equal(housekeepingCounters(db).terminalMarked, 1);

    // L1 guard: a terminal-marked row is never re-parented.
    assert.equal(reparentInboxByIssue(db, issue.id, "wi-late"), 0);
    assert.equal(
      db.sql.get<InboxRow>("SELECT * FROM inbox WHERE event_key = 'e-rejected'")?.work_item_id,
      null,
    );
  } finally {
    cleanup();
  }
});

test("housekeeping: an explicit enqueue does not resurrect a housekept BASELINE_EXCLUDED row", () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const issue = seedIssue(db, REPO_ID, { number: 56, state: "BASELINE_EXCLUDED" });
    insertInboxEvent(db, {
      issue_id: issue.id,
      event_key: "e-baseline",
      kind: "issue_discovered",
      payload_json: "{}",
      work_item_id: null,
    });
    runTerminalUnattachedHousekeeping(db, new Date("2026-09-10T00:00:00.000Z"));

    const admitted = enqueueIssue(db, { id: REPO_ID }, 56);
    assert.equal(admitted.applied, true);
    assert.equal(admitted.outcome, "admitted");

    // The issue is admitted (R14 intact) but the housekept event stays terminal.
    assert.equal(reparentInboxByIssue(db, issue.id, "wi-enqueued"), 0);
    const row = db.sql.get<InboxRow>("SELECT * FROM inbox WHERE event_key = 'e-baseline'");
    assert.equal(row?.state, "TERMINAL");
    assert.equal(row?.terminal_action, "terminal_marked");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// P3-S4  ordered P0-P6 reconcile + fault injection
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG: TissueConfig = {
  pollIntervalSeconds: 300,
  maxConcurrentGlobal: 3,
  retentionDays: 30,
  agents: {},
  repos: [],
};

function stubDeps(db: TissueDb, onFault: (b: ReconcileBoundary) => void): ReconcileDeps {
  const housekeeping = {
    checked: 0,
    terminalMarked: 0,
    pruned: 0,
    issueIds: [] as string[],
    at: new Date().toISOString(),
    counters: { terminalMarked: 0, pruned: 0, lastAt: null as string | null },
    lastAction: null,
  };
  return {
    now: () => new Date(),
    openDb: () => db,
    closeDb: () => {},
    verifyRepos: async () => [],
    censusSessions: async () => [],
    reconcileArtifacts: async () => ({ expiredLeases: 0, effects: 0, cleaned: [], retained: [] }),
    scanDrift: async () => [],
    housekeep: async () => housekeeping,
    resumeNormalLoop: async () => ({ recovered: [], claimed: null }),
    injectFault: (boundary) => onFault(boundary),
  };
}

/**
 * Census-providing reconcile deps for the authoritative P2 session-loss specs.
 * Reuses every inert dependency from `stubDeps` and only substitutes the census,
 * so no gh/OpenCode call is made outside the supplied classifications.
 */
function censusDeps(
  db: TissueDb,
  census: SessionCensusEntry[],
  overrides: Partial<ReconcileDeps> = {},
): ReconcileDeps {
  return { ...stubDeps(db, () => {}), censusSessions: async () => census, ...overrides };
}

test("reconcile: runs the ordered idempotent P0-P6 sweep and hits all five fault boundaries", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const faults: ReconcileBoundary[] = [];
    const sink = new CapturingSink();
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(sink.writeable(), "info"),
      db,
      deps: stubDeps(db, (b) => faults.push(b)),
    });

    assert.deepEqual(
      report.phases.map((p) => p.phase),
      ["P0", "P1", "P2", "P3", "P4", "P5", "P6"],
    );
    assert.ok(report.phases.every((p) => p.ok));
    assert.deepEqual(faults, ["cleanup", "drift_fail", "ingest", "reparent", "prompt_before_completion"]);
  } finally {
    cleanup();
  }
});

test("reconcile: a fault at one boundary fails that phase only and later phases still run", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(new CapturingSink().writeable(), "info"),
      db,
      deps: stubDeps(db, (b) => {
        if (b === "drift_fail") throw new Error("injected drift failure");
      }),
    });

    const p4 = report.phases.find((p) => p.phase === "P4");
    assert.equal(p4?.ok, false);
    assert.equal(p4?.error, "injected drift failure");
    assert.equal(report.phases.find((p) => p.phase === "P5")?.ok, true);
    assert.equal(report.phases.find((p) => p.phase === "P6")?.ok, true);
  } finally {
    cleanup();
  }
});

test("reconcile: stale-PROMPTING crash is recovered to BACKOFF with an audit transition", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    updateTriageState(db, REPO_ID, { state: "PROMPTING" });
    const recovered = await recoverStalePrompting(db, undefined, new ScriptedTriageDriver());
    assert.equal(recovered.length, 1);
    assert.equal(getRepositoryById(db, REPO_ID)?.triage_state, "BACKOFF");
    assert.ok(listTransitions(db, "triage", REPO_ID).some((t) => t.event === "triage_backoff"));
  } finally {
    cleanup();
  }
});

test("reconcile: session census classifies idle/wedged/missing/incomplete", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    insertWorkItem(db, { id: "wi-run", repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });
    insertWorkItem(db, { id: "wi-done", repo_id: REPO_ID, state: "COMPLETED", base_branch: "main" });
    insertSession(db, { id: "ses_idle", kind: "triage", repo_id: REPO_ID, directory: "/r", state: "ACTIVE" });
    insertSession(db, {
      id: "ses_wedge",
      kind: "resolution",
      repo_id: REPO_ID,
      work_item_id: "wi-run",
      directory: "/w",
      state: "ACTIVE",
    });
    insertSession(db, { id: "ses_missing", kind: "triage", repo_id: REPO_ID, directory: "/m", state: "ACTIVE" });
    insertSession(db, {
      id: "ses_incomplete",
      kind: "resolution",
      repo_id: REPO_ID,
      work_item_id: "wi-done",
      directory: "/d",
      state: "ACTIVE",
    });
    // Age the wedged session beyond W_WEDGE (240s).
    db.sql.run("UPDATE opencode_sessions SET updated_at = ? WHERE id = 'ses_wedge'", "2020-01-01T00:00:00.000Z");

    const statuses: Record<string, "idle" | "busy" | "retry" | "missing"> = {
      ses_idle: "idle",
      ses_wedge: "retry",
      ses_missing: "missing",
      ses_incomplete: "idle",
    };
    const census = await classifySessionCensus(db, async (id) => statuses[id] ?? "missing", new Date());
    const byId = new Map(census.map((c) => [c.sessionId, c.classification]));
    assert.equal(byId.get("ses_idle"), "idle");
    assert.equal(byId.get("ses_wedge"), "wedged");
    assert.equal(byId.get("ses_missing"), "missing");
    // resolution session mapped to a terminal WorkItem is "incomplete"
    assert.equal(byId.get("ses_incomplete"), "incomplete");
  } finally {
    cleanup();
  }
});

test("reconcile: session census keeps a fresh busy/retry session in its raw status, not wedged", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    // Non-terminal owners so the resolution incomplete-mapping never overrides.
    insertWorkItem(db, { id: "wi-busy", repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });
    insertWorkItem(db, { id: "wi-retry", repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });
    insertSession(db, {
      id: "ses_busy",
      kind: "resolution",
      repo_id: REPO_ID,
      work_item_id: "wi-busy",
      directory: "/busy",
      state: "ACTIVE",
    });
    insertSession(db, {
      id: "ses_retry",
      kind: "resolution",
      repo_id: REPO_ID,
      work_item_id: "wi-retry",
      directory: "/retry",
      state: "ACTIVE",
    });
    // Both rows were last updated 10s before `now` — well within W_WEDGE (240s).
    db.sql.run(
      "UPDATE opencode_sessions SET updated_at = ? WHERE id IN ('ses_busy', 'ses_retry')",
      "2026-09-10T00:00:00.000Z",
    );

    const statuses: Record<string, "busy" | "retry"> = { ses_busy: "busy", ses_retry: "retry" };
    const census = await classifySessionCensus(db, async (id) => statuses[id] ?? "missing", new Date("2026-09-10T00:00:10.000Z"));
    const byId = new Map(census.map((c) => [c.sessionId, c.classification]));
    assert.equal(byId.get("ses_busy"), "busy");
    assert.equal(byId.get("ses_retry"), "retry");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// TASK-tissue-G P1-S2..S6  authoritative P2 session-loss recovery + P6 gate
// ---------------------------------------------------------------------------

test("reconcile: a missing resolution session moves its RUNNING WorkItem to FAILED_HOLD (lease cleared, session preserved)", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-missing";
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });
    insertSession(db, {
      id: "ses_missing_res",
      kind: "resolution",
      repo_id: REPO_ID,
      work_item_id: wi,
      directory: "/w",
      state: "ACTIVE",
    });
    db.sql.run(
      "UPDATE work_items SET lease_token = 'lease-x', lease_until = ? WHERE id = ?",
      "2030-01-01T00:00:00.000Z",
      wi,
    );

    const census: SessionCensusEntry[] = [
      { sessionId: "ses_missing_res", kind: "resolution", repoId: REPO_ID, workItemId: wi, classification: "missing" },
    ];
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(new CapturingSink().writeable(), "info"),
      db,
      deps: censusDeps(db, census),
    });

    assert.equal(report.phases.find((p) => p.phase === "P2")?.ok, true);
    const held = getWorkItem(db, wi);
    assert.equal(held?.state, "FAILED_HOLD");
    assert.equal(held?.lease_token, null, "the hold clears the lease");
    assert.equal(held?.lease_until, null);

    const wedge = listTransitions(db, "work_item", wi).find((t) => t.to_state === "FAILED_HOLD");
    assert.ok(wedge, "a durable work_item transition into FAILED_HOLD is written");
    assert.equal(wedge?.from_state, "RUNNING");
    assert.equal(wedge?.event, "wedge");
    const reason = JSON.parse(wedge?.reason_json ?? "{}") as { reason?: string; session_id?: string };
    assert.equal(reason.reason, "session_missing");
    assert.equal(reason.session_id, "ses_missing_res");

    // The durable session row is preserved exactly; no replacement session is invented.
    assert.equal(db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM opencode_sessions")?.c, 1);
    assert.equal(
      db.sql.get<{ state: string }>("SELECT state FROM opencode_sessions WHERE id = 'ses_missing_res'")?.state,
      "ACTIVE",
    );
  } finally {
    cleanup();
  }
});

test("reconcile: a wedged resolution session holds its WAITING WorkItem with reason session_wedged", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-wedged";
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "WAITING", base_branch: "main" });
    insertSession(db, {
      id: "ses_wedged_res",
      kind: "resolution",
      repo_id: REPO_ID,
      work_item_id: wi,
      directory: "/w",
      state: "ACTIVE",
    });
    // Age the session beyond W_WEDGE (240s) so the real census classifies it wedged.
    db.sql.run("UPDATE opencode_sessions SET updated_at = ? WHERE id = 'ses_wedged_res'", "2020-01-01T00:00:00.000Z");

    const census = await classifySessionCensus(db, async () => "retry", new Date());
    assert.equal(census.find((c) => c.sessionId === "ses_wedged_res")?.classification, "wedged");

    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(new CapturingSink().writeable(), "info"),
      db,
      deps: censusDeps(db, census),
    });
    assert.equal(report.phases.find((p) => p.phase === "P2")?.ok, true);
    assert.equal(getWorkItem(db, wi)?.state, "FAILED_HOLD");
    const wedge = listTransitions(db, "work_item", wi).find((t) => t.to_state === "FAILED_HOLD");
    assert.equal(wedge?.from_state, "WAITING");
    assert.equal(wedge?.event, "wedge");
    assert.equal((JSON.parse(wedge?.reason_json ?? "{}") as { reason?: string }).reason, "session_wedged");
  } finally {
    cleanup();
  }
});

test("reconcile: an incomplete resolution session retains its mapping and leaves the terminal WorkItem unchanged", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-done";
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "COMPLETED", base_branch: "main" });
    insertSession(db, {
      id: "ses_incomplete_res",
      kind: "resolution",
      repo_id: REPO_ID,
      work_item_id: wi,
      directory: "/d",
      state: "ACTIVE",
    });

    const census = await classifySessionCensus(db, async () => "idle", new Date());
    assert.equal(census.find((c) => c.sessionId === "ses_incomplete_res")?.classification, "incomplete");

    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(new CapturingSink().writeable(), "info"),
      db,
      deps: censusDeps(db, census),
    });
    assert.equal(report.phases.find((p) => p.phase === "P2")?.ok, true);

    // The terminal WorkItem is never relabelled.
    assert.equal(getWorkItem(db, wi)?.state, "COMPLETED");
    // The session mapping is retained as history (R20), never replaced.
    assert.equal(
      db.sql.get<{ state: string }>("SELECT state FROM opencode_sessions WHERE id = 'ses_incomplete_res'")?.state,
      "RETAINED",
    );
    const retained = listTransitions(db, "session", "ses_incomplete_res");
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.from_state, "ACTIVE");
    assert.equal(retained[0]?.to_state, "RETAINED");
    assert.equal(retained[0]?.event, "session_retained");
    assert.equal(
      db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM opencode_sessions WHERE id = 'ses_incomplete_res'")?.c,
      1,
    );
  } finally {
    cleanup();
  }
});

test("reconcile: missing and wedged triage sessions release the repository mapping without touching the pump", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    seedRepository(db, { owner: "xiaden", name: "reb", id: "repo-reb" });
    insertSession(db, { id: "ses_triage_missing", kind: "triage", repo_id: REPO_ID, directory: "/m", state: "ACTIVE" });
    insertSession(db, { id: "ses_triage_wedged", kind: "triage", repo_id: "repo-reb", directory: "/w", state: "ACTIVE" });
    db.sql.run("UPDATE opencode_sessions SET updated_at = ? WHERE id = 'ses_triage_wedged'", "2020-01-01T00:00:00.000Z");
    updateTriageState(db, REPO_ID, { state: "PROMPTING", sessionId: "ses_triage_missing" });
    updateTriageState(db, "repo-reb", { state: "PROMPTING", sessionId: "ses_triage_wedged" });

    const census: SessionCensusEntry[] = [
      { sessionId: "ses_triage_missing", kind: "triage", repoId: REPO_ID, workItemId: null, classification: "missing" },
      { sessionId: "ses_triage_wedged", kind: "triage", repoId: "repo-reb", workItemId: null, classification: "wedged" },
    ];
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(new CapturingSink().writeable(), "info"),
      db,
      deps: censusDeps(db, census),
    });
    assert.equal(report.phases.find((p) => p.phase === "P2")?.ok, true);

    for (const repoId of [REPO_ID, "repo-reb"]) {
      assert.equal(getRepositoryById(db, repoId)?.triage_session_id, null, `${repoId} mapping released`);
      assert.equal(getRepositoryById(db, repoId)?.triage_state, "PROMPTING", `${repoId} pump state untouched`);
      const transitions = listTransitions(db, "triage", repoId);
      const released = transitions.find((t) => t.event === "triage_session_released");
      assert.ok(released, `${repoId} records a triage_session_released evidence row`);
      assert.equal(released?.from_state, "PROMPTING");
      assert.equal(released?.to_state, "PROMPTING");
      assert.ok(transitions.every((t) => t.event !== "triage_backoff"));
    }
    // Session rows are preserved, never deleted.
    assert.equal(db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM opencode_sessions")?.c, 2);
  } finally {
    cleanup();
  }
});

test("reconcile: resident OpenCode unavailability fails P2, still runs P3-P5, and gates P6 prompt-dependent resume", async () => {
  const { db, cleanup } = createTestDb();
  try {
    // Manual (config_managed = 0) enabled repo: config.repos = [] must not disable it.
    seedRepository(db, { id: REPO_ID });
    updateTriageState(db, REPO_ID, { state: "PROMPTING" });
    // A durable session row exists so the census actually probes the resident dependency.
    insertSession(db, {
      id: "ses_triage_probe",
      kind: "triage",
      repo_id: REPO_ID,
      directory: "/repo",
      state: "ACTIVE",
    });

    let ensureCalls = 0;
    let promptCalls = 0;
    const driver: SessionDriver = {
      ensureSession: async () => {
        ensureCalls += 1;
        return { sessionId: "ses_never_created", directory: "/repo" };
      },
      getSessionStatus: async () => {
        throw new Error("resident OpenCode unavailable (transport failure)");
      },
      promptTriage: async () => {
        promptCalls += 1;
        return { issueId: "issue-never", disposition: "READY" };
      },
    };

    const sink = new CapturingSink();
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(sink.writeable(), "info"),
      db,
      driver,
      gh: new GhClient({ binary: "/usr/bin/gh" }),
    });

    assert.equal(report.phases.find((p) => p.phase === "P2")?.ok, false, "the census cannot be taken");
    assert.equal(report.phases.find((p) => p.phase === "P3")?.ok, true, "safe non-OpenCode reconciliation still runs");
    assert.equal(report.phases.find((p) => p.phase === "P4")?.ok, true);
    assert.equal(report.phases.find((p) => p.phase === "P5")?.ok, true);

    const p6 = report.phases.find((p) => p.phase === "P6");
    assert.equal(p6?.ok, true, "a deliberate gate is not a phase failure");
    const detail = p6?.detail as { recovered: string[]; claimed: string | null; gated?: boolean };
    assert.equal(detail.gated, true);
    assert.deepEqual(detail.recovered, []);
    assert.equal(detail.claimed, null);

    assert.equal(getRepositoryById(db, REPO_ID)?.triage_state, "PROMPTING");
    assert.ok(listTransitions(db, "triage", REPO_ID).every((t) => t.event !== "triage_backoff"));
    assert.equal(ensureCalls, 0, "no prompt-dependent session ensure while the dependency is unobservable");
    assert.equal(promptCalls, 0, "no prompt-dependent triage while the dependency is unobservable");
    assert.ok(
      sink.records().some((r) => r.event === "reconcile.p6_gated" && r.lvl === "warn"),
      "the gate is recorded as a warn",
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// TASK-tissue-G P3-S6  resident dependency-health seam crossing
// ---------------------------------------------------------------------------

test("reconcile: derives resident dependency health from the P2 census and passes it to P6 on both branches", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const healthSeen: Array<{ openCodeAvailable: boolean }> = [];

    // P2 census throws (resident dependency unobservable) -> P6 receives false.
    const failing = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(new CapturingSink().writeable(), "info"),
      db,
      deps: censusDeps(db, [], {
        censusSessions: async () => {
          throw new Error("resident OpenCode unavailable (transport failure)");
        },
        resumeNormalLoop: async (_db, health) => {
          healthSeen.push(health);
          return { recovered: [], claimed: null };
        },
      }),
    });
    assert.equal(failing.phases.find((p) => p.phase === "P2")?.ok, false);
    assert.deepEqual(healthSeen, [{ openCodeAvailable: false }]);

    // A resolved census — even one full of per-session missing/wedged entries —
    // proves the service answered, so P6 receives true.
    seedRepository(db, { id: REPO_ID });
    const census: SessionCensusEntry[] = [
      { sessionId: "ses_probe", kind: "triage", repoId: REPO_ID, workItemId: null, classification: "missing" },
    ];
    const resolved = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(new CapturingSink().writeable(), "info"),
      db,
      deps: censusDeps(db, census, {
        resumeNormalLoop: async (_db, health) => {
          healthSeen.push(health);
          return { recovered: [], claimed: null };
        },
      }),
    });
    assert.equal(resolved.phases.find((p) => p.phase === "P2")?.ok, true);
    assert.deepEqual(healthSeen, [
      { openCodeAvailable: false },
      { openCodeAvailable: true },
    ]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// TASK-tissue-G QA round 1  untested session-census recovery branches
// ---------------------------------------------------------------------------

test("reconcile: an already-FAILED_HOLD owner absorbs a lost resolution session without re-entering", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-held";
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "FAILED_HOLD", base_branch: "main" });
    insertSession(db, {
      id: "ses_held_res",
      kind: "resolution",
      repo_id: REPO_ID,
      work_item_id: wi,
      directory: "/h",
      state: "ACTIVE",
    });

    const census: SessionCensusEntry[] = [
      { sessionId: "ses_held_res", kind: "resolution", repoId: REPO_ID, workItemId: wi, classification: "missing" },
    ];
    const sink = new CapturingSink();
    const first = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(sink.writeable(), "info"),
      db,
      deps: censusDeps(db, census),
    });
    assert.equal(first.phases.find((p) => p.phase === "P2")?.ok, true);

    // The held WorkItem stays held and is never re-entered via a wedge edge.
    assert.equal(getWorkItem(db, wi)?.state, "FAILED_HOLD");
    let transitions = listTransitions(db, "work_item", wi);
    assert.equal(transitions.filter((t) => t.event === "wedge").length, 0, "no re-entry wedge");
    assert.equal(transitions.filter((t) => t.to_state === "FAILED_HOLD").length, 1);
    const absorbed = transitions.filter((t) => t.event === "session_loss_absorbed");
    assert.equal(absorbed.length, 1);
    assert.equal(absorbed[0]?.from_state, "FAILED_HOLD");
    assert.equal(absorbed[0]?.to_state, "FAILED_HOLD");

    // A second pass over the same census changes no entity state; the
    // per-pass absorb evidence accumulates (documented evidence-only idempotency).
    const second = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(sink.writeable(), "info"),
      db,
      deps: censusDeps(db, census),
    });
    assert.equal(second.phases.find((p) => p.phase === "P2")?.ok, true);
    assert.equal(getWorkItem(db, wi)?.state, "FAILED_HOLD");
    transitions = listTransitions(db, "work_item", wi);
    assert.equal(transitions.filter((t) => t.event === "wedge").length, 0);
    assert.equal(transitions.filter((t) => t.event === "session_loss_absorbed").length, 2);

    // Supplementary: the recovery warn names the absorb action and no human gate.
    const warn = sink
      .records()
      .find((r) => r.event === "reconcile.session_recovered" && r.action === "work_item_failed_hold_absorbed");
    assert.ok(warn);
    assert.equal(warn?.human_inspect, false);
  } finally {
    cleanup();
  }
});

test("reconcile: a lost resolution session for a non-holdable owner records evidence only and flags human inspect", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-paused";
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "PAUSED_WORK", base_branch: "main" });
    insertSession(db, {
      id: "ses_paused_res",
      kind: "resolution",
      repo_id: REPO_ID,
      work_item_id: wi,
      directory: "/p",
      state: "ACTIVE",
    });

    const census: SessionCensusEntry[] = [
      { sessionId: "ses_paused_res", kind: "resolution", repoId: REPO_ID, workItemId: wi, classification: "wedged" },
    ];
    const sink = new CapturingSink();
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(sink.writeable(), "info"),
      db,
      deps: censusDeps(db, census),
    });
    assert.equal(report.phases.find((p) => p.phase === "P2")?.ok, true);

    // No state change and no hold: the owner is not in a holdable state.
    assert.equal(getWorkItem(db, wi)?.state, "PAUSED_WORK");
    const transitions = listTransitions(db, "work_item", wi);
    assert.equal(transitions.filter((t) => t.to_state === "FAILED_HOLD").length, 0);
    assert.equal(transitions.filter((t) => t.event === "wedge").length, 0);
    const observed = transitions.filter((t) => t.event === "session_loss_observed");
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.from_state, "PAUSED_WORK");
    assert.equal(observed[0]?.to_state, "PAUSED_WORK");

    const warn = sink.records().find((r) => r.event === "reconcile.session_recovered");
    assert.equal(warn?.action, "work_item_failed_hold_observed");
    assert.equal(warn?.human_inspect, true);
  } finally {
    cleanup();
  }
});

test("reconcile: a lost resolution session with no owner is anchored on the session with no state change", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    insertSession(db, {
      id: "ses_orphan_res",
      kind: "resolution",
      repo_id: REPO_ID,
      directory: "/o",
      state: "ACTIVE",
    });

    const census: SessionCensusEntry[] = [
      { sessionId: "ses_orphan_res", kind: "resolution", repoId: REPO_ID, workItemId: null, classification: "missing" },
    ];
    const sink = new CapturingSink();
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(sink.writeable(), "info"),
      db,
      deps: censusDeps(db, census),
    });
    assert.equal(report.phases.find((p) => p.phase === "P2")?.ok, true);

    // No WorkItem is invented for an unsolved owner mapping.
    assert.equal(db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM work_items")?.c, 0);
    // The evidence row is anchored on the session, self-looping at its state.
    const observed = listTransitions(db, "session", "ses_orphan_res").filter(
      (t) => t.event === "session_loss_observed",
    );
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.from_state, "ACTIVE");
    assert.equal(observed[0]?.to_state, "ACTIVE");

    const warn = sink.records().find((r) => r.event === "reconcile.session_recovered");
    assert.equal(warn?.action, "work_item_failed_hold_observed");
    assert.equal(warn?.human_inspect, true);
  } finally {
    cleanup();
  }
});

test("reconcile: a stale triage census entry never releases a newer live session mapping", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    // The repository's current live triage session.
    updateTriageState(db, REPO_ID, { state: "PROMPTING", sessionId: "ses_triage_live" });
    // A census entry for an older, different session id that is now gone.
    const census: SessionCensusEntry[] = [
      { sessionId: "ses_triage_stale", kind: "triage", repoId: REPO_ID, workItemId: null, classification: "missing" },
    ];
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: new JsonLogger(new CapturingSink().writeable(), "info"),
      db,
      deps: censusDeps(db, census),
    });
    const p2 = report.phases.find((p) => p.phase === "P2");
    assert.equal(p2?.ok, true);

    // The live mapping survives; the stale entry is a no-op.
    assert.equal(getRepositoryById(db, REPO_ID)?.triage_session_id, "ses_triage_live");
    assert.equal(getRepositoryById(db, REPO_ID)?.triage_state, "PROMPTING");
    assert.equal(
      listTransitions(db, "triage", REPO_ID).filter((t) => t.event === "triage_session_released").length,
      0,
    );
    const detail = p2?.detail as { recovery: Array<{ sessionId: string; action: string }> };
    assert.equal(detail.recovery.find((r) => r.sessionId === "ses_triage_stale")?.action, "no_action");
  } finally {
    cleanup();
  }
});
