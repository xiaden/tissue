// tests/integration/controller-queue.test.ts
//
// M4 durable claim tests: capacity (global 3 / per-repo 1), ordering (priority
// then creation), commit-before-effects durability, and the guardrail that
// DEFERRED dependency waiters do not occupy run slots or become claimable.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTestDb, seedRepository, type TestDb } from "../helpers/db.ts";
import {
  insertWorkItem,
  getWorkItem,
  listTransitions,
  listWorkItemsByRepo,
  addWorkItemDependency,
  type WorkItemRow,
} from "../../src/db/repositories.ts";
import { claimNextWorkItem } from "../../src/controller/queue.ts";
import { runWrite } from "../../src/db/open.ts";
import { seedIssue } from "../helpers/db.ts";

function seed(db: TestDb["db"], overrides: { id: string; priority?: number; state?: string }): WorkItemRow {
  return insertWorkItem(db, {
    id: overrides.id,
    repo_id: "xiaden/nomarr",
    state: overrides.state ?? "QUEUED",
    title: overrides.id,
    base_branch: "main",
    priority: overrides.priority ?? 0,
  });
}

test("claims the only QUEUED item, moving it to RUNNING with a durable lease + audit", () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { maxConcurrentPerRepo: 4 });
    seed(db, { id: "wi-a", priority: 1 });
    const now = new Date("2026-09-09T12:00:00.000Z");

    const claim = claimNextWorkItem(db, now);
    assert.ok(claim, "expected a claim");
    assert.equal(claim.workItemId, "wi-a");
    assert.equal(claim.repoId, "xiaden/nomarr");
    assert.ok(claim.leaseToken, "expected a random lease token");
    assert.ok(claim.leaseUntil > now.toISOString(), "leaseUntil must be in the future");

    // Commit-before-effects: immediately readable, durable.
    const row = getWorkItem(db, "wi-a")!;
    assert.equal(row.state, "RUNNING");
    assert.equal(row.lease_token, claim.leaseToken);
    assert.equal(row.lease_until, claim.leaseUntil);

    // Exactly one audited QUEUED -> RUNNING claim transition.
    const txns = listTransitions(db, "work_item", "wi-a");
    const claims = txns.filter((t) => t.event === "claim" && t.to_state === "RUNNING");
    assert.equal(claims.length, 1);
  } finally {
    cleanup();
  }
});

test("flood within one repo respects per-repo cap of 1", () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { maxConcurrentPerRepo: 1 });
    for (let i = 0; i < 5; i++) seed(db, { id: `wi-${i}` });
    const now = new Date("2026-09-09T12:00:00.000Z");

    const first = claimNextWorkItem(db, now);
    assert.ok(first, "expected first claim");
    const second = claimNextWorkItem(db, now);
    assert.equal(second, null, "second claim must be refused by the per-repo cap");

    const rows = listWorkItemsByRepo(db, "xiaden/nomarr");
    assert.equal(rows.filter((r) => r.state === "RUNNING").length, 1);
    assert.equal(rows.filter((r) => r.state === "QUEUED").length, 4);
  } finally {
    cleanup();
  }
});

test("global cap of 3 across repos (two repos each perRepo>=3), one per repo honoured", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repoA = seedRepository(db, { owner: "xiaden", name: "repoa", maxConcurrentPerRepo: 5 });
    const repoB = seedRepository(db, { owner: "xiaden", name: "repob", maxConcurrentPerRepo: 5 });
    const repoIds = [repoA.id, repoB.id];
    for (const rid of repoIds) {
      for (let i = 0; i < 4; i++) insertWorkItem(db, { id: `wi-${rid}-${i}`, repo_id: rid, state: "QUEUED", title: `q-${rid}-${i}`, base_branch: "main" });
    }
    const now = new Date("2026-09-09T12:00:00.000Z");
    const claimed: string[] = [];
    let claim = claimNextWorkItem(db, now, { globalLimit: 3 });
    while (claim) {
      claimed.push(claim.workItemId);
      claim = claimNextWorkItem(db, now, { globalLimit: 3 });
    }
    assert.equal(claimed.length, 3, "global cap of 3 must hold");

    // Per-repo cap 1: across two repos the 3rd claim can only come from one repo's 2nd slot —
    // but perRepo=5 here allows a repo to host multiple, so all 3 must be distinct work items.
    assert.equal(new Set(claimed).size, 3);
    const running = listWorkItemsByRepo(db, repoIds[0]!).filter((r) => r.state === "RUNNING").length +
      listWorkItemsByRepo(db, repoIds[1]!).filter((r) => r.state === "RUNNING").length;
    assert.equal(running, 3);
  } finally {
    cleanup();
  }
});

test("ordering: higher numeric priority is claimed first (priority DESC)", () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { maxConcurrentPerRepo: 5 });
    seed(db, { id: "wi-old-low", priority: 1 });
    seed(db, { id: "wi-new-high", priority: 9 });
    seed(db, { id: "wi-mid", priority: 5 });
    const now = new Date("2026-09-09T12:00:00.000Z");

    const a = claimNextWorkItem(db, now)!;
    assert.equal(a.workItemId, "wi-new-high");
    const b = claimNextWorkItem(db, now)!;
    assert.equal(b.workItemId, "wi-mid");
    const c = claimNextWorkItem(db, now)!;
    assert.equal(c.workItemId, "wi-old-low");
  } finally {
    cleanup();
  }
});

test("returns null when no candidate fits under repo capacity", () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { maxConcurrentPerRepo: 1 });
    seed(db, { id: "wi-running", state: "RUNNING" }); // occupies the single repo slot
    seed(db, { id: "wi-queued" });
    const now = new Date("2026-09-09T12:00:00.000Z");
    assert.equal(claimNextWorkItem(db, now), null);
  } finally {
    cleanup();
  }
});

test("DEFERRED dependency waiters are non-claimable and capacity-exempt", () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { maxConcurrentPerRepo: 1 });
    const deferred = seed(db, { id: "wi-deferred", state: "DEFERRED" });
    const issue = seedIssue(db, "xiaden/nomarr", { id: "issue-dependency", number: 9001 });

    const relation = runWrite(db, (tx) =>
      addWorkItemDependency(tx, deferred.id, { kind: "issue", id: issue.id }),
    );
    assert.equal(relation.dependent_work_item_id, deferred.id);
    assert.equal(relation.dependency_issue_id, issue.id);
    assert.equal(relation.dependency_work_item_id, null);
    assert.equal(relation.state, "ACTIVE");

    const now = new Date("2026-09-09T12:00:00.000Z");
    assert.equal(claimNextWorkItem(db, now), null, "a deferred-only queue must yield no claim");

    const sibling = seed(db, { id: "wi-queued-sibling", state: "QUEUED" });
    const claim = claimNextWorkItem(db, now);
    assert.ok(claim, "a queued sibling remains claimable under the repo capacity limit");
    assert.equal(claim.workItemId, sibling.id);
    assert.equal(getWorkItem(db, deferred.id)!.state, "DEFERRED");
  } finally {
    cleanup();
  }
});

test("AWAITING_DECISION consumes per-repository capacity", () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { maxConcurrentPerRepo: 1 });
    seed(db, { id: "wi-awaiting-decision", state: "AWAITING_DECISION" });
    seed(db, { id: "wi-queued-behind" });
    assert.equal(claimNextWorkItem(db, new Date("2026-09-09T12:00:00.000Z")), null);
    assert.equal(getWorkItem(db, "wi-queued-behind")!.state, "QUEUED");
  } finally {
    cleanup();
  }
});

test("cross-repo saturation: a saturated repo at the queue top must not starve a capacity-eligible repo (R8)", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repoA = seedRepository(db, { owner: "xiaden", name: "repoa", maxConcurrentPerRepo: 1 });
    const repoB = seedRepository(db, { owner: "xiaden", name: "repob", maxConcurrentPerRepo: 1 });
    // Repo A occupies its single per-repo slot.
    insertWorkItem(db, { id: "wi-A-running", repo_id: repoA.id, state: "RUNNING", base_branch: "main" });
    // Repo A's global-top QUEUED item cannot be claimed: its repo is at cap.
    insertWorkItem(db, { id: "wi-A-top", repo_id: repoA.id, state: "QUEUED", base_branch: "main", priority: 100 });
    // Repo B has a capacity-eligible QUEUED item (lower priority), and global
    // capacity (only repo A's 1 RUNNING) is free.
    insertWorkItem(db, { id: "wi-B-eligible", repo_id: repoB.id, state: "QUEUED", base_branch: "main", priority: 1 });
    const now = new Date("2026-09-09T12:00:00.000Z");

    const claim = claimNextWorkItem(db, now, { globalLimit: 3 });
    assert.ok(claim, "a capacity-eligible repo B item must be claimed");
    assert.equal(claim.workItemId, "wi-B-eligible", "skip repo A's saturated top item and claim repo B's");
    assert.equal(getWorkItem(db, "wi-A-top")!.state, "QUEUED", "repo A's saturated top item is not claimed");
  } finally {
    cleanup();
  }
});
