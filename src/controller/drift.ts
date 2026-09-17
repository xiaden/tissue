// src/controller/drift.ts
//
// Drift detection + adoption (DD "Recovery and startup reconciliation", P3-S1).
//
// An artifact-owning WorkItem has a *canonical* set of artifacts: its controller
// branch, its ACTIVE worktree row, and its PR rows. A shape-filtered scan asks
// external reality (local git + gh) what controller-shaped artifacts exist. Any
// observed artifact that belongs to this WorkItem but is not in the canonical set
// is an *unexpected artifact diff*.
//
// When drift exists the controller adopts the ENTIRE unexpected diff for the
// owning WorkItem in ONE failure transaction:
//   - local branch   -> recorded as the WorkItem head branch
//   - worktree       -> adopted as a ROGUE evidence worktree row
//   - pull request   -> adopted as a ROGUE evidence PR row (never a second ACTIVE
//                       PR, preserving the `ux_pr_one_active` invariant)
// and the WorkItem is moved to FAILED_HOLD via the legal `drift` transition.
//
// An owner ALREADY in FAILED_HOLD absorbs and logs every unexpected artifact
// without re-entering FAILED_HOLD (and without an illegal transition). Terminal
// history (COMPLETED / REJECTED / FAILED) is NEVER relabelled as FAILED_HOLD —
// such rows are not artifact-owning and the pass is a no-op.

import { resolve } from "node:path";

import { ARTIFACT_OWNING_WORK_ITEM_STATES, isLegalTransition } from "../domain/state-machine.ts";
import { recordTransition } from "../domain/transitions.ts";
import { runWrite, type TissueDb } from "../db/open.ts";
import {
  appendTransition,
  getRepositoryById,
  getWorkItem,
  insertPullRequestIfAbsent,
  insertWorktreeIfAbsent,
  listPullRequestsByWorkItem,
  listWorktreesByWorkItem,
  setWorkItemHeadBranch,
  setWorkItemState,
  type RepositoryRow,
} from "../db/repositories.ts";
import { resolveWorktreeRoot } from "../config/load.ts";
import { argvPrList, type GhClient } from "../integrations/gh-client.ts";
import { listLocalBranches, worktreeDirFor, worktreeList } from "../integrations/git-client.ts";
import type { JsonLogger } from "../logging/jsonl.ts";
import { worktreeBranchFor } from "./worktrees.ts";

export interface ObservedWorktree {
  path: string;
  branch: string;
}

export interface ObservedPr {
  number: number;
  headRef: string;
  state: string;
}

export interface ObservedArtifacts {
  branches: string[];
  worktrees: ObservedWorktree[];
  prs: ObservedPr[];
}

/** External read surface for a drift scan (injectable; production reads git + gh). */
export interface DriftScanner {
  scan(repo: RepositoryRow): Promise<ObservedArtifacts>;
}

export type DriftArtifactKind = "branch" | "worktree" | "pr";

export interface DriftArtifact {
  kind: DriftArtifactKind;
  ref: string;
  path?: string;
  prNumber?: number;
  state?: string;
}

export interface DriftResult {
  workItemId: string;
  scanned: boolean;
  reason?: string;
  expected: { branch: string | null; worktreeBranches: string[]; prNumbers: number[] };
  unexpected: DriftArtifact[];
  adopted: DriftArtifact[];
  absorbed: DriftArtifact[];
  transitionedToFailedHold: boolean;
  alreadyFailedHold: boolean;
}

export interface DriftOptions {
  logger?: JsonLogger;
}

/**
 * Scan and adopt drift for one WorkItem. Idempotent: once the entire unexpected
 * diff is adopted it enters the canonical set, so a repeat scan adopts nothing.
 */
export async function scanAndAdoptDrift(
  db: TissueDb,
  workItemId: string,
  scanner: DriftScanner,
  opts: DriftOptions = {},
): Promise<DriftResult> {
  const workItem = getWorkItem(db, workItemId);
  if (!workItem) {
    return emptyResult(workItemId, false, "unknown_work_item");
  }
  if (!ARTIFACT_OWNING_WORK_ITEM_STATES.has(workItem.state)) {
    // Terminal history is never relabelled as FAILED_HOLD.
    return emptyResult(workItemId, false, `state ${workItem.state} is not artifact-owning`);
  }
  const repo = getRepositoryById(db, workItem.repo_id);
  if (!repo) {
    return emptyResult(workItemId, false, "unknown_repository");
  }

  // The canonical controller branch: the stored head branch, or the branch the
  // WorkItem id deterministically yields (pre-claim QUEUED rows may not have one).
  const canonicalBranch = workItem.head_branch ?? worktreeBranchFor(workItemId);
  // Expected worktree directory derives from the SAME resolved worktree root
  // creation uses (`TISSUE_WORKTREE_ROOT`, falling back byte-identically to
  // `<TISSUE_STATE_DIR ?? ".tissue">/worktrees`) plus the owner-repo segment.
  // A stale state-rooted derivation would fail to attribute migrated worktrees
  // and mis-report them as `ROGUE` -> FAILED_HOLD (DD §6.2).
  const root = resolve(resolveWorktreeRoot(process.env), `${repo.owner}-${repo.name}`);
  const expectedWorktreeDir = worktreeDirFor(root, workItemId);

  const worktreeRows = listWorktreesByWorkItem(db, workItemId);
  const prRows = listPullRequestsByWorkItem(db, workItemId);
  const expected = {
    branch: workItem.head_branch,
    worktreeBranches: worktreeRows.map((w) => w.branch),
    prNumbers: prRows.map((p) => p.number),
  };

  const observed = await scanner.scan(repo);

  // Shape filter: only artifacts attributable to THIS WorkItem's controller
  // identity are considered (exact branch or the deterministic worktree dir
  // derived from the resolved worktree root above).
  const ownedBranches = observed.branches.filter((b) => b === canonicalBranch);
  const ownedWorktrees = observed.worktrees.filter(
    (w) => w.branch === canonicalBranch || w.path === expectedWorktreeDir,
  );
  const ownedPrs = observed.prs.filter((p) => p.headRef === canonicalBranch);

  const unexpected: DriftArtifact[] = [];

  if (ownedBranches.length > 0 && workItem.head_branch !== canonicalBranch) {
    unexpected.push({ kind: "branch", ref: canonicalBranch });
  }
  const expectedWorktreeKeys = new Set(worktreeRows.map((w) => `${w.branch}\u0000${w.path}`));
  for (const w of ownedWorktrees) {
    if (!expectedWorktreeKeys.has(`${w.branch}\u0000${w.path}`)) {
      unexpected.push({ kind: "worktree", ref: w.branch, path: w.path });
    }
  }
  for (const p of ownedPrs) {
    if (!expected.prNumbers.includes(p.number)) {
      unexpected.push({ kind: "pr", ref: p.headRef, prNumber: p.number, state: p.state });
    }
  }

  if (unexpected.length === 0) {
    return {
      workItemId,
      scanned: true,
      expected,
      unexpected: [],
      adopted: [],
      absorbed: [],
      transitionedToFailedHold: false,
      alreadyFailedHold: workItem.state === "FAILED_HOLD",
    };
  }

  const alreadyFailedHold = workItem.state === "FAILED_HOLD";
  const legalHold = isLegalTransition("work_item", workItem.state, "FAILED_HOLD", "drift");

  // ONE failure transaction adopts the ENTIRE unexpected artifact diff.
  runWrite(db, (tx) => {
    unexpected.forEach((artifact, index) => {
      if (artifact.kind === "branch") {
        setWorkItemHeadBranch(tx, workItemId, artifact.ref);
      } else if (artifact.kind === "worktree") {
        insertWorktreeIfAbsent(tx, {
          id: `drift-wt-${workItemId}-${index}`,
          work_item_id: workItemId,
          path: artifact.path ?? "",
          branch: artifact.ref,
          state: "ROGUE",
        });
      } else {
        insertPullRequestIfAbsent(tx, {
          id: `drift-pr-${workItemId}-${artifact.prNumber}`,
          work_item_id: workItemId,
          repo_id: workItem.repo_id,
          number: artifact.prNumber ?? 0,
          head_ref: artifact.ref,
          state: "ROGUE",
          origin: "rogue",
        });
      }
    });

    const evidence = {
      reason: "unexpected_artifact_diff",
      unexpected,
      workItemState: workItem.state,
    };
    if (alreadyFailedHold) {
      // Absorb: record durable evidence, do NOT re-enter FAILED_HOLD.
      appendTransition(tx, {
        entity_type: "work_item",
        entity_id: workItemId,
        from_state: workItem.state,
        to_state: workItem.state,
        event: "drift_absorbed",
        reason_json: JSON.stringify(evidence),
        actor: "controller.drift",
      });
    } else if (legalHold) {
      recordTransition(
        tx,
        { type: "work_item", id: workItemId },
        workItem.state,
        "FAILED_HOLD",
        "drift",
        evidence,
        "controller.drift",
      );
      setWorkItemState(tx, workItemId, "FAILED_HOLD");
    } else {
      // No legal edge from this state: record evidence, change nothing.
      appendTransition(tx, {
        entity_type: "work_item",
        entity_id: workItemId,
        from_state: workItem.state,
        to_state: workItem.state,
        event: "drift_observed",
        reason_json: JSON.stringify(evidence),
        actor: "controller.drift",
      });
    }
  });

  opts.logger?.warn(alreadyFailedHold ? "drift.absorbed" : "drift.adopted", {
    workItemId,
    count: unexpected.length,
    artifacts: unexpected,
    transitionedToFailedHold: !alreadyFailedHold && legalHold,
  });

  return {
    workItemId,
    scanned: true,
    expected,
    unexpected,
    adopted: alreadyFailedHold ? [] : unexpected,
    absorbed: alreadyFailedHold ? unexpected : [],
    transitionedToFailedHold: !alreadyFailedHold && legalHold,
    alreadyFailedHold,
  };
}

function emptyResult(workItemId: string, scanned: boolean, reason: string): DriftResult {
  return {
    workItemId,
    scanned,
    reason,
    expected: { branch: null, worktreeBranches: [], prNumbers: [] },
    unexpected: [],
    adopted: [],
    absorbed: [],
    transitionedToFailedHold: false,
    alreadyFailedHold: false,
  };
}

/** Production scanner: local git branches/worktrees + `gh pr list` (typed argv). */
export class GitGhDriftScanner implements DriftScanner {
  private readonly gh: GhClient;

  constructor(gh: GhClient) {
    this.gh = gh;
  }

  async scan(repo: RepositoryRow): Promise<ObservedArtifacts> {
    const branches = await listLocalBranches(repo.local_dir);
    const worktrees = parseWorktreePorcelain(await worktreeList(repo.local_dir));
    const raw = (await this.gh.runJson(
      argvPrList({ owner: repo.owner, name: repo.name, state: "all", limit: 100 }),
    )) as unknown;
    const prs: ObservedPr[] = [];
    if (Array.isArray(raw)) {
      for (const item of raw as Array<Record<string, unknown>>) {
        const number = Number(item.number);
        const headRef = String(item.headRefName ?? "");
        if (Number.isInteger(number) && headRef.length > 0) {
          prs.push({ number, headRef, state: String(item.state ?? "") });
        }
      }
    }
    return { branches, worktrees, prs };
  }
}

/** Parse `git worktree list --porcelain` into path/branch pairs. */
export function parseWorktreePorcelain(text: string): ObservedWorktree[] {
  const out: ObservedWorktree[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length).trim();
    } else if (line.trim().length === 0) {
      if (path !== null && branch !== null) out.push({ path, branch });
      path = null;
      branch = null;
    }
  }
  if (path !== null && branch !== null) out.push({ path, branch });
  return out;
}
