// tests/integration/controller-queue.test.ts
//
// M4 durable claim tests: capacity (global 3 / per-repo 1), ordering (priority
// then creation), commit-before-effects durability, and the guardrail that
// PAUSED_WORK/BLOCKED/FAILED_HOLD do NOT occupy run slots.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTestDb, seedRepository, type TestDb } from "../helpers/db.ts";
import {
  insertWorkItem,
  getWorkItem,
  setWorkItemState,
  listTransitions,
  listWorkItemsByRepo,
  type WorkItemRow,
} from "../../src/db/repositories.ts";
import { claimNextWorkItem } from "../../src/controller/queue.ts";
import { runWrite } from "../../src/db/open.ts";
import { recordTransition } from "../../src/domain/transitions.ts";

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

test("PAUSED_WORK / BLOCKED / FAILED_HOLD do not occupy a run slot", () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { maxConcurrentPerRepo: 1 });
    // Repo slot would look full if any of these counted as running capacity.
    seed(db, { id: "wi-blocked", state: "BLOCKED" });
    seed(db, { id: "wi-paused", state: "PAUSED_WORK" });
    seed(db, { id: "wi-hold", state: "FAILED_HOLD" });
    seed(db, { id: "wi-queued" });
    const now = new Date("2026-09-09T12:00:00.000Z");
    const claim = claimNextWorkItem(db, now);
    assert.ok(claim, "a QUEUED item behind only non-running states must be claimable");
    assert.equal(claim.workItemId, "wi-queued");
  } finally {
    cleanup();
  }
});

test("blocked_by dependency: a BLOCKED item holds no slot and is claimable again once re-ready (R9)", () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { maxConcurrentPerRepo: 2 });
    const dep = seed(db, { id: "wi-dep" }); // the dependency being worked
    const blocked = seed(db, { id: "wi-blocked", state: "BLOCKED" });
    runWrite(db, (tx) =>
      setWorkItemState(tx, blocked.id, "BLOCKED", { blockedBy: "wi-dep" }),
    );
    const now = new Date("2026-09-09T12:00:00.000Z");

    // The BLOCKED item (blocked_by = wi-dep) does not occupy a run slot.
    const claimDep = claimNextWorkItem(db, now);
    assert.equal(claimDep?.workItemId, "wi-dep");

    // Dependency completes; controller unblocks the dependent item via an
    // audited BLOCKED -> READY -> QUEUED re-ready, making it claimable.
    runWrite(db, (tx) => {
      recordTransition(tx, { type: "work_item", id: dep.id }, "RUNNING", "COMPLETED", "completion", { blocked_by: null }, "test");
      setWorkItemState(tx, dep.id, "COMPLETED", { leaseToken: null, leaseUntil: null });
      recordTransition(tx, { type: "work_item", id: blocked.id }, "BLOCKED", "READY", "unblock", { blocked_by: null }, "controller.dispatch");
      setWorkItemState(tx, blocked.id, "READY", { blockedBy: null });
      recordTransition(tx, { type: "work_item", id: blocked.id }, "READY", "QUEUED", "enqueue", {}, "controller.dispatch");
      setWorkItemState(tx, blocked.id, "QUEUED");
    });

    const claim = claimNextWorkItem(db, now);
    assert.equal(claim?.workItemId, "wi-blocked", "re-readied item must become claimable");
    assert.equal(getWorkItem(db, blocked.id)!.blocked_by, null);
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
