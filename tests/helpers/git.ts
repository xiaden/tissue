// tests/helpers/git.ts
//
// Test-only real git fixtures. Creates a local temporary BARE repository with a
// main-branch commit and clones it into a working "main checkout" — the exact
// topology createWorktree/verifyWorktree/cleanupWorktree operate on. All
// mutation (branch/worktree create/delete, dirty/locked cleanup) runs against
// these local repos only; no remote or real-GitHub state is ever touched.

import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileP("git", args, { cwd });
}

export interface TempRepo {
  dir: string;
  /** Bare origin repository path. */
  bare: string;
  /** Main checkout cloned from the bare origin (default branch main). */
  clone: string;
  cleanup: () => void;
}

/** Build a bare origin with a `main` commit plus a local clone of it. */
export async function createTempRepo(): Promise<TempRepo> {
  const dir = mkdtempSync(join(tmpdir(), "tissue-git-"));
  const bare = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const clone = join(dir, "clone");

  try {
    await git(dir, ["init", "--bare", "-b", "main", bare]);
    mkdirSync(seed);
    await git(seed, ["init", "-b", "main"]);
    await git(seed, ["config", "user.email", "tissue-test@example.com"]);
    await git(seed, ["config", "user.name", "Tissue Test"]);
    writeFileSync(join(seed, "a.txt"), "hello\n");
    await git(seed, ["add", "."]);
    await git(seed, ["commit", "-m", "init"]);
    await git(seed, ["remote", "add", "origin", bare]);
    await git(seed, ["push", "-u", "origin", "main"]);

    await git(dir, ["clone", bare, clone]);
    await git(clone, ["config", "user.email", "tissue-test@example.com"]);
    await git(clone, ["config", "user.name", "Tissue Test"]);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, bare, clone, cleanup };
}
