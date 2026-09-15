// tests/integration/domain-transitions.test.ts
//
// P3-S3 spec-first tests for the centralized transition ledger: a legal
// transition appends exactly one audit row; an illegal transition (out of the
// table, or a wrong event, or an unknown state) throws and appends nothing.
// This is the durable gate that keeps illegal transitions out of history.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runWrite } from "../../src/db/open.ts";
import { insertWorkItem, insertIssue, listTransitions, insertWorktree, setWorktreeState } from "../../src/db/repositories.ts";
import {
  recordTransition,
  IllegalTransitionError,
  UnknownStateError,
} from "../../src/domain/transitions.ts";
import { createTestDb, seedRepository } from "../helpers/db.ts";

test("recordTransition appends exactly one audit row for a legal transition", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const wi = insertWorkItem(db, { id: "wi-1", repo_id: repo.id, state: "READY", base_branch: "main" });

    runWrite(db, (tx) => {
      const rec = recordTransition(
        tx,
        { type: "work_item", id: wi.id },
        "READY",
        "QUEUED",
        "enqueue",
        { capacity: true },
        "controller.claim",
      );
      assert.equal(rec.from_state, "READY");
      assert.equal(rec.to_state, "QUEUED");
      assert.equal(rec.event, "enqueue");
      assert.equal(rec.actor, "controller.claim");
      assert.ok(rec.at, "expected DB-assigned timestamp");
    });

    const rows = listTransitions(db, "work_item", wi.id);
    assert.equal(rows.length, 1, "exactly one audit row for one legal transition");
    assert.equal(rows[0]!.event, "enqueue");
  } finally {
    cleanup();
  }
});

test("an out-of-table transition throws IllegalTransitionError and appends nothing", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const wi = insertWorkItem(db, { id: "wi-x", repo_id: repo.id, state: "QUEUED", base_branch: "main" });
    // QUEUED -> COMPLETED is not in the table (must pass RUNNING).
    assert.throws(
      () =>
        runWrite(db, (tx) =>
          recordTransition(tx, { type: "work_item", id: wi.id }, "QUEUED", "COMPLETED", "completed", null, "t"),
        ),
      IllegalTransitionError,
    );
    assert.equal(listTransitions(db, "work_item", wi.id).length, 0, "no audit row on illegal transition");
  } finally {
    cleanup();
  }
});

test("a wrong event on a real edge throws and appends nothing", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = insertIssue(db, {
      id: "issue-1",
      repo_id: repo.id,
      number: 1,
      title: "t",
      state: "TRIAGE_PENDING",
      updated_at: "2026-09-09T00:00:00.000Z",
    });
    assert.throws(
      () =>
        runWrite(db, (tx) =>
          recordTransition(tx, { type: "issue", id: issue.id }, "TRIAGE_PENDING", "READY", "triage_duplicate", null, "t"),
        ),
      IllegalTransitionError,
    );
    assert.equal(listTransitions(db, "issue", issue.id).length, 0);
  } finally {
    cleanup();
  }
});

test("unknown source or destination state throws UnknownStateError", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const wi = insertWorkItem(db, { id: "wi-u", repo_id: repo.id, state: "READY", base_branch: "main" });
    assert.throws(
      () =>
        runWrite(db, (tx) =>
          recordTransition(tx, { type: "work_item", id: wi.id }, "NOPE", "QUEUED", "enqueue", null, "t"),
        ),
      UnknownStateError,
    );
    assert.throws(
      () =>
        runWrite(db, (tx) =>
          recordTransition(tx, { type: "work_item", id: wi.id }, "READY", "NOPE", "enqueue", null, "t"),
        ),
      UnknownStateError,
    );
  } finally {
    cleanup();
  }
});

test("worktree and session transitions record in the same ledger shape", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const wi = insertWorkItem(db, { id: "wi-w", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    insertWorktree(db, { id: "wt-1", work_item_id: wi.id, path: "/tmp/wt", branch: "tissue/wi_abc", state: "ACTIVE" });

    runWrite(db, (tx) => {
      recordTransition(tx, { type: "worktree", id: "wt-1" }, "ACTIVE", "CLEANING", "cleanup_start", null, "t");
      recordTransition(tx, { type: "worktree", id: "wt-1" }, "CLEANING", "CLEANED", "cleaned", null, "t");
    });
    setWorktreeState(db, "wt-1", "CLEANED");
    const rows = listTransitions(db, "worktree", "wt-1");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.to_state, "CLEANING");
    assert.equal(rows[1]!.to_state, "CLEANED");
  } finally {
    cleanup();
  }
});
