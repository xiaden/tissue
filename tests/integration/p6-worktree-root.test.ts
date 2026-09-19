// tests/integration/p6-worktree-root.test.ts
//
// Phase 1 (plan H, spec-first) specification for the `TISSUE_WORKTREE_ROOT` seam.
//
// SEAM CONTRACT (normative):
//   * `TISSUE_WORKTREE_ROOT` is an env scalar — not a YAML key. `resolveWorktreeRoot(env)`
//     returns it verbatim once it passes the shared absolute-path rule.
//   * BYTE-IDENTICAL FALLBACK: when the variable is unset the resolver returns
//     `resolve(env.TISSUE_STATE_DIR ?? ".tissue", "worktrees")` — exactly the path today's
//     derivation produces, so no existing deployed path changes meaning (L25).
//   * CONTAINMENT RE-ROOTED: worktrees remain `<root>/<owner>-<repo>/<work-item-id>`; creation,
//     cleanup, and the drift expected-path derivation all read the SAME resolved root.
//   * GUARDS PRESERVED: `assertContainedPath` and `assertNoSymlinkEscape` are unchanged and are
//     merely evaluated against the resolved root; a stale/tampered stored `worktrees.path` still
//     cannot authorize deletion outside the owned boundary (L7/L8; ADR-003; CONTRACTS :90/:92).
//
// Provenance: this file was authored spec-first (Phase 1) against the specification above and
// now runs against the implemented seam (Phases 2–5 plus the Phase 6 cleanup-ancestor repair).
// Every spec here exercises the current source and passes; a new assertion that does not
// exercise the seam is reported, never silently kept.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { ConfigError, resolveWorktreeRoot, validateAbsolutePath } from "../../src/config/load.ts";
import {
  assertContainedPath,
  assertNoSymlinkEscape,
  cleanupWorktree,
  createWorktree,
  worktreeBranchFor,
  type WorktreeIdentity,
} from "../../src/controller/worktrees.ts";
import { worktreeAdd } from "../../src/integrations/git-client.ts";
import { scanAndAdoptDrift, type DriftScanner, type ObservedArtifacts } from "../../src/controller/drift.ts";
import { getWorkItem, insertWorkItem, insertWorktree } from "../../src/db/repositories.ts";
import { createTempRepo } from "../helpers/git.ts";
import { createTestDb, REPO_ID, seedRepository } from "../helpers/db.ts";
import type { RepositoryConfig } from "../../src/config/types.ts";

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

const ENV_KEYS = ["TISSUE_WORKTREE_ROOT", "TISSUE_STATE_DIR"] as const;

/** Point the process env at a scenario and return a restore closure. */
function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): () => void {
  const prior = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function captureThrow(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error, "expected a thrown Error");
    return error;
  }
  throw new Error("expected the call to throw");
}

async function captureReject(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof Error, "expected a rejected Error");
    return error;
  }
  throw new Error("expected the call to reject");
}

function fakeScanner(observed: ObservedArtifacts): DriftScanner {
  return { scan: async () => observed };
}

function makeTemp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `tissue-p6-${tag}-`));
}

// ---------------------------------------------------------------------------
// P1-S1 — resolver: env scalar wins; unset fallback is byte-identical
// ---------------------------------------------------------------------------

test("P1-S1 resolveWorktreeRoot: TISSUE_WORKTREE_ROOT wins; unset is byte-identical to <TISSUE_STATE_DIR>/worktrees", () => {
  const restore = withEnv({ TISSUE_WORKTREE_ROOT: "/srv/tissue/worktrees", TISSUE_STATE_DIR: "/tmp/state" });
  try {
    assert.equal(
      resolveWorktreeRoot({ TISSUE_WORKTREE_ROOT: "/srv/tissue/worktrees", TISSUE_STATE_DIR: "/tmp/state" }),
      "/srv/tissue/worktrees",
      "when set, the configured worktree root is returned verbatim",
    );

    // Unset: the fallback is exactly today's derivation, via the same `resolve` semantics.
    assert.equal(
      resolveWorktreeRoot({ TISSUE_STATE_DIR: "/tmp/state" }),
      resolve("/tmp/state", "worktrees"),
      "unset must reproduce <TISSUE_STATE_DIR>/worktrees byte-identically",
    );
    assert.equal(
      resolveWorktreeRoot({}),
      resolve(".tissue", "worktrees"),
      "unset TISSUE_STATE_DIR falls back to the .tissue default",
    );

    // A configured root that merely looks like a state dir is still returned verbatim.
    assert.equal(resolveWorktreeRoot({ TISSUE_WORKTREE_ROOT: "/srv/tissue/worktrees" }), "/srv/tissue/worktrees");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// P1-S2 — validation reuses validateAbsolutePath (never re-implemented)
// ---------------------------------------------------------------------------

test("P1-S2 resolveWorktreeRoot rejects relative/control-character roots with the existing ConfigError shape", () => {
  const relative = captureThrow(() => resolveWorktreeRoot({ TISSUE_WORKTREE_ROOT: "relative/worktrees" }));
  const control = captureThrow(() => resolveWorktreeRoot({ TISSUE_WORKTREE_ROOT: "/srv/tissue/\u0000evil" }));
  const sharedRule = captureThrow(() => validateAbsolutePath("relative/worktrees", "TISSUE_WORKTREE_ROOT"));

  assert.ok(relative instanceof ConfigError, "a relative root must throw ConfigError");
  assert.ok(control instanceof ConfigError, "a control-character root must throw ConfigError");
  assert.ok(sharedRule instanceof ConfigError, "validateAbsolutePath must be the shared exported rule");

  assert.match(relative.message, /absolute path with no control characters/);
  assert.match(control.message, /absolute path with no control characters/);

  // Byte-identical to the one shared rule proves the resolver reuses validateAbsolutePath
  // rather than forking its own check.
  assert.equal(relative.message, sharedRule.message);
  assert.match(relative.message, /config: TISSUE_WORKTREE_ROOT:/);
});

// ---------------------------------------------------------------------------
// P1-S3 — createWorktree re-roots under TISSUE_WORKTREE_ROOT
// ---------------------------------------------------------------------------

test("P1-S3 createWorktree places the worktree under TISSUE_WORKTREE_ROOT with a tissue/wi_ branch", async () => {
  const root = makeTemp("wt-root");
  const state = makeTemp("wt-state");
  const restore = withEnv({ TISSUE_WORKTREE_ROOT: root, TISSUE_STATE_DIR: state });
  const tr = await createTempRepo();
  try {
    const wid = "wi-p6-root-1";
    const identity = await createWorktree(repoConfig({ localDir: tr.clone }), wid);

    assert.equal(identity.repoSlug, "xiaden-nomarr");
    assert.equal(identity.worktreeDir, join(root, "xiaden-nomarr", wid), "the worktree must live under the configured root");
    assert.ok(existsSync(identity.worktreeDir));
    assert.match(identity.branch, /^tissue\/wi_/);
    assert.equal(identity.branch, `tissue/wi_${wid}`);
    assert.ok(!identity.worktreeDir.startsWith(state), "the private state dir must not own the worktree");

    // cleanup resolves the same re-rooted root and completes the lifecycle.
    const cleaned = await cleanupWorktree(identity, "merged");
    assert.equal(cleaned.worktreeRemoved, true);
    assert.equal(cleaned.branchDeleted, true);
    assert.equal(existsSync(identity.worktreeDir), false);
  } finally {
    tr.cleanup();
    restore();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1-S4 — cleanup resolves the same root; guards + messages preserved
// ---------------------------------------------------------------------------

test("P1-S4 cleanupWorktree uses TISSUE_WORKTREE_ROOT and preserves the containment/symlink rejections", async () => {
  const root = makeTemp("clean-root");
  const state = makeTemp("clean-state");
  const outside = makeTemp("clean-outside");
  const restore = withEnv({ TISSUE_WORKTREE_ROOT: root, TISSUE_STATE_DIR: state });
  const tr = await createTempRepo();
  try {
    const wid = "wi-p6-clean-1";
    const identity = await createWorktree(repoConfig({ localDir: tr.clone }), wid);
    const ownedRoot = join(root, "xiaden-nomarr");
    assert.equal(identity.worktreeDir, join(ownedRoot, wid));
    mkdirSync(ownedRoot, { recursive: true });

    // A real worktree created under the configured root cleans up through the same root.
    const cleaned = await cleanupWorktree(identity, "merged");
    assert.equal(cleaned.worktreeRemoved, true);
    assert.equal(cleaned.branchDeleted, true);
    assert.equal(existsSync(identity.worktreeDir), false);

    // Traversal (`../..`) candidate is rejected with the unchanged assertContainedPath message,
    // naming the configured root — proving cleanup re-rooted rather than kept the state root.
    const traversal = join(ownedRoot, "..", "..", "escape");
    const traversalError = await captureReject(() => cleanupWorktree({ ...identity, worktreeDir: traversal }, "merged"));
    assert.match(traversalError.message, /refusing cleanup .* outside Tissue-owned root/);
    assert.ok(traversalError.message.includes(ownedRoot), "the rejection must name the configured worktree root");

    // Symlink-escape candidate: lexically inside, realpath outside.
    writeFileSync(join(outside, "sentinel.txt"), "keep", "utf8");
    const escapeLink = join(ownedRoot, "wi_escape");
    symlinkSync(outside, escapeLink, "dir");
    const symlinkError = await captureReject(() => cleanupWorktree({ ...identity, worktreeDir: escapeLink }, "merged"));
    assert.match(symlinkError.message, /outside|refusing/i);
    assert.equal(existsSync(join(outside, "sentinel.txt")), true, "a tampered path must never authorize deletion outside the owned boundary");
  } finally {
    tr.cleanup();
    restore();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1-S5 — drift expected-worktree derivation reads TISSUE_WORKTREE_ROOT
// ---------------------------------------------------------------------------

test("P1-S5 drift never reports a recorded worktree under TISSUE_WORKTREE_ROOT as ROGUE", async () => {
  const root = makeTemp("drift-root");
  const state = makeTemp("drift-state");
  const restore = withEnv({ TISSUE_WORKTREE_ROOT: root, TISSUE_STATE_DIR: state });
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    const wi = "wi-xiaden-nomarr-drift-recorded";
    const canonical = worktreeBranchFor(wi);
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "RUNNING", base_branch: "main", head_branch: canonical });

    const expectedPath = join(root, "xiaden-nomarr", wi);
    insertWorktree(db, { id: "wt-reroot-recorded", work_item_id: wi, path: expectedPath, branch: canonical, state: "ACTIVE" });

    const result = await scanAndAdoptDrift(db, wi, fakeScanner({
      branches: [],
      worktrees: [{ path: expectedPath, branch: canonical }],
      prs: [],
    }));
    assert.equal(result.unexpected.length, 0, "a recorded worktree under TISSUE_WORKTREE_ROOT must never be ROGUE");
    assert.equal(getWorkItem(db, wi)?.state, "RUNNING");
  } finally {
    cleanup();
    restore();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("P3-S3 real cleanup and drift callers use TISSUE_WORKTREE_ROOT", async () => {
  const root = makeTemp("real-caller-root");
  const state = makeTemp("real-caller-state");
  const restore = withEnv({ TISSUE_WORKTREE_ROOT: root, TISSUE_STATE_DIR: state });
  const tr = await createTempRepo();
  const { db, cleanup } = createTestDb();
  try {
    const wi = "wi-p3-real-caller";
    const identity = await createWorktree(repoConfig({ localDir: tr.clone }), wi);
    seedRepository(db, { id: REPO_ID });
    insertWorkItem(db, { id: wi, repo_id: REPO_ID, state: "RUNNING", base_branch: "main", head_branch: identity.branch });
    insertWorktree(db, { id: `wt-${wi}`, work_item_id: wi, path: identity.worktreeDir, branch: identity.branch, state: "ACTIVE" });
    const drift = await scanAndAdoptDrift(db, wi, fakeScanner({ branches: [], worktrees: [{ path: identity.worktreeDir, branch: identity.branch }], prs: [] }));
    assert.equal(drift.unexpected.length, 0, "real drift scan must recognize the configured-root worktree");
    const cleaned = await cleanupWorktree(identity, "merged");
    assert.equal(cleaned.worktreeRemoved, true);
    assert.equal(existsSync(identity.worktreeDir), false, "real cleanup must delete only the configured-root worktree");
  } finally {
    cleanup(); tr.cleanup(); restore();
    rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true });
  }
});

test("P1-S5 drift expected-worktree derivation uses TISSUE_WORKTREE_ROOT (state root no longer attributes; configured root does)", async () => {
  const root = makeTemp("drift-derive-root");
  const state = makeTemp("drift-derive-state");
  const restore = withEnv({ TISSUE_WORKTREE_ROOT: root, TISSUE_STATE_DIR: state });
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });

    // (b) A worktree at the OLD state-rooted expected path is no longer this WorkItem's
    // expected worktree: the derivation must not attribute it (no false ROGUE).
    const stateWi = "wi-xiaden-nomarr-drift-state";
    insertWorkItem(db, { id: stateWi, repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });
    const statePath = join(state, "worktrees", "xiaden-nomarr", stateWi);
    const stateResult = await scanAndAdoptDrift(db, stateWi, fakeScanner({
      branches: [],
      worktrees: [{ path: statePath, branch: "tissue/wi_not-canonical" }],
      prs: [],
    }));
    assert.equal(stateResult.unexpected.length, 0, "the state-rooted derivation must no longer attribute worktrees");

    // (c) A worktree AT the configured-root expected path IS attributed to this WorkItem,
    // proving `expectedWorktreeDir` is derived from TISSUE_WORKTREE_ROOT.
    const rootWi = "wi-xiaden-nomarr-drift-configured";
    insertWorkItem(db, { id: rootWi, repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });
    const rootPath = join(root, "xiaden-nomarr", rootWi);
    const rootResult = await scanAndAdoptDrift(db, rootWi, fakeScanner({
      branches: [],
      worktrees: [{ path: rootPath, branch: "tissue/wi_not-canonical" }],
      prs: [],
    }));
    assert.ok(
      rootResult.unexpected.some((artifact) => artifact.kind === "worktree" && artifact.path === rootPath),
      "the configured-root expected path must be attributed to the WorkItem",
    );
  } finally {
    cleanup();
    restore();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// P5-S1 — creation-time repository-slug ancestor containment (QA CRITICAL)
// ---------------------------------------------------------------------------
//
// RED-before-fix regression: the repository-slug root `<root>/xiaden-nomarr` already
// exists as a symlink to a directory OUTSIDE the configured root. `mkdirSync(ownedRoot,
// {recursive:true})` follows that symlink, and because the final WorkItem directory does
// not exist yet the later `assertNoSymlinkEscape` realpaths nothing and cannot see the
// escape — so `git worktree add` creates `<outside>/<work-item-id>`. The repair (P5-S2)
// must reject the escaping repository-slug ancestor BEFORE mkdir follows it and BEFORE
// `git worktree add` runs, leaving the outside directory and its sentinel untouched.

test("P5-S1 createWorktree rejects an escaping repository-slug ancestor symlink before mkdir/git worktree add", async () => {
  const root = makeTemp("slug-escape-root");
  const state = makeTemp("slug-escape-state");
  const outside = makeTemp("slug-escape-outside");
  const restore = withEnv({ TISSUE_WORKTREE_ROOT: root, TISSUE_STATE_DIR: state });
  const tr = await createTempRepo();
  try {
    // Sentinel in the outside directory: it must survive untouched.
    writeFileSync(join(outside, "sentinel.txt"), "keep", "utf8");

    // The exact repository slug used by the test repo, existing as a symlink that
    // escapes the configured root.
    const slugLink = join(root, "xiaden-nomarr");
    symlinkSync(outside, slugLink, "dir");
    assert.ok(lstatSync(slugLink).isSymbolicLink(), "precondition: the repository-slug ancestor is a symlink");

    const wid = "wi-p6-slug-escape-1";
    let rejected: Error | undefined;
    try {
      await createWorktree(repoConfig({ localDir: tr.clone }), wid);
    } catch (error) {
      rejected = error as Error;
    }

    const outsideContents = readdirSync(outside).sort();
    assert.ok(
      rejected instanceof Error,
      "createWorktree must reject an escaping repository-slug ancestor symlink before mkdir/git worktree add; " +
        `observed: resolved without rejection (outside/<wid> exists=${existsSync(join(outside, wid))}, ` +
        `outside contents=[${outsideContents.join(", ")}])`,
    );
    assert.match(
      rejected.message,
      /outside Tissue-owned root/,
      "the rejection must be the shared containment guard message",
    );

    // Rejection must occur before anything is created outside the configured root.
    assert.equal(existsSync(join(outside, wid)), false, "no worktree may be created outside the configured root");
    assert.equal(existsSync(join(outside, "sentinel.txt")), true, "the outside sentinel must remain untouched");
    assert.deepEqual(readdirSync(outside), ["sentinel.txt"], "the outside directory must be untouched");
    assert.ok(lstatSync(slugLink).isSymbolicLink(), "the escaping symlink must not be replaced by a real directory");
  } finally {
    tr.cleanup();
    restore();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P6-S1 — cleanup-time repository-slug ancestor containment (QA MAJOR escalation)
// ---------------------------------------------------------------------------
//
// RED-before-fix regression, symmetric with P5-S1 on the create side: the repository-slug
// root `<root>/xiaden-nomarr` exists as a symlink to a directory OUTSIDE the configured
// root, and a real linked worktree physically lives at `<outside>/<work-item-id>` through
// that symlink. The stored/observed `worktreeDir` `join(<root>, "xiaden-nomarr", <wid>)`
// is lexically inside `ownedRoot` but realpaths outside the configured root, so the current
// cleanup validates it only against the symlinked `ownedRoot` and authorizes deletion
// outside the boundary. The repair (P6-S2) must validate the physical ancestry of the
// repository-slug root against the resolved configured root BEFORE any removal, rejecting
// with the existing guard message and leaving the outside directory and its sentinel intact.

test("P6-S1 cleanupWorktree rejects an escaping repository-slug ancestor symlink before any removal", async () => {
  const root = makeTemp("clean-slug-escape-root");
  const state = makeTemp("clean-slug-escape-state");
  const outside = makeTemp("clean-slug-escape-outside");
  const restore = withEnv({ TISSUE_WORKTREE_ROOT: root, TISSUE_STATE_DIR: state });
  const tr = await createTempRepo();
  try {
    // Sentinel in the outside directory: it must survive untouched.
    writeFileSync(join(outside, "sentinel.txt"), "keep", "utf8");

    // The exact repository slug used by the test repo, existing as a symlink that
    // escapes the configured root.
    const slugLink = join(root, "xiaden-nomarr");
    symlinkSync(outside, slugLink, "dir");
    assert.ok(lstatSync(slugLink).isSymbolicLink(), "precondition: the repository-slug ancestor is a symlink");

    // A REAL linked worktree placed at `<root>/xiaden-nomarr/<wid>`, which the escaping
    // repository-slug symlink physically resolves to `<outside>/<wid>`.
    const wid = "wi-p6-clean-slug-escape";
    const branch = worktreeBranchFor(wid);
    const linkedPath = join(root, "xiaden-nomarr", wid);
    const outsideWorktree = join(outside, wid);
    await worktreeAdd({ mainDir: tr.clone, worktreeDir: linkedPath, branch, startPoint: "main" });
    assert.equal(
      realpathSync(linkedPath),
      realpathSync(outsideWorktree),
      "precondition: the stored worktree path physically resolves outside the configured root",
    );
    assert.ok(
      !realpathSync(linkedPath).startsWith(`${realpathSync(root)}${sep}`),
      "precondition: the real worktree lives outside the configured root",
    );

    const identity: WorktreeIdentity = {
      workItemId: wid,
      mainDir: tr.clone,
      worktreeDir: linkedPath,
      branch,
      headSha: null,
      repoSlug: "xiaden-nomarr",
    };

    // The repair must reject BEFORE any removal, with the existing containment message shape.
    const rejected = await captureReject(() => cleanupWorktree(identity, "merged"));
    assert.match(rejected.message, /refusing/);
    assert.match(rejected.message, /outside Tissue-owned root/);

    // Nothing outside the configured root may be deleted or mutated.
    assert.equal(existsSync(join(outside, "sentinel.txt")), true, "the outside sentinel must remain untouched");
    assert.ok(existsSync(outsideWorktree), "the real outside worktree must survive the rejected cleanup");
    assert.deepEqual(
      readdirSync(outside).sort(),
      ["sentinel.txt", wid].sort(),
      "the outside directory must be untouched (sentinel + real worktree still present)",
    );
    assert.ok(lstatSync(slugLink).isSymbolicLink(), "the escaping symlink must not be replaced by a real directory");

    // The linked-worktree registration remains valid (nothing was removed/pruned).
    assert.ok(existsSync(join(tr.clone, ".git", "worktrees")), "the main checkout's worktree registration must survive");
  } finally {
    tr.cleanup();
    restore();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
