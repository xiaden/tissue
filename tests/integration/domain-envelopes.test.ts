// tests/integration/domain-envelopes.test.ts
//
// P3-S3 spec-first tests for typed bounded agent envelopes: a valid envelope
// applies a single legal state disposition (with one audit row) and NEVER
// creates a session/worktree/PR identity or a lifecycle effect; a duplicate
// envelope records a durable `noop_duplicate_envelope` and creates no second
// effect; an envelope that would move an entity out of a legal edge is rejected
// without a state change or an audit row.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runWrite, type TissueDb } from "../../src/db/open.ts";
import {
  insertWorkItem,
  insertIssue,
  getIssueById,
  getWorkItem,
  updateIssueState,
  setWorkItemState,
  listTransitions,
  addWorkItemDependency,
} from "../../src/db/repositories.ts";
import {
  applyEnvelope,
  EnvelopeValidationError,
  type AgentEnvelope,
} from "../../src/domain/envelopes.ts";
import { recordTransition } from "../../src/domain/transitions.ts";
import { createTestDb, seedRepository } from "../helpers/db.ts";

function countRows(db: TissueDb, table: string): number {
  const row = db.sql.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number(row?.c ?? 0);
}

test("a valid triage envelope applies READY with one audited transition and no new identity", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = insertIssue(db, {
      id: "issue-r",
      repo_id: repo.id,
      number: 1,
      title: "fix x",
      state: "TRIAGE_PENDING",
      updated_at: "2026-09-09T00:00:00.000Z",
    });
    const env: AgentEnvelope = {
      kind: "triage",
      envelope_id: "env-ready-1",
      issue_id: issue.id,
      disposition: "READY",
      reason: "reproduced; clear root cause",
    };
    const res = runWrite(db, (tx) => applyEnvelope(tx, env));
    assert.equal(res.status, "applied");
    assert.equal(getIssueById(db, issue.id)?.state, "READY");

    const rows = listTransitions(db, "issue", issue.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.event, "triage_ready");
    assert.equal(rows[0]!.from_state, "TRIAGE_PENDING");
    assert.equal(rows[0]!.to_state, "READY");

    // Envelopes cannot create session/worktree/PR identities or effects.
    assert.equal(countRows(db, "opencode_sessions"), 0);
    assert.equal(countRows(db, "worktrees"), 0);
    assert.equal(countRows(db, "pull_requests"), 0);
  } finally {
    cleanup();
  }
});

test("a duplicate envelope records noop_duplicate_envelope and creates no second effect", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = insertIssue(db, {
      id: "issue-dup",
      repo_id: repo.id,
      number: 2,
      title: "dup",
      state: "TRIAGE_PENDING",
      updated_at: "2026-09-09T00:00:00.000Z",
    });
    const env: AgentEnvelope = { kind: "triage", envelope_id: "env-dup-1", issue_id: issue.id, disposition: "DUPLICATE" };
    const first = runWrite(db, (tx) => applyEnvelope(tx, env));
    assert.equal(first.status, "applied");
    assert.equal(getIssueById(db, issue.id)?.state, "DUPLICATE");

    const second = runWrite(db, (tx) => applyEnvelope(tx, env));
    assert.equal(second.status, "noop_duplicate");
    assert.equal(getIssueById(db, issue.id)?.state, "DUPLICATE", "state unchanged on duplicate");

    const rows = listTransitions(db, "issue", issue.id);
    assert.equal(rows.length, 2, "applied + one noop audit row, no second real transition");
    assert.equal(rows[1]!.event, "noop_duplicate_envelope");
    // Only one real disposition transition occurred.
    assert.equal(rows.filter((r) => r.event === "triage_duplicate").length, 1);
  } finally {
    cleanup();
  }
});

test("an envelope whose disposition is already reached is a no-op even under a fresh envelope id", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = insertIssue(db, {
      id: "issue-rd",
      repo_id: repo.id,
      number: 3,
      title: "ready",
      state: "READY", // already triaged to READY
      updated_at: "2026-09-09T00:00:00.000Z",
    });
    const res = runWrite(db, (tx) =>
      applyEnvelope(tx, { kind: "triage", envelope_id: "env-rd-2", issue_id: issue.id, disposition: "READY" }),
    );
    assert.equal(res.status, "noop_duplicate");
    assert.equal(getIssueById(db, issue.id)?.state, "READY");
    assert.equal(listTransitions(db, "issue", issue.id).length, 1);
    assert.equal(listTransitions(db, "issue", issue.id)![0]!.event, "noop_duplicate_envelope");
  } finally {
    cleanup();
  }
});

test("a duplicate envelope id is a no-op while dependency remains deferred", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    insertWorkItem(db, { id: "wi-dep", repo_id: repo.id, state: "DEFERRED", base_branch: "main" });
    const wi = insertWorkItem(db, { id: "wi-block", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const env: AgentEnvelope = {
      kind: "resolution",
      envelope_id: "env-block-1",
      work_item_id: wi.id,
      outcome: "deferred",
      dependency: { kind: "work_item", id: "wi-dep" },
    };
    assert.equal(runWrite(db, (tx) => applyEnvelope(tx, env)).status, "applied");
    assert.equal(getWorkItem(db, wi.id)?.state, "DEFERRED");

    // DEFERRED remains dependency-waiting until Plan E's verified completion path.
    // Re-applying the SAME envelope id is still a durable no-op.
    const again = runWrite(db, (tx) => applyEnvelope(tx, env));
    assert.equal(again.status, "noop_duplicate");
    assert.equal(getWorkItem(db, wi.id)?.state, "DEFERRED", "state unchanged");
    const noops = listTransitions(db, "work_item", wi.id).filter((r) => r.event === "noop_duplicate_envelope");
    assert.equal(noops.length, 1);
  } finally {
    cleanup();
  }
});

test("an out-of-edge envelope disposition is rejected with no state change and no audit row", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = insertIssue(db, {
      id: "issue-new",
      repo_id: repo.id,
      number: 4,
      title: "fresh",
      state: "NEW", // never triaged: cannot be dispositioned to READY directly
      updated_at: "2026-09-09T00:00:00.000Z",
    });
    assert.throws(
      () =>
        runWrite(db, (tx) =>
          applyEnvelope(tx, { kind: "triage", envelope_id: "env-illegal", issue_id: issue.id, disposition: "READY" }),
        ),
      EnvelopeValidationError,
    );
    assert.equal(getIssueById(db, issue.id)?.state, "NEW", "state unchanged on rejection");
    assert.equal(listTransitions(db, "issue", issue.id).length, 0, "no audit row on rejected envelope");
  } finally {
    cleanup();
  }
});

test("invalid envelope data is rejected (bad disposition, unsafe identifier, bad kind)", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = insertIssue(db, {
      id: "issue-v",
      repo_id: repo.id,
      number: 5,
      title: "v",
      state: "TRIAGE_PENDING",
      updated_at: "2026-09-09T00:00:00.000Z",
    });
    assert.throws(
      () => runWrite(db, (tx) => applyEnvelope(tx, { kind: "triage", envelope_id: "e1", issue_id: issue.id, disposition: "COMPLETED" } as never)),
      EnvelopeValidationError,
    );
    assert.throws(
      () =>
        runWrite(db, (tx) =>
          applyEnvelope(tx, { kind: "triage", envelope_id: "e2; rm -rf", issue_id: issue.id, disposition: "READY" }),
        ),
      EnvelopeValidationError,
    );
    assert.throws(
      () => runWrite(db, (tx) => applyEnvelope(tx, { kind: "nonsense", envelope_id: "e3" } as never)),
      EnvelopeValidationError,
    );
  } finally {
    cleanup();
  }
});

test("triage BLOCKED disposition stores blocked_by and unblocks back to TRIAGE_PENDING", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = insertIssue(db, {
      id: "issue-blk",
      repo_id: repo.id,
      number: 6,
      title: "blocked",
      state: "TRIAGE_PENDING",
      updated_at: "2026-09-09T00:00:00.000Z",
    });
    const res = runWrite(db, (tx) =>
      applyEnvelope(tx, {
        kind: "triage",
        envelope_id: "env-blk",
        issue_id: issue.id,
        disposition: "BLOCKED",
        blocked_by: "issue-dep-9",
      }),
    );
    assert.equal(res.status, "applied");
    assert.equal(getIssueById(db, issue.id)?.state, "BLOCKED");
    assert.equal(getIssueById(db, issue.id)?.blocked_by, "issue-dep-9");

    runWrite(db, (tx) => {
      updateIssueState(tx, issue.id, "TRIAGE_PENDING");
      recordTransition(tx, { type: "issue", id: issue.id }, "BLOCKED", "TRIAGE_PENDING", "unblock_triage", null, "controller.unblock");
    });
    assert.equal(getIssueById(db, issue.id)?.state, "TRIAGE_PENDING");
  } finally {
    cleanup();
  }
});

test("resolution envelope completed applies RUNNING -> COMPLETED with one audit row", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const wi = insertWorkItem(db, { id: "wi-complete", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const res = runWrite(db, (tx) =>
      applyEnvelope(tx, { kind: "resolution", envelope_id: "env-done", work_item_id: wi.id, outcome: "completed" }),
    );
    assert.equal(res.status, "applied");
    assert.equal(getWorkItem(db, wi.id)?.state, "COMPLETED");
    const rows = listTransitions(db, "work_item", wi.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.event, "completed");
    assert.equal(rows[0]!.from_state, "RUNNING");
    assert.equal(rows[0]!.to_state, "COMPLETED");
  } finally {
    cleanup();
  }
});

test("resolution needs_changes resumes a WAITING item; completion on COMPLETED is a no-op", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const wi = insertWorkItem(db, { id: "wi-wait", repo_id: repo.id, state: "WAITING", base_branch: "main" });

    const revise = runWrite(db, (tx) =>
      applyEnvelope(tx, { kind: "resolution", envelope_id: "env-again", work_item_id: wi.id, outcome: "needs_changes" }),
    );
    assert.equal(revise.status, "applied");
    assert.equal(getWorkItem(db, wi.id)?.state, "RUNNING");

    const done = runWrite(db, (tx) =>
      applyEnvelope(tx, { kind: "resolution", envelope_id: "env-done2", work_item_id: wi.id, outcome: "completed" }),
    );
    assert.equal(done.status, "applied");
    assert.equal(getWorkItem(db, wi.id)?.state, "COMPLETED");

    // Second completed from COMPLETED is a no-op (already in state).
    const dup = runWrite(db, (tx) =>
      applyEnvelope(tx, { kind: "resolution", envelope_id: "env-done3", work_item_id: wi.id, outcome: "completed" }),
    );
    assert.equal(dup.status, "noop_duplicate");
    assert.equal(getWorkItem(db, wi.id)?.state, "COMPLETED");
  } finally {
    cleanup();
  }
});

test("resolution outcomes distinguish human decision from one durable dependency", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = insertIssue(db, { id: "issue-dependency", repo_id: repo.id, number: 19, title: "dependency", state: "TRIAGE_PENDING", updated_at: "2026-09-10T00:00:00.000Z" });
    const human = insertWorkItem(db, { id: "wi-human", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const waiting = runWrite(db, (tx) => applyEnvelope(tx, {
      kind: "resolution", envelope_id: "env-human", work_item_id: human.id, outcome: "awaiting_decision",
    }));
    assert.equal(waiting.status, "applied");
    assert.equal(getWorkItem(db, human.id)?.state, "AWAITING_DECISION");

    const deferred = insertWorkItem(db, { id: "wi-deferred", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const result = runWrite(db, (tx) => applyEnvelope(tx, {
      kind: "resolution", envelope_id: "env-defer", work_item_id: deferred.id, outcome: "deferred",
      dependency: { kind: "issue", id: issue.id },
    }));
    assert.equal(result.status, "applied");
    assert.equal(getWorkItem(db, deferred.id)?.state, "DEFERRED");
    const relation = db.sql.get<{ dependency_issue_id: string | null; dependency_work_item_id: string | null }>(
      "SELECT dependency_issue_id, dependency_work_item_id FROM work_item_dependencies WHERE dependent_work_item_id = ?", deferred.id,
    );
    assert.equal(relation?.dependency_issue_id, issue.id);
    assert.equal(relation?.dependency_work_item_id, null);

    assert.throws(() => runWrite(db, (tx) => applyEnvelope(tx, {
      kind: "resolution", envelope_id: "env-missing", work_item_id: human.id, outcome: "deferred",
    })), EnvelopeValidationError);
    assert.throws(() => runWrite(db, (tx) => applyEnvelope(tx, {
      kind: "resolution", envelope_id: "env-extra", work_item_id: human.id, outcome: "awaiting_decision",
      dependency: { kind: "issue", id: issue.id },
    })), EnvelopeValidationError);
    assert.throws(() => runWrite(db, (tx) => applyEnvelope(tx, {
      kind: "resolution", envelope_id: "env-blocked", work_item_id: human.id, outcome: "blocked" as never,
    })), EnvelopeValidationError);
  } finally {
    cleanup();
  }
});

test("deferred envelope rejects missing dependency targets without partial effects", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const missingIssueTarget = insertWorkItem(db, {
      id: "wi-missing-issue",
      repo_id: repo.id,
      state: "RUNNING",
      base_branch: "main",
    });
    const missingWorkItemTarget = insertWorkItem(db, {
      id: "wi-missing-work-item",
      repo_id: repo.id,
      state: "RUNNING",
      base_branch: "main",
    });

    assert.throws(
      () => runWrite(db, (tx) => applyEnvelope(tx, {
        kind: "resolution",
        envelope_id: "env-missing-issue",
        work_item_id: missingIssueTarget.id,
        outcome: "deferred",
        dependency: { kind: "issue", id: "issue-does-not-exist" },
      })),
      /dependency 'issue-does-not-exist' was not found/,
    );
    assert.throws(
      () => runWrite(db, (tx) => applyEnvelope(tx, {
        kind: "resolution",
        envelope_id: "env-missing-work-item",
        work_item_id: missingWorkItemTarget.id,
        outcome: "deferred",
        dependency: { kind: "work_item", id: "wi-does-not-exist" },
      })),
      /dependency 'wi-does-not-exist' was not found/,
    );

    assert.equal(getWorkItem(db, missingIssueTarget.id)?.state, "RUNNING");
    assert.equal(getWorkItem(db, missingWorkItemTarget.id)?.state, "RUNNING");
    assert.equal(
      db.sql.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM work_item_dependencies WHERE dependent_work_item_id IN (?, ?)",
        missingIssueTarget.id,
        missingWorkItemTarget.id,
      )?.c,
      0,
      "rejected dependencies do not leave dependency rows",
    );
    assert.equal(listTransitions(db, "work_item", missingIssueTarget.id).length, 0);
    assert.equal(listTransitions(db, "work_item", missingWorkItemTarget.id).length, 0);
  } finally {
    cleanup();
  }
});

test("deferred envelope rejects a work-item dependency cycle without partial effects", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const first = insertWorkItem(db, { id: "wi-cycle-first", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const second = insertWorkItem(db, { id: "wi-cycle-second", repo_id: repo.id, state: "RUNNING", base_branch: "main" });

    runWrite(db, (tx) => addWorkItemDependency(tx, first.id, { kind: "work_item", id: second.id }));

    assert.throws(
      () => runWrite(db, (tx) => applyEnvelope(tx, {
        kind: "resolution",
        envelope_id: "env-cycle",
        work_item_id: second.id,
        outcome: "deferred",
        dependency: { kind: "work_item", id: first.id },
      })),
      /WorkItem dependency cycle detected/,
    );

    assert.equal(getWorkItem(db, second.id)?.state, "RUNNING", "cycle rejection leaves state unchanged");
    assert.equal(
      db.sql.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM work_item_dependencies WHERE dependent_work_item_id = ?",
        second.id,
      )?.c,
      0,
      "cycle rejection does not add a dependency row",
    );
    assert.equal(listTransitions(db, "work_item", second.id).length, 0, "cycle rejection does not append an audit transition");
    assert.equal(
      db.sql.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM work_item_dependencies WHERE dependent_work_item_id = ? AND dependency_work_item_id = ?",
        first.id,
        second.id,
      )?.c,
      1,
      "the pre-existing dependency remains intact",
    );
  } finally {
    cleanup();
  }
});

test("pause and resume work-item flow is durable and audited", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const wi = insertWorkItem(db, { id: "wi-pause", repo_id: repo.id, state: "RUNNING", base_branch: "main" });

    // Pause an actively-running item, then resume into the queue.
    runWrite(db, (tx) => {
      setWorkItemState(tx, wi.id, "PAUSED_WORK");
      recordTransition(tx, { type: "work_item", id: wi.id }, "RUNNING", "PAUSED_WORK", "pause_work", null, "controller.pause");
    });
    assert.equal(getWorkItem(db, wi.id)?.state, "PAUSED_WORK");
    runWrite(db, (tx) => {
      setWorkItemState(tx, wi.id, "QUEUED");
      recordTransition(tx, { type: "work_item", id: wi.id }, "PAUSED_WORK", "QUEUED", "resume_work", null, "controller.resume");
    });
    assert.equal(getWorkItem(db, wi.id)?.state, "QUEUED");

    const rows = listTransitions(db, "work_item", wi.id);
    const events = rows.map((r) => r.event);
    assert.deepEqual(events, ["pause_work", "resume_work"]);
  } finally {
    cleanup();
  }
});

test("envelope application never creates session/worktree/PR rows even across many applications", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = insertIssue(db, {
      id: "issue-many",
      repo_id: repo.id,
      number: 7,
      title: "many",
      state: "TRIAGE_PENDING",
      updated_at: "2026-09-09T00:00:00.000Z",
    });
    for (let i = 0; i < 5; i += 1) {
      runWrite(db, (tx) =>
        applyEnvelope(tx, { kind: "triage", envelope_id: `env-${i}`, issue_id: issue.id, disposition: "READY" }),
      );
    }
    assert.equal(countRows(db, "opencode_sessions"), 0);
    assert.equal(countRows(db, "worktrees"), 0);
    assert.equal(countRows(db, "pull_requests"), 0);
    assert.equal(countRows(db, "side_effects"), 0);
  } finally {
    cleanup();
  }
});
