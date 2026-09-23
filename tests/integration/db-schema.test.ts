// tests/integration/db-schema.test.ts
//
// P2-S2 spec-first tests: the migrated schema contains the exact conceptual
// tables/indexes from the DD, partial-unique indexes enforce one-active-per-
// owner, the inbox id is globally monotonic AUTOINCREMENT, event_key dedup and
// JSON boundary validation hold, foreign keys are enforced, and inbox carries
// the terminal-unattached housekeeping audit/retention fields.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TissueDbError } from "../../src/db/open.ts";
import {
  upsertRepository,
  insertIssue,
  insertWorkItem,
  attachIssueToWorkItem,
  detachIssueFromWorkItem,
  activeIssueLinksForIssue,
  insertSession,
  insertWorktree,
  insertPullRequest,
  insertInboxEvent,
  listInboxByWorkItem,
  insertSideEffect,
  appendTransition,
  addWorkItemDependency,
} from "../../src/db/repositories.ts";
import { createTestDb, seedRepository, seedIssue } from "../helpers/db.ts";

const TABLES = [
  "repositories",
  "issues",
  "work_items",
  "issue_work_items",
  "opencode_sessions",
  "worktrees",
  "pull_requests",
  "inbox",
  "state_transitions",
  "side_effects",
  "controller_leases",
];

test("migrated schema contains dependency relation and version ledger", () => {
  const { db, cleanup } = createTestDb();
  try {
    assert.equal(db.sql.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")?.version, 2);
    const table = db.sql.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_item_dependencies'");
    assert.match(table?.sql ?? "", /CHECK \(\(dependency_issue_id IS NOT NULL\) != \(dependency_work_item_id IS NOT NULL\)\)/);
    const columns = db.sql.all<{ name: string }>("PRAGMA table_info('work_items')").map((row) => row.name);
    assert.ok(!columns.includes("blocked_by"), "WorkItem blocked_by is not an active column contract");
  } finally {
    cleanup();
  }
});

test("dependency schema enforces exactly one target and exposes lookup indexes", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    insertWorkItem(db, { id: "wi-schema-dependent", repo_id: repo.id, state: "DEFERRED", base_branch: "main" });
    insertWorkItem(db, { id: "wi-schema-target", repo_id: repo.id, state: "COMPLETED", base_branch: "main" });

    assert.throws(
      () => db.sql.run(
        "INSERT INTO work_item_dependencies(id, dependent_work_item_id, dependency_issue_id, dependency_work_item_id, created_at) VALUES(?,?,?,?,?)",
        "dep-both-null",
        "wi-schema-dependent",
        null,
        null,
        "2026-09-09T00:00:00.000Z",
      ),
      /CHECK/i,
    );
    assert.throws(
      () => db.sql.run(
        "INSERT INTO work_item_dependencies(id, dependent_work_item_id, dependency_issue_id, dependency_work_item_id, created_at) VALUES(?,?,?,?,?)",
        "dep-both-set",
        "wi-schema-dependent",
        "wi-schema-target",
        "wi-schema-target",
        "2026-09-09T00:00:00.000Z",
      ),
      /CHECK/i,
    );

    const indexes = new Set(
      db.sql.all<{ name: string }>("PRAGMA index_list('work_item_dependencies')").map((row) => row.name),
    );
    assert.ok(indexes.has("ix_work_item_dependencies_issue"));
    assert.ok(indexes.has("ix_work_item_dependencies_work_item"));
    assert.ok(indexes.has("ix_work_item_dependencies_dependents"));
  } finally {
    cleanup();
  }
});

test("migrated schema contains all 11 conceptual tables", () => {
  const { db, cleanup } = createTestDb();
  try {
    const names = new Set(
      db.sql
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
        .map((r) => r.name),
    );
    for (const t of TABLES) assert.ok(names.has(t), `expected table '${t}'`);
  } finally {
    cleanup();
  }
});

test("inbox carries terminal-unattached housekeeping audit/retention fields", () => {
  const { db, cleanup } = createTestDb();
  try {
    const cols = db.sql
      .all<{ name: string }>("PRAGMA table_info('inbox')")
      .map((r) => r.name);
    for (const c of ["terminal_action", "terminal_reason", "retention_deadline", "housekept_at", "id", "event_key", "work_item_id", "issue_id"]) {
      assert.ok(cols.includes(c), `expected inbox column '${c}'`);
    }
  } finally {
    cleanup();
  }
});

test("ux_issue_one_active: at most one ACTIVE issue_work_items row per issue", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { state: "READY" });
    insertWorkItem(db, { id: "wi-a", repo_id: repo.id, state: "QUEUED", base_branch: "main" });
    insertWorkItem(db, { id: "wi-b", repo_id: repo.id, state: "QUEUED", base_branch: "main" });
    attachIssueToWorkItem(db, issue.id, "wi-a");
    assert.throws(() => attachIssueToWorkItem(db, issue.id, "wi-b"), /UNIQUE/i);
    // After the active link detaches, a second attachment is allowed.
    detachIssueFromWorkItem(db, issue.id, "wi-a");
    attachIssueToWorkItem(db, issue.id, "wi-b");
    assert.deepEqual(activeIssueLinksForIssue(db, issue.id).map((l) => l.work_item_id), ["wi-b"]);
  } finally {
    cleanup();
  }
});

test("ux_resolution_one_active: one ACTIVE resolution session per work item", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    insertWorkItem(db, { id: "wi-s", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    insertSession(db, { id: "ses-1", kind: "resolution", work_item_id: "wi-s", directory: "/wt", state: "ACTIVE" });
    assert.throws(
      () => insertSession(db, { id: "ses-2", kind: "resolution", work_item_id: "wi-s", directory: "/wt2", state: "ACTIVE" }),
      /UNIQUE/i,
    );
    // A triage-kind session does not collide with the resolution index.
    insertSession(db, { id: "ses-t", kind: "triage", work_item_id: "wi-s", directory: "/wt3", state: "ACTIVE" });
  } finally {
    cleanup();
  }
});

test("ux_worktree_one_active and ux_pr_one_active enforce one active per work item", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    insertWorkItem(db, { id: "wi-x", repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    insertWorktree(db, { id: "wt-1", work_item_id: "wi-x", path: "/p1", branch: "b1", state: "ACTIVE" });
    assert.throws(
      () => insertWorktree(db, { id: "wt-2", work_item_id: "wi-x", path: "/p2", branch: "b2", state: "ACTIVE" }),
      /UNIQUE/i,
    );
    insertPullRequest(db, { id: "pr-1", work_item_id: "wi-x", repo_id: repo.id, number: 101, head_ref: "tissue/wi_x", state: "ACTIVE" });
    assert.throws(
      () => insertPullRequest(db, { id: "pr-2", work_item_id: "wi-x", repo_id: repo.id, number: 102, head_ref: "tissue/wi_x2", state: "ACTIVE" }),
      /UNIQUE/i,
    );
  } finally {
    cleanup();
  }
});

test("inbox.id is globally monotonic across issues (AUTOINCREMENT order)", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const i1 = seedIssue(db, repo.id, { state: "TRIAGE_PENDING" });
    const i2 = seedIssue(db, repo.id, { state: "TRIAGE_PENDING" });
    const ids: number[] = [];
    for (const issue of [i1, i1, i2, i1, i2]) {
      ids.push(
        insertInboxEvent(db, {
          issue_id: issue.id,
          event_key: `ev-${issue.number}-${ids.length}`,
          kind: "issue.comment",
          payload_json: JSON.stringify({ n: 1 }),
        }),
      );
    }
    // Strictly increasing = global monotonic order.
    for (let k = 1; k < ids.length; k++) assert.ok(ids[k]! > ids[k - 1]!, `inbox ids must increase: ${ids.join(",")}`);
    // Ordering by a single work item (post re-parent) is by id too.
    const all = db.sql.all<{ id: number }>("SELECT id FROM inbox ORDER BY id");
    assert.deepEqual(all.map((r) => r.id), ids);
  } finally {
    cleanup();
  }
});

test("inbox event_key is UNIQUE: duplicate polling events are rejected", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { state: "TRIAGE_PENDING" });
    insertInboxEvent(db, { issue_id: issue.id, event_key: "dup-1", kind: "issue.comment", payload_json: "{}" });
    assert.throws(
      () => insertInboxEvent(db, { issue_id: issue.id, event_key: "dup-1", kind: "issue.comment", payload_json: "{}" }),
      /UNIQUE/i,
    );
  } finally {
    cleanup();
  }
});

test("JSON boundary columns reject malformed JSON but accept valid strings", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    assert.throws(
      () =>
        upsertRepository(db, {
          id: "repo-j",
          owner: "xiaden",
          name: "jsonbad",
          remote: "x",
          local_dir: "/workspace/x",
          baseline_at: "2026-09-01T00:00:00.000Z",
          poll_interval_seconds: 300,
          labels_json: "{not-json",
        }),
      TissueDbError,
    );
    assert.throws(
      () => seedIssue(db, repo.id, { body_json: "oops", number: 501, title: "t" }),
      TissueDbError,
    );
    const ok = seedIssue(db, repo.id, { number: 502, title: "ok", body_json: JSON.stringify({ a: [1, 2] }) });
    assert.equal(ok.body_json, JSON.stringify({ a: [1, 2] }));
    assert.throws(
      () => insertInboxEvent(db, { issue_id: ok.id, event_key: "bad-payload", kind: "x", payload_json: "{nope" }),
      TissueDbError,
    );
    insertInboxEvent(db, { issue_id: ok.id, event_key: "good-payload", kind: "x", payload_json: "{}" });
  } finally {
    cleanup();
  }
});

test("dependency foreign keys, target identity, uniqueness, and self/cycle rejection are enforced", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { state: "READY" });
    insertWorkItem(db, { id: "wi-dependent", repo_id: repo.id, state: "DEFERRED", base_branch: "main" });
    insertWorkItem(db, { id: "wi-target", repo_id: repo.id, state: "COMPLETED", base_branch: "main" });
    const issueRelation = addWorkItemDependency(db, "wi-dependent", { kind: "issue", id: issue.id });
    assert.equal(issueRelation.dependency_issue_id, issue.id);
    assert.throws(() => addWorkItemDependency(db, "wi-dependent", { kind: "issue", id: issue.id }), /UNIQUE/i);
    assert.throws(() => addWorkItemDependency(db, "wi-dependent", { kind: "work_item", id: "wi-dependent" }), /itself/i);
    addWorkItemDependency(db, "wi-target", { kind: "work_item", id: "wi-dependent" });
    assert.throws(() => addWorkItemDependency(db, "wi-dependent", { kind: "work_item", id: "wi-target" }), /cycle/i);
    assert.throws(() => db.sql.run("INSERT INTO work_item_dependencies(id, dependent_work_item_id, dependency_issue_id, dependency_work_item_id, created_at) VALUES(?,?,?,?,?)", "bad", "missing", issue.id, null, new Date().toISOString()), /FOREIGN KEY/i);
  } finally {
    cleanup();
  }
});

test("foreign keys are enforced for issue and inbox references", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    // Missing repo on an issue.
    assert.throws(
      () => insertIssue(db, { id: "issue-orphan", repo_id: "repo-nope", number: 1, title: "x", state: "NEW", updated_at: "2026-09-09T00:00:00.000Z" }),
      /FOREIGN KEY/i,
    );
    const issue = seedIssue(db, repo.id, { state: "NEW" });
    // Missing issue on an inbox row.
    assert.throws(
      () => insertInboxEvent(db, { issue_id: "issue-nope", event_key: "orphan", kind: "x", payload_json: "{}" }),
      /FOREIGN KEY/i,
    );
    // A valid row is accepted.
    const id = insertInboxEvent(db, { issue_id: issue.id, event_key: "ok", kind: "x", payload_json: "{}" });
    assert.equal(listInboxByWorkItem(db, "wi").length, 0); // not attached yet
    assert.equal(typeof id, "number");
  } finally {
    cleanup();
  }
});

test("side_effects effect_key UNIQUE and state_transitions accept one audit row", () => {
  const { db, cleanup } = createTestDb();
  try {
    insertSideEffect(db, { id: "fx-1", kind: "pr_comment", effect_key: "efk-1", state: "PENDING", payload_json: "{}" });
    assert.throws(
      () => insertSideEffect(db, { id: "fx-2", kind: "pr_comment", effect_key: "efk-1", state: "PENDING", payload_json: "{}" }),
      /UNIQUE/i,
    );
    appendTransition(db, {
      entity_type: "issue",
      entity_id: "issue-1",
      from_state: "NEW",
      to_state: "TRIAGE_PENDING",
      event: "discovered",
      actor: "controller",
    });
    const rows = db.sql.all<{ entity_id: string }>("SELECT entity_id FROM state_transitions");
    assert.deepEqual(rows.map((r) => r.entity_id), ["issue-1"]);
  } finally {
    cleanup();
  }
});
