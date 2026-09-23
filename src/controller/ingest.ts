// src/controller/ingest.ts
//
// M7 transactional snapshot ingest (R18/R19/R22). One BEGIN IMMEDIATE commits
// everything a poll observed: issue/PR snapshot columns, the poll watermark,
// snapshot_hash change-suppression, event_key dedup, NULL-WorkItem inbox rows
// (re-parented by Issue id in the same transaction), and any side-effect intents
// (transactional outbox). Either the whole snapshot lands or none of it does.
//
// Baseline discipline (R14/R22): issues created before the repository baseline
// are inserted as BASELINE_EXCLUDED and NEVER receive inbox events; only an
// explicit `tissue enqueue` admits them (BASELINE_EXCLUDED -> NEW).

import type { TissueDb } from "../db/open.ts";
import { runWrite } from "../db/open.ts";
import { recordTransition } from "../domain/transitions.ts";
import {
  activeIssueLinksForIssue,
  getIssueByRepoNumber,
  getRepositoryById,
  getWorkItemByHeadBranch,
  insertInboxEventIfAbsent,
  insertSideEffectIfAbsent,
  reparentInboxByIssue,
  setPollWatermark,
  updateIssueState,
  upsertIssueFromSnapshot,
  upsertPullRequestFromSnapshot,
  type InboxInput,
  type RepositoryRow,
} from "../db/repositories.ts";
import type { GhCommentSnapshot, GhSnapshot } from "./poll.ts";
import { admitIssue, parseConfiguredLabels } from "./intake.ts";
import { decideGithubActor, normalizeGithubLogin, type ActorObservation, type ProvenanceEnvelope, type TrustedGithubPolicy } from "./trust.ts";

export interface SideEffectIntent {
  id: string;
  kind: string;
  effect_key: string;
  payload_json: string;
}

export interface IngestOptions {
  /** Outbox intents to commit atomically with the snapshot (replay-idempotent). */
  sideEffects?: readonly SideEffectIntent[];
  /** Canonical controller policy; absent only for legacy objective-only callers. */
  policy?: TrustedGithubPolicy;
}

export interface IngestResult {
  repoId: string;
  committed: true;
  issuesSeen: number;
  issuesNew: number;
  issuesChanged: number;
  issuesExcludedBaseline: number;
  issuesExcludedLabel: number;
  inboxInserted: number;
  inboxDuplicates: number;
  reparented: number;
  prsSeen: number;
  prsLinked: number;
  prsUnlinked: number;
  prsRogue: number;
  checksSeen: number;
  reviewsSeen: number;
  conflictsSeen: number;
  commentsSeen: number;
  sideEffectsInserted: number;
  sideEffectsDuplicate: number;
  watermark: string;
}

function issueIdFor(repoId: string, number: number): string {
  return `issue-${repoId}-${number}`;
}

function prIdFor(repoId: string, number: number): string {
  return `pr-${repoId}-${number}`;
}

/** gh PR state -> pull_requests.state (ACTIVE/MERGED/CLOSED). */
function mapPrState(ghState: string): string {
  switch (ghState) {
    case "MERGED":
      return "MERGED";
    case "CLOSED":
      return "CLOSED";
    default:
      return "ACTIVE";
  }
}

function isBaseline(createdAt: string, baselineAt: string | null): boolean {
  if (baselineAt === null || createdAt.length === 0) return false;
  return createdAt < baselineAt;
}

function trustedProse(envelope: ProvenanceEnvelope): boolean {
  return envelope.decision === "TRUSTED" && envelope.deliveryClass === "TRUSTED_PROSE";
}

function observationEnvelope(
  repoId: string,
  sourceKind: string,
  objectId: string,
  observedVersion: string,
  authoritativeAt: string,
  actorProjection: { rawLogin: string | null; presence: "PRESENT" | "MISSING" | "MALFORMED" } | undefined,
  policy: TrustedGithubPolicy | undefined,
  contentId: string | null = null,
  contentHash: string | null = null,
  legacyVersion = false,
): ProvenanceEnvelope {
  const rawLogin = actorProjection?.rawLogin ?? null;
  const presence = actorProjection?.presence ?? "MISSING";
  const normalizedLogin = normalizeGithubLogin(rawLogin);
  const actor: ActorObservation = {
    present: rawLogin !== null,
    rawLogin,
    normalizedLogin,
    presence: presence === "PRESENT" && normalizedLogin !== null ? "PRESENT" : presence,
  };
  const decision = decideGithubActor(policy ?? null, actor);
  return {
    repository: repoId,
    sourceKind,
    objectId,
    contentId,
    observedVersion: legacyVersion ? "legacy" : observedVersion,
    contentHash: legacyVersion ? null : contentHash,
    authoritativeAt,
    policyRevision: policy?.revision ?? "unavailable",
    actor,
    ...decision,
  };
}

/**
 * Commit one polled snapshot. Must be called inside a write transaction
 * (`ingestRepositorySnapshot` wraps it). Idempotent: re-ingesting the same
 * snapshot inserts no new inbox rows and produces no new transitions.
 */
export function ingestSnapshot(tx: TissueDb, snapshot: GhSnapshot, opts: IngestOptions = {}): IngestResult {
  const result: IngestResult = {
    repoId: snapshot.repoId,
    committed: true,
    issuesSeen: snapshot.issues.length,
    issuesNew: 0,
    issuesChanged: 0,
    issuesExcludedBaseline: 0,
    issuesExcludedLabel: 0,
    inboxInserted: 0,
    inboxDuplicates: 0,
    reparented: 0,
    prsSeen: snapshot.pullRequests.length,
    prsLinked: 0,
    prsUnlinked: 0,
    prsRogue: 0,
    checksSeen: 0,
    reviewsSeen: 0,
    conflictsSeen: 0,
    commentsSeen: 0,
    sideEffectsInserted: 0,
    sideEffectsDuplicate: 0,
    watermark: snapshot.watermark,
  };

  const record = (input: InboxInput): void => {
    const res = insertInboxEventIfAbsent(tx, input);
    if (res.inserted) result.inboxInserted += 1;
    else result.inboxDuplicates += 1;
  };

  const repoRow = getRepositoryById(tx, snapshot.repoId);
  const configuredLabels = parseConfiguredLabels(repoRow?.labels_json ?? null);

  // ---- issues -----------------------------------------------------------------
  for (const issue of snapshot.issues) {
    const existing = getIssueByRepoNumber(tx, snapshot.repoId, issue.number);
    const baseline = isBaseline(issue.createdAt, snapshot.baselineAt);
    const issueId = issueIdFor(snapshot.repoId, issue.number);
    const activeLink = activeIssueLinksForIssue(tx, issueId)[0]?.work_item_id ?? null;

    // An already-admitted issue (explicit enqueue set NEW) is never demoted by a
    // later baseline/label re-evaluation; it is scheduled for triage.
    if (existing && existing.state === "NEW") {
      if (existing.snapshot_hash !== issue.snapshotHash) {
        upsertIssueFromSnapshot(tx, {
          id: existing.id,
          repo_id: snapshot.repoId,
          number: issue.number,
           title: issue.title,
          state: "NEW",
          snapshot_hash: issue.snapshotHash,
           updated_at: issue.updatedAt,
           envelope: observationEnvelope(snapshot.repoId, "issue", String(issue.number), issue.updatedAt, issue.updatedAt, issue.author, opts.policy, String(issue.number), issue.snapshotHash, true),
         });
        result.issuesChanged += 1;
      }
      recordTransition(
        tx,
        { type: "issue", id: issueId },
        "NEW",
        "TRIAGE_PENDING",
        "schedule_triage",
        { number: issue.number, snapshot_hash: issue.snapshotHash, reason: "explicit_enqueue" },
        "controller.ingest",
      );
      updateIssueState(tx, issueId, "TRIAGE_PENDING");
      record({
        work_item_id: activeLink,
        issue_id: issueId,
        event_key: `issue:${snapshot.repoId}:${issue.number}:${issue.snapshotHash}`,
        kind: "issue_discovered",
        payload_json: JSON.stringify({ issue_id: issueId, number: issue.number, state: "NEW", snapshot_hash: issue.snapshotHash }),
        created_at: snapshot.collectedAt,
      });
      if (activeLink) result.reparented += reparentInboxByIssue(tx, issueId, activeLink);
      continue;
    }

    const decision = admitIssue(issue.labels, configuredLabels, false, baseline);
    if (!decision.admitted) {
      if (!existing) {
        upsertIssueFromSnapshot(tx, {
          id: issueId,
          repo_id: snapshot.repoId,
          number: issue.number,
           title: issue.title,
          state: "BASELINE_EXCLUDED",
          snapshot_hash: issue.snapshotHash,
           updated_at: issue.updatedAt,
           envelope: observationEnvelope(snapshot.repoId, "issue", String(issue.number), issue.updatedAt, issue.updatedAt, issue.author, opts.policy, String(issue.number), issue.snapshotHash, true),
         });
        if (decision.reason === "label_mismatch") result.issuesExcludedLabel += 1;
        else result.issuesExcludedBaseline += 1;
      }
      continue;
    }

    if (!existing) {
      upsertIssueFromSnapshot(tx, {
        id: issueId,
        repo_id: snapshot.repoId,
        number: issue.number,
           title: issue.title,
        state: "NEW",
        snapshot_hash: issue.snapshotHash,
           updated_at: issue.updatedAt,
           envelope: observationEnvelope(snapshot.repoId, "issue", String(issue.number), issue.updatedAt, issue.updatedAt, issue.author, opts.policy, String(issue.number), issue.snapshotHash, true),
         });
      // Discovery: NEW -> TRIAGE_PENDING (scheduled by the triage pump).
      recordTransition(
        tx,
        { type: "issue", id: issueId },
        "NEW",
        "TRIAGE_PENDING",
        "discovery",
        { number: issue.number, snapshot_hash: issue.snapshotHash },
        "controller.poll",
      );
      updateIssueState(tx, issueId, "TRIAGE_PENDING");
      result.issuesNew += 1;
      record({
        work_item_id: activeLink,
        issue_id: issueId,
        event_key: `issue:${snapshot.repoId}:${issue.number}:${issue.snapshotHash}`,
        kind: "issue_discovered",
        payload_json: JSON.stringify({
          issue_id: issueId,
          number: issue.number,
          state: "NEW",
          snapshot_hash: issue.snapshotHash,
        }),
        created_at: snapshot.collectedAt,
      });
    } else if (existing.state === "BASELINE_EXCLUDED") {
      // A previously excluded issue stays excluded through normal discovery: the
      // explicit `tissue enqueue` is the SOLE historical override (R14). Refresh the
      // stored snapshot hash without emitting any inbox event.
      if (existing.snapshot_hash !== issue.snapshotHash) {
        upsertIssueFromSnapshot(tx, {
          id: existing.id,
          repo_id: snapshot.repoId,
          number: issue.number,
           title: issue.title,
          state: "BASELINE_EXCLUDED",
          snapshot_hash: issue.snapshotHash,
           updated_at: issue.updatedAt,
           envelope: observationEnvelope(snapshot.repoId, "issue", String(issue.number), issue.updatedAt, issue.updatedAt, issue.author, opts.policy, String(issue.number), issue.snapshotHash, true),
         });
        result.issuesChanged += 1;
      }
    } else if (existing.snapshot_hash !== issue.snapshotHash) {
      upsertIssueFromSnapshot(tx, {
        id: existing.id,
        repo_id: snapshot.repoId,
        number: issue.number,
           title: issue.title,
        state: existing.state,
        snapshot_hash: issue.snapshotHash,
           updated_at: issue.updatedAt,
           envelope: observationEnvelope(snapshot.repoId, "issue", String(issue.number), issue.updatedAt, issue.updatedAt, issue.author, opts.policy, String(issue.number), issue.snapshotHash, true),
         });
      result.issuesChanged += 1;
      record({
        work_item_id: activeLink,
        issue_id: existing.id,
        event_key: `issue:${snapshot.repoId}:${issue.number}:${issue.snapshotHash}`,
        kind: "issue_updated",
        payload_json: JSON.stringify({
          issue_id: existing.id,
          number: issue.number,
          state: existing.state,
          snapshot_hash: issue.snapshotHash,
        }),
        created_at: snapshot.collectedAt,
      });
    }

    // Re-parent any pre-existing NULL-WorkItem rows now that an attachment exists.
    // The L1 terminal-action guard keeps housekept rows unattached.
    if (activeLink) {
      result.reparented += reparentInboxByIssue(tx, issueId, activeLink);
    }
  }

  // ---- pull requests / checks / reviews / conflicts ---------------------------
  const linkedPrs = new Map<number, { workItemId: string; issueId: string | null }>();
  for (const pr of snapshot.pullRequests) {
    const workItem = getWorkItemByHeadBranch(tx, pr.headRefName);
    if (!workItem) {
      result.prsUnlinked += 1;
      continue;
    }
    // A PR whose head owner/repo is NOT the configured writable push repository is
    // a foreign fork riding the same controller branch: it is rogue/drift and is
    // NEVER adopted as the controller's PR, but its evidence is retained.
    if (isForeignHead(pr, repoRow)) {
       const prEnvelope = observationEnvelope(snapshot.repoId, "pull_request", String(pr.number), pr.updatedAt, pr.updatedAt, pr.author, opts.policy, String(pr.number), prSnapshotHash(pr));
       upsertPullRequestFromSnapshot(tx, {
         id: prIdFor(snapshot.repoId, pr.number),
        work_item_id: workItem.id,
        repo_id: snapshot.repoId,
        number: pr.number,
        head_ref: pr.headRefName,
        head_sha: pr.headRefOid,
        state: "ROGUE",
        origin: "rogue",
         snapshotHash: prSnapshotHash(pr),
         envelope: prEnvelope,
       });
      result.prsRogue += 1;
      continue;
    }
    const issueId = linkedIssueId(tx, workItem.id);
    linkedPrs.set(pr.number, { workItemId: workItem.id, issueId });
    result.prsLinked += 1;
       const prEnvelope = observationEnvelope(snapshot.repoId, "pull_request", String(pr.number), pr.updatedAt, pr.updatedAt, pr.author, opts.policy, String(pr.number), prSnapshotHash(pr));
       upsertPullRequestFromSnapshot(tx, {
         id: prIdFor(snapshot.repoId, pr.number),
      work_item_id: workItem.id,
      repo_id: snapshot.repoId,
      number: pr.number,
      head_ref: pr.headRefName,
      head_sha: pr.headRefOid,
      state: mapPrState(pr.state),
      origin: "expected",
         snapshotHash: prSnapshotHash(pr),
         envelope: prEnvelope,
       });
    if (issueId) {
      record({
        work_item_id: workItem.id,
        issue_id: issueId,
        event_key: `pr:${snapshot.repoId}:${pr.number}:${pr.headRefOid}:${pr.state}`,
        kind: "pr_updated",
        payload_json: JSON.stringify({ pr_number: pr.number, state: pr.state, head_sha: pr.headRefOid }),
        created_at: snapshot.collectedAt,
      });
    }
  }

  for (const check of snapshot.checks) {
    const link = linkedPrs.get(check.prNumber);
    if (!link || !link.issueId) continue;
    result.checksSeen += 1;
    record({
      work_item_id: link.workItemId,
      issue_id: link.issueId,
      event_key: `check:${snapshot.repoId}:${check.checkKey}`,
      kind: "check_updated",
      payload_json: JSON.stringify({
        pr_number: check.prNumber,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
      }),
      created_at: snapshot.collectedAt,
    });
  }

  for (const review of snapshot.reviews) {
    const link = linkedPrs.get(review.prNumber);
    if (!link || !link.issueId) continue;
    result.reviewsSeen += 1;
    record({
      work_item_id: link.workItemId,
      issue_id: link.issueId,
      event_key: `review:${snapshot.repoId}:${review.prNumber}:${review.reviewId}:${review.state}`,
      kind: "review_updated",
      payload_json: JSON.stringify({ pr_number: review.prNumber, review_id: review.reviewId, state: review.state }),
      created_at: snapshot.collectedAt,
    });
  }

  for (const conflict of snapshot.conflicts) {
    const link = linkedPrs.get(conflict.prNumber);
    if (!link || !link.issueId) continue;
    const dirty =
      conflict.mergeable === "CONFLICTING" ||
      conflict.mergeStateStatus === "DIRTY" ||
      conflict.mergeStateStatus === "BEHIND";
    if (!dirty) continue;
    result.conflictsSeen += 1;
    record({
      work_item_id: link.workItemId,
      issue_id: link.issueId,
      event_key: `conflict:${snapshot.repoId}:${conflict.prNumber}:${conflict.mergeStateStatus}`,
      kind: "pr_conflict",
      payload_json: JSON.stringify({
        pr_number: conflict.prNumber,
        mergeable: conflict.mergeable,
        merge_state_status: conflict.mergeStateStatus,
      }),
      created_at: snapshot.collectedAt,
    });
  }

  // ---- bounded comment events (issue + PR) ------------------------------------
  for (const comment of snapshot.comments ?? []) {
    const link = commentLink(tx, snapshot.repoId, comment, linkedPrs);
    if (!link || !link.issueId) continue;
    result.commentsSeen += 1;
    const rawLogin = comment.rawAuthor ?? comment.author ?? null;
    const presence = comment.authorPresence ?? (rawLogin === null ? "MISSING" : "PRESENT");
    const normalizedLogin = normalizeGithubLogin(rawLogin);
    const actor: ActorObservation = {
      present: rawLogin !== null,
      rawLogin,
      normalizedLogin,
      presence: presence === "MISSING" ? "MISSING" : presence === "MALFORMED" || normalizedLogin === null ? "MALFORMED" : "PRESENT",
    };
    const decision = decideGithubActor(opts.policy ?? null, actor);
    const envelope: ProvenanceEnvelope = {
      repository: snapshot.repoId,
      sourceKind: `${comment.target}_comment`,
      objectId: String(comment.number),
      contentId: comment.commentId,
      observedVersion: comment.bodyHash,
      contentHash: comment.bodyHash,
      authoritativeAt: comment.createdAt || snapshot.collectedAt,
      policyRevision: opts.policy?.revision ?? "unavailable",
      actor,
      ...decision,
    };
    const trusted = decision.decision === "TRUSTED";
    record({
      work_item_id: link.workItemId,
      issue_id: link.issueId,
      event_key: `comment:${snapshot.repoId}:${comment.target}:${comment.number}:${comment.commentId}:${comment.bodyHash}`,
      kind: comment.target === "issue" ? "issue_comment" : "pr_comment",
      payload_json: JSON.stringify(trusted ? {
        target: comment.target,
        number: comment.number,
        comment_id: comment.commentId,
        author: comment.author,
        body_preview: comment.bodyPreview,
      } : {
        target: comment.target,
        number: comment.number,
        comment_id: comment.commentId,
        denied: true,
      }),
      created_at: snapshot.collectedAt,
      envelope,
      quarantine_json: trusted ? null : JSON.stringify({
        sourceKind: envelope.sourceKind,
        objectId: envelope.objectId,
        contentId: envelope.contentId,
        observedVersion: envelope.observedVersion,
        contentHash: envelope.contentHash,
        authoritativeAt: envelope.authoritativeAt,
        actor: envelope.actor,
        decision: envelope.decision,
        reason: envelope.reason,
        deliveryClass: envelope.deliveryClass,
      }),
    });
  }

  // ---- side-effect intents (transactional outbox) -----------------------------
  for (const intent of opts.sideEffects ?? []) {
    const res = insertSideEffectIfAbsent(tx, {
      id: intent.id,
      kind: intent.kind,
      effect_key: intent.effect_key,
      state: "PENDING",
      payload_json: intent.payload_json,
    });
    if (res.inserted) result.sideEffectsInserted += 1;
    else result.sideEffectsDuplicate += 1;
  }

  // ---- watermark (committed with the snapshot) --------------------------------
  setPollWatermark(tx, snapshot.owner, snapshot.name, snapshot.watermark);
  return result;
}

/** Foreign if a positive head owner/repo is known and differs from push target. */
function isForeignHead(
  pr: { headOwner: string; headRepo: string },
  repo: RepositoryRow | undefined,
): boolean {
  if (!repo) return false;
  const expectedOwner = repo.push_owner || repo.target_owner || repo.owner;
  const expectedName = repo.push_name || repo.target_name || repo.name;
  const expectedRepo = `${expectedOwner}/${expectedName}`;
  if (pr.headRepo) return pr.headRepo.toLowerCase() !== expectedRepo.toLowerCase();
  if (pr.headOwner) return pr.headOwner.toLowerCase() !== expectedOwner.toLowerCase();
  // Unknown head identity is not treated as a foreign fork here (fail-open for
  // linking is bounded by the stricter identity checks at PR adoption time).
  return false;
}

/** Resolve the WorkItem/Issue attachment for a comment event. */
function commentLink(
  tx: TissueDb,
  repoId: string,
  comment: GhCommentSnapshot,
  linkedPrs: Map<number, { workItemId: string; issueId: string | null }>,
): { workItemId: string | null; issueId: string | null } | null {
  if (comment.target === "pr") {
    const link = linkedPrs.get(comment.number);
    return link ? { workItemId: link.workItemId, issueId: link.issueId } : null;
  }
  const issueId = issueIdFor(repoId, comment.number);
  const activeLink = activeIssueLinksForIssue(tx, issueId)[0]?.work_item_id ?? null;
  const issueExists = getIssueByRepoNumber(tx, repoId, comment.number);
  if (!issueExists && !activeLink) return null;
  return { workItemId: activeLink, issueId };
}

function prSnapshotHash(pr: { headRefOid: string; state: string; mergeable: string; mergeStateStatus: string }): string {
  return `${pr.headRefOid}:${pr.state}:${pr.mergeable}:${pr.mergeStateStatus}`;
}

/** First ACTIVE issue attached to a WorkItem, used to satisfy inbox.issue_id. */
function linkedIssueId(tx: TissueDb, workItemId: string): string | null {
  const row = tx.sql.get<{ issue_id: string }>(
    "SELECT issue_id FROM issue_work_items WHERE work_item_id = ? AND state = 'ACTIVE' ORDER BY issue_id LIMIT 1",
    workItemId,
  );
  return row?.issue_id ?? null;
}

/** Wrap ingestSnapshot in BEGIN IMMEDIATE so the whole snapshot commits atomically. */
export function ingestRepositorySnapshot(
  db: TissueDb,
  snapshot: GhSnapshot,
  opts: IngestOptions = {},
): IngestResult {
  return runWrite(db, (tx) => ingestSnapshot(tx, snapshot, opts));
}
