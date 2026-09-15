// src/controller/inbox-relay.ts
//
// M7 ordered durable inbox delivery (R10, DD "Ordered inbox/outbox delivery and
// completion"; T8 rules G1-G5, RG-3/RG-4 evidence). Exactly one WorkItem's
// PENDING events are bundled in global inbox.id order and delivered to that
// WorkItem's single real resolution session — and only when the controller has
// OBSERVED the session idle with no DELIVERING row outstanding and no controller
// turn active.
//
// Delivery is durable single-flight, never status-derived:
//   1. no DELIVERING row  ->  the bundle may be claimed;
//   2. the delivery nonce is recorded on the rows BEFORE the prompt is sent;
//   3. DELIVERED requires a nonce-bearing USER message followed by a parent-linked
//      ASSISTANT turn excluding summary=true / mode=compaction (RG-4) — HTTP 204
//      and an idle status are NEVER completion;
//   4. a noReply / dropped turn is bounded: past W_turn the bundle is recycled
//      DELIVERING->PENDING (+ human-inspect); past W_wedge the WorkItem is held
//      FAILED_HOLD with the evidence preserved.
//
// The relay never issues a second prompt while a DELIVERING row exists, so it
// never relies on an OpenCode "busy" rejection (G4): a prompt accepted while
// busy is reconciled by the same bounded observation window.

import { randomUUID } from "node:crypto";

import { TISSUE_RESOLVE_AGENT } from "../config/types.ts";
import type { TissueDb } from "../db/open.ts";
import { runWrite } from "../db/open.ts";
import {
  getActiveResolutionSession,
  getWorkItem,
  getRepositoryById,
  listWorktreesByWorkItem,
  latestTransitionAt,
  listDeliveringInboxByWorkItem,
  listPendingInboxByWorkItem,
  markInboxDelivered,
  markInboxDelivering,
  recycleInboxToPending,
  setWorkItemState,
  insertSideEffectIfAbsent,
  type InboxRow,
} from "../db/repositories.ts";
import { recordTransition } from "../domain/transitions.ts";
import { isLegalTransition } from "../domain/state-machine.ts";
import type { JsonLogger } from "../logging/jsonl.ts";
import type {
  AcceptedObservation,
  CompletionMatch,
  PromptEnvelope,
} from "../integrations/opencode-driver.ts";
import type { ResolutionDriver, SessionStatus } from "./session-driver.ts";
import { applyResolutionEnvelope, type ResolutionEnvelope } from "../domain/envelopes.ts";
import { headSha } from "../integrations/git-client.ts";

/** Bounded noReply observation window (T8: W_turn = 120s). */
export const W_TURN_MS = 120_000;
/** Wedged/busy ceiling before FAILED_HOLD (T8: W_wedge = 2 x W_turn = 240s). */
export const W_WEDGE_MS = 240_000;
/** Idle must be observed across K consecutive samples separated by >= Q (G3). */
export const K_IDLE_SAMPLES = 2;
export const Q_IDLE_GAP_MS = 5_000;

/** The narrow OpenCode surface the relay needs; OpenCodeDriver satisfies it. */
export interface RelayDriver {
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  promptAsync(sessionId: string, prompt: PromptEnvelope): Promise<AcceptedObservation>;
  observeCompletion(sessionId: string, deliveryNonce: string): Promise<CompletionMatch>;
  readResolutionResult?(sessionId: string, workItemId: string, deliveryNonce: string): Promise<{ envelope: import("../domain/envelopes.ts").ResolutionEnvelope } | null>;
}

export type DeliveryStatus =
  | "delivered"
  | "observing"
  | "busy_hold"
  | "no_pending"
  | "no_session"
  | "no_work_item"
  | "recycled"
  | "failed_hold"
  | "session_missing"
  | "prompt_failed";

export interface DeliveryResult {
  status: DeliveryStatus;
  workItemId: string;
  inboxIds: number[];
  nonce?: string;
  sessionId?: string;
  reason?: string;
  recycled?: number;
}

export interface RelayOptions {
  now?: Date;
  logger?: JsonLogger;
  /** Nonce factory (tests inject a deterministic value). */
  nonce?: () => string;
  wTurnMs?: number;
  wWedgeMs?: number;
  /** Consecutive idle samples required before delivering (G3). Default 2. */
  kIdleSamples?: number;
  /** Gap between idle samples in ms (G3 Q). Default 5000. */
  idleGapMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Agent name used when prompting the resolution session. */
  agent?: string;
  /** Native provider/model identity preserved on every resolution prompt. */
  model?: { providerID: string; modelID: string };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeNonce(): string {
  return `dlv_${randomUUID().replace(/-/g, "")}`;
}

/** Bounded bundle digest: controller-owned ids/kinds/JSON only, never gh text. */
export function buildBundleText(rows: readonly InboxRow[], nonce: string): string {
  const lines = rows.map((r) => `- event ${r.id} [${r.kind}] ${r.payload_json}`);
  return [
    `tissue delivery nonce: ${nonce}`,
    "Apply the following durable Tissue inbox events in order. Do not mutate Tissue lifecycle state.",
    ...lines,
  ].join("\n");
}

function transitionInbox(
  tx: TissueDb,
  rowId: number,
  from: string,
  to: string,
  event: string,
  nonce?: string,
  at?: string,
): void {
  recordTransition(
    tx,
    { type: "inbox", id: String(rowId) },
    from,
    to,
    event,
    nonce ? { delivery_nonce: nonce } : null,
    "controller.relay",
    at,
  );
}

/**
 * Relay the oldest PENDING events for ONE WorkItem, if and only if its resolution
 * session is observed idle with no outstanding DELIVERING row. Idempotent and
 * crash-safe: a DELIVERING row is always resumed (never duplicated), and a turn
 * that completed before a crash is adopted as DELIVERED rather than re-prompted.
 */
export async function relayOldestInbox(
  db: TissueDb,
  workItemId: string,
  driver: RelayDriver,
  opts: RelayOptions = {},
): Promise<DeliveryResult> {
  const now = opts.now ?? new Date();
  const wTurnMs = opts.wTurnMs ?? W_TURN_MS;
  const wWedgeMs = opts.wWedgeMs ?? W_WEDGE_MS;
  const logger = opts.logger;

  const workItem = getWorkItem(db, workItemId);
  if (!workItem) return { status: "no_work_item", workItemId, inboxIds: [] };

  const session = getActiveResolutionSession(db, workItemId);
  if (!session) return { status: "no_session", workItemId, inboxIds: [] };

  // ---- 1. Resume an existing DELIVERING attempt (durable single-flight) --------
  const delivering = listDeliveringInboxByWorkItem(db, workItemId);
  if (delivering.length > 0) {
    const nonce = delivering[0]!.delivery_nonce ?? "";
    const ids = delivering.map((r) => r.id);
    const startedAt =
      latestTransitionAt(db, "inbox", String(delivering[0]!.id), "delivery_started") ?? delivering[0]!.created_at;
    // Injected clocks used by deterministic tests may precede the database
    // timestamp written by a real clock. Treat that as zero elapsed time rather
    // than allowing a negative duration to bypass the bounded observation window.
    const elapsedMs = Math.max(0, now.getTime() - Date.parse(startedAt));

    const match = await driver.observeCompletion(session.id, nonce);
    if (match.matched) {
      await applyResolutionResult(db, workItemId, session.id, nonce, driver);
      return adoptDelivered(db, workItemId, ids, nonce, session.id, now);
    }
    if (match.reason === "session_missing") {
      return holdWorkItem(db, workItemId, session.id, ids, "session_missing", now, logger);
    }
    if (elapsedMs < wTurnMs) {
      return { status: "observing", workItemId, inboxIds: ids, nonce, sessionId: session.id, reason: match.reason };
    }
    if (elapsedMs >= wWedgeMs) {
      return holdWorkItem(db, workItemId, session.id, ids, "wedge", now, logger);
    }
    return recycle(db, workItemId, ids, session.id, match.reason, now, logger);
  }

  // ---- 2. Claim the oldest PENDING bundle, but only when observed idle ---------
  const pending = listPendingInboxByWorkItem(db, workItemId);
  if (pending.length === 0) return { status: "no_pending", workItemId, inboxIds: [] };

  const idle = await observeIdleAcrossSamples(driver, session.id, opts);
  if (!idle) return { status: "busy_hold", workItemId, inboxIds: [], sessionId: session.id };

  const nonce = (opts.nonce ?? makeNonce)();
  const ids = pending.map((r) => r.id);

  // Record the nonce and mark DELIVERING BEFORE the external prompt.
  runWrite(db, (tx) => {
    markInboxDelivering(tx, ids, nonce);
    // Use the same clock the relay windows against, so a deterministic injected
    // clock and the durable `delivery_started` audit row agree. Production omits
    // an injected clock and both sides use the real time source.
    for (const id of ids) transitionInbox(tx, id, "PENDING", "DELIVERING", "delivery_started", nonce, now.toISOString());
  });

  try {
    await driver.promptAsync(session.id, {
      text: buildBundleText(pending, nonce),
      nonce,
      // The dedicated resolution identity is mandatory: an omitted relay option
      // means tissue-resolve, never the resident OpenCode default agent.
      agent: opts.agent ?? TISSUE_RESOLVE_AGENT,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
  } catch (err) {
    // The prompt never reached the session: recycle so a later pass retries.
    const recycled = recycle(db, workItemId, ids, session.id, "prompt_failed", now, logger);
    return { ...recycled, reason: (err as Error).message };
  }

  // A fast turn may already be observable (sync completion); otherwise bound it.
  const match = await driver.observeCompletion(session.id, nonce);
  if (match.matched) {
    await applyResolutionResult(db, workItemId, session.id, nonce, driver);
    return adoptDelivered(db, workItemId, ids, nonce, session.id, now);
  }
  return { status: "observing", workItemId, inboxIds: ids, nonce, sessionId: session.id, reason: match.reason };
}

/** Observe idle across K samples separated by >= Q (G3); any non-idle -> false. */
async function observeIdleAcrossSamples(driver: RelayDriver, sessionId: string, opts: RelayOptions): Promise<boolean> {
  const k = Math.max(1, opts.kIdleSamples ?? K_IDLE_SAMPLES);
  const gap = opts.idleGapMs ?? Q_IDLE_GAP_MS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let i = 0; i < k; i++) {
    if (i > 0 && gap > 0) await sleep(gap);
    const status = await driver.getSessionStatus(sessionId);
    if (status !== "idle") return false;
  }
  return true;
}

async function applyResolutionResult(
  db: TissueDb,
  workItemId: string,
  sessionId: string,
  nonce: string,
  driver: RelayDriver,
): Promise<void> {
  if (!driver.readResolutionResult) return;
  const result = await driver.readResolutionResult(sessionId, workItemId, nonce);
  if (!result) return;
  const workItem = getWorkItem(db, workItemId);
  if (!workItem) throw new Error(`resolution result references missing WorkItem '${workItemId}'`);
  const repo = getRepositoryById(db, workItem.repo_id);
  const worktree = listWorktreesByWorkItem(db, workItemId).find((row) => row.state === "ACTIVE");
  if (!repo || !worktree) throw new Error(`resolution result has no active worktree for '${workItemId}'`);
  const envelope = result.envelope;
  const resolvedHeadSha = await headSha(worktree.path);
  runWrite(db, (tx) => {
    // `completed` means the agent finished the repair turn, not that the
    // controller has completed push/PR/protection/merge.  Keep the WorkItem
    // RUNNING until the verified merge effect closes the lifecycle.  Other
    // outcomes are state transitions owned by the envelope application.
    if (envelope.outcome !== "completed") {
      applyResolutionEnvelope(tx, envelope);
      return;
    }
    const payload = {
      owner: repo.target_owner || repo.owner,
      name: repo.target_name || repo.name,
      push_owner: repo.push_owner || repo.target_owner || repo.owner,
      push_name: repo.push_name || repo.target_name || repo.name,
      // The configured push remote is resolved into the durable payload; never
      // hard-code `origin` silently (explicit `origin` remains the default policy).
      push_remote: repo.push_remote || "origin",
      work_item_id: workItemId,
      dir: worktree.path,
      head_ref: worktree.branch,
      head_sha: resolvedHeadSha,
      base_branch: workItem.base_branch,
      title: workItem.title ?? `Tissue ${workItemId}`,
      body: `Automated repair for WorkItem ${workItemId}`,
      method: "squash" as const,
      // Durable merge policy captured at effect creation so the hard autoMerge gate
      // holds at execution even across restarts.
      auto_merge: repo.auto_merge === 1,
      merge_policy_known: true,
    };
    insertSideEffectIfAbsent(tx, {
      id: `fx-push-${workItemId}`,
      kind: "push",
      effect_key: `push:${workItemId}:${payload.head_sha}`,
      state: "PENDING",
      payload_json: JSON.stringify(payload),
    });
    insertSideEffectIfAbsent(tx, {
      id: `fx-pr-${workItemId}`,
      kind: "pr",
      effect_key: `pr:${workItemId}:${payload.head_ref}`,
      state: "PENDING",
      payload_json: JSON.stringify(payload),
    });
  });
}

function adoptDelivered(
  db: TissueDb,
  workItemId: string,
  ids: readonly number[],
  nonce: string,
  sessionId: string,
  now: Date,
): DeliveryResult {
  runWrite(db, (tx) => {
    markInboxDelivered(tx, ids, now.toISOString());
    for (const id of ids) transitionInbox(tx, id, "DELIVERING", "DELIVERED", "delivered", nonce, now.toISOString());
  });
  return { status: "delivered", workItemId, inboxIds: [...ids], nonce, sessionId };
}

function recycle(
  db: TissueDb,
  workItemId: string,
  ids: readonly number[],
  sessionId: string,
  reason: string,
  now: Date,
  logger?: JsonLogger,
): DeliveryResult {
  let recycled = 0;
  runWrite(db, (tx) => {
    recycled = recycleInboxToPending(tx, ids);
    for (const id of ids) transitionInbox(tx, id, "DELIVERING", "PENDING", "recycle_no_reply", undefined, now.toISOString());
  });
  logger?.warn("inbox.no_reply_recycled", { work_item_id: workItemId, inbox_ids: ids, reason, human_inspect: true });
  return { status: "recycled", workItemId, inboxIds: [...ids], sessionId, reason, recycled };
}

/**
 * Hold a wedged WorkItem: FAILED_HOLD (event wedge) with human-inspect, leaving
 * the DELIVERING evidence in place until `tissue cleanup`. Never relabels
 * terminal history and never deletes the session.
 */
function holdWorkItem(
  db: TissueDb,
  workItemId: string,
  sessionId: string,
  ids: readonly number[],
  reason: string,
  now: Date,
  logger?: JsonLogger,
): DeliveryResult {
  const workItem = getWorkItem(db, workItemId);
  const from = workItem?.state ?? "RUNNING";
  runWrite(db, (tx) => {
    if (isLegalTransition("work_item", from, "FAILED_HOLD", "wedge")) {
      recordTransition(tx, { type: "work_item", id: workItemId }, from, "FAILED_HOLD", "wedge", { reason }, "controller.relay");
      setWorkItemState(tx, workItemId, "FAILED_HOLD", { leaseToken: null, leaseUntil: null });
    }
  });
  logger?.error("inbox.wedged_failed_hold", {
    work_item_id: workItemId,
    session_id: sessionId,
    inbox_ids: ids,
    reason,
    human_inspect: true,
  });
  return { status: reason === "session_missing" ? "session_missing" : "failed_hold", workItemId, inboxIds: [...ids], sessionId, reason };
}
