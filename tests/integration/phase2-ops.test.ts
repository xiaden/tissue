import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTissueDb, closeDb, runWrite } from "../../src/db/open.ts";
import { upsertRepository, insertIssue, insertWorkItem, insertSession, insertWorktree, insertPullRequestIfAbsent } from "../../src/db/repositories.ts";
import { enqueueOperation, pauseOperation, resumeOperation, cleanupOperation, statusOperation, inspectOperation, historyOperation } from "../../src/controller/ops.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import type { TissueConfig } from "../../src/config/types.ts";

test("Phase 2 ops preserve admission, pause, retained history, and observability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-phase2-"));
  const config: TissueConfig = { pollIntervalSeconds: 60, maxConcurrentGlobal: 3, retentionDays: 30, agents: {}, repos: [] };
  const db = openTissueDb(join(dir, "tissue.db"));
  const repo = upsertRepository(db, { id: "repo-1", owner: "acme", name: "widgets", remote: "https://github.com/acme/widgets.git", local_dir: dir, baseline_at: "2026-01-01T00:00:00.000Z", poll_interval_seconds: 60, max_concurrent_per_repo: 1, protection_json: JSON.stringify({ enabled: true, reviews: 1, checks: ["ci"] }) });
  insertIssue(db, { id: "issue-1", repo_id: repo.id, number: 12, title: "baseline", state: "BASELINE_EXCLUDED", updated_at: new Date().toISOString() });
  insertWorkItem(db, { id: "wi-1", repo_id: repo.id, state: "READY", base_branch: "main" });
  insertSession(db, { id: "session-1", kind: "resolution", repo_id: repo.id, work_item_id: "wi-1", directory: dir, state: "ACTIVE" });
  insertWorktree(db, { id: "wt-1", work_item_id: "wi-1", path: join(dir, "worktree"), branch: "tissue/wi-wi-1", state: "ACTIVE" });
  insertPullRequestIfAbsent(db, { id: "pr-1", work_item_id: "wi-1", repo_id: repo.id, number: 7, head_ref: "tissue/wi-wi-1", head_sha: null, state: "OPEN" });
  closeDb(db);
  const logger = new JsonLogger(new CapturingSink().writeable(), "info", "phase2");
  const ctx = { config, stateDir: dir, logger };
  const admitted = enqueueOperation(ctx, "acme", "widgets", 12);
  assert.equal(admitted.outcome, "admitted");
  const paused = pauseOperation(ctx, "wi-1");
  assert.equal(paused.state, "PAUSED_WORK");
  const reopened = openTissueDb(join(dir, "tissue.db"));
  assert.equal(reopened.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", "wi-1")?.state, "PAUSED_WORK");
  closeDb(reopened);
  const resumed = resumeOperation(ctx, "wi-1");
  assert.equal(resumed.state, "QUEUED");
  const status = statusOperation(ctx) as { failedHold: number; sessions: unknown[]; leases: unknown; transitions: unknown[]; wal: unknown; housekeeping: unknown };
  assert.equal(status.failedHold, 0);
  assert.equal(status.sessions.length, 1);
  assert.ok(status.leases);
  assert.ok(status.transitions.length > 0);
  assert.ok(status.wal);
  assert.ok(status.housekeeping);
  const inspected = inspectOperation(ctx, "acme/widgets") as { pullRequests: unknown[]; protection: unknown };
  assert.equal(inspected.pullRequests.length, 1);
  assert.deepEqual(inspected.protection, { enabled: true, reviews: 1, checks: ["ci"] });
  assert.ok((historyOperation(ctx) as { transitions: unknown[] }).transitions.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test("cleanupOperation emits retained redacted ERROR JSONL and preserves FAILED_HOLD on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-cleanup-"));
  const sink = new CapturingSink();
  const logger = new JsonLogger(sink.writeable(), "info", "cleanup");
  const config: TissueConfig = { pollIntervalSeconds: 60, maxConcurrentGlobal: 3, retentionDays: 30, agents: {}, repos: [] };
  const db = openTissueDb(join(dir, "tissue.db"));
  const repo = upsertRepository(db, { id: "repo-cleanup", owner: "acme", name: "widgets", remote: "https://github.com/acme/widgets.git", local_dir: join(dir, "missing-repo"), baseline_at: "2026-01-01T00:00:00.000Z", poll_interval_seconds: 60, max_concurrent_per_repo: 1 });
  insertWorkItem(db, { id: "wi-hold", repo_id: repo.id, state: "FAILED_HOLD", base_branch: "main" });
  insertWorktree(db, { id: "wt-hold", work_item_id: "wi-hold", path: join(dir, "missing-worktree"), branch: "tissue/wi-hold", state: "ACTIVE" });
  closeDb(db);
  await assert.rejects(() => cleanupOperation({ config, stateDir: dir, logger }, "wi-hold"));
  const reopened = openTissueDb(join(dir, "tissue.db"));
  assert.equal(reopened.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", "wi-hold")?.state, "FAILED_HOLD");
  closeDb(reopened);
  const record = sink.records().find((item) => item.event === "cleanup.human_inspect");
  assert.ok(record);
  assert.equal(record?.lvl, "error");
  assert.equal(record?.workItemId, "wi-hold");
  assert.equal(record?.status, "failure");
  assert.equal(record?.reason, "cleanup_failed");
  assert.doesNotMatch(JSON.stringify(record), /token|secret|credential|transcript|session/i);
  rmSync(dir, { recursive: true, force: true });
});

test("cleanupOperation emits ERROR JSONL on successful explicit cleanup and leaves history queryable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-cleanup-success-"));
  const sink = new CapturingSink();
  const logger = new JsonLogger(sink.writeable(), "info", "cleanup");
  const config: TissueConfig = { pollIntervalSeconds: 60, maxConcurrentGlobal: 3, retentionDays: 30, agents: {}, repos: [] };
  const db = openTissueDb(join(dir, "tissue.db"));
  const repo = upsertRepository(db, { id: "repo-cleanup-ok", owner: "acme", name: "widgets", remote: "https://github.com/acme/widgets.git", local_dir: dir, baseline_at: "2026-01-01T00:00:00.000Z", poll_interval_seconds: 60, max_concurrent_per_repo: 1 });
  insertWorkItem(db, { id: "wi-ok", repo_id: repo.id, state: "FAILED_HOLD", base_branch: "main" });
  closeDb(db);
  const result = await cleanupOperation({ config, stateDir: dir, logger }, "wi-ok");
  assert.equal(result.state, "FAILED");
  const record = sink.records().find((item) => item.event === "cleanup.human_inspect");
  assert.equal(record?.lvl, "error");
  assert.equal(record?.status, "success");
  assert.doesNotMatch(JSON.stringify(record), /token|secret|credential|transcript|session/i);
  const reopened = openTissueDb(join(dir, "tissue.db"));
  try {
    assert.equal(reopened.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", "wi-ok")?.state, "FAILED");
    const transition = reopened.sql.get<{ from_state: string; to_state: string; event: string }>(
      "SELECT from_state, to_state, event FROM state_transitions WHERE entity_id = ? ORDER BY id DESC LIMIT 1",
      "wi-ok",
    );
    assert.equal(transition?.from_state, "FAILED_HOLD");
    assert.equal(transition?.to_state, "FAILED");
    assert.equal(transition?.event, "cleanup");
    const history = historyOperation({ config, stateDir: dir, logger }, "wi-ok") as { transitions: Array<{ entity_id: string; to_state: string }> };
    assert.equal(history.transitions.length, 1);
    assert.equal(history.transitions[0]?.entity_id, "wi-ok");
    assert.equal(history.transitions[0]?.to_state, "FAILED");
  } finally {
    closeDb(reopened);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("Phase 2 status is safe on a fresh state directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-phase2-empty-"));
  const config: TissueConfig = { pollIntervalSeconds: 60, maxConcurrentGlobal: 3, retentionDays: 30, agents: {}, repos: [] };
  const logger = new JsonLogger(new CapturingSink().writeable(), "info", "phase2");
  const report = statusOperation({ config, stateDir: join(dir, "nested"), logger }) as { capacity: { globalLimit: number }; failedHold: number };
  assert.equal(report.capacity.globalLimit, 3);
  assert.equal(report.failedHold, 0);
  rmSync(dir, { recursive: true, force: true });
});
