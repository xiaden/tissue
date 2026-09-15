// src/controller/enqueue.ts
//
// M5 baseline exclusion / manual admission (R14; CONTRACTS `enqueueIssue`).
//
// Pre-activation issues are BASELINE_EXCLUDED and never become WorkItems through
// normal discovery. The ONLY historical admission path is an explicit `tissue
// enqueue owner/repo#number`, which performs the single legal FSM transition
// BASELINE_EXCLUDED -> NEW (event 'manual_enqueue'). Any other current state is
// not silently admitted — the outcome is surfaced instead.
//
// This module only runs inside a `runWrite` transaction so the state change and
// its audit row are atomic.

import type { TissueDb } from "../db/open.ts";
import { runWrite } from "../db/open.ts";
import { getIssueByRepoNumber, updateIssueState } from "../db/repositories.ts";
import { recordTransition } from "../domain/transitions.ts";

/** Identifier of a configured repository (the repositories.id primary key). */
export interface RepoRef {
  id: string;
}

export interface EnqueueResult {
  applied: boolean;
  /** Machine-readable outcome: admitted | already_new | not_found | not_admissible. */
  outcome: "admitted" | "already_new" | "not_found" | "not_admissible";
  issueId?: string;
  /** Current issue state when it was not admissible. */
  state?: string;
}

/**
 * Admit a BASELINE_EXCLUDED issue into the NEW pipeline through the sole legal
 * transition. Idempotent: an already-NEW issue is reported (not re-transitioned);
 * an issue in any other state is surfaced as not admissible and left untouched.
 */
export function enqueueIssue(db: TissueDb, repo: RepoRef, issueNumber: number): EnqueueResult {
  return runWrite(db, (tx) => {
    const issue = getIssueByRepoNumber(tx, repo.id, issueNumber);
    if (!issue) {
      return { applied: false, outcome: "not_found" } as EnqueueResult;
    }
    if (issue.state === "NEW") {
      return { applied: false, outcome: "already_new", issueId: issue.id } as EnqueueResult;
    }
    if (issue.state !== "BASELINE_EXCLUDED") {
      return {
        applied: false,
        outcome: "not_admissible",
        issueId: issue.id,
        state: issue.state,
      } as EnqueueResult;
    }
    recordTransition(
      tx,
      { type: "issue", id: issue.id },
      "BASELINE_EXCLUDED",
      "NEW",
      "manual_enqueue",
      { repo_id: repo.id, issue_number: issueNumber },
      "human:enqueue",
    );
    updateIssueState(tx, issue.id, "NEW");
    return { applied: true, outcome: "admitted", issueId: issue.id } as EnqueueResult;
  });
}
