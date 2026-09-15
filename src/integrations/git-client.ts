// src/integrations/git-client.ts
//
// M5 identifier-safe git subprocess client (R17/DD worktrees section). Every git
// operation is a typed argv spawn (never a shell string). Only controller-
// generated `tissue/wi_<opaque-id>` branches are ever created or deleted, and
// worktree paths are the controller-owned disposable directories derived from
// the Tissue state root (`TISSUE_STATE_DIR`)/worktrees. `.tissue/` context files are excluded from the
// worktree so untrusted issue bodies are never staged by `git add -A`.
//
// `git` (real git 2.47.3) is invoked by name — it is not the unverified PATH gh
// shim and carries no credential advisory. All untrusted GitHub text is DATA and
// never appears in argv; branch/path arguments are validated identifier-safe.

import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { runCaptured, type GhSpawnResult, type SpawnOptions } from "./gh-client.ts";

export class GitError extends Error {
  constructor(message: string) {
    super(`git: ${message}`);
    this.name = "GitError";
  }
}

export class GitArgError extends Error {
  constructor(message: string) {
    super(`git-argv: ${message}`);
    this.name = "GitArgError";
  }
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Assert a branch ref name is safe to pass as a single typed argv token. */
export function assertBranchName(value: string, field = "branch"): string {
  if (value.length === 0 || value.length > 200 || CONTROL_RE.test(value) || !BRANCH_RE.test(value)) {
    throw new GitArgError(`${field}: '${value}' is not a valid identifier-safe branch name`);
  }
  if (value.startsWith("-")) {
    throw new GitArgError(`${field}: branch must not start with '-' (option-injection guard)`);
  }
  return value;
}

/** Assert a controller path is absolute and free of control characters. */
export function assertAbsolutePath(value: string, field = "path"): string {
  if (CONTROL_RE.test(value) || !value.startsWith("/")) {
    throw new GitArgError(`${field}: must be an absolute path with no control characters`);
  }
  return value;
}

/** Run a typed git argv array in an optional working directory. */
export async function runGit(args: readonly string[], opts: SpawnOptions = {}): Promise<GhSpawnResult> {
  return await runCaptured("git", args, opts);
}

/** True when `dir` is inside a git repository (rev-parse --git-dir succeeds). */
export async function isGitRepository(dir: string): Promise<boolean> {
  assertAbsolutePath(dir, "dir");
  const res = await runGit(["rev-parse", "--git-dir"], { cwd: dir });
  return res.exitCode === 0;
}

/** Current checked-out branch (or detached HEAD marker) in `dir`. */
export async function currentBranch(dir: string): Promise<string> {
  const res = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  if (res.exitCode !== 0) throw new GitError(`cannot read HEAD branch in ${dir}`);
  const b = res.stdout.trim();
  return b === "HEAD" ? "" : b;
}

/** Full HEAD object id in `dir`. */
export async function headSha(dir: string): Promise<string> {
  const res = await runGit(["rev-parse", "HEAD"], { cwd: dir });
  if (res.exitCode !== 0) throw new GitError(`cannot read HEAD sha in ${dir}`);
  return res.stdout.trim();
}

/** URL configured for the named remote in `dir` ("" when absent).
 *
 * Reads the *configured* URL (`git config --get remote.<name>.url`) rather than
 * `git remote get-url`, which silently applies `url.<base>.insteadOf` rewriting.
 * Capability verification must see the declared GitHub identity even when a test
 * or operator redirects transport to a local mirror via insteadOf; real git
 * operations still honor the rewrite. */
export async function remoteUrl(dir: string, name = "origin"): Promise<string> {
  assertRemoteName(name);
  const res = await runGit(["config", "--get", `remote.${name}.url`], { cwd: dir });
  return res.exitCode === 0 ? res.stdout.trim() : "";
}

/** Whether the named local branch exists in `dir`. */
export async function localBranchExists(dir: string, branch: string): Promise<boolean> {
  assertBranchName(branch, "branch");
  const res = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: dir });
  return res.exitCode === 0;
}

export interface WorktreeAddSpec {
  /** Main checkout (owns the repository) — absolute path. */
  mainDir: string;
  /** Disposable linked-worktree path under `<TISSUE_STATE_DIR>/worktrees`. */
  worktreeDir: string;
  /** Controller-generated `tissue/wi_<opaque>` branch. */
  branch: string;
  /** Start point ref (e.g. the repo's base branch name in the main clone). */
  startPoint: string;
}

/** `git worktree add -b <branch> <dir> <startPoint>` — typed argv, no shell. */
export async function worktreeAdd(spec: WorktreeAddSpec): Promise<void> {
  assertAbsolutePath(spec.mainDir, "mainDir");
  assertAbsolutePath(spec.worktreeDir, "worktreeDir");
  assertBranchName(spec.branch, "branch");
  assertBranchName(spec.startPoint, "startPoint");
  const res = await runGit(
    ["worktree", "add", "-b", spec.branch, spec.worktreeDir, spec.startPoint],
    { cwd: spec.mainDir },
  );
  if (res.exitCode !== 0) {
    throw new GitError(`worktree add failed for '${spec.worktreeDir}': ${res.stderr.trim()}`);
  }
}

/** `git worktree list --porcelain` for `mainDir`. */
export async function worktreeList(mainDir: string): Promise<string> {
  const res = await runGit(["worktree", "list", "--porcelain"], { cwd: mainDir });
  if (res.exitCode !== 0) throw new GitError(`worktree list failed in ${mainDir}`);
  return res.stdout;
}

/** Remove a linked worktree, forcing it when dirty/locked (typed argv). */
export async function worktreeRemove(mainDir: string, worktreeDir: string, force: boolean): Promise<void> {
  const args = force
    ? ["worktree", "remove", "--force", worktreeDir]
    : ["worktree", "remove", worktreeDir];
  const res = await runGit(args, { cwd: mainDir });
  if (res.exitCode !== 0) {
    throw new GitError(`worktree remove failed for '${worktreeDir}': ${res.stderr.trim()}`);
  }
}

/** Prune stale worktree administrative data in `mainDir`. */
export async function worktreePrune(mainDir: string): Promise<void> {
  const res = await runGit(["worktree", "prune"], { cwd: mainDir });
  if (res.exitCode !== 0) throw new GitError(`worktree prune failed in ${mainDir}`);
}

/** Delete a local branch in `repoDir`; force (-D) discards an unmerged head. */
export async function deleteLocalBranch(repoDir: string, branch: string, force: boolean): Promise<void> {
  assertAbsolutePath(repoDir, "repoDir");
  assertBranchName(branch, "branch");
  const flag = force ? "-D" : "-d";
  const res = await runGit(["branch", flag, branch], { cwd: repoDir });
  if (res.exitCode !== 0) {
    throw new GitError(`branch delete failed for '${branch}': ${res.stderr.trim()}`);
  }
}

/** True when the worktree has uncommitted changes (non-empty porcelain status). */
export async function isDirty(dir: string): Promise<boolean> {
  const res = await runGit(["status", "--porcelain"], { cwd: dir });
  if (res.exitCode !== 0) throw new GitError(`status failed in ${dir}`);
  return res.stdout.trim().length > 0;
}

/** Absolute path of the worktree-local info/exclude file. */
export async function infoExcludePath(dir: string): Promise<string> {
  const res = await runGit(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
    cwd: dir,
  });
  if (res.exitCode !== 0) throw new GitError(`cannot resolve info/exclude in ${dir}`);
  return res.stdout.trim();
}

/**
 * Ensure `.tissue/` is ignored in the worktree so untrusted issue bodies under
 * `.tissue/` are never staged by a broad `git add -A`. Appends to the
 * worktree-local info/exclude if the pattern is not already present.
 */
export async function ensureTissueIgnored(dir: string): Promise<void> {
  const excludeFile = await infoExcludePath(dir);
  let content = "";
  try {
    content = readFileSync(excludeFile, "utf8");
  } catch {
    content = "";
  }
  const lines = content.split("\n").map((l) => l.trim());
  if (!lines.includes(".tissue/")) {
    appendFileSync(excludeFile, content.endsWith("\n") || content.length === 0 ? ".tissue/\n" : "\n.tissue/\n");
  }
}

/** True when `pattern` is ignored by the repo's exclude rules in `dir`. */
export async function isPathIgnored(dir: string, pattern: string): Promise<boolean> {
  const res = await runGit(["check-ignore", "-q", "--", pattern], { cwd: dir });
  return res.exitCode === 0;
}

/** Path join that returns a controller-owned worktree path under a root. */
export function worktreeDirFor(root: string, workItemId: string): string {
  assertAbsolutePath(root, "worktree root");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workItemId) || CONTROL_RE.test(workItemId)) {
    throw new GitArgError(`workItemId '${workItemId}' is not identifier-safe for a worktree path`);
  }
  return join(root, workItemId);
}

// ---- push / remote verification (R17/R18, effect support) -----------------------
// Pushes are NEVER forced and NEVER include --force/--force-with-lease. The effect
// layer verifies the remote ref SHA after pushing so DONE means "remote observed".

const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertRemoteName(value: string): string {
  if (value.length === 0 || value.length > 100 || CONTROL_RE.test(value) || !REMOTE_RE.test(value)) {
    throw new GitArgError(`remote '${value}' is not identifier-safe`);
  }
  return value;
}

export interface PushOptions {
  remote?: string;
  /** Set upstream tracking (`git push -u <remote> <branch>`). Default true. */
  setUpstream?: boolean;
}

/**
 * Push a controller-owned branch to a remote. Typed argv; never force. Throws
 * GitError on failure (callers classify/backoff). The returned branch is the
 * pushed ref; callers must verify the remote SHA separately before DONE.
 */
export async function pushBranch(dir: string, branch: string, opts: PushOptions = {}): Promise<void> {
  assertAbsolutePath(dir, "dir");
  assertBranchName(branch, "branch");
  const remote = assertRemoteName(opts.remote ?? "origin");
  const args = ["push"];
  if (opts.setUpstream ?? true) args.push("-u");
  args.push(remote, branch);
  const res = await runGit(args, { cwd: dir });
  if (res.exitCode !== 0) {
    throw new GitError(`push failed for '${branch}' -> ${remote}: ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

/** Resolve the SHA a remote advertises for a branch (or null when absent). */
export async function remoteBranchSha(dir: string, branch: string, remote = "origin"): Promise<string | null> {
  assertAbsolutePath(dir, "dir");
  assertBranchName(branch, "branch");
  assertRemoteName(remote);
  const res = await runGit(["ls-remote", remote, `refs/heads/${branch}`], { cwd: dir });
  if (res.exitCode !== 0) {
    throw new GitError(`ls-remote failed for '${branch}': ${res.stderr.trim()}`);
  }
  const line = res.stdout.trim().split("\n")[0]?.trim();
  if (!line) return null;
  const sha = line.split(/\s+/)[0] ?? null;
  return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/**
 * List local branch short names in a checkout (drift scan / terminal cleanup).
 * Read-only typed argv; never a shell.
 */
export async function listLocalBranches(dir: string): Promise<string[]> {
  assertAbsolutePath(dir, "dir");
  const res = await runGit(["branch", "--format=%(refname:short)"], { cwd: dir });
  if (res.exitCode !== 0) {
    throw new GitError(`branch list failed in '${dir}'`);
  }
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
