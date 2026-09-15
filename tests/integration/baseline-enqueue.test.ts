// tests/integration/baseline-enqueue.test.ts
//
// P1-S2: baseline exclusion + manual enqueue (R14 / CONTRACTS enqueueIssue).
// Pre-activation issues are BASELINE_EXCLUDED; the ONLY historical admission
// path is an explicit enqueue, which performs the single legal FSM transition
// BASELINE_EXCLUDED -> NEW (event manual_enqueue) and appends one audit row,
// all inside one runWrite transaction.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTestDb, seedRepository, seedIssue } from "../helpers/db.ts";
import { enqueueIssue } from "../../src/controller/enqueue.ts";
import { getIssueByRepoNumber, listTransitions } from "../../src/db/repositories.ts";

test("enqueueIssue admits a BASELINE_EXCLUDED issue (BASELINE_EXCLUDED -> NEW + audit)", () => {
  const td = createTestDb();
  try {
    const repo = seedRepository(td.db, {});
    const seeded = seedIssue(td.db, repo.id, { state: "BASELINE_EXCLUDED" });
    assert.equal(seeded.state, "BASELINE_EXCLUDED");

    const res = enqueueIssue(td.db, { id: repo.id }, seeded.number);
    assert.equal(res.applied, true);
    assert.equal(res.outcome, "admitted");
    assert.ok(res.issueId);

    const issue = getIssueByRepoNumber(td.db, repo.id, seeded.number);
    assert.equal(issue?.state, "NEW");

    const led = listTransitions(td.db, "issue", issue!.id).filter(
      (t) => t.to_state === "NEW" && t.event === "manual_enqueue",
    );
    assert.equal(led.length, 1);
  } finally {
    td.cleanup();
  }
});

test("enqueueIssue on an already-NEW issue is idempotent (no re-transition)", () => {
  const td = createTestDb();
  try {
    const repo = seedRepository(td.db, {});
    const seeded = seedIssue(td.db, repo.id, { state: "NEW" });
    const res = enqueueIssue(td.db, { id: repo.id }, seeded.number);
    assert.equal(res.applied, false);
    assert.equal(res.outcome, "already_new");
    assert.equal(getIssueByRepoNumber(td.db, repo.id, seeded.number)?.state, "NEW");
  } finally {
    td.cleanup();
  }
});

test("enqueueIssue on a non-baseline terminal state is surfaced, never silently admitted", () => {
  const td = createTestDb();
  try {
    const repo = seedRepository(td.db, {});
    const seeded = seedIssue(td.db, repo.id, { state: "REJECTED" });
    const res = enqueueIssue(td.db, { id: repo.id }, seeded.number);
    assert.equal(res.applied, false);
    assert.equal(res.outcome, "not_admissible");
    assert.equal(res.state, "REJECTED");
    assert.equal(getIssueByRepoNumber(td.db, repo.id, seeded.number)?.state, "REJECTED");
  } finally {
    td.cleanup();
  }
});

test("enqueueIssue on an unknown issue number is surfaced as not_found", () => {
  const td = createTestDb();
  try {
    const repo = seedRepository(td.db, {});
    const res = enqueueIssue(td.db, { id: repo.id }, 99999);
    assert.equal(res.applied, false);
    assert.equal(res.outcome, "not_found");
  } finally {
    td.cleanup();
  }
});
