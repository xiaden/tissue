import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTissueDb, closeDb } from "../../src/db/open.ts";
import { listRepositories, synchronizeConfiguredRepositories, assertDispatchReady, insertWorkItem, persistRepositoryCapability } from "../../src/db/repositories.ts";
import { promoteReadyWorkItems, runNormalLoopPass, type NormalLoopIo } from "../../src/runtime/daemon.ts";
import { claimNextWorkItem } from "../../src/controller/queue.ts";
import { statusOperation, doctorOperation } from "../../src/controller/ops.ts";
import { assertContainedPath, assertNoSymlinkEscape, cleanupWorktree, createWorktree, resolveContainedWorktreePath, verifyRepository } from "../../src/controller/worktrees.ts";
import { GhClient } from "../../src/integrations/gh-client.ts";
import { runGit } from "../../src/integrations/git-client.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import { createTempRepo } from "../helpers/git.ts";
import { writeFakeGh } from "../helpers/fake-gh.ts";
import type { RepositoryConfig } from "../../src/config/types.ts";
import type { TissueConfig } from "../../src/config/types.ts";

function repoConfig(o: { localDir: string } & Partial<RepositoryConfig>): RepositoryConfig {
  return {
    owner: "xiaden", name: "nomarr", enabled: true, pollIntervalSeconds: 300, maxConcurrentPerRepo: 1,
    baseBranch: "main", labels: [], autoMerge: false, priority: 0, ...o,
  };
}

test("production closure sync converges config into an empty Tissue DB and preserves runtime state", () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-p1-"));
  const db = openTissueDb(join(dir, "tissue.db"));
  const config: TissueConfig = {
    pollIntervalSeconds: 60, maxConcurrentGlobal: 3, retentionDays: 30, agents: {},
    repos: [{ owner: "acme", name: "widgets", remote: "https://github.com/acme/widgets.git", localDir: dir,
      enabled: true, pollIntervalSeconds: 60, maxConcurrentPerRepo: 1, baseBranch: "main", labels: [], autoMerge: false, priority: 2 }],
  };
  try {
    const first = synchronizeConfiguredRepositories(db, config, new Date("2026-09-12T00:00:00.000Z"));
    assert.equal(first.inserted, 1);
    assert.equal(listRepositories(db).length, 1);
    db.sql.run("UPDATE repositories SET poll_watermark = ?, triage_attempts = ?, capability_state = ?", "w", 4, "ready");
    const second = synchronizeConfiguredRepositories(db, config, new Date("2026-09-12T00:01:00.000Z"));
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 1);
    const row = listRepositories(db)[0]!;
    assert.equal(row.poll_watermark, "w");
    assert.equal(row.triage_attempts, 4);
    assert.equal(row.capability_state, "ready");
    assertDispatchReady(db, row.id, "poll");
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test("production closure sync disables absent configured rows without deleting history", () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-p1-disable-"));
  const db = openTissueDb(join(dir, "tissue.db"));
  const base: TissueConfig = { pollIntervalSeconds: 60, maxConcurrentGlobal: 3, retentionDays: 30, agents: {}, repos: [] };
  try {
    synchronizeConfiguredRepositories(db, { ...base, repos: [{ owner: "acme", name: "widgets", remote: "https://github.com/acme/widgets.git", localDir: dir, enabled: true, pollIntervalSeconds: 60, maxConcurrentPerRepo: 1, baseBranch: "main", labels: [], autoMerge: false, priority: 0 }] }, new Date());
    const id = listRepositories(db)[0]!.id;
    synchronizeConfiguredRepositories(db, base, new Date());
    const row = listRepositories(db).find((r) => r.id === id)!;
    assert.equal(row.enabled, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test("dispatch readiness fails closed for unknown capability", () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-p1-ready-"));
  const db = openTissueDb(join(dir, "tissue.db"));
  try {
    assert.throws(() => assertDispatchReady(db, "missing", "dispatch"), /not ready|unknown/i);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test("config-managed dispatch fails closed before poll and claim until capability is ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-p1-gate-"));
  const db = openTissueDb(join(dir, "tissue.db"));
  const config: TissueConfig = {
    pollIntervalSeconds: 60, maxConcurrentGlobal: 3, retentionDays: 30, agents: {},
    repos: [{ owner: "acme", name: "widgets", remote: "https://github.com/acme/widgets.git", localDir: dir,
      enabled: true, pollIntervalSeconds: 60, maxConcurrentPerRepo: 1, baseBranch: "main", labels: [], autoMerge: false, priority: 0 }],
  };
  let polled = 0;
  const io = {
    now: () => new Date(),
    logger: { info() {}, debug() {}, warn() {}, error() {} } as unknown as NormalLoopIo["logger"],
    pollRepository: async () => { polled += 1; return {} as never; },
    ingest: () => ({ issuesNew: 0 } as never),
    runTriage: async () => ({ ran: false }),
    claimNext: () => null,
    ensureResolution: async () => null,
    relay: async () => ({ status: "IDLE" }),
    executeEffects: async () => 0,
  } as unknown as NormalLoopIo;
  try {
    synchronizeConfiguredRepositories(db, config, new Date());
    const repoId = listRepositories(db)[0]!.id;
    const blocked = await runNormalLoopPass(db, config, io);
    assert.equal(polled, 0, "unknown readiness must fail closed before polling");
    assert.ok(blocked.errors.some((e) => e.phase === `poll:${repoId}` && /not ready/.test(e.error)));
    insertWorkItem(db, { id: "wi-gate-1", repo_id: repoId, state: "READY", base_branch: "main" });
    assert.equal(promoteReadyWorkItems(db), 0, "unknown readiness must block promotion");
    assert.equal(claimNextWorkItem(db, new Date(), { globalLimit: 3 }), null, "unknown readiness must block claim");
    persistRepositoryCapability(db, repoId, { state: "ready", capability: { ok: true } }, new Date());
    assert.equal(promoteReadyWorkItems(db), 1);
    assert.ok(claimNextWorkItem(db, new Date(), { globalLimit: 3 }));
    const ready = await runNormalLoopPass(db, config, io);
    assert.equal(polled, 1);
    assert.deepEqual(ready.errors, []);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test("target, checkout, and writable push capability are verified against the fork and configured pushRemote", async () => {
  const tr = await createTempRepo();
  const fake = writeFakeGh({
    meta: {
      "repos/xiaden/nomarr": { default_branch: "main", has_issues: true, permissions: { admin: true, push: false, pull: true } },
      "repos/forkowner/nomarr": { default_branch: "main", has_issues: true, permissions: { admin: true, push: true, pull: true } },
    },
    protection: { "repos/xiaden/nomarr/branches/main/protection": "not_protected" },
  });
  try {
    await runGit(["remote", "set-url", "origin", "https://github.com/xiaden/nomarr.git"], { cwd: tr.clone });
    await runGit(["remote", "add", "fork", "https://github.com/forkowner/nomarr.git"], { cwd: tr.clone });
    const gh = new GhClient({ binary: fake.binary });
    const cap = await verifyRepository(
      repoConfig({ localDir: tr.clone, targetOwner: "xiaden", targetName: "nomarr", pushOwner: "forkowner", pushName: "nomarr", pushRemote: "fork" }),
      gh,
    );
    assert.equal(cap.checkoutRemoteMatchesTarget, true);
    assert.equal(cap.pushRemoteMatchesExpected, true);
    assert.equal(cap.writablePushVerified, true);
    assert.equal(cap.pushPermission, true);
    assert.equal(cap.readiness.ready, true);

    const mismatched = await verifyRepository(
      repoConfig({ localDir: tr.clone, targetOwner: "xiaden", targetName: "nomarr", pushOwner: "forkowner", pushName: "nomarr", pushRemote: "origin" }),
      gh,
    );
    assert.equal(mismatched.pushRemoteMatchesExpected, false);
    assert.equal(mismatched.readiness.ready, false);
    assert.ok(mismatched.readiness.reasons.some((r) => /push remote/.test(r)));
  } finally { fake.cleanup(); tr.cleanup(); }
});

// Plan H (spec-first re-root): `resolveContainedWorktreeRoot`/`resolveContainedWorktreePath` take the
// ALREADY-RESOLVED worktree root as their first argument (one canonical containment composition;
// the resolver owns the `TISSUE_STATE_DIR ?? ".tissue"/worktrees` fallback). There is no second
// `worktrees` segment appended — worktrees remain `<root>/<owner>-<repo>/<work-item-id>`.
test("worktree containment rejects traversal/symlink escape and stays under the resolved root", () => {
  const state = mkdtempSync(join(tmpdir(), "tissue-p1-contain-"));
  try {
    const root = join(state, "worktrees");
    assert.throws(() => resolveContainedWorktreePath(root, "../evil", "wi-1"), /outside/i);
    assert.throws(() => assertContainedPath(root, join(root, "..", "evil"), "cleanup"), /outside/i);
    const dir = resolveContainedWorktreePath(root, "xiaden-nomarr", "wi-1");
    assert.ok(dir.startsWith(join(root, "xiaden-nomarr")));
    assert.equal(dir, join(root, "xiaden-nomarr", "wi-1"), "the resolved root must not be re-appended");
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("symlink escape: a path lexically inside the owned root but realpath-resolving outside is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "tissue-p1-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "tissue-p1-symlink-outside-"));
  try {
    writeFileSync(join(outside, "sentinel.txt"), "keep", "utf8");
    const link = join(root, "escape-link");
    symlinkSync(outside, link, "dir");

    // Lexically inside the root …
    assert.ok(link.startsWith(root));
    // … but the realpath resolves outside, so the symlink guard must refuse.
    assert.throws(() => assertNoSymlinkEscape(root, link, "cleanup"), /outside|refusing/i);

    // Positive control: a real in-root directory is accepted.
    const inside = join(root, "real-dir");
    mkdirSync(inside);
    assert.doesNotThrow(() => assertNoSymlinkEscape(root, inside, "cleanup"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("cleanupWorktree refuses a symlinked worktree path that escapes the owned root and preserves the target", async () => {
  const tr = await createTempRepo();
  const state = mkdtempSync(join(tmpdir(), "tissue-p1-cleanup-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "tissue-p1-cleanup-outside-"));
  const previous = process.env.TISSUE_STATE_DIR;
  try {
    process.env.TISSUE_STATE_DIR = state;
    const ownedRoot = join(state, "worktrees", "xiaden-nomarr");
    mkdirSync(ownedRoot, { recursive: true });
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "keep", "utf8");
    const escapeLink = join(ownedRoot, "wi_escape");
    symlinkSync(outside, escapeLink, "dir");

    await assert.rejects(
      cleanupWorktree(
        {
          workItemId: "wi-escape",
          mainDir: tr.clone,
          worktreeDir: escapeLink,
          branch: "tissue/wi_escape",
          headSha: null,
          repoSlug: "xiaden-nomarr",
        },
        "merged",
      ),
      /outside|refusing/i,
    );
    // A tampered path can never authorize deletion outside the owned boundary.
    assert.equal(existsSync(sentinel), true, "out-of-boundary sentinel must be preserved");
    assert.equal(existsSync(outside), true, "out-of-boundary directory must be preserved");
  } finally {
    if (previous === undefined) delete process.env.TISSUE_STATE_DIR;
    else process.env.TISSUE_STATE_DIR = previous;
    tr.cleanup();
    rmSync(state, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("status and doctor expose redacted repository readiness", () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-p1-ops-"));
  const config: TissueConfig = {
    pollIntervalSeconds: 60, maxConcurrentGlobal: 3, retentionDays: 30, agents: {},
    repos: [{ owner: "acme", name: "widgets", remote: "https://github.com/acme/widgets.git", localDir: dir,
      enabled: true, pollIntervalSeconds: 60, maxConcurrentPerRepo: 1, baseBranch: "main", labels: [], autoMerge: false, priority: 0 }],
  };
  const seed = openTissueDb(join(dir, "tissue.db"));
  try {
    synchronizeConfiguredRepositories(seed, config, new Date());
    persistRepositoryCapability(seed, "acme/widgets", { state: "not_ready", capability: { readiness: { reasons: ["push remote does not match configured writable repository"] } } }, new Date());
  } finally { closeDb(seed); }
  const logger = new JsonLogger(new CapturingSink().writeable(), "info", "p1");
  const status = statusOperation({ config, stateDir: dir, logger }) as { repositoryReadiness: Array<Record<string, unknown>> };
  assert.equal(status.repositoryReadiness[0]?.capability, "not_ready");
  assert.equal(status.repositoryReadiness[0]?.ready, false);
  assert.deepEqual(status.repositoryReadiness[0]?.reasons, ["push remote does not match configured writable repository"]);
  const doctor = doctorOperation({ config, stateDir: dir, logger }) as { repositories: Array<Record<string, unknown>> };
  assert.equal(doctor.repositories[0]?.ready, false);
  assert.equal(doctor.repositories[0]?.capability, "not_ready");
  rmSync(dir, { recursive: true, force: true });
});

const DISPATCH_OPERATIONS = ["poll", "triage", "claim", "dispatch", "effect"] as const;

function gateConfig(dir: string): TissueConfig {
  return {
    pollIntervalSeconds: 60, maxConcurrentGlobal: 3, retentionDays: 30, agents: {},
    repos: [{ owner: "acme", name: "widgets", remote: "https://github.com/acme/widgets.git", localDir: dir,
      enabled: true, pollIntervalSeconds: 60, maxConcurrentPerRepo: 1, baseBranch: "main", labels: [], autoMerge: false, priority: 0 }],
  };
}

test("assertDispatchReady fails closed for every dispatch operation until the row is enabled and ready", () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-p1-gate-"));
  const db = openTissueDb(join(dir, "tissue.db"));
  try {
    synchronizeConfiguredRepositories(db, gateConfig(dir), new Date());
    const id = "acme/widgets";
    // Missing row: every operation fails closed.
    for (const op of DISPATCH_OPERATIONS) {
      assert.throws(() => assertDispatchReady(db, "missing/repo", op), /not ready|unknown/i, `missing row must block ${op}`);
    }
    // capability_state starts null (unknown): every operation fails closed.
    for (const op of DISPATCH_OPERATIONS) {
      assert.throws(() => assertDispatchReady(db, id, op), /not ready|unknown/i, `null capability must block ${op}`);
    }
    persistRepositoryCapability(db, id, { state: "not_ready", capability: { readiness: { reasons: ["probe failed"] } } }, new Date());
    for (const op of DISPATCH_OPERATIONS) {
      assert.throws(() => assertDispatchReady(db, id, op), /not ready|unknown/i, `not_ready capability must block ${op}`);
    }
    persistRepositoryCapability(db, id, { state: "unknown", capability: {} }, new Date());
    for (const op of DISPATCH_OPERATIONS) {
      assert.throws(() => assertDispatchReady(db, id, op), /not ready|unknown/i, `unknown capability must block ${op}`);
    }
    // ready but disabled still fails closed.
    persistRepositoryCapability(db, id, { state: "ready", capability: { ok: true } }, new Date());
    db.sql.run("UPDATE repositories SET enabled = 0 WHERE id = ?", id);
    for (const op of DISPATCH_OPERATIONS) {
      assert.throws(() => assertDispatchReady(db, id, op), /not ready|unknown/i, `disabled repo must block ${op}`);
    }
    // enabled + ready is the only passing state.
    db.sql.run("UPDATE repositories SET enabled = 1 WHERE id = ?", id);
    for (const op of DISPATCH_OPERATIONS) {
      assert.doesNotThrow(() => assertDispatchReady(db, id, op), `enabled ready repo must allow ${op}`);
    }
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test("sync disables by owner/name identity so a legacy non-canonical id is never wrongly disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-p1-legacy-"));
  const db = openTissueDb(join(dir, "tissue.db"));
  const config = gateConfig(dir);
  try {
    synchronizeConfiguredRepositories(db, config, new Date("2026-09-12T00:00:00.000Z"));
    // Simulate a legacy/manual row: non-canonical primary key, same identity.
    db.sql.run("UPDATE repositories SET id = ? WHERE id = ?", "legacy-row-42", "acme/widgets");
    const converged = synchronizeConfiguredRepositories(db, config, new Date("2026-09-12T00:01:00.000Z"));
    assert.equal(converged.inserted, 0);
    assert.equal(converged.updated, 1);
    assert.equal(converged.disabled, 0);
    const rows = listRepositories(db);
    assert.equal(rows.length, 1, "the legacy row must not be duplicated or deleted");
    assert.equal(rows[0]!.id, "legacy-row-42");
    assert.equal(rows[0]!.enabled, 1, "identity match must not wrongly disable the legacy row");
    // A genuinely absent repository is still disabled (never deleted).
    const removed = synchronizeConfiguredRepositories(db, { ...config, repos: [] }, new Date("2026-09-12T00:02:00.000Z"));
    assert.equal(removed.disabled, 1);
    const after = listRepositories(db);
    assert.equal(after.length, 1, "disabling must never delete the row");
    assert.equal(after[0]!.id, "legacy-row-42");
    assert.equal(after[0]!.enabled, 0);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

test("config disable retains the row, runtime state, and history; re-add preserves them with no manual upsert", () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-p1-retain-"));
  const db = openTissueDb(join(dir, "tissue.db"));
  const config = gateConfig(dir);
  const createdAt = "2026-01-02T03:04:05.000Z";
  try {
    synchronizeConfiguredRepositories(db, config, new Date("2026-09-12T00:00:00.000Z"));
    const repo = listRepositories(db)[0]!;
    // Durable runtime / triage / session / capability / counter / timestamp state.
    db.sql.run(
      "UPDATE repositories SET poll_watermark=?, triage_attempts=?, triage_failures=?, triage_state=?, triage_session_id=?, capability_state=?, capability_json=?, issues_enabled=?, protection_json=?, created_at=? WHERE id=?",
      "2026-09-10T00:00:00.000Z", 4, 2, "PROMPTING", "ses_triage_1", "ready", JSON.stringify({ ok: true }), 1, JSON.stringify({ enabled: true }), createdAt, repo.id,
    );
    insertWorkItem(db, { id: "wi-history-1", repo_id: repo.id, state: "COMPLETED", base_branch: "main" });
    const before = listRepositories(db)[0]!;

    const disabled = synchronizeConfiguredRepositories(db, { ...config, repos: [] }, new Date("2026-09-12T00:01:00.000Z"));
    assert.equal(disabled.disabled, 1);
    const retained = listRepositories(db);
    assert.equal(retained.length, 1, "disabled row must be retained, never deleted");
    assert.equal(retained[0]!.id, before.id);
    assert.equal(retained[0]!.enabled, 0);
    assert.equal(retained[0]!.poll_watermark, before.poll_watermark);
    assert.equal(retained[0]!.triage_attempts, 4);
    assert.equal(retained[0]!.triage_failures, 2);
    assert.equal(retained[0]!.triage_state, "PROMPTING");
    assert.equal(retained[0]!.triage_session_id, "ses_triage_1");
    assert.equal(retained[0]!.capability_state, "ready");
    assert.equal(retained[0]!.capability_json, JSON.stringify({ ok: true }));
    assert.equal(retained[0]!.issues_enabled, 1);
    assert.equal(retained[0]!.protection_json, JSON.stringify({ enabled: true }));
    assert.equal(retained[0]!.created_at, createdAt, "created_at/audit history preserved");
    assert.equal(db.sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM work_items WHERE id='wi-history-1'")?.count, 1, "work-item history preserved");

    // Re-adding the repo (config.repos only, no manual upsertRepository) preserves history.
    const readded = synchronizeConfiguredRepositories(db, config, new Date("2026-09-12T00:02:00.000Z"));
    assert.equal(readded.updated, 1);
    const after = listRepositories(db)[0]!;
    assert.equal(after.id, before.id);
    assert.equal(after.enabled, 1);
    assert.equal(after.poll_watermark, before.poll_watermark);
    assert.equal(after.triage_attempts, 4);
    assert.equal(after.capability_state, "ready");
    assert.equal(after.created_at, createdAt);
    assert.equal(db.sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM work_items WHERE id='wi-history-1'")?.count, 1);
  } finally { closeDb(db); rmSync(dir, { recursive: true, force: true }); }
});

// Plan H (spec-first re-root): when TISSUE_WORKTREE_ROOT is set, creation and cleanup resolve
// that root while TISSUE_STATE_DIR remains the separate private-state domain (L7/L8, ADR-003).
test("worktrees re-root to TISSUE_WORKTREE_ROOT when set; private state stays separate", async () => {
  const tr = await createTempRepo();
  const root = mkdtempSync(join(tmpdir(), "tissue-p1-wt-reroot-"));
  const state = mkdtempSync(join(tmpdir(), "tissue-p1-wt-reroot-state-"));
  const previousRoot = process.env.TISSUE_WORKTREE_ROOT;
  const previousState = process.env.TISSUE_STATE_DIR;
  try {
    process.env.TISSUE_WORKTREE_ROOT = root;
    process.env.TISSUE_STATE_DIR = state;
    const identity = await createWorktree(repoConfig({ localDir: tr.clone }), "wi-reroot-1");
    assert.equal(identity.repoSlug, "xiaden-nomarr");
    assert.equal(identity.worktreeDir, join(root, "xiaden-nomarr", "wi-reroot-1"), "the worktree must live under TISSUE_WORKTREE_ROOT");
    assert.ok(!identity.worktreeDir.startsWith(state), "the private state dir must not own the worktree");
    const cleaned = await cleanupWorktree(identity, "merged");
    assert.equal(cleaned.worktreeRemoved, true);
    assert.equal(cleaned.branchDeleted, true);
    assert.equal(existsSync(identity.worktreeDir), false);
  } finally {
    if (previousRoot === undefined) delete process.env.TISSUE_WORKTREE_ROOT;
    else process.env.TISSUE_WORKTREE_ROOT = previousRoot;
    if (previousState === undefined) delete process.env.TISSUE_STATE_DIR;
    else process.env.TISSUE_STATE_DIR = previousState;
    tr.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("worktrees live under <state>/worktrees/<owner-name> and cleanup rejects any escape", async () => {
  const tr = await createTempRepo();
  const state = mkdtempSync(join(tmpdir(), "tissue-p1-wt-root-"));
  const previous = process.env.TISSUE_STATE_DIR;
  try {
    process.env.TISSUE_STATE_DIR = state;
    const identity = await createWorktree(repoConfig({ localDir: tr.clone }), "wi-contained-1");
    const expectedRoot = join(state, "worktrees", "xiaden-nomarr");
    assert.ok(identity.worktreeDir.startsWith(expectedRoot), "creation must live under <state>/worktrees/<owner-name>");
    assert.equal(identity.repoSlug, "xiaden-nomarr");
    assert.ok(existsSync(identity.worktreeDir));
    const cleaned = await cleanupWorktree(identity, "merged");
    assert.equal(cleaned.worktreeRemoved, true);
    assert.equal(cleaned.branchDeleted, true);
    assert.equal(existsSync(identity.worktreeDir), false);
    // A stale/tampered absolute path outside the boundary is refused.
    await assert.rejects(
      cleanupWorktree({ ...identity, worktreeDir: join(state, "..", "escape") }, "merged"),
      /outside|refusing/i,
    );
    // A path under a different repository segment is outside this identity's root.
    await assert.rejects(
      cleanupWorktree({ ...identity, worktreeDir: join(state, "worktrees", "other-repo", "wi-x") }, "merged"),
      /outside|refusing/i,
    );
  } finally {
    if (previous === undefined) delete process.env.TISSUE_STATE_DIR;
    else process.env.TISSUE_STATE_DIR = previous;
    tr.cleanup();
    rmSync(state, { recursive: true, force: true });
  }
});
