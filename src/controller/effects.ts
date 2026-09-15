// src/controller/effects.ts
//
// M7 verified side effects (R18/R19, DD "Effects", CONTRACTS
// executeVerifiedEffect). The side_effects table is a transactional outbox: an
// intent is committed by ingest/triage BEFORE any external mutation, and this
// module is the only thing that executes it. Every effect is re-verified against
// external reality before it is marked DONE, so a crash between mutation and
// completion is reconciled on retry instead of duplicating the mutation.
//
// Merge is the guarded operation: protection, required checks, reviews and
// mergeability are read FIRST. A human review / required approval holds the
// effect (WorkItem RUNNING->WAITING, same session resumes after) — this module
// NEVER force-pushes and NEVER bypasses branch protection (no --admin). An
// external merge/close/not-found is adopted as reality, never fought.

import type { TissueDb } from "../db/open.ts";
import { runWrite } from "../db/open.ts";
import {
  getSideEffectFull,
  insertPullRequestIfAbsent,
  insertSideEffectIfAbsent,
  markPullRequestState,
  requeueSideEffect,
  setSideEffectState,
  setWorkItemState,
  type SideEffectRow,
} from "../db/repositories.ts";
import { recordTransition } from "../domain/transitions.ts";
import { getStateMachine, isLegalTransition } from "../domain/state-machine.ts";
import {
  GhClient,
  GhError,
  argvIssueClose,
  argvIssueComment,
  argvIssueReopen,
  argvIssueView,
  argvPrChecks,
  argvPrCreate,
  argvPrList,
  argvPrMerge,
  argvPrReviews,
  argvPrView,
  argvProtection,
  assertRepoIdentifier,
  type MergeMethod,
} from "../integrations/gh-client.ts";
import { pushBranch, remoteBranchSha } from "../integrations/git-client.ts";

// ---- effect payload + transport types --------------------------------------------

export interface EffectPayload {
  /** Target repository for Issue/PR/protection operations. */
  owner: string;
  name: string;
  /** Writable repository/remote for branch pushes; defaults to target. */
  push_owner?: string;
  push_name?: string;
  push_remote?: string;
  work_item_id: string;
  /** Worktree directory for push effects. */
  dir?: string;
  issue_number?: number;
  pr_number?: number;
  head_ref?: string;
  head_sha?: string;
  base_branch?: string;
  method?: MergeMethod;
  title?: string;
  body?: string;
  /** Configured merge policy: only true may create/execute a merge effect. */
  auto_merge?: boolean;
  /** False when merge policy could not be positively established (fail closed). */
  merge_policy_known?: boolean;
}

export interface ProtectionRead {
  enabled: boolean;
  requiredApprovals: number;
  enforceAdmins: boolean;
  requiredChecks: string[];
  /**
   * False when protection state could NOT be positively established. Undefined is
   * treated as known (explicit unprotected is distinct from unknown).
   */
  known?: boolean;
}

export interface MergePolicyRead {
  autoMerge: boolean;
  /** False when the configured merge policy/protection is unknown/unavailable. */
  policyKnown: boolean;
}

export interface PrView {
  number: number;
  headRefName?: string;
  headSha?: string | null;
  /** Login of the PR head repository owner (fork identity). */
  headOwner?: string | null;
  /** "owner/name" of the PR head repository when known. */
  headRepo?: string | null;
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  isDraft: boolean;
  reviewDecision: string;
}

export interface CheckView {
  name: string;
  status: string;
  conclusion: string;
}

export interface ReviewView {
  reviewId: string;
  state: string;
  author: string;
}

/** The external operations the effect executor drives. Never a shell; typed argv. */
export interface EffectTransport {
  pushHead(dir: string, branch: string, sha: string, remote?: string): Promise<{ remoteSha: string | null }>;
  readIssueState(owner: string, name: string, number: number): Promise<{ state: string } | null>;
  commentIssue(owner: string, name: string, number: number, body: string): Promise<{ id: string | null }>;
  closeIssue(owner: string, name: string, number: number): Promise<void>;
  reopenIssue(owner: string, name: string, number: number): Promise<void>;
  createPr(
    owner: string,
    name: string,
    head: string,
    base: string,
    title: string,
     body: string,
     headOwner?: string,
   ): Promise<{ number: number | null }>;
  findPrByHead(owner: string, name: string, headRef: string): Promise<PrView | null>;
  readPr(owner: string, name: string, number: number): Promise<PrView | null>;
  readProtection(owner: string, name: string, branch: string): Promise<ProtectionRead>;
  readChecks(owner: string, name: string, number: number): Promise<CheckView[]>;
  readReviews(owner: string, name: string, number: number): Promise<ReviewView[]>;
  mergePr(owner: string, name: string, number: number, method: MergeMethod): Promise<void>;
}

export type EffectStatus =
  | "done"
  | "adopted"
  | "waiting"
  | "retry"
  | "already_done"
  | "not_found"
  | "invalid"
  | "monitoring"
  | "external_only";

export interface EffectResult {
  status: EffectStatus;
  effectId: string;
  kind?: string;
  attempt?: number;
  reason?: string;
  prNumber?: number;
}

export interface EffectOptions {
  now?: Date;
  /** Backoff before re-checking a human-approval wait/transient failure. */
  waitBackoffMs?: number;
  maxAttempts?: number;
}

const DEFAULT_WAIT_BACKOFF_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Canonical pull_requests.state vocabulary source (ACTIVE/MERGED/CLOSED). Falls
 * back to the requested canonical state only if the shared table is malformed;
 * this module must never persist a non-canonical state like 'OPEN'.
 */
function canonicalPrState(fallback: string): string {
  const states = getStateMachine("pull_request").states as readonly string[];
  return states.includes(fallback) ? fallback : states[0]!;
}

// ---- merge policy + PR adoption identity -----------------------------------------

/**
 * Hard autoMerge gate. A merge effect may be created and executed ONLY when the
 * merge policy is positively known AND auto_merge is true. autoMerge=false yields
 * `external_only` (the controller monitors/adopts an externally-performed merge but
 * never runs `gh pr merge`); unknown/unavailable protection or policy fails closed
 * to `hold`.
 */
export function evaluateMergePolicy(
  _payload: EffectPayload,
  protection: ProtectionRead,
  policy: MergePolicyRead,
): "allow" | "external_only" | "hold" {
  if (protection.known === false) return "hold";
  if (!policy.policyKnown) return "hold";
  if (!policy.autoMerge) return "external_only";
  return "allow";
}

/** Identity a PR must match before it is adopted as the controller's PR. */
export interface PullRequestIdentity {
  targetOwner: string;
  targetName: string;
  headRef: string;
  headSha: string | null;
  pushOwner: string;
  pushName: string;
}

export interface ObservedPullRequest {
  number: number;
  headRefName?: string | null;
  headSha?: string | null;
  headOwner?: string | null;
  headRepo?: string | null;
  state?: string;
}

export type AdoptionFailureReason =
  | "invalid_number"
  | "branch_mismatch"
  | "sha_mismatch"
  | "foreign_fork"
  | "head_identity_unknown";

export type AdoptionResult =
  | { adopted: true; number: number; reason: "verified" }
  | { adopted: false; number?: number; reason: AdoptionFailureReason; rogue: boolean };

/**
 * Verify an observed PR against the controller's expected identity before it is
 * adopted. A foreign fork on the same controller branch is rogue/drift and is
 * NEVER adopted; all other mismatches are non-rogue rejections. Evidence/history
 * is retained by the caller.
 */
export function adoptVerifiedPullRequest(
  identity: PullRequestIdentity,
  observed: ObservedPullRequest,
): AdoptionResult {
  const number = observed.number;
  if (!Number.isInteger(number) || number <= 0) {
    return { adopted: false, reason: "invalid_number", rogue: false };
  }
  if (observed.headRefName != null && observed.headRefName !== identity.headRef) {
    return { adopted: false, number, reason: "branch_mismatch", rogue: false };
  }
  const expectedRepo = `${identity.pushOwner}/${identity.pushName}`.toLowerCase();
  const expectedOwner = identity.pushOwner.toLowerCase();
  const headRepo = (observed.headRepo ?? "").toLowerCase();
  const headOwner = (observed.headOwner ?? "").toLowerCase();
  if (headRepo) {
    if (headRepo !== expectedRepo) return { adopted: false, number, reason: "foreign_fork", rogue: true };
  } else if (headOwner) {
    if (headOwner !== expectedOwner) return { adopted: false, number, reason: "foreign_fork", rogue: true };
  } else {
    return { adopted: false, number, reason: "head_identity_unknown", rogue: false };
  }
  if (identity.headSha && observed.headSha && observed.headSha !== identity.headSha) {
    return { adopted: false, number, reason: "sha_mismatch", rogue: false };
  }
  return { adopted: true, number, reason: "verified" };
}

// ---- guards ----------------------------------------------------------------------

function parsePayload(effect: SideEffectRow): EffectPayload {
  const raw = JSON.parse(effect.payload_json) as Partial<EffectPayload>;
  if (typeof raw.owner !== "string" || typeof raw.name !== "string" || typeof raw.work_item_id !== "string") {
    throw new Error("effect payload requires owner, name and work_item_id");
  }
  assertRepoIdentifier(raw.owner, "owner");
  assertRepoIdentifier(raw.name, "name");
  if (raw.push_owner !== undefined) assertRepoIdentifier(raw.push_owner, "push_owner");
  if (raw.push_name !== undefined) assertRepoIdentifier(raw.push_name, "push_name");
  return raw as EffectPayload;
}

function isTransient(err: unknown): boolean {
  if (err instanceof GhError) return err.kind === "rate_limited" || err.kind === "network";
  const msg = (err as Error).message ?? "";
  return /rate limit|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network|502|503|504/i.test(msg);
}

function backoffMs(attempt: number, base: number): number {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), 60 * 60_000);
}

/** Latest per-author review state; approvals must be the author's final word. */
export function countApprovals(reviews: readonly ReviewView[]): number {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.author.length === 0) continue;
    latest.set(r.author, r.state);
  }
  let count = 0;
  for (const state of latest.values()) if (state === "APPROVED") count += 1;
  return count;
}

// ---- the executor -----------------------------------------------------------------

/**
 * Execute one committed outbox intent and verify it before DONE. Idempotent:
 * re-running a DONE effect is a no-op, and a crash mid-execution is reconciled by
 * reading external reality on the next attempt rather than re-mutating.
 */
export async function executeVerifiedEffect(
  db: TissueDb,
  effectId: string,
  transport: EffectTransport,
  opts: EffectOptions = {},
): Promise<EffectResult> {
  const now = opts.now ?? new Date();
  const waitBackoff = opts.waitBackoffMs ?? DEFAULT_WAIT_BACKOFF_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const effect = getSideEffectFull(db, effectId);
  if (!effect) return { status: "not_found", effectId };
  if (effect.state === "DONE") return { status: "already_done", effectId, kind: effect.kind, attempt: effect.attempt };

  let payload: EffectPayload;
  try {
    payload = parsePayload(effect);
  } catch (err) {
    markFailed(db, effectId, (err as Error).message);
    return { status: "invalid", effectId, kind: effect.kind, reason: (err as Error).message };
  }

  const attempt = effect.attempt + 1;
  if (attempt > maxAttempts) {
    markFailed(db, effectId, "max attempts exceeded", now, null);
    return { status: "retry", effectId, kind: effect.kind, attempt, reason: "max_attempts" };
  }

  try {
    switch (effect.kind) {
      case "push":
        return await runPush(db, effectId, payload, transport, attempt);
      case "comment":
        return await runComment(db, effectId, payload, transport, attempt);
      case "close":
        return await runStateChange(db, effectId, payload, transport, attempt, "CLOSED");
      case "reopen":
        return await runStateChange(db, effectId, payload, transport, attempt, "OPEN");
      case "pr":
        return await runCreatePr(db, effectId, payload, transport, attempt);
      case "monitor":
        return await runMonitor(db, effectId, payload, transport, now, waitBackoff, attempt);
      case "merge":
        return await runMerge(db, effectId, payload, transport, now, waitBackoff, attempt);
      default:
        markFailed(db, effectId, `unknown effect kind '${effect.kind}'`);
        return { status: "invalid", effectId, kind: effect.kind, reason: "unknown_kind" };
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (isTransient(err)) {
      markFailed(db, effectId, message, now, backoffMs(attempt, waitBackoff));
      return { status: "retry", effectId, kind: effect.kind, attempt, reason: message };
    }
    markFailed(db, effectId, message, now, null);
    return { status: "retry", effectId, kind: effect.kind, attempt, reason: message };
  }
}

function markExecuting(db: TissueDb, effectId: string): void {
  runWrite(db, (tx) => setSideEffectState(tx, effectId, "EXECUTING"));
}

function markDone(db: TissueDb, effectId: string): void {
  runWrite(db, (tx) => setSideEffectState(tx, effectId, "DONE"));
}

function markFailed(db: TissueDb, effectId: string, reason: string, now?: Date, nextAttemptAt?: number | null): void {
  runWrite(db, (tx) =>
    setSideEffectState(tx, effectId, "FAILED", {
      lastError: reason,
      nextAttemptAt: nextAttemptAt == null || now === undefined ? null : new Date(now.getTime() + nextAttemptAt).toISOString(),
    }),
  );
}

async function runPush(
  db: TissueDb,
  effectId: string,
  payload: EffectPayload,
  transport: EffectTransport,
  attempt: number,
): Promise<EffectResult> {
  if (!payload.dir || !payload.head_ref || !payload.head_sha) {
    markFailed(db, effectId, "push effect missing dir/head_ref/head_sha");
    return { status: "invalid", effectId, kind: "push", reason: "missing_fields" };
  }
  // A push must target the configured push remote; never silently fall back to a
  // hard-coded `origin` (the configured pushRemote is resolved into the payload).
  if (!payload.push_remote) {
    markFailed(db, effectId, "push effect missing configured push_remote");
    return { status: "invalid", effectId, kind: "push", reason: "missing_push_remote" };
  }
  markExecuting(db, effectId);
  const { remoteSha } = await transport.pushHead(payload.dir, payload.head_ref, payload.head_sha, payload.push_remote);
  if (remoteSha === payload.head_sha) {
    markDone(db, effectId);
    return { status: "done", effectId, kind: "push", attempt };
  }
  markFailed(db, effectId, `remote sha ${remoteSha ?? "absent"} != ${payload.head_sha}`);
  return { status: "retry", effectId, kind: "push", attempt, reason: "remote_sha_mismatch" };
}

async function runComment(
  db: TissueDb,
  effectId: string,
  payload: EffectPayload,
  transport: EffectTransport,
  attempt: number,
): Promise<EffectResult> {
  if (payload.issue_number === undefined) {
    markFailed(db, effectId, "comment effect missing issue_number");
    return { status: "invalid", effectId, kind: "comment", reason: "missing_issue_number" };
  }
  markExecuting(db, effectId);
  const res = await transport.commentIssue(payload.owner, payload.name, payload.issue_number, payload.body ?? "");
  markDone(db, effectId);
  return { status: "done", effectId, kind: "comment", attempt, reason: res.id ?? undefined };
}

async function runStateChange(
  db: TissueDb,
  effectId: string,
  payload: EffectPayload,
  transport: EffectTransport,
  attempt: number,
  target: "OPEN" | "CLOSED",
): Promise<EffectResult> {
  if (payload.issue_number === undefined) {
    markFailed(db, effectId, "state effect missing issue_number");
    return { status: "invalid", effectId, kind: target === "CLOSED" ? "close" : "reopen", reason: "missing_issue_number" };
  }
  const kind = target === "CLOSED" ? "close" : "reopen";
  const current = await transport.readIssueState(payload.owner, payload.name, payload.issue_number);
  if (current?.state === target) {
    markDone(db, effectId);
    return { status: "adopted", effectId, kind, attempt, reason: "already_in_target_state" };
  }
  markExecuting(db, effectId);
  if (target === "CLOSED") await transport.closeIssue(payload.owner, payload.name, payload.issue_number);
  else await transport.reopenIssue(payload.owner, payload.name, payload.issue_number);
  const after = await transport.readIssueState(payload.owner, payload.name, payload.issue_number);
  if (after?.state === target) {
    markDone(db, effectId);
    return { status: "done", effectId, kind, attempt };
  }
  markFailed(db, effectId, `issue state did not reach ${target} (saw ${after?.state ?? "missing"})`);
  return { status: "retry", effectId, kind, attempt, reason: "state_not_verified" };
}

async function runCreatePr(
  db: TissueDb,
  effectId: string,
  payload: EffectPayload,
  transport: EffectTransport,
  attempt: number,
): Promise<EffectResult> {
  if (!payload.head_ref || !payload.base_branch) {
    markFailed(db, effectId, "pr effect missing head_ref/base_branch");
    return { status: "invalid", effectId, kind: "pr", reason: "missing_fields" };
  }
  // Existing PRs are verified against identity and adopted even if the controller
  // crashed before recording push completion. New PR creation stays downstream of
  // a verified push. Adoption is safe because the target repository is read first.
  const identity = prIdentity(payload);
  if (!identity) {
    markFailed(db, effectId, "pr effect missing expected push owner/name or head identity");
    return { status: "invalid", effectId, kind: "pr", reason: "missing_identity" };
  }

  // Adopt an already-created PR for this head ref (crash between create and DONE).
  const existing = await transport.findPrByHead(payload.owner, payload.name, payload.head_ref);
  if (existing) {
    const adoption = adoptVerifiedPullRequest(identity, {
      number: existing.number,
      headRefName: existing.headRefName ?? null,
      headSha: existing.headSha ?? null,
      headOwner: existing.headOwner ?? null,
      headRepo: existing.headRepo ?? null,
    });
    if (adoption.adopted) {
      markDone(db, effectId);
      adoptPrAndScheduleMerge(db, payload, existing.number, existing.headRefName ?? payload.head_ref, existing.headSha ?? payload.head_sha ?? null);
      return { status: "adopted", effectId, kind: "pr", attempt, prNumber: existing.number, reason: "already_exists" };
    }
    // Retain the foreign-fork evidence; never adopt. A same-branch foreign fork is
    // recorded as rogue drift and the effect stays retryable (not failed hard).
    if (adoption.rogue) recordRoguePr(db, payload, existing);
    requeueSideEffect(db, effectId, { lastError: `pr_identity_${adoption.reason}` });
    return { status: "retry", effectId, kind: "pr", attempt, reason: `pr_identity_${adoption.reason}` };
  }

  const pushState = db.sql.get<{ state: string }>(
    "SELECT state FROM side_effects WHERE effect_key = ?",
    `push:${payload.work_item_id}:${payload.head_sha ?? ""}`,
  )?.state;
  if (pushState !== "DONE") {
    requeueSideEffect(db, effectId, { lastError: "push_pending" });
    return { status: "retry", effectId, kind: "pr", attempt, reason: "push_pending" };
  }

  markExecuting(db, effectId);
  const created = await transport.createPr(
    payload.owner,
    payload.name,
    payload.head_ref,
    payload.base_branch,
    payload.title ?? `Tissue ${payload.work_item_id}`,
    payload.body ?? "",
    identity.pushOwner !== payload.owner ? identity.pushOwner : undefined,
  );
  const found = created.number !== null
    ? await transport.readPr(payload.owner, payload.name, created.number)
    : await transport.findPrByHead(payload.owner, payload.name, payload.head_ref);
  if (found) {
    const adoption = adoptVerifiedPullRequest(prIdentity(payload) ?? identity, {
      number: found.number,
      headRefName: found.headRefName ?? null,
      headSha: found.headSha ?? null,
      headOwner: found.headOwner ?? null,
      headRepo: found.headRepo ?? null,
    });
    if (adoption.adopted) {
      markDone(db, effectId);
      adoptPrAndScheduleMerge(db, payload, found.number, found.headRefName ?? payload.head_ref, found.headSha ?? payload.head_sha ?? null);
      return { status: "done", effectId, kind: "pr", attempt, prNumber: found.number };
    }
    if (adoption.rogue) recordRoguePr(db, payload, found);
    markFailed(db, effectId, `created PR failed identity check: ${adoption.reason}`);
    return { status: "retry", effectId, kind: "pr", attempt, reason: `pr_identity_${adoption.reason}` };
  }
  markFailed(db, effectId, "created PR could not be verified");
  return { status: "retry", effectId, kind: "pr", attempt, reason: "pr_not_verified" };
}

/** Build the required PR identity from a payload, or null when it is incomplete. */
function prIdentity(payload: EffectPayload): PullRequestIdentity | null {
  if (!payload.head_ref) return null;
  const pushOwner = payload.push_owner ?? payload.owner;
  const pushName = payload.push_name ?? payload.name;
  if (!pushOwner || !pushName) return null;
  return {
    targetOwner: payload.owner,
    targetName: payload.name,
    headRef: payload.head_ref,
    headSha: payload.head_sha ?? null,
    pushOwner,
    pushName,
  };
}

/** Retain evidence of a same-branch foreign-fork PR without adopting it. */
function recordRoguePr(db: TissueDb, payload: EffectPayload, pr: PrView): void {
  runWrite(db, (tx) => {
    const wi = tx.sql.get<{ repo_id: string }>("SELECT repo_id FROM work_items WHERE id = ?", payload.work_item_id);
    if (!wi) return;
    insertPullRequestIfAbsent(tx, {
      id: `pr-${payload.work_item_id}-${pr.number}-rogue`,
      work_item_id: payload.work_item_id,
      repo_id: wi.repo_id,
      number: pr.number,
      head_ref: pr.headRefName ?? payload.head_ref ?? "",
      head_sha: pr.headSha ?? null,
      state: "ROGUE",
      origin: "rogue",
    });
  });
}

function adoptPrAndScheduleMerge(
  db: TissueDb,
  payload: EffectPayload,
  prNumber: number,
  headRef: string,
  headSha: string | null,
): void {
  if (!Number.isInteger(prNumber) || prNumber <= 0) return;
  // Hard autoMerge gate at effect creation: a merge intent is created ONLY when
  // the configured policy is positive AND known. Otherwise a `monitor` effect is
  // created, which adopts an external merge/close but never runs `gh pr merge`.
  const autoMerge = payload.auto_merge === true;
  const policyKnown = payload.merge_policy_known !== false;
  const kind = autoMerge && policyKnown ? "merge" : "monitor";
  runWrite(db, (tx) => {
    const wi = tx.sql.get<{ repo_id: string }>("SELECT repo_id FROM work_items WHERE id = ?", payload.work_item_id);
    if (!wi) return;
    insertPullRequestIfAbsent(tx, {
      id: `pr-${payload.work_item_id}-${prNumber}`,
      work_item_id: payload.work_item_id,
      repo_id: wi.repo_id,
      number: prNumber,
      head_ref: headRef,
      head_sha: headSha,
      // Persist the canonical PR state (ACTIVE/MERGED/CLOSED). A non-canonical
      // 'OPEN' would be invisible to ux_pr_one_active and listActivePullRequests
      // until a later poll rewrote it, causing order-dependent E2E flake.
      state: canonicalPrState("ACTIVE"),
      origin: "controller",
    });
    insertSideEffectIfAbsent(tx, {
      id: `fx-${kind}-${payload.work_item_id}-${prNumber}`,
      kind,
      effect_key: `${kind}:${payload.work_item_id}:${prNumber}`,
      state: "PENDING",
      payload_json: JSON.stringify({
        ...payload,
        pr_number: prNumber,
        head_ref: headRef,
        head_sha: headSha ?? payload.head_sha,
        auto_merge: autoMerge,
        merge_policy_known: policyKnown,
      }),
    });
  });
}

/**
 * Monitor an externally-governed PR (autoMerge=false / unknown policy). Adopts an
 * external merge or close; otherwise requeues, NEVER issuing `gh pr merge`.
 */
async function runMonitor(
  db: TissueDb,
  effectId: string,
  payload: EffectPayload,
  transport: EffectTransport,
  now: Date,
  waitBackoff: number,
  attempt: number,
): Promise<EffectResult> {
  if (payload.pr_number === undefined) {
    markFailed(db, effectId, "monitor effect missing pr_number");
    return { status: "invalid", effectId, kind: "monitor", reason: "missing_fields" };
  }
  const prNumber = payload.pr_number;
  const pr = await transport.readPr(payload.owner, payload.name, prNumber);
  if (!pr) {
    markDone(db, effectId);
    markLocalPr(db, payload, prNumber, "CLOSED");
    return { status: "adopted", effectId, kind: "monitor", attempt, prNumber, reason: "pr_not_found" };
  }
  if (pr.state === "MERGED") {
    markDone(db, effectId);
    markLocalPr(db, payload, prNumber, "MERGED");
    completeMergedWorkItem(db, payload.work_item_id, prNumber);
    return { status: "adopted", effectId, kind: "monitor", attempt, prNumber, reason: "already_merged" };
  }
  if (pr.state === "CLOSED") {
    markDone(db, effectId);
    markLocalPr(db, payload, prNumber, "CLOSED");
    return { status: "adopted", effectId, kind: "monitor", attempt, prNumber, reason: "already_closed" };
  }
  requeueSideEffect(db, effectId, {
    lastError: "external_only",
    nextAttemptAt: new Date(now.getTime() + waitBackoff).toISOString(),
  });
  return { status: "monitoring", effectId, kind: "monitor", attempt, prNumber, reason: "external_only" };
}

async function runMerge(
  db: TissueDb,
  effectId: string,
  payload: EffectPayload,
  transport: EffectTransport,
  now: Date,
  waitBackoff: number,
  attempt: number,
): Promise<EffectResult> {
  if (payload.pr_number === undefined || !payload.base_branch) {
    markFailed(db, effectId, "merge effect missing pr_number/base_branch");
    return { status: "invalid", effectId, kind: "merge", reason: "missing_fields" };
  }
  const prNumber = payload.pr_number;

  // ---- read external reality BEFORE any mutation ------------------------------
  const pr = await transport.readPr(payload.owner, payload.name, prNumber);
  if (!pr) {
    markDone(db, effectId);
    markLocalPr(db, payload, prNumber, "CLOSED");
    return { status: "adopted", effectId, kind: "merge", attempt, prNumber, reason: "pr_not_found" };
  }
  if (pr.state === "MERGED") {
    markDone(db, effectId);
    markLocalPr(db, payload, prNumber, "MERGED");
    completeMergedWorkItem(db, payload.work_item_id, prNumber);
    return { status: "adopted", effectId, kind: "merge", attempt, prNumber, reason: "already_merged" };
  }
  if (pr.state === "CLOSED") {
    markDone(db, effectId);
    markLocalPr(db, payload, prNumber, "CLOSED");
    return { status: "adopted", effectId, kind: "merge", attempt, prNumber, reason: "already_closed" };
  }
  if (pr.isDraft) {
    return holdWaiting(db, effectId, payload, now, waitBackoff, attempt, "draft");
  }

  const [protection, checks, reviews] = await Promise.all([
    transport.readProtection(payload.owner, payload.name, payload.base_branch),
    transport.readChecks(payload.owner, payload.name, prNumber),
    transport.readReviews(payload.owner, payload.name, prNumber),
  ]);

  // Hard autoMerge gate at execution: unknown protection/policy fails closed, and
  // autoMerge=false degrades to external-only monitoring.
  const policy: MergePolicyRead = {
    autoMerge: payload.auto_merge === true,
    policyKnown: payload.merge_policy_known !== false,
  };
  const decision = evaluateMergePolicy(payload, protection, policy);
  if (decision === "external_only") {
    requeueSideEffect(db, effectId, {
      lastError: "auto_merge_disabled",
      nextAttemptAt: new Date(now.getTime() + waitBackoff).toISOString(),
    });
    return { status: "external_only", effectId, kind: "merge", attempt, prNumber, reason: "auto_merge_disabled" };
  }
  if (decision === "hold") {
    return holdWaiting(db, effectId, payload, now, waitBackoff, attempt, "merge_policy_unknown");
  }

  if (protection.requiredApprovals > 0) {
    const approvals = countApprovals(reviews);
    if (approvals < protection.requiredApprovals) {
      return holdWaiting(db, effectId, payload, now, waitBackoff, attempt, "human_approval_required");
    }
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") {
    return holdWaiting(db, effectId, payload, now, waitBackoff, attempt, `review_${pr.reviewDecision.toLowerCase()}`);
  }
  if (protection.requiredChecks.length > 0) {
    const byName = new Map(checks.map((c) => [c.name, c.conclusion]));
    const missing = protection.requiredChecks.filter((name) => byName.get(name) !== "SUCCESS");
    if (missing.length > 0) {
      return holdWaiting(db, effectId, payload, now, waitBackoff, attempt, `checks_pending:${missing.join(",")}`);
    }
  }
  if (pr.mergeable !== "MERGEABLE") {
    // Never merge an unmergeable PR; leave it for the resolution session.
    requeueSideEffect(db, effectId, {
      lastError: `not_mergeable:${pr.mergeable}/${pr.mergeStateStatus}`,
      nextAttemptAt: new Date(now.getTime() + waitBackoff).toISOString(),
    });
    return { status: "retry", effectId, kind: "merge", attempt, prNumber, reason: "not_mergeable" };
  }

  // ---- allowed: merge, then verify --------------------------------------------
  const method = payload.method ?? "squash";
  markExecuting(db, effectId);
  await transport.mergePr(payload.owner, payload.name, prNumber, method);
  const after = await transport.readPr(payload.owner, payload.name, prNumber);
  if (after?.state === "MERGED") {
     markDone(db, effectId);
     markLocalPr(db, payload, prNumber, "MERGED");
      completeMergedWorkItem(db, payload.work_item_id, prNumber);
    return { status: "done", effectId, kind: "merge", attempt, prNumber };
  }
  markFailed(db, effectId, `merge not verified (state ${after?.state ?? "missing"})`);
  return { status: "retry", effectId, kind: "merge", attempt, prNumber, reason: "merge_not_verified" };
}

/** Hold a WorkItem in WAITING (RUNNING->WAITING) and requeue the merge effect. */
function holdWaiting(
  db: TissueDb,
  effectId: string,
  payload: EffectPayload,
  now: Date,
  waitBackoff: number,
  attempt: number,
  reason: string,
): EffectResult {
  runWrite(db, (tx) => {
    const row = tx.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", payload.work_item_id);
    const from = row?.state ?? "RUNNING";
    if (isLegalTransition("work_item", from, "WAITING", "await_review")) {
      recordTransition(tx, { type: "work_item", id: payload.work_item_id }, from, "WAITING", "await_review", { reason }, "controller.effects");
      setWorkItemState(tx, payload.work_item_id, "WAITING", { leaseToken: null, leaseUntil: null });
    }
  });
  requeueSideEffect(db, effectId, {
    lastError: reason,
    nextAttemptAt: new Date(now.getTime() + waitBackoff).toISOString(),
  });
  return { status: "waiting", effectId, kind: "merge", attempt, prNumber: payload.pr_number, reason };
}

function markLocalPr(db: TissueDb, payload: EffectPayload, prNumber: number, state: string): void {
  runWrite(db, (tx) => markPullRequestState(tx, payload.work_item_id, prNumber, state));
}

function completeMergedWorkItem(db: TissueDb, workItemId: string, prNumber: number): void {
  runWrite(db, (tx) => {
    const current = tx.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", workItemId)?.state;
    if (!current) return;
    let completionFrom = current;
    if (current === "WAITING") {
      recordTransition(tx, { type: "work_item", id: workItemId }, "WAITING", "RUNNING", "resume", { pr_number: prNumber, merge_verified: true }, "controller.effects");
      setWorkItemState(tx, workItemId, "RUNNING");
      completionFrom = "RUNNING";
    }
    if (isLegalTransition("work_item", completionFrom, "COMPLETED", "completed")) {
      recordTransition(tx, { type: "work_item", id: workItemId }, completionFrom, "COMPLETED", "completed", { pr_number: prNumber }, "controller.effects");
      setWorkItemState(tx, workItemId, "COMPLETED");
    }
  });
}

// ---- production transport over /usr/bin/gh + git ---------------------------------

export interface GhEffectTransportOptions {
  gh: GhClient;
}

/** EffectTransport over the validated gh binary and git client (typed argv only). */
export class GhEffectTransport implements EffectTransport {
  private readonly gh: GhClient;

  constructor(opts: GhEffectTransportOptions) {
    this.gh = opts.gh;
  }

  async pushHead(dir: string, branch: string, sha: string, remote?: string): Promise<{ remoteSha: string | null }> {
    await pushBranch(dir, branch, { remote });
    const remoteSha = await remoteBranchSha(dir, branch, remote);
    return { remoteSha: remoteSha ?? null };
  }

  async readIssueState(owner: string, name: string, number: number): Promise<{ state: string } | null> {
    try {
      const raw = (await this.gh.runJson(argvIssueView(owner, name, number))) as { state?: unknown };
      return { state: String(raw.state ?? "").toUpperCase() };
    } catch (err) {
      if (err instanceof GhError && err.kind === "not_found") return null;
      throw err;
    }
  }

  async commentIssue(owner: string, name: string, number: number, body: string): Promise<{ id: string | null }> {
    await this.gh.run(argvIssueComment(owner, name, number), { stdinData: body });
    return { id: null };
  }

  async closeIssue(owner: string, name: string, number: number): Promise<void> {
    await this.gh.run(argvIssueClose(owner, name, number));
  }

  async reopenIssue(owner: string, name: string, number: number): Promise<void> {
    await this.gh.run(argvIssueReopen(owner, name, number));
  }

  async createPr(
    owner: string,
    name: string,
    head: string,
    base: string,
    title: string,
    body: string,
    headOwner?: string,
  ): Promise<{ number: number | null }> {
    await this.gh.run(argvPrCreate({ owner, name, head, headOwner, base, title }), { stdinData: body });
    return { number: null };
  }

  async findPrByHead(owner: string, name: string, headRef: string): Promise<PrView | null> {
    const raw = (await this.gh.runJson(argvPrList({ owner, name, state: "all", limit: 100 }))) as unknown;
    if (!Array.isArray(raw)) return null;
    for (const item of raw as Array<Record<string, unknown>>) {
      if (item.headRefName === headRef) return parsePr(item);
    }
    return null;
  }

  async readPr(owner: string, name: string, number: number): Promise<PrView | null> {
    try {
      const raw = (await this.gh.runJson(argvPrView(owner, name, number))) as Record<string, unknown>;
      return parsePr(raw);
    } catch (err) {
      if (err instanceof GhError && err.kind === "not_found") return null;
      throw err;
    }
  }

  async readProtection(owner: string, name: string, branch: string): Promise<ProtectionRead> {
    try {
      const raw = (await this.gh.runJson(argvProtection({ owner, name, branch }))) as Record<string, unknown>;
      return parseProtection(raw);
    } catch (err) {
      if (err instanceof GhError && err.kind === "not_found") {
        return { enabled: false, requiredApprovals: 0, enforceAdmins: false, requiredChecks: [], known: true };
      }
      throw err;
    }
  }

  async readChecks(owner: string, name: string, number: number): Promise<CheckView[]> {
    const raw = (await this.gh.runJson(argvPrChecks(owner, name, number))) as { statusCheckRollup?: unknown };
    if (!Array.isArray(raw.statusCheckRollup)) return [];
    const out: CheckView[] = [];
    for (const item of raw.statusCheckRollup as Array<Record<string, unknown>>) {
      const checkName = String(item.name ?? item.context ?? "");
      if (checkName.length === 0) continue;
      out.push({
        name: checkName,
        status: String(item.status ?? "UNKNOWN").toUpperCase(),
        conclusion: String(item.conclusion ?? "PENDING").toUpperCase(),
      });
    }
    return out;
  }

  async readReviews(owner: string, name: string, number: number): Promise<ReviewView[]> {
    const raw = (await this.gh.runJson(argvPrReviews(owner, name, number))) as { reviews?: unknown };
    if (!Array.isArray(raw.reviews)) return [];
    const out: ReviewView[] = [];
    for (const item of raw.reviews as Array<Record<string, unknown>>) {
      const author = item.author && typeof item.author === "object"
        ? String((item.author as { login?: unknown }).login ?? "")
        : "";
      out.push({
        reviewId: String(item.id ?? ""),
        state: String(item.state ?? "UNKNOWN").toUpperCase(),
        author,
      });
    }
    return out;
  }

  async mergePr(owner: string, name: string, number: number, method: MergeMethod): Promise<void> {
    await this.gh.run(argvPrMerge(owner, name, number, method));
  }
}

function parsePr(raw: Record<string, unknown>): PrView {
  const headOwnerRecord = raw.headRepositoryOwner as { login?: unknown } | undefined;
  const headRepoRecord = raw.headRepository as { nameWithOwner?: unknown } | undefined;
  return {
    number: Number(raw.number ?? 0),
    ...(typeof raw.headRefName === "string" ? { headRefName: raw.headRefName } : {}),
    ...(typeof raw.headRefOid === "string" ? { headSha: raw.headRefOid } : {}),
    ...(headOwnerRecord && typeof headOwnerRecord.login === "string" ? { headOwner: headOwnerRecord.login } : {}),
    ...(headRepoRecord && typeof headRepoRecord.nameWithOwner === "string" ? { headRepo: headRepoRecord.nameWithOwner } : {}),
    state: String(raw.state ?? "OPEN").toUpperCase(),
    mergeable: String(raw.mergeable ?? "UNKNOWN").toUpperCase(),
    mergeStateStatus: String(raw.mergeStateStatus ?? "UNKNOWN").toUpperCase(),
    isDraft: raw.isDraft === true,
    reviewDecision: String(raw.reviewDecision ?? "").toUpperCase(),
  };
}

function parseProtection(raw: Record<string, unknown>): ProtectionRead {
  const status = raw.required_status_checks as { contexts?: unknown; checks?: unknown } | null | undefined;
  let requiredChecks: string[] = [];
  if (status) {
    const contexts = Array.isArray(status.contexts) ? status.contexts.map(String) : [];
    const contextsFromChecks = Array.isArray(status.checks)
      ? status.checks.map((c) => String((c as { context?: unknown }).context ?? "")).filter((s) => s.length > 0)
      : [];
    requiredChecks = [...new Set([...contexts, ...contextsFromChecks])];
  }
  const reviews = raw.required_pull_request_reviews as { required_approving_review_count?: unknown } | null | undefined;
  const admins = raw.enforce_admins as { enabled?: unknown } | boolean | null | undefined;
  return {
    enabled: true,
    requiredApprovals: Number(reviews?.required_approving_review_count ?? 0),
    enforceAdmins: admins === true ? true : Boolean((admins as { enabled?: unknown } | null)?.enabled),
    requiredChecks,
    known: true,
  };
}
