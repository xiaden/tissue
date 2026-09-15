// src/domain/envelopes.ts
//
// M3 typed, bounded, untrusted-data agent envelopes (R10/R12, CONTRACTS agent
// envelope contract).
//
// Agents never acquire locks, choose identities, create PRs, or mutate
// controller state. They return a bounded, typed envelope; the controller
// validates identifiers/state/ownership and, in `applyEnvelope`, applies ONLY a
// legal state disposition inside the caller's transaction. An envelope can
// never create a session/worktree/PR identity or run a lifecycle effect — its
// only possible durable outcome is a legal entity transition (audited) or an
// auditable `noop_duplicate_envelope` no-op.
//
// Envelope fields are bounded (identifier-safe, length-capped) so untrusted
// issue/agent data cannot smuggle shell syntax, huge payloads, or arbitrary
// dispositions through the boundary.

import type { WriteTx } from "../db/open.ts";
import { getIssueById, getWorkItem, updateIssueState, setWorkItemState, listTransitions, appendTransition } from "../db/repositories.ts";
import { recordTransition } from "./transitions.ts";
import {
  ISSUE_TRIAGE_DISPOSITIONS,
  ISSUE_DISPOSITION_EVENT,
  isLegalTransition,
  type IssueTriageDisposition,
} from "./state-machine.ts";

// ---- Bounded envelope schemas -------------------------------------------------

export interface TriageEnvelope {
  kind: "triage";
  /** Controller-assigned unique id for at-least-once/dedup application. */
  envelope_id: string;
  /** Identifier of the (existing) issue being triaged. */
  issue_id: string;
  /** Disposition the triage agent recommends (one of the six triage yields). */
  disposition: IssueTriageDisposition;
  /** Canonical WorkItem reference when the disposition groups to one (e.g. DUPLICATE). */
  canonical_work_item_id?: string;
  /** Dependency identifiers when disposition is BLOCKED. */
  blocked_by?: string;
  /** Free-form but bounded human/agent rationale (kept out of the FSM). */
  reason?: string;
}

export type ResolutionOutcome =
  | "completed"
  | "awaiting_review"
  | "needs_changes"
  | "blocked";

export interface ResolutionEnvelope {
  kind: "resolution";
  envelope_id: string;
  /** Identifier of the (existing) WorkItem whose lifecycle this proposes to move. */
  work_item_id: string;
  /** Proposed lifecycle outcome (mapped onto legal WorkItem transitions). */
  outcome: ResolutionOutcome;
  /** Dependency identifiers when outcome is blocked. */
  blocked_by?: string;
  /** Bounded rationale. */
  reason?: string;
}

export type AgentEnvelope = TriageEnvelope | ResolutionEnvelope;

export interface ApplyResult {
  status: "applied" | "noop_duplicate";
  entityType: "issue" | "work_item";
  entityId: string;
  fromState: string | null;
  toState: string;
  envelopeId: string;
}

// ---- Errors ------------------------------------------------------------------

/** Envelope data failed bounded validation (untrusted input rejected). */
export class EnvelopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeValidationError";
  }
}

// ---- Bounded validation primitives -------------------------------------------

const IDENTIFIER_RE = /^[A-Za-z0-9._/:-]+$/;

function validateIdentifier(value: unknown, field: string, maxLen = 160): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EnvelopeValidationError(`${field}: must be a non-empty string`);
  }
  if (value.length > maxLen) {
    throw new EnvelopeValidationError(`${field}: exceeds ${maxLen} characters`);
  }
  if (!IDENTIFIER_RE.test(value)) {
    throw new EnvelopeValidationError(`${field}: contains characters that are not identifier-safe`);
  }
  return value;
}

function validateReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new EnvelopeValidationError("reason: must be a string");
  if (value.length > 2000) throw new EnvelopeValidationError("reason: exceeds 2000 characters");
  return value;
}

// ---- Envelope validation ------------------------------------------------------

function validateTriageEnvelope(e: TriageEnvelope): void {
  validateIdentifier(e.envelope_id, "envelope_id");
  validateIdentifier(e.issue_id, "issue_id");
  if (!ISSUE_TRIAGE_DISPOSITIONS.includes(e.disposition)) {
    throw new EnvelopeValidationError(`disposition: '${String(e.disposition)}' is not a triage disposition`);
  }
  if (e.canonical_work_item_id !== undefined) {
    validateIdentifier(e.canonical_work_item_id, "canonical_work_item_id");
  }
  if (e.blocked_by !== undefined) validateIdentifier(e.blocked_by, "blocked_by");
  validateReason(e.reason);
}

function validateResolutionEnvelope(e: ResolutionEnvelope): void {
  validateIdentifier(e.envelope_id, "envelope_id");
  validateIdentifier(e.work_item_id, "work_item_id");
  const outcomes: ResolutionOutcome[] = ["completed", "awaiting_review", "needs_changes", "blocked"];
  if (!outcomes.includes(e.outcome)) {
    throw new EnvelopeValidationError(`outcome: '${String(e.outcome)}' is not a resolution outcome`);
  }
  if (e.blocked_by !== undefined) validateIdentifier(e.blocked_by, "blocked_by");
  validateReason(e.reason);
}

export function validateEnvelope(envelope: AgentEnvelope): void {
  if (envelope === null || typeof envelope !== "object") {
    throw new EnvelopeValidationError("envelope: must be an object");
  }
  if (envelope.kind === "triage") {
    validateTriageEnvelope(envelope);
    return;
  }
  if (envelope.kind === "resolution") {
    validateResolutionEnvelope(envelope);
    return;
  }
  throw new EnvelopeValidationError(`envelope kind '${String((envelope as { kind?: unknown }).kind)}' is unsupported`);
}

// ---- Duplicate detection ------------------------------------------------------

/**
 * True when this exact `envelope_id` was already applied (non-noop) to the
 * entity, or the entity is already in `targetState`. Either means applying
 * again would create no second effect and must be a durable no-op.
 */
function isDuplicate(
  tx: WriteTx,
  entityType: "issue" | "work_item",
  entityId: string,
  envelopeId: string,
  currentState: string,
  targetState: string,
): boolean {
  if (currentState === targetState) return true;
  const rows = listTransitions(tx, entityType, entityId);
  for (const r of rows) {
    if (r.event === "noop_duplicate_envelope") continue;
    if (r.reason_json === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.reason_json);
    } catch {
      continue;
    }
    const obj = parsed as { envelope_id?: unknown };
    if (obj && typeof obj === "object" && obj.envelope_id === envelopeId) return true;
  }
  return false;
}

function recordNoop(
  tx: WriteTx,
  entityType: "issue" | "work_item",
  entityId: string,
  fromState: string | null,
  targetState: string,
  envelopeId: string,
  reasonText?: string,
): void {
  appendTransition(tx, {
    entity_type: entityType,
    entity_id: entityId,
    from_state: fromState,
    to_state: targetState,
    event: "noop_duplicate_envelope",
    reason_json: JSON.stringify({
      envelope_id: envelopeId,
      duplicate: true,
      reason: reasonText ?? "envelope already applied or target state already reached",
    }),
    actor: "controller.applyEnvelope",
  });
}

// ---- Application --------------------------------------------------------------

export function applyTriageEnvelope(tx: WriteTx, envelope: TriageEnvelope): ApplyResult {
  validateTriageEnvelope(envelope);
  const issue = getIssueById(tx, envelope.issue_id);
  if (!issue) throw new EnvelopeValidationError(`issue '${envelope.issue_id}' does not exist`);
  const targetState = envelope.disposition;
  const event = ISSUE_DISPOSITION_EVENT[envelope.disposition];

  if (isDuplicate(tx, "issue", issue.id, envelope.envelope_id, issue.state, targetState)) {
    recordNoop(tx, "issue", issue.id, issue.state, targetState, envelope.envelope_id, envelope.reason);
    return {
      status: "noop_duplicate",
      entityType: "issue",
      entityId: issue.id,
      fromState: issue.state,
      toState: targetState,
      envelopeId: envelope.envelope_id,
    };
  }

  if (!isLegalTransition("issue", issue.state, targetState, event)) {
    // Cannot apply a disposition the centralized FSM does not allow from this
    // issue's current state (e.g. NEW → READY skipping triage).
    throw new EnvelopeValidationError(
      `issue '${issue.id}' is in state '${issue.state}' which cannot legally become '${targetState}'`,
    );
  }

  // Apply the disposition in one transaction: update the durable state AND
  // append the audited transition via the centralized ledger. Never creates a
  // WorkItem/session/effect.
  updateIssueState(
    tx,
    issue.id,
    targetState,
    JSON.stringify({
      disposition: targetState,
      canonical_work_item_id: envelope.canonical_work_item_id ?? null,
      envelope_id: envelope.envelope_id,
    }),
    envelope.blocked_by ?? null,
  );
  recordTransition(
    tx,
    { type: "issue", id: issue.id },
    issue.state,
    targetState,
    event,
    {
      envelope_id: envelope.envelope_id,
      disposition: targetState,
      canonical_work_item_id: envelope.canonical_work_item_id ?? null,
      blocked_by: envelope.blocked_by ?? null,
      reason: envelope.reason ?? null,
    },
    "controller.applyEnvelope",
  );
  return {
    status: "applied",
    entityType: "issue",
    entityId: issue.id,
    fromState: issue.state,
    toState: targetState,
    envelopeId: envelope.envelope_id,
  };
}

const RESOLUTION_OUTCOME_TO: Record<ResolutionOutcome, string> = {
  completed: "COMPLETED",
  awaiting_review: "WAITING",
  needs_changes: "RUNNING",
  blocked: "BLOCKED",
};

const RESOLUTION_OUTCOME_EVENT: Record<ResolutionOutcome, string> = {
  completed: "completed",
  awaiting_review: "await_review",
  needs_changes: "resume",
  blocked: "block",
};

export function applyResolutionEnvelope(tx: WriteTx, envelope: ResolutionEnvelope): ApplyResult {
  validateResolutionEnvelope(envelope);
  const wi = getWorkItem(tx, envelope.work_item_id);
  if (!wi) throw new EnvelopeValidationError(`work item '${envelope.work_item_id}' does not exist`);
  const targetState = RESOLUTION_OUTCOME_TO[envelope.outcome];
  const event = RESOLUTION_OUTCOME_EVENT[envelope.outcome];

  if (isDuplicate(tx, "work_item", wi.id, envelope.envelope_id, wi.state, targetState)) {
    recordNoop(tx, "work_item", wi.id, wi.state, targetState, envelope.envelope_id, envelope.reason);
    return {
      status: "noop_duplicate",
      entityType: "work_item",
      entityId: wi.id,
      fromState: wi.state,
      toState: targetState,
      envelopeId: envelope.envelope_id,
    };
  }

  if (!isLegalTransition("work_item", wi.state, targetState, event)) {
    throw new EnvelopeValidationError(
      `work item '${wi.id}' is in state '${wi.state}' which cannot legally become '${targetState}' via '${envelope.outcome}'`,
    );
  }

  setWorkItemState(tx, wi.id, targetState, {
    blockedBy: envelope.outcome === "blocked" ? (envelope.blocked_by ?? null) : null,
  });
  recordTransition(
    tx,
    { type: "work_item", id: wi.id },
    wi.state,
    targetState,
    event,
    {
      envelope_id: envelope.envelope_id,
      outcome: envelope.outcome,
      blocked_by: envelope.outcome === "blocked" ? (envelope.blocked_by ?? null) : null,
      reason: envelope.reason ?? null,
    },
    "controller.applyEnvelope",
  );
  return {
    status: "applied",
    entityType: "work_item",
    entityId: wi.id,
    fromState: wi.state,
    toState: targetState,
    envelopeId: envelope.envelope_id,
  };
}

/** Validate a bounded agent envelope and apply its single state disposition. */
export function applyEnvelope(tx: WriteTx, envelope: AgentEnvelope): ApplyResult {
  validateEnvelope(envelope);
  if (envelope.kind === "triage") return applyTriageEnvelope(tx, envelope);
  return applyResolutionEnvelope(tx, envelope);
}
