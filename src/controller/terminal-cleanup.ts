// src/controller/terminal-cleanup.ts
//
// Terminal leftover cleanup (DD "Recovery and startup reconciliation", P3-S2).
//
// A COMPLETED / REJECTED / terminal FAILED WorkItem should have no disposable
// worktree or controller branch left behind. If cleanup previously failed, the
// leftover is a *cleanup failure*: retry the cleanup and emit a human-inspect
// event. It is NEVER a correctness failure and the terminal WorkItem history
// (COMPLETED / REJECTED / FAILED) is NEVER relabelled as FAILED_HOLD.
//
// Retained unchanged and queryable: Issue, WorkItem, PR, transition/effect
// ledgers, logs, session mapping, and the real transcript (R20/R22). This module
// only removes the disposable worktree/branch and marks the worktree ledger.

import { runWrite, type TissueDb } from "../db/open.ts";
import { recordTransition } from "../domain/transitions.ts";
import {
  getRepositoryById,
  getWorkItem,
  listActivePullRequests,
  listActiveWorktrees,
  type WorktreeRow,
} from "../db/repositories.ts";
import type { CleanupResult, WorktreeIdentity } from "./worktrees.ts";
import type { JsonLogger } from "../logging/jsonl.ts";

export const TERMINAL_WORK_ITEM_STATES = ["COMPLETED", "REJECTED", "FAILED"] as const;

export interface TerminalCleanupDeps {
  logger?: JsonLogger;
  now?: Date;
  /** Remove the disposable worktree + local branch (production: cleanupWorktree). */
  removeWorktree(identity: WorktreeIdentity, mode: "merged" | "explicit-failed-hold"): Promise<CleanupResult>;
}

export interface TerminalCleanupLeftover {
  kind: "worktree" | "pull_request";
  workItemId: string;
  ref: string;
  id: string;
}

export interface TerminalCleanupResult {
  scanned: number;
  cleanedWorktrees: string[];
  removedBranches: string[];
  humanInspect: TerminalCleanupLeftover[];
  errors: Array<{ worktreeId: string; error: string }>;
}

const TERMINAL_PLACEHOLDERS = TERMINAL_WORK_ITEM_STATES.map(() => "?").join(", ");

/**
 * Retry cleanup for terminal WorkItems with leftover worktrees/branches and flag
 * leftover PRs for human inspection. Idempotent: cleaned worktrees leave the
 * selected set; terminal history and all retained rows are untouched.
 */
export async function cleanupTerminalLeftovers(
  db: TissueDb,
  deps: TerminalCleanupDeps,
): Promise<TerminalCleanupResult> {
  const now = deps.now ?? new Date();
  const at = now.toISOString();
  const result: TerminalCleanupResult = {
    scanned: 0,
    cleanedWorktrees: [],
    removedBranches: [],
    humanInspect: [],
    errors: [],
  };

  const worktrees = db.sql.all<WorktreeRow>(
    `SELECT w.* FROM worktrees w
       JOIN work_items wi ON wi.id = w.work_item_id
      WHERE wi.state IN (${TERMINAL_PLACEHOLDERS})
        AND w.state IN ('ACTIVE', 'CLEANING')
      ORDER BY w.created_at, w.id`,
    ...TERMINAL_WORK_ITEM_STATES,
  );
  const prs = listActivePullRequests(db).filter((pr) => {
    const wi = getWorkItem(db, pr.work_item_id);
    return wi !== undefined && (TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(wi.state);
  });
  result.scanned = worktrees.length + prs.length;

  for (const wt of worktrees) {
    const wi = getWorkItem(db, wt.work_item_id);
    if (!wi) continue;
    const repo = getRepositoryById(db, wi.repo_id);
    if (!repo) {
      result.errors.push({ worktreeId: wt.id, error: `unknown repository '${wi.repo_id}'` });
      result.humanInspect.push({ kind: "worktree", workItemId: wi.id, ref: wt.branch, id: wt.id });
      continue;
    }

    // ACTIVE -> CLEANING (audited) before touching external state.
    if (wt.state === "ACTIVE") {
      runWrite(db, (tx) => {
        recordTransition(
          tx,
          { type: "worktree", id: wt.id },
          "ACTIVE",
          "CLEANING",
          "cleanup_start",
          { reason: "terminal_leftover", work_item_id: wi.id },
          "controller.cleanup",
        );
        tx.sql.run("UPDATE worktrees SET state = 'CLEANING' WHERE id = ? AND state = 'ACTIVE'", wt.id);
      });
    }

    const identity: WorktreeIdentity = {
      workItemId: wi.id,
      mainDir: repo.local_dir,
      worktreeDir: wt.path,
      branch: wt.branch,
      headSha: null,
      repoSlug: `${repo.owner}-${repo.name}`,
    };
    const mode = wi.state === "FAILED" ? "explicit-failed-hold" : "merged";

    try {
      const cleanup = await deps.removeWorktree(identity, mode);
      runWrite(db, (tx) => {
        recordTransition(
          tx,
          { type: "worktree", id: wt.id },
          "CLEANING",
          "CLEANED",
          "cleanup_done",
          { worktree_removed: cleanup.worktreeRemoved, branch_deleted: cleanup.branchDeleted },
          "controller.cleanup",
        );
        tx.sql.run("UPDATE worktrees SET state = 'CLEANED', cleaned_at = ? WHERE id = ?", at, wt.id);
      });
      result.cleanedWorktrees.push(wt.id);
      if (cleanup.branchDeleted) result.removedBranches.push(wt.branch);
      deps.logger?.info("cleanup.terminal_leftover_cleaned", {
        workItemId: wi.id,
        worktreeId: wt.id,
        branch: wt.branch,
        workItemState: wi.state,
      });
    } catch (err) {
      result.errors.push({ worktreeId: wt.id, error: (err as Error).message });
      result.humanInspect.push({ kind: "worktree", workItemId: wi.id, ref: wt.branch, id: wt.id });
      deps.logger?.warn("cleanup.human_inspect", {
        workItemId: wi.id,
        worktreeId: wt.id,
        branch: wt.branch,
        workItemState: wi.state,
        reason: "cleanup_retry_failed",
        error: (err as Error).message,
      });
    }
  }

  // A leftover PR cannot be removed by the controller without a mutation; it is
  // surfaced for a human and retained (never relabelled, never deleted).
  for (const pr of prs) {
    result.humanInspect.push({ kind: "pull_request", workItemId: pr.work_item_id, ref: pr.head_ref, id: pr.id });
    deps.logger?.warn("cleanup.human_inspect", {
      workItemId: pr.work_item_id,
      prNumber: pr.number,
      headRef: pr.head_ref,
      reason: "terminal_work_item_leftover_pr",
    });
  }

  return result;
}
