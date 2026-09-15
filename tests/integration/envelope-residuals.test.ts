// tests/integration/envelope-residuals.test.ts
//
// P2-S4 carry-forward tests (exec-manager L2 residuals):
//   (2) created_at ASC tie-break among equal queue priorities;
//   (3) MERGED / PAUSED_TRIAGE / REJECTED triage dispositions applied via envelope
//       (MERGED groups onto the canonical WorkItem); and
//   (4) an awaiting_review resolution outcome drives RUNNING -> WAITING via envelope.
// Also pins the bounded triage backoff ladder ordering/cap (residual 1).

import test from "node:test";
import assert from "node:assert/strict";

import { applyEnvelope } from "../../src/domain/envelopes.ts";
import { runWrite } from "../../src/db/open.ts";
import { getIssueById, getWorkItem, insertWorkItem, updateIssueState } from "../../src/db/repositories.ts";
import { claimNextWorkItem } from "../../src/controller/queue.ts";
import { runTriageRepo, triageBackoffDelayMs, TRIAGE_BACKOFF_CAP_MS } from "../../src/controller/triage.ts";
import { createTestDb, seedRepository, seedIssue } from "../helpers/db.ts";
import { ScriptedTriageDriver } from "../helpers/session-driver.ts";

const NOW = new Date("2026-09-09T12:00:00.000Z");

function pending(issueId: string, db: ReturnType<typeof createTestDb>["db"]): void {
  updateIssueState(db, issueId, "TRIAGE_PENDING");
}

test("L2(3): REJECTED / PAUSED_TRIAGE / MERGED dispositions apply through a typed envelope", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    for (const [disposition, expected] of [
      ["REJECTED", "REJECTED"],
      ["PAUSED_TRIAGE", "PAUSED_TRIAGE"],
      ["MERGED", "MERGED"],
    ] as const) {
      const issue = seedIssue(db, repo.id, { number: 100 + expected.length, title: disposition });
      pending(issue.id, db);
      const res = runWrite(db, (tx) =>
        applyEnvelope(tx, {
          kind: "triage",
          envelope_id: `env-${disposition}`,
          issue_id: issue.id,
          disposition,
        }),
      );
      assert.equal(res.status, "applied");
      assert.equal(getIssueById(db, issue.id)?.state, expected);
    }
  } finally {
    cleanup();
  }
});

test("L2(3): a MERGED disposition groups the issue onto the canonical WorkItem", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const canonical = insertWorkItem(db, {
      id: "wi-canonical",
      repo_id: repo.id,
      state: "RUNNING",
      base_branch: "main",
    });
    const issue = seedIssue(db, repo.id, { number: 8, title: "merged upstream" });
    pending(issue.id, db);
    const driver = new ScriptedTriageDriver([
      { issueId: issue.id, disposition: "MERGED", canonicalWorkItemId: canonical.id },
    ]);
    const summary = await runTriageRepo(db, repo.id, driver, NOW);
    assert.equal(summary.outcome, "disposition_applied");
    assert.equal(getIssueById(db, issue.id)?.state, "MERGED");
    const link = db.sql.get<{ work_item_id: string }>(
      "SELECT work_item_id FROM issue_work_items WHERE issue_id = ? AND state = 'ACTIVE'",
      issue.id,
    );
    assert.equal(link?.work_item_id, canonical.id);
  } finally {
    cleanup();
  }
});

test("L2(4): an awaiting_review resolution envelope drives WorkItem RUNNING -> WAITING", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const wi = insertWorkItem(db, { id: "wi-xiaden-nomarr-7", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const res = runWrite(db, (tx) =>
      applyEnvelope(tx, {
        kind: "resolution",
        envelope_id: "env-await-review",
        work_item_id: wi.id,
        outcome: "awaiting_review",
      }),
    );
    assert.equal(res.status, "applied");
    assert.equal(getWorkItem(db, wi.id)?.state, "WAITING");

    // Duplicate envelope is an auditable no-op (no second transition).
    const dup = runWrite(db, (tx) =>
      applyEnvelope(tx, {
        kind: "resolution",
        envelope_id: "env-await-review",
        work_item_id: wi.id,
        outcome: "awaiting_review",
      }),
    );
    assert.equal(dup.status, "noop_duplicate");
  } finally {
    cleanup();
  }
});

test("L2(2): equal-priority queue claims break ties by created_at ASC", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db, { maxConcurrentPerRepo: 2 });
    insertWorkItem(db, { id: "wi-older", repo_id: repo.id, state: "QUEUED", base_branch: "main", priority: 0 });
    insertWorkItem(db, { id: "wi-newer", repo_id: repo.id, state: "QUEUED", base_branch: "main", priority: 0 });
    db.sql.run("UPDATE work_items SET created_at = ? WHERE id = ?", "2026-09-01T00:00:00.000Z", "wi-older");
    db.sql.run("UPDATE work_items SET created_at = ? WHERE id = ?", "2026-09-02T00:00:00.000Z", "wi-newer");

    const claim = claimNextWorkItem(db, NOW, { globalLimit: 3 });
    assert.ok(claim);
    assert.equal(claim?.workItemId, "wi-older", "oldest created_at wins among equal priority");
  } finally {
    cleanup();
  }
});

test("L2(1): the triage backoff ladder is monotonic and capped", () => {
  const low = triageBackoffDelayMs(0, () => 0);
  const mid = triageBackoffDelayMs(1, () => 0);
  const high = triageBackoffDelayMs(2, () => 0);
  assert.ok(low <= mid && mid <= high);
  assert.ok(triageBackoffDelayMs(50, () => 1) <= TRIAGE_BACKOFF_CAP_MS);
});
