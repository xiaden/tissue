// src/controller/worktrees.ts
//
// M5 repository-dispatch and disposable-worktree controller (R6/R14/R17; DD
// worktrees/polling sections; CONTRACTS verifyRepository / createWorktree /
// verifyWorktree / cleanupWorktree). This composes the identifier-safe gh and
// git clients into repository-capability verification and the disposable
// worktree lifecycle used before a resolution session and after merge/cleanup.
//
// Contract rules enforced here:
//   - verifyRepository surfaces missing capability (issues disabled, absent
//     default branch, unreachable remote, insufficient auth) — never silently
//     healthy — and throws when authenticated gh readiness cannot be established.
//   - createWorktree creates ONLY a controller-generated `tissue/wi_<opaque-id>`
//     branch and one linked worktree under the resolved worktree root
//     (`TISSUE_WORKTREE_ROOT`, falling back to `<TISSUE_STATE_DIR>/worktrees`)
//     at `<root>/<owner-name>/<work-item-id>`; no other branch shape or location is
//     ever created.
//   - .tissue/ is excluded in the worktree (R17) so untrusted bodies are never
//     staged by a broad `git add -A`.
//   - cleanupWorktree removes the disposable worktree/branch only under the
//     legal calling state; dirty/locked cleanup is retried with --force. Evidence
//     of a FAILED_HOLD item is preserved until an explicit human cleanup invokes
//     it in 'explicit-failed-hold' mode.

import { mkdirSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { resolveWorktreeRoot } from "../config/load.ts";
import type { RepositoryConfig } from "../config/types.ts";
import type { GhClient, ProtectionState } from "../integrations/gh-client.ts";
import { GhError } from "../integrations/gh-client.ts";
import {
  GitArgError,
  GitError,
  isGitRepository,
  remoteUrl,
  currentBranch,
  headSha,
  localBranchExists,
  worktreeAdd,
  worktreeRemove,
  worktreePrune,
  deleteLocalBranch,
  ensureTissueIgnored,
  worktreeDirFor,
} from "../integrations/git-client.ts";

// ---- identity shapes -----------------------------------------------------------

/** A WorkItem identifier as produced by the controller (opaque, identifier-safe). */
export type WorkItemId = string;

/** The durable identity of a created disposable worktree + branch. */
export interface WorktreeIdentity {
  workItemId: string;
  /** Main checkout (owns the repository) — from the repository config. */
  mainDir: string;
  /** Linked-worktree directory (controller-owned, under the worktree root). */
  worktreeDir: string;
  /** Controller-generated branch: exactly `tissue/wi_<opaque-id>`. */
  branch: string;
  /** HEAD object id captured at creation/verification time. */
  headSha: string | null;
  /**
   * The repository segment under the resolved worktree root (owner-name).
   * Creation and cleanup both resolve the canonical containment root from this
   * relative segment, so neither can be redirected outside the controller-owned
   * boundary.
   */
  repoSlug: string;
}

/** Expected identity a caller (work item row) believes a worktree should carry. */
export interface WorkItemIdentity {
  workItemId: string;
  /** The expected controller-generated head branch. */
  headBranch: string;
  /** The repository base branch the work item forks from. */
  baseBranch: string;
}

export interface VerificationResult {
  ok: boolean;
  worktreeDir: string;
  branch: string;
  head: string | null;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

export interface CleanupResult {
  workItemId: string;
  mainDir: string;
  worktreeDir: string;
  branch: string;
  mode: "merged" | "explicit-failed-hold";
  worktreeRemoved: boolean;
  /** True when the worktree was dirty/locked and required a forced removal. */
  worktreeForced: boolean;
  branchDeleted: boolean;
}

// ---- repository capability -----------------------------------------------------

/** Durable readiness verdict derived from a capability probe. */
export interface RepoReadiness {
  ready: boolean;
  reasons: string[];
  checkedAt: string;
}

/** What verifyRepository learned about a configured repository (surfaced, never healthy-by-default). */
export interface RepoCapability {
  owner: string;
  name: string;
  ghBinary: string;
  ghVersionOk: boolean;
  ghAuthenticated: boolean;
  ghAccount?: string;
  checkoutPresent: boolean;
  remotePresent: boolean;
  remoteUrl?: string;
  targetOwner: string;
  targetName: string;
  targetExists: boolean;
  /** Configured push owner/name (the writable fork/checkout target). */
  pushOwner: string;
  pushName: string;
  /** Configured remote name used for push; null means the `origin` default. */
  pushRemote: string | null;
  pushRemotePresent: boolean;
  pushRemoteUrl?: string;
  /** true/false when the URL parses to a GitHub slug, null when unparseable. */
  checkoutRemoteMatchesTarget: boolean | null;
  pushRemoteMatchesExpected: boolean | null;
  writablePushVerified: boolean;
  defaultBranch: string | null;
  /** Configured base branch the controller dispatches work from. */
  baseBranch: string;
  /** null when the default branch could not be read; surfaced, not assumed equal. */
  baseBranchMatchesDefault: boolean | null;
  /** Issues-enabled capability; null = could not be determined (surfaced). */
  issuesEnabled: boolean | null;
  pushPermission: boolean | null;
  protection: ProtectionState;
  /** Protection was read successfully (a 404 is a known-unprotected state). */
  protectionKnown: boolean;
  readiness: RepoReadiness;
}

/** Parse a GitHub remote URL to an `owner/name` slug; null for other remotes. */
export function parseGithubRemoteSlug(url: string): string | null {
  const m = /^(?:https?:\/\/|git:\/\/|ssh:\/\/)?(?:git@)?github\.com[/:]([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** One canonical lexical containment check shared by creation and cleanup. */
export function assertContainedPath(root: string, candidate: string, label = "path"): void {
  const r = resolve(root);
  const c = resolve(candidate);
  if (c !== r && !c.startsWith(`${r}${sep}`)) {
    throw new GitError(`refusing ${label} '${c}' outside Tissue-owned root '${r}'`);
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Reject a symlink that escapes the canonical root even when the lexical path is inside. */
export function assertNoSymlinkEscape(root: string, candidate: string, label = "path"): void {
  const realRoot = realpathOrNull(root) ?? resolve(root);
  const realCandidate = realpathOrNull(candidate);
  if (realCandidate) assertContainedPath(realRoot, realCandidate, label);
}

/**
 * Resolve the canonical containment root for a repository segment under an
 * already-resolved worktree root: `<root>/<subdir>`. `root` is the value
 * returned by `resolveWorktreeRoot` (the `<...>/worktrees` level), NOT the raw
 * state root — there is exactly ONE canonical `worktrees` composition, owned by
 * the resolver, so this function must not append `worktrees` again. `subdir` is
 * always a relative repository slug (owner-name); traversal or absolute segments
 * are rejected so the resolved root can never escape the worktree root.
 * (CONTRACTS resolveContainedWorktreeRoot.)
 */
export function resolveContainedWorktreeRoot(root: string, subdir: string): string {
  const base = resolve(root);
  const contained = resolve(base, subdir);
  assertContainedPath(base, contained, "worktree root");
  return contained;
}

export function resolveContainedWorktreePath(
  root: string,
  subdir: string,
  workItemId: string,
): string {
  const containedRoot = resolveContainedWorktreeRoot(root, subdir);
  const dir = worktreeDirFor(containedRoot, workItemId);
  assertContainedPath(containedRoot, dir, "worktree directory");
  return dir;
}

/** Build the controller-generated branch name for a WorkItem id (exactly `tissue/wi_<opaque>`). */
export function worktreeBranchFor(workItemId: WorkItemId): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workItemId)) {
    throw new GitArgError(`workItemId '${workItemId}' is not identifier-safe for a branch name`);
  }
  return `tissue/wi_${workItemId}`;
}

/**
 * Verify a configured repository before dispatch (CONTRACTS verifyRepository).
 * Checks checkout, remote, base/default branch, Issues capability, protection
 * metadata, and authenticated gh readiness. Missing capability is surfaced in
 * the returned object (never silently healthy); hard readiness failure
 * (unauth'd / too-old gh) throws a classified GhError.
 */
export async function verifyRepository(
  repo: RepositoryConfig,
  gh: GhClient,
): Promise<RepoCapability> {
  const val = await gh.validate();
  if (!val.authenticated || !val.versionOk) {
    throw new GhError(
      "auth",
      `cannot verify ${repo.owner}/${repo.name}: gh authenticated=${val.authenticated} versionOk=${val.versionOk}`,
    );
  }

  const checkoutPresent = await isGitRepository(repo.localDir);
  const pushRemote = repo.pushRemote ?? "origin";
  const remote = checkoutPresent ? await remoteUrl(repo.localDir, "origin") : "";
  const pushRemoteUrl = checkoutPresent ? await remoteUrl(repo.localDir, pushRemote) : "";
  if (!checkoutPresent) {
    throw new GhError("bad_request", `cannot dispatch ${repo.owner}/${repo.name}: local checkout is unavailable`);
  }
  if (remote.length === 0) {
    throw new GhError("bad_request", `cannot dispatch ${repo.owner}/${repo.name}: origin remote is unavailable`);
  }

  let meta: { defaultBranch: string | null; issuesEnabled: boolean | null; push: boolean | null } = {
    defaultBranch: null,
    issuesEnabled: null,
    push: null,
  };
  let protection: ProtectionState = {
    enabled: false,
    requiredApprovals: null,
    enforceAdmins: null,
    requiredChecks: null,
  };

  const targetOwner = repo.targetOwner ?? repo.owner;
  const targetName = repo.targetName ?? repo.name;
  const pushOwner = repo.pushOwner ?? targetOwner;
  const pushName = repo.pushName ?? targetName;
  const pushIsTarget = pushOwner === targetOwner && pushName === targetName;

  // Repository metadata / protection come from authenticated gh, read against
  // the verification *target*. The writable push repository is verified
  // separately when it differs (fork / explicit pushRemote).
  const targetMeta = await gh.repoMeta({ owner: targetOwner, name: targetName });
  meta = {
    defaultBranch: targetMeta.defaultBranch,
    issuesEnabled: targetMeta.issuesEnabled,
    push: targetMeta.permissions?.push ?? null,
  };
  const pushPermission = pushIsTarget
    ? meta.push
    : (await gh.repoMeta({ owner: pushOwner, name: pushName })).permissions?.push ?? null;
  protection = await gh.protection({ owner: targetOwner, name: targetName, branch: repo.baseBranch });

  const checkoutRemoteMatchesTarget = parseGithubRemoteSlug(remote) === `${targetOwner}/${targetName}`;
  const pushRemoteMatchesExpected = pushRemoteUrl ? parseGithubRemoteSlug(pushRemoteUrl) === `${pushOwner}/${pushName}` : false;
  const baseBranchMatchesDefault = meta.defaultBranch === null ? null : repo.baseBranch === meta.defaultBranch;
  const reasons: string[] = [];
  if (!checkoutRemoteMatchesTarget) reasons.push("checkout remote does not match target repository");
  if (!pushRemoteMatchesExpected) reasons.push("push remote does not match configured writable repository");
  if (pushPermission !== true) reasons.push("push permission is unavailable");
  if (meta.issuesEnabled !== true) reasons.push("GitHub Issues capability is unavailable");
  if (baseBranchMatchesDefault !== true) reasons.push("base branch is not verified default");
  if (meta.defaultBranch === null || baseBranchMatchesDefault !== true) {
    throw new GhError("bad_request", `cannot dispatch ${repo.owner}/${repo.name}: base branch '${repo.baseBranch}' is not the verified default branch`);
  }
  if (meta.issuesEnabled !== true) {
    throw new GhError("bad_request", `cannot dispatch ${repo.owner}/${repo.name}: GitHub Issues capability is unavailable`);
  }
  if (pushPermission !== true) {
    throw new GhError("bad_request", `cannot dispatch ${repo.owner}/${repo.name}: push permission is unavailable`);
  }

  return {
    owner: repo.owner,
    name: repo.name,
    targetOwner,
    targetName,
    targetExists: meta.defaultBranch !== null,
    pushOwner,
    pushName,
    pushRemote,
    pushRemotePresent: pushRemoteUrl.length > 0,
    ...(pushRemoteUrl ? { pushRemoteUrl } : {}),
    checkoutRemoteMatchesTarget,
    pushRemoteMatchesExpected,
    writablePushVerified: pushPermission === true && pushRemoteMatchesExpected,
    ghBinary: gh.binary,
    ghVersionOk: val.versionOk,
    ghAuthenticated: val.authenticated,
    ...(val.account ? { ghAccount: val.account } : {}),
    checkoutPresent,
    remotePresent: remote.length > 0,
    ...(remote ? { remoteUrl: remote } : {}),
    defaultBranch: meta.defaultBranch,
    baseBranch: repo.baseBranch,
    baseBranchMatchesDefault,
    issuesEnabled: meta.issuesEnabled,
    pushPermission,
    protection,
    protectionKnown: true,
    readiness: { ready: reasons.length === 0, reasons, checkedAt: new Date().toISOString() },
  };
}

// ---- worktree lifecycle --------------------------------------------------------

/**
 * Create a controller-generated `tissue/wi_<opaque-id>` branch and one linked
 * worktree for a WorkItem, and exclude `.tissue/` in that worktree.
 * (CONTRACTS createWorktree.)
 */
export async function createWorktree(
  repo: RepositoryConfig,
  workItemId: WorkItemId,
): Promise<WorktreeIdentity> {
  if (!(await isGitRepository(repo.localDir))) {
    throw new GitError(`main checkout '${repo.localDir}' is not a git repository`);
  }
  if (!(await localBranchExists(repo.localDir, repo.baseBranch))) {
    throw new GitError(`base branch '${repo.baseBranch}' does not exist in '${repo.localDir}'`);
  }

  const branch = worktreeBranchFor(workItemId);
  if (await localBranchExists(repo.localDir, branch)) {
    throw new GitError(`branch '${branch}' already exists — refusing to reuse an identity`);
  }

  // Disposable space lives under the resolved worktree root: `TISSUE_WORKTREE_ROOT`
  // when set, otherwise `<TISSUE_STATE_DIR ?? ".tissue">/worktrees`. That root is a
  // SHARED storage domain separate from the PRIVATE state root (L7; ADR-003).
  const root = resolveWorktreeRoot(process.env);
  const repoSlug = `${repo.owner}-${repo.name}`;
  const ownedRoot = resolveContainedWorktreeRoot(root, repoSlug);
  // Validate the PHYSICAL ancestry of the repository-slug root against the resolved
  // configured root BEFORE the recursive mkdir can follow it. The lexical containment
  // above cannot see an existing `<root>/<owner>-<repo>` symlink whose target lives
  // outside the root: `mkdirSync(..., {recursive:true})` would follow it, and because
  // the final WorkItem directory does not exist yet the later leaf
  // `assertNoSymlinkEscape(ownedRoot, worktreeDir)` realpaths nothing and misses the
  // escape — letting `git worktree add` create the worktree outside the boundary.
  assertNoSymlinkEscape(root, ownedRoot, "worktree root");
  mkdirSync(ownedRoot, { recursive: true });
  const worktreeDir = resolveContainedWorktreePath(root, repoSlug, workItemId);
  assertNoSymlinkEscape(ownedRoot, worktreeDir, "worktree directory");

  await worktreeAdd({
    mainDir: repo.localDir,
    worktreeDir,
    branch,
    startPoint: repo.baseBranch,
  });
  await ensureTissueIgnored(worktreeDir);

  const sha = await headSha(worktreeDir);
  return { workItemId, mainDir: repo.localDir, worktreeDir, branch, headSha: sha, repoSlug };
}

/**
 * Verify directory, branch, HEAD, and WorkItem identity before push/PR effects
 * (CONTRACTS verifyWorktree). Fails loudly on any identity or branch mismatch.
 */
export async function verifyWorktree(
  identity: WorktreeIdentity,
  expected: WorkItemIdentity,
): Promise<VerificationResult> {
  const bad = (reason: string): VerificationResult => ({
    ok: false,
    worktreeDir: identity.worktreeDir,
    branch: identity.branch,
    head: null,
    reason,
  });

  if (identity.workItemId !== expected.workItemId) {
    return bad(`work item mismatch: identity '${identity.workItemId}' vs expected '${expected.workItemId}'`);
  }
  if (identity.branch !== expected.headBranch) {
    return bad(`branch mismatch: '${identity.branch}' vs expected '${expected.headBranch}'`);
  }
  if (!(await isGitRepository(identity.mainDir))) {
    return bad(`main checkout '${identity.mainDir}' is not a git repository`);
  }
  if (!(await isGitRepository(identity.worktreeDir))) {
    return bad(`worktree '${identity.worktreeDir}' is missing or not a git repository`);
  }
  const actualBranch = await currentBranch(identity.worktreeDir);
  if (actualBranch !== expected.headBranch) {
    return bad(`worktree is on branch '${actualBranch}', expected '${expected.headBranch}'`);
  }
  const head = await headSha(identity.worktreeDir);
  if (identity.headSha !== null && identity.headSha !== head) {
    return bad(`worktree HEAD advanced unexpectedly ('${identity.headSha}' -> '${head}')`);
  }
  return { ok: true, worktreeDir: identity.worktreeDir, branch: identity.branch, head };
}

/**
 * Remove a disposable worktree/branch under legal calling state and prune.
 * Dirty/locked cleanup is retried with --force. FAILED_HOLD evidence is only
 * destroyed when the caller invokes this in 'explicit-failed-hold' mode.
 * (CONTRACTS cleanupWorktree.)
 */
export async function cleanupWorktree(
  identity: WorktreeIdentity,
  mode: "merged" | "explicit-failed-hold",
): Promise<CleanupResult> {
  const root = resolveWorktreeRoot(process.env);
  // Resolve the SAME canonical containment root creation used, from the relative
  // repository segment. A stale/tampered DB path can never authorize deletion
  // outside the controller-owned boundary: it must resolve inside the root and
  // pass the symlink-escape check.
  const ownedRoot = resolveContainedWorktreeRoot(root, identity.repoSlug);
  // Validate the PHYSICAL ancestry of the repository-slug root against the resolved
  // configured root BEFORE any deletion, symmetric with the create-side guard in
  // createWorktree. The lexical check below cannot see an existing
  // `<root>/<owner>-<repo>` symlink whose target lives outside the root: the leaf
  // `assertNoSymlinkEscape(ownedRoot, ownedPath)` realpaths the symlinked `ownedRoot`
  // as its root and would authorize removal of a real worktree that physically
  // resolves outside the configured boundary.
  assertNoSymlinkEscape(root, ownedRoot, "worktree root");
  const ownedPath = resolve(identity.worktreeDir);
  assertContainedPath(ownedRoot, ownedPath, "cleanup");
  assertNoSymlinkEscape(ownedRoot, ownedPath, "cleanup");
  let worktreeRemoved = false;
  let worktreeForced = false;

  if (await isGitRepository(identity.worktreeDir)) {
    try {
      await worktreeRemove(identity.mainDir, identity.worktreeDir, false);
      worktreeRemoved = true;
    } catch {
      // Dirty/locked — retry with --force (dirty/locked cleanup retry).
      await worktreeRemove(identity.mainDir, identity.worktreeDir, true);
      worktreeRemoved = true;
      worktreeForced = true;
    }
  }
  await worktreePrune(identity.mainDir);

  let branchDeleted = false;
  if (await localBranchExists(identity.mainDir, identity.branch)) {
    await deleteLocalBranch(identity.mainDir, identity.branch, true);
    branchDeleted = true;
  }

  return {
    workItemId: identity.workItemId,
    mainDir: identity.mainDir,
    worktreeDir: identity.worktreeDir,
    branch: identity.branch,
    mode,
    worktreeRemoved,
    worktreeForced,
    branchDeleted,
  };
}
