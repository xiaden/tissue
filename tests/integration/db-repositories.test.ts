// tests/integration/db-repositories.test.ts
//
// P2-S3 spec-first tests for repository methods: snapshots/watermarks,
// Issue<->WorkItem relationships and re-parenting, ordered inbox delivery, side
// effects, transitions/history, durable leases, status/history summarizers, and
// idempotent terminal-unattached housekeeping with audit rows + retention
// deadlines + counters.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  upsertRepository,
  getRepository,
  getPollWatermark,
  setPollWatermark,
  insertWorkItem,
  getWorkItem,
  setWorkItemState,
  attachIssueToWorkItem,
  detachIssueFromWorkItem,
  activeIssueLinksForIssue,
  activeIssueIdsForWorkItem,
  listIssuesByRepo,
  updateIssueState,
  insertInboxEvent,
  listInboxByWorkItem,
  listNullWorkItemInboxByIssue,
  reparentInboxByIssue,
  countInboxByState,
  insertSideEffect,
  getSideEffect,
  setSideEffectState,
  appendTransition,
  listTransitions,
  listRecentTransitions,
  acquireLease,
  releaseLease,
  expireLeases,
  getLease,
  housekeepTerminalUnattachedInbox,
  housekeepingCounters,
  statusSummary,
} from "../../src/db/repositories.ts";
import { createTestDb, seedRepository, seedIssue } from "../helpers/db.ts";

// ---- snapshots / watermarks -------------------------------------------------

test("poll watermark snapshot is set and read back per repository", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    assert.equal(getPollWatermark(db, repo.owner, repo.name), null);
    setPollWatermark(db, repo.owner, repo.name, "2026-09-09T10:00:00.000Z");
    assert.equal(getPollWatermark(db, repo.owner, repo.name), "2026-09-09T10:00:00.000Z");
    const row = getRepository(db, repo.owner, repo.name)!;
    assert.equal(row.poll_watermark, "2026-09-09T10:00:00.000Z");
    // Upsert does not clobber an existing watermark.
    upsertRepository(db, {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      remote: repo.remote,
      local_dir: repo.local_dir,
      baseline_at: repo.baseline_at,
      poll_interval_seconds: repo.poll_interval_seconds,
      priority: 5,
    });
    assert.equal(getPollWatermark(db, repo.owner, repo.name), "2026-09-09T10:00:00.000Z");
  } finally {
    cleanup();
  }
});

test("issue list and state update persist", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const i1 = seedIssue(db, repo.id, { number: 1, state: "NEW", title: "a" });
    const i2 = seedIssue(db, repo.id, { number: 2, state: "READY", title: "b" });
    updateIssueState(db, i1.id, "TRIAGE_PENDING", JSON.stringify({ d: 1 }));
    const issues = listIssuesByRepo(db, repo.id);
    assert.equal(issues.length, 2);
    assert.equal(issues.find((i) => i.number === 1)?.state, "TRIAGE_PENDING");
    assert.equal(issues.find((i) => i.number === 1)?.disposition_json, JSON.stringify({ d: 1 }));
    void i2;
  } finally {
    cleanup();
  }
});

// ---- relationships + re-parenting ------------------------------------------

test("attach/detach Issue<->WorkItem and expose active links both ways", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { state: "READY" });
    insertWorkItem(db, { id: "wi-r", repo_id: repo.id, state: "QUEUED", base_branch: "main", priority: 2 });
    attachIssueToWorkItem(db, issue.id, "wi-r");
    assert.deepEqual(activeIssueLinksForIssue(db, issue.id).map((l) => l.work_item_id), ["wi-r"]);
    assert.deepEqual(activeIssueIdsForWorkItem(db, "wi-r"), [issue.id]);
    detachIssueFromWorkItem(db, issue.id, "wi-r");
    assert.deepEqual(activeIssueLinksForIssue(db, issue.id), []);
    assert.deepEqual(activeIssueIdsForWorkItem(db, "wi-r"), []);
  } finally {
    cleanup();
  }
});

test("NULL-WorkItem inbox events are re-parented by Issue id on attachment", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const a = seedIssue(db, repo.id, { number: 10, state: "READY" });
    const b = seedIssue(db, repo.id, { number: 11, state: "READY" });
    // Events predate attachment: work_item_id is NULL.
    insertInboxEvent(db, { issue_id: a.id, event_key: "a-1", kind: "issue.comment", payload_json: "{}" });
    insertInboxEvent(db, { issue_id: b.id, event_key: "b-1", kind: "issue.comment", payload_json: "{}" });
    insertInboxEvent(db, { issue_id: a.id, event_key: "a-2", kind: "issue.reopen", payload_json: "{}" });
    insertWorkItem(db, { id: "wi-p", repo_id: repo.id, state: "QUEUED", base_branch: "main" });
    attachIssueToWorkItem(db, a.id, "wi-p");
    const reparented = reparentInboxByIssue(db, a.id, "wi-p");
    assert.equal(reparented, 2, "both of a's unattached events are re-parented");
    assert.equal(listNullWorkItemInboxByIssue(db, a.id).length, 0);
    assert.equal(listNullWorkItemInboxByIssue(db, b.id).length, 1, "b's event stays unattached");
    const attached = listInboxByWorkItem(db, "wi-p");
    assert.deepEqual(attached.map((e) => e.event_key), ["a-1", "a-2"]);
    assert.equal(countInboxByState(db).PENDING, 3);
  } finally {
    cleanup();
  }
});

// ---- inbox ordering / effects / transitions ---------------------------------

test("inbox rows for a work item are returned in strict global id order", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { state: "READY" });
    insertWorkItem(db, { id: "wi-o", repo_id: repo.id, state: "QUEUED", base_branch: "main" });
    attachIssueToWorkItem(db, issue.id, "wi-o");
    for (let k = 1; k <= 4; k++) {
      insertInboxEvent(db, { issue_id: issue.id, work_item_id: "wi-o", event_key: `o-${k}`, kind: "ci", payload_json: "{}" });
      insertInboxEvent(db, { issue_id: issue.id, work_item_id: "wi-o", event_key: `x-${k}`, kind: "ci", payload_json: "{}" });
    }
    const keys = listInboxByWorkItem(db, "wi-o").map((e) => e.event_key);
    assert.deepEqual(keys, ["o-1", "x-1", "o-2", "x-2", "o-3", "x-3", "o-4", "x-4"]);
  } finally {
    cleanup();
  }
});

test("side effects: insert, read, and transition to DONE with attempt increments", () => {
  const { db, cleanup } = createTestDb();
  try {
    insertSideEffect(db, { id: "fx", kind: "issue_comment", effect_key: "ek-fx", state: "PENDING", payload_json: JSON.stringify({ body: "hi" }) });
    assert.equal(getSideEffect(db, "fx")?.state, "PENDING");
    setSideEffectState(db, "fx", "DONE");
    const after = getSideEffect(db, "fx")!;
    assert.equal(after.state, "DONE");
    assert.equal(after.attempt, 1);
  } finally {
    cleanup();
  }
});

test("state_transitions audit and recent history ordering", () => {
  const { db, cleanup } = createTestDb();
  try {
    appendTransition(db, { entity_type: "issue", entity_id: "i-1", from_state: "NEW", to_state: "TRIAGE_PENDING", event: "discovered", actor: "controller" });
    appendTransition(db, { entity_type: "work_item", entity_id: "wi-1", from_state: "QUEUED", to_state: "RUNNING", event: "claimed", actor: "controller", reason_json: JSON.stringify({ lease: "t" }) });
    const issueT = listTransitions(db, "issue", "i-1");
    assert.equal(issueT.length, 1);
    assert.equal(issueT[0]?.to_state, "TRIAGE_PENDING");
    const recent = listRecentTransitions(db, 5);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]?.entity_type, "work_item", "most recent first");
  } finally {
    cleanup();
  }
});

// ---- work item state plumbing -------------------------------------------------

test("work item state transitions update row and attach nothing new", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    insertWorkItem(db, { id: "wi-st", repo_id: repo.id, state: "READY", base_branch: "main", priority: 1 });
    setWorkItemState(db, "wi-st", "QUEUED");
    const row = getWorkItem(db, "wi-st")!;
    assert.equal(row.state, "QUEUED");
    assert.ok(row.updated_at > row.created_at || row.updated_at === row.created_at);
  } finally {
    cleanup();
  }
});

// ---- durable leases -----------------------------------------------------------

test("leases: acquire, hold-while-active, expire, reclaim, and owner-token release", () => {
  const { db, cleanup } = createTestDb();
  try {
    const t0 = new Date("2026-09-09T00:00:00.000Z");
    // Acquire a fresh lease.
    const first = acquireLease(db, "lease:wt", "tok-1", t0, 10_000);
    assert.equal(first.acquired, true);
    assert.equal(getLease(db, "lease:wt")?.owner_token, "tok-1");
    // A competing owner before expiry is refused.
    const t1 = new Date(t0.getTime() + 1000);
    const held = acquireLease(db, "lease:wt", "tok-2", t1, 10_000);
    assert.equal(held.acquired, false);
    assert.equal(held.reason, "held");
    assert.equal(getLease(db, "lease:wt")?.owner_token, "tok-1");
    // Releasing with the wrong token is a no-op; with the right token it frees.
    assert.equal(releaseLease(db, "lease:wt", "tok-2"), false);
    assert.equal(releaseLease(db, "lease:wt", "tok-1"), true);
    assert.equal(getLease(db, "lease:wt"), undefined);
    // An expired lease is reclaimed by a new owner (durable expiry).
    const t2 = new Date(t0.getTime() + 20_000);
    acquireLease(db, "lease:exp", "tok-old", t0, 10_000);
    assert.equal(acquireLease(db, "lease:exp", "tok-new", t2, 10_000).acquired, true);
    assert.equal(getLease(db, "lease:exp")?.owner_token, "tok-new");
    // expireLeases removes only rows past their deadline.
    acquireLease(db, "lease:soon", "tok-s", t0, 5_000);
    const removed = expireLeases(db, new Date(t0.getTime() + 30_000));
    assert.ok(removed >= 1);
    assert.equal(getLease(db, "lease:soon"), undefined);
    assert.equal(getLease(db, "lease:exp"), undefined);
  } finally {
    cleanup();
  }
});

// ---- terminal-unattached inbox housekeeping (R10/R22) --------------------------

test("housekeeping terminal-marks NULL-WorkItem rows for terminal issues with audit + retention", () => {
  const { db, cleanup } = createTestDb({ retentionDays: 7 });
  try {
    const repo = seedRepository(db);
    const rejected = seedIssue(db, repo.id, { number: 20, state: "REJECTED" });
    const dup = seedIssue(db, repo.id, { number: 21, state: "DUPLICATE" });
    const active = seedIssue(db, repo.id, { number: 22, state: "READY" });
    // Unattached events on terminal + non-terminal issues.
    const rejIds = [
      insertInboxEvent(db, { issue_id: rejected.id, event_key: "rej-1", kind: "issue.comment", payload_json: "{}" }),
      insertInboxEvent(db, { issue_id: rejected.id, event_key: "rej-2", kind: "issue.comment", payload_json: "{}" }),
    ];
    insertInboxEvent(db, { issue_id: dup.id, event_key: "dup-1", kind: "issue.comment", payload_json: "{}" });
    const activeEvent = insertInboxEvent(db, { issue_id: active.id, event_key: "act-1", kind: "issue.comment", payload_json: "{}" });
    // An attached (re-parented) event on a terminal issue must NOT be housekept.
    insertWorkItem(db, { id: "wi-kept", repo_id: repo.id, state: "COMPLETED", base_branch: "main" });
    const attachedId = insertInboxEvent(db, { issue_id: rejected.id, work_item_id: "wi-kept", event_key: "rej-attached", kind: "issue.comment", payload_json: "{}" });

    const now = new Date("2026-09-09T12:00:00.000Z");
    const res = housekeepTerminalUnattachedInbox(db, now);
    assert.equal(res.checked, 3, "two rejected + one duplicate unattached rows");
    assert.equal(res.terminalMarked, 3);
    assert.equal(res.pruned, 0);
    assert.deepEqual(new Set(res.issueIds), new Set([rejected.id, dup.id]));

    for (const id of [...rejIds]) {
      const row = db.sql.get<{ state: string; terminal_action: string | null; retention_deadline: string | null; terminal_reason: string | null }>(
        "SELECT state, terminal_action, retention_deadline, terminal_reason FROM inbox WHERE id = ?",
        id,
      )!;
      assert.equal(row.state, "TERMINAL");
      assert.equal(row.terminal_action, "terminal_marked");
      assert.match(row.terminal_reason ?? "", /REJECTED/);
      const deadline = Date.parse(row.retention_deadline!);
      assert.ok(Math.abs(deadline - Date.parse("2026-09-16T12:00:00.000Z")) < 2000, "retention deadline = now + retentionDays");
    }
    // Non-terminal and attached rows are untouched.
    const activeRow = db.sql.get<{ state: string; terminal_action: string | null }>("SELECT state, terminal_action FROM inbox WHERE id = ?", activeEvent)!;
    assert.equal(activeRow.state, "PENDING");
    assert.equal(activeRow.terminal_action, null);
    const attachedRow = db.sql.get<{ state: string; terminal_action: string | null }>("SELECT state, terminal_action FROM inbox WHERE id = ?", attachedId)!;
    assert.equal(attachedRow.state, "PENDING", "attached event on a terminal issue is not housekept");
    assert.equal(attachedRow.terminal_action, null);

    // One audit state_transitions row per housekept event.
    const audits = db.sql.all<{ entity_id: string }>(
      "SELECT entity_id FROM state_transitions WHERE event = 'terminal_unattached_housekeeping'",
    );
    assert.equal(audits.length, 3);
    assert.deepEqual(new Set(audits.map((a) => a.entity_id)), new Set([String(rejIds[0]), String(rejIds[1]), String(db.sql.get<{ id: number }>("SELECT id FROM inbox WHERE event_key='dup-1'")!.id)]));

    // Counters reflect the marks; lastAt is set.
    const counters = housekeepingCounters(db);
    assert.equal(counters.terminalMarked, 3);
    assert.equal(counters.pruned, 0);
    assert.ok(counters.lastAt !== null);

    // Repeated housekeeping is a no-op.
    const again = housekeepTerminalUnattachedInbox(db, new Date("2026-09-09T13:00:00.000Z"));
    assert.equal(again.checked, 0);
    assert.equal(again.terminalMarked, 0);
    assert.equal(again.issueIds.length, 0);
    assert.equal(housekeepingCounters(db).terminalMarked, 3);
    assert.equal(db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM state_transitions WHERE event='terminal_unattached_housekeeping'")?.c, 3);
  } finally {
    cleanup();
  }
});

test("housekeeping terminal-marks unattached BASELINE_EXCLUDED rows with retention deadline and audit", () => {
  const { db, cleanup } = createTestDb({ retentionDays: 30 });
  try {
    const repo = seedRepository(db);
    const base = seedIssue(db, repo.id, { number: 30, state: "BASELINE_EXCLUDED" });
    insertInboxEvent(db, { issue_id: base.id, event_key: "base-1", kind: "issue.comment", payload_json: "{}" });
    const now = new Date("2026-09-01T00:00:00.000Z");
    housekeepTerminalUnattachedInbox(db, now);
    const row = db.sql.get<{ retention_deadline: string | null; state: string }>(
      "SELECT retention_deadline, state FROM inbox WHERE event_key = 'base-1'",
    )!;
    assert.equal(row.state, "TERMINAL");
    const deadline = Date.parse(row.retention_deadline!);
    assert.ok(Math.abs(deadline - Date.parse("2026-10-01T00:00:00.000Z")) < 2000, "uses the configured retention window");
  } finally {
    cleanup();
  }
});

// ---- status / history summarizers ------------------------------------------------

test("statusSummary aggregates repositories, work items, inbox, leases, housekeeping", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { number: 1, state: "REJECTED" });
    insertWorkItem(db, { id: "wi-s1", repo_id: repo.id, state: "QUEUED", base_branch: "main" });
    insertWorkItem(db, { id: "wi-s2", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    insertInboxEvent(db, { issue_id: issue.id, event_key: "st-1", kind: "x", payload_json: "{}" });
    insertSideEffect(db, { id: "fx-st", kind: "x", effect_key: "ek-st", state: "PENDING", payload_json: "{}" });
    acquireLease(db, "lease:st", "tok", new Date(), 10_000);
    housekeepTerminalUnattachedInbox(db, new Date());

    const s = statusSummary(db);
    assert.equal(s.repositories, 1);
    assert.equal(s.issues, 1);
    assert.equal(s.workItems.QUEUED, 1);
    assert.equal(s.workItems.RUNNING, 1);
    assert.equal(s.inbox.TERMINAL, 1);
    assert.equal(s.sideEffectsPending, 1);
    assert.equal(s.activeLeases, 1);
    assert.equal(s.housekeeping.terminalMarked, 1);
  } finally {
    cleanup();
  }
});
