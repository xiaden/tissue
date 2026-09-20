// tests/integration/worktrees.test.ts
//
// P1-S2: real disposable-worktree lifecycle against a LOCAL temporary bare
// repository + clone (tests/helpers/git.ts) plus fake gh for repository
// capability verification. Real-GitHub state is never touched: all branch /
// worktree / dirty / locked / cleanup mutation runs against local repos, and
// repository metadata is served by the executable fake gh.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GhClient, GhError } from "../../src/integrations/gh-client.ts";
import {
  runGit,
  currentBranch,
  isGitRepository,
  isDirty,
  isPathIgnored,
  localBranchExists,
} from "../../src/integrations/git-client.ts";
import {
  createWorktree,
  cleanupWorktree,
  verifyRepository,
  verifyWorktree,
} from "../../src/controller/worktrees.ts";
import type { RepositoryConfig } from "../../src/config/types.ts";
import { createTempRepo } from "../helpers/git.ts";
import { writeFakeGh, defaultNomarrMeta } from "../helpers/fake-gh.ts";

// P3-S7: createWorktree writes linked worktrees beneath TISSUE_STATE_DIR. Use an
// isolated per-run state dir and remove it afterward so repeated `npm test` runs
// are deterministic — no linked worktree from this suite is left under the shared
// default state dir. Assertions are unchanged.
const STATE_DIR = join(process.cwd(), ".tissue", `worktrees-test-${process.pid}-${Date.now()}`);
const PRIOR_STATE_DIR = process.env.TISSUE_STATE_DIR;
process.env.TISSUE_STATE_DIR = STATE_DIR;
after(() => {
  if (PRIOR_STATE_DIR === undefined) delete process.env.TISSUE_STATE_DIR;
  else process.env.TISSUE_STATE_DIR = PRIOR_STATE_DIR;
  rmSync(STATE_DIR, { recursive: true, force: true });
});

// Minimal RepositoryConfig-compatible helper (fills the non-repo-run fields).
function repoConfig(o: { localDir: string } & Partial<RepositoryConfig>): RepositoryConfig {
  return {
    owner: o.owner ?? "xiaden",
    name: o.name ?? "nomarr",
    enabled: true,
    pollIntervalSeconds: 300,
    maxConcurrentPerRepo: 1,
    baseBranch: "main",
    labels: [],
    autoMerge: false,
    priority: 0,
    ...o,
  };
}

test("createWorktree creates tissue/wi_ branch + linked worktree; verify ok; .tissue excluded", async () => {
  const tr = await createTempRepo();
  try {
    const repo = repoConfig({ localDir: tr.clone });
    const wid = "wi-xiaden-nomarr-3";
    const ident = await createWorktree(repo, wid);

    assert.equal(ident.branch, `tissue/wi_${wid}`);
    assert.ok(await isGitRepository(ident.worktreeDir));
    assert.equal(await currentBranch(ident.worktreeDir), ident.branch);
    assert.ok(await localBranchExists(tr.clone, ident.branch));
    assert.ok(ident.headSha && ident.headSha.length === 40, "captures the worktree HEAD sha");

    const v = await verifyWorktree(ident, { workItemId: wid, headBranch: ident.branch, baseBranch: "main" });
    assert.ok(v.ok, v.reason ?? "verifyWorktree should have succeeded");
    assert.equal(v.branch, ident.branch);

    // .tissue/ context is excluded so untrusted bodies are never staged by git add -A.
    assert.ok(await isPathIgnored(ident.worktreeDir, ".tissue/wi-payload.txt"));

    // Only the base branch plus ONE controller tissue/wi_ branch may exist locally.
    const names = (await runGit(["branch", "--list"], { cwd: tr.clone }))
      .stdout.split("\n")
      .map((s) => s.replace(/^[*+ ]+/, "").trim())
      .filter(Boolean);
    assert.ok(names.includes("main"));
    const others = names.filter((n) => n !== "main");
    assert.equal(others.length, 1);
    assert.match(others[0] ?? "", /^tissue\/wi_/);
  } finally {
    tr.cleanup();
  }
});

test("createWorktree refuses to reuse an identity (duplicate branch)", async () => {
  const tr = await createTempRepo();
  try {
    const repo = repoConfig({ localDir: tr.clone });
    const wid = "wi-dup-1";
    const ident = await createWorktree(repo, wid);
    await assert.rejects(createWorktree(repo, wid));
    assert.ok(existsSync(ident.worktreeDir));
  } finally {
    tr.cleanup();
  }
});

test("cleanupWorktree(merged) removes clean worktree + deletes branch + prunes", async () => {
  const tr = await createTempRepo();
  try {
    const repo = repoConfig({ localDir: tr.clone });
    const wid = "wi-clean-1";
    const ident = await createWorktree(repo, wid);
    const res = await cleanupWorktree(ident, "merged");

    assert.equal(res.mode, "merged");
    assert.equal(res.worktreeRemoved, true);
    assert.equal(res.worktreeForced, false);
    assert.equal(res.branchDeleted, true);
    assert.equal(existsSync(ident.worktreeDir), false);
    assert.equal(await localBranchExists(tr.clone, ident.branch), false);
    assert.equal(await isGitRepository(ident.worktreeDir), false);
  } finally {
    tr.cleanup();
  }
});

test("cleanupWorktree retries dirty worktree removal with --force", async () => {
  const tr = await createTempRepo();
  try {
    const repo = repoConfig({ localDir: tr.clone });
    const wid = "wi-dirty-1";
    const ident = await createWorktree(repo, wid);
    writeFileSync(join(ident.worktreeDir, "uncommitted.txt"), "dirty\n");
    assert.ok(await isDirty(ident.worktreeDir));

    const res = await cleanupWorktree(ident, "merged");
    assert.equal(res.worktreeRemoved, true);
    assert.equal(res.worktreeForced, true, "dirty worktree removal must be forced");
    assert.equal(existsSync(ident.worktreeDir), false);
    assert.equal(await localBranchExists(tr.clone, ident.branch), false);
  } finally {
    tr.cleanup();
  }
});

test("verifyWorktree fails loudly on identity / branch mismatch", async () => {
  const tr = await createTempRepo();
  try {
    const repo = repoConfig({ localDir: tr.clone });
    const wid = "wi-neg-1";
    const ident = await createWorktree(repo, wid);

    const badItem = await verifyWorktree(ident, { workItemId: "wi-other-99", headBranch: ident.branch, baseBranch: "main" });
    assert.equal(badItem.ok, false);

    const badBranch = await verifyWorktree(ident, { workItemId: wid, headBranch: "tissue/wi_somethingelse", baseBranch: "main" });
    assert.equal(badBranch.ok, false);
    assert.match(badBranch.reason ?? "", /branch mismatch/);
  } finally {
    tr.cleanup();
  }
});

test("verifyRepository surfaces capability; unauth throws; issues-disabled surfaced", async () => {
  const tr = await createTempRepo();
  const repo = repoConfig({ localDir: tr.clone });

  // Healthy metadata scenario (Issues enabled, branch unprotected).
  const good = writeFakeGh({ meta: defaultNomarrMeta() });
  try {
    const gh = new GhClient({ binary: good.binary });
    const cap = await verifyRepository(repo, gh);
    assert.equal(cap.checkoutPresent, true);
    assert.equal(cap.remotePresent, true);
    assert.equal(cap.defaultBranch, "main");
    assert.equal(cap.baseBranchMatchesDefault, true);
    assert.equal(cap.issuesEnabled, true);
    assert.equal(cap.protection.enabled, false);
    assert.equal(cap.ghAuthenticated, true);
  } finally {
    good.cleanup();
  }

  // Unauthenticated gh → readiness cannot be established → classified error.
  const unauth = writeFakeGh({ auth: false, meta: defaultNomarrMeta() });
  try {
    const gh = new GhClient({ binary: unauth.binary });
    await assert.rejects(verifyRepository(repo, gh), GhError);
  } finally {
    unauth.cleanup();
  }

  // Issues disabled → surfaced (false), never silently healthy.
  const noIssues = writeFakeGh({
    meta: {
      "repos/xiaden/nomarr": { default_branch: "main", has_issues: false, permissions: { admin: true, push: true, pull: true } },
    },
  });
  try {
    const gh = new GhClient({ binary: noIssues.binary });
    await assert.rejects(
      verifyRepository(repo, gh),
      (error: unknown) => error instanceof GhError && /Issues capability is unavailable/.test(error.message),
    );
  } finally {
    noIssues.cleanup();
    tr.cleanup();
  }
});

test("verifyRepository resolves the configured pushRemote (never hard-coded origin) and verifies the writable repo", async () => {
  const tr = await createTempRepo();
  try {
    // Origin points at the target; a separate `fork` remote is the configured push destination.
    await runGit(["remote", "set-url", "origin", "https://github.com/xiaden/nomarr.git"], { cwd: tr.clone });
    await runGit(["remote", "add", "fork", "https://github.com/xiaden-fork/nomarr.git"], { cwd: tr.clone });

    const repo = repoConfig({
      localDir: tr.clone,
      pushRemote: "fork",
      pushOwner: "xiaden-fork",
      pushName: "nomarr",
    });

    const forkMeta = {
      "repos/xiaden-fork/nomarr": { default_branch: "main", has_issues: true, permissions: { admin: true, push: true, pull: true } },
    };
    const fake = writeFakeGh({ meta: { ...defaultNomarrMeta(), ...forkMeta } });
    try {
      const gh = new GhClient({ binary: fake.binary });
      const cap = await verifyRepository(repo, gh);
      assert.equal(cap.pushRemote, "fork");
      assert.equal(cap.pushRemotePresent, true);
      assert.equal(cap.pushRemoteMatchesExpected, true);
      assert.equal(cap.writablePushVerified, true);
      assert.equal(cap.readiness.ready, true, cap.readiness.reasons.join("; "));
    } finally {
      fake.cleanup();
    }

    // A configured pushRemote absent from the checkout fails closed (surfaced, never origin).
    const missing = repoConfig({ localDir: tr.clone, pushRemote: "upstream", pushOwner: "xiaden-fork", pushName: "nomarr" });
    const fake2 = writeFakeGh({ meta: { ...defaultNomarrMeta(), ...forkMeta } });
    try {
      const gh = new GhClient({ binary: fake2.binary });
      const cap = await verifyRepository(missing, gh);
      assert.equal(cap.pushRemotePresent, false);
      assert.equal(cap.pushRemoteMatchesExpected, false);
      assert.equal(cap.writablePushVerified, false);
      assert.equal(cap.readiness.ready, false);
      assert.match(cap.readiness.reasons.join("; "), /push remote/);
    } finally {
      fake2.cleanup();
    }
  } finally {
    tr.cleanup();
  }
});

// P1-S5 (plan H, spec-first): when TISSUE_WORKTREE_ROOT is set, creation and cleanup
// re-root there while TISSUE_STATE_DIR stays the separate private-state domain (ADR-003).
test("createWorktree re-roots under TISSUE_WORKTREE_ROOT when set; private state stays separate", async () => {
  const tr = await createTempRepo();
  const root = mkdtempSync(join(tmpdir(), "tissue-wt-reroot-"));
  const priorRoot = process.env.TISSUE_WORKTREE_ROOT;
  process.env.TISSUE_WORKTREE_ROOT = root;
  try {
    const repo = repoConfig({ localDir: tr.clone });
    const wid = "wi-rerooted-1";
    const ident = await createWorktree(repo, wid);

    assert.equal(ident.repoSlug, "xiaden-nomarr");
    assert.equal(ident.worktreeDir, join(root, "xiaden-nomarr", wid), "the worktree must live under TISSUE_WORKTREE_ROOT");
    assert.equal(ident.branch, `tissue/wi_${wid}`);
    assert.ok(!ident.worktreeDir.startsWith(STATE_DIR), "the configured root must replace the state-rooted derivation");

    const res = await cleanupWorktree(ident, "merged");
    assert.equal(res.worktreeRemoved, true);
    assert.equal(res.branchDeleted, true);
    assert.equal(existsSync(ident.worktreeDir), false);
  } finally {
    if (priorRoot === undefined) delete process.env.TISSUE_WORKTREE_ROOT;
    else process.env.TISSUE_WORKTREE_ROOT = priorRoot;
    tr.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
