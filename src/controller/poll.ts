// src/controller/poll.ts
//
// M7 level-triggered polling (R18/R19). One poll produces a typed GhSnapshot of
// IDs/SHAs/states only: issues, pull requests, checks, reviews, and conflict
// markers. Every gh call is a typed argv array with a fixed --json field set —
// no shell string, no untrusted text in argv. Polling is LEVEL-triggered: the
// watermark only bounds volume; correctness comes from ingest's snapshot_hash /
// event_key dedup, so a re-read of unchanged state is a no-op downstream.
//
// The snapshot deliberately carries NO issue/PR body text beyond the bounded
// title needed for the triage digest; bodies are fetched only at triage time.

import { createHash } from "node:crypto";

import {
  GhClient,
  argvIssueComments,
  argvIssueList,
  argvPrComments,
  argvPrList,
  argvPrChecks,
  argvPrReviews,
  type GhError,
} from "../integrations/gh-client.ts";

export interface RepoPollRef {
  id: string;
  owner: string;
  name: string;
  /** ISO baseline cutoff; issues created before this are BASELINE_EXCLUDED. */
  baselineAt: string | null;
  /** Max rows fetched per entity per poll. Default 100. */
  limit?: number;
}

export interface GhIssueSnapshot {
  number: number;
  /** Bounded title preview used by the triage digest (never an event payload). */
  title: string;
  state: string;
  updatedAt: string;
  createdAt: string;
  labels: string[];
  /** Deterministic content hash used for change suppression. */
  snapshotHash: string;
}

export interface GhPrSnapshot {
  number: number;
  state: string;
  headRefName: string;
  headRefOid: string;
  /** Login of the repository owning the PR head branch (fork identity). */
  headOwner: string;
  /** "owner/name" of the PR head repository when GitHub supplies it. */
  headRepo: string;
  updatedAt: string;
  mergeable: string;
  mergeStateStatus: string;
  isDraft: boolean;
  url: string;
}

export interface GhCheckSnapshot {
  prNumber: number;
  name: string;
  status: string;
  conclusion: string;
  /** Stable identity when GitHub supplies one; otherwise name+status. */
  checkKey: string;
}

export interface GhReviewSnapshot {
  prNumber: number;
  reviewId: string;
  state: string;
  submittedAt: string;
}

export interface GhCommentSnapshot {
  target: "issue" | "pr";
  /** Issue or PR number the comment belongs to. */
  number: number;
  commentId: string;
  author: string;
  createdAt: string;
  /** Bounded, control-safe preview (full untrusted text never enters an event). */
  bodyPreview: string;
  /** Stable hash of the sanitized body for edit detection / dedup. */
  bodyHash: string;
}

export interface GhConflictSnapshot {
  prNumber: number;
  mergeable: string;
  mergeStateStatus: string;
}

export interface GhSnapshot {
  repoId: string;
  owner: string;
  name: string;
  baselineAt: string | null;
  /** Prior watermark this poll started from (null on first poll). */
  cursor: string | null;
  /** New watermark == collectedAt; persisted with the snapshot in one tx. */
  watermark: string;
  collectedAt: string;
  issues: GhIssueSnapshot[];
  pullRequests: GhPrSnapshot[];
  checks: GhCheckSnapshot[];
  reviews: GhReviewSnapshot[];
  conflicts: GhConflictSnapshot[];
  comments: GhCommentSnapshot[];
}

export interface PollResult {
  snapshot: GhSnapshot;
  /** Per-entity counts fetched before watermark filtering (observability only). */
  fetched: { issues: number; pullRequests: number; checks: number; reviews: number };
}

// ---- deterministic hashing --------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** sha256 over a canonical serialization of the passed value. */
export function snapshotHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

// ---- snapshot parsing (fixed fields; tolerant of extra columns) -------------------

interface RawIssue {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  labels?: unknown;
}

interface RawPr {
  number?: unknown;
  state?: unknown;
  headRefName?: unknown;
  headRefOid?: unknown;
  headRepositoryOwner?: unknown;
  headRepository?: unknown;
  updatedAt?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
  isDraft?: unknown;
  url?: unknown;
}

interface RawComment {
  id?: unknown;
  body?: unknown;
  author?: unknown;
  createdAt?: unknown;
}

interface RawCheckRollupEntry {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  context?: unknown;
  __typename?: unknown;
}

interface RawReview {
  id?: unknown;
  state?: unknown;
  submittedAt?: unknown;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function labelsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
      out.push((item as { name: string }).name);
    }
  }
  return out;
}

function parseIssues(raw: unknown): GhIssueSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: GhIssueSnapshot[] = [];
  for (const item of raw as RawIssue[]) {
    const number = asNumber(item.number);
    if (number === null) continue;
    const title = asString(item.title).slice(0, 200);
    const state = asString(item.state).toUpperCase();
    const updatedAt = asString(item.updatedAt);
    const createdAt = asString(item.createdAt, updatedAt);
    const labels = labelsOf(item.labels);
    out.push({
      number,
      title,
      state,
      updatedAt,
      createdAt,
      labels,
      snapshotHash: snapshotHash({ number, title, state, updatedAt, labels }),
    });
  }
  return out;
}

function parsePrs(raw: unknown): GhPrSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: GhPrSnapshot[] = [];
  for (const item of raw as RawPr[]) {
    const number = asNumber(item.number);
    if (number === null) continue;
    const headOwnerRecord = item.headRepositoryOwner as { login?: unknown } | undefined;
    const headRepoRecord = item.headRepository as { nameWithOwner?: unknown } | undefined;
    out.push({
      number,
      state: asString(item.state).toUpperCase(),
      headRefName: asString(item.headRefName),
      headRefOid: asString(item.headRefOid),
      headOwner: headOwnerRecord && typeof headOwnerRecord.login === "string" ? headOwnerRecord.login : "",
      headRepo: headRepoRecord && typeof headRepoRecord.nameWithOwner === "string" ? headRepoRecord.nameWithOwner : "",
      updatedAt: asString(item.updatedAt),
      mergeable: asString(item.mergeable, "UNKNOWN").toUpperCase(),
      mergeStateStatus: asString(item.mergeStateStatus, "UNKNOWN").toUpperCase(),
      isDraft: item.isDraft === true,
      url: asString(item.url),
    });
  }
  return out;
}

function parseChecks(raw: unknown, prNumber: number): GhCheckSnapshot[] {
  const rollup = (raw as { statusCheckRollup?: unknown } | null)?.statusCheckRollup;
  if (!Array.isArray(rollup)) return [];
  const out: GhCheckSnapshot[] = [];
  for (const item of rollup as RawCheckRollupEntry[]) {
    const name = asString(item.name) || asString(item.context);
    if (name.length === 0) continue;
    const status = asString(item.status, "UNKNOWN").toUpperCase();
    const conclusion = asString(item.conclusion, "PENDING").toUpperCase();
    out.push({ prNumber, name, status, conclusion, checkKey: `${prNumber}:${name}:${status}:${conclusion}` });
  }
  return out;
}

function parseReviews(raw: unknown, prNumber: number): GhReviewSnapshot[] {
  const reviews = (raw as { reviews?: unknown } | null)?.reviews;
  if (!Array.isArray(reviews)) return [];
  const out: GhReviewSnapshot[] = [];
  for (const item of reviews as RawReview[]) {
    const reviewId = asString(item.id);
    if (reviewId.length === 0) continue;
    out.push({
      prNumber,
      reviewId,
      state: asString(item.state, "UNKNOWN").toUpperCase(),
      submittedAt: asString(item.submittedAt),
    });
  }
  return out;
}

function parseComments(raw: unknown, target: "issue" | "pr", number: number): GhCommentSnapshot[] {
  const comments = (raw as { comments?: unknown } | null)?.comments;
  if (!Array.isArray(comments)) return [];
  const out: GhCommentSnapshot[] = [];
  for (const item of comments as RawComment[]) {
    const commentId = asString(item.id);
    if (commentId.length === 0) continue;
    const authorRecord = item.author as { login?: unknown } | undefined;
    const createdAt = asString(item.createdAt);
    const body = asString(item.body).slice(0, 2000);
    out.push({
      target,
      number,
      commentId,
      author: authorRecord && typeof authorRecord.login === "string" ? authorRecord.login : "",
      createdAt,
      bodyPreview: body.slice(0, 400),
      bodyHash: snapshotHash({ commentId, body, createdAt }),
    });
  }
  return out;
}

// ---- the poll ---------------------------------------------------------------------

interface Cursor {
  watermark: string | null;
}

function after(a: string, watermark: string | null): boolean {
  return watermark === null || a >= watermark;
}

/**
 * Read a level-triggered snapshot for one repository. `cursor.watermark` is the
 * previous collectedAt; entities untouched since the watermark are skipped to
 * bound volume (correctness is enforced by ingest dedup). Never mutates anything.
 */
export async function pollRepository(
  repo: RepoPollRef,
  cursor: Cursor,
  gh: GhClient,
): Promise<PollResult> {
  const limit = repo.limit ?? 100;
  const watermark = cursor.watermark;

  const issueRaw = await gh.runJson(argvIssueList({ owner: repo.owner, name: repo.name, state: "all", limit }));
  const prRaw = await gh.runJson(argvPrList({ owner: repo.owner, name: repo.name, state: "all", limit }));

  const issues = parseIssues(issueRaw).filter((i) => after(i.updatedAt, watermark));
  const pullRequests = parsePrs(prRaw).filter((p) => after(p.updatedAt, watermark));

  const checks: GhCheckSnapshot[] = [];
  const reviews: GhReviewSnapshot[] = [];
  const conflicts: GhConflictSnapshot[] = [];
  for (const pr of pullRequests) {
    const [checkRaw, reviewRaw] = await Promise.all([
      gh.runJson(argvPrChecks(repo.owner, repo.name, pr.number)),
      gh.runJson(argvPrReviews(repo.owner, repo.name, pr.number)),
    ]);
    checks.push(...parseChecks(checkRaw, pr.number));
    reviews.push(...parseReviews(reviewRaw, pr.number));
    conflicts.push({ prNumber: pr.number, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus });
  }

  // Bounded comment reads keyed by the NUMERIC id of already-filtered entities;
  // comment ids/bodies are hashed + previewed, never passed into argv.
  const comments: GhCommentSnapshot[] = [];
  for (const issue of issues) {
    const commentRaw = await gh.runJson(argvIssueComments(repo.owner, repo.name, issue.number));
    comments.push(...parseComments(commentRaw, "issue", issue.number));
  }
  for (const pr of pullRequests) {
    const commentRaw = await gh.runJson(argvPrComments(repo.owner, repo.name, pr.number));
    comments.push(...parseComments(commentRaw, "pr", pr.number));
  }

  const collectedAt = new Date().toISOString();
  const snapshot: GhSnapshot = {
    repoId: repo.id,
    owner: repo.owner,
    name: repo.name,
    baselineAt: repo.baselineAt,
    cursor: watermark,
    watermark: collectedAt,
    collectedAt,
    issues,
    pullRequests,
    checks,
    reviews,
    conflicts,
    comments,
  };
  return {
    snapshot,
    fetched: {
      issues: Array.isArray(issueRaw) ? issueRaw.length : 0,
      pullRequests: Array.isArray(prRaw) ? prRaw.length : 0,
      checks: checks.length,
      reviews: reviews.length,
    },
  };
}

/** Narrow a GhError-ish thrown value to decide transient retry vs hard failure. */
export function isTransientPollError(err: unknown): boolean {
  const kind = (err as Partial<GhError>).kind;
  return kind === "rate_limited" || kind === "network";
}
