// src/domain/state-machine.ts
//
// M3 pure state machine definitions for the eight durable entities (R9/R10/R11).
//
// All legal transitions are centralized here as *data* (table-driven), one table
// of legal (from, to, event) triples per entity. Everything else in the domain
// validates against these tables; there is no scattered "if state == X" logic.
// Keeping the machines as plain data lets the spec tests enumerate every legal
// and illegal pair by construction and assert that no transition outside the
// table is ever legal.
//
// State conventions (authoritative DD):
//   - Issue:    BASELINE_EXCLUDED → NEW only via explicit `tissue enqueue`
//               (R14); normal discovery creates NEW → TRIAGE_PENDING. Triage
//               yields READY | DUPLICATE | MERGED | PAUSED_TRIAGE | BLOCKED |
//               REJECTED. Duplicate/merged history remains; future edits and
//               reopens create inbox events, never another WorkItem.
//   - WorkItem: READY → QUEUED → RUNNING → WAITING → RUNNING → COMPLETED with
//               PAUSED_WORK / BLOCKED / FAILED_HOLD / FAILED / REJECTED as
//               alternatives. BLOCKED stores blocked_by; dependency completion
//               atomically re-readies it. FAILED_HOLD preserves evidence until
//               an explicit human `tissue cleanup <wi>`; only then FAILED.
//               Terminal leftovers on COMPLETED/REJECTED/FAILED are cleanup
//               failures and are NEVER relabelled FAILED_HOLD.
//   - Triage (per-repository triage pump): IDLE → PROMPTING → IDLE, BACKOFF,
//               PAUSED_TRIAGE; one flight/repo; escalation after repeated
//               failures; explicit unpause resets.
//   - Session:  ACTIVE → RETAINED (mapping); a real session is never deleted.
//   - Worktree: ACTIVE → CLEANING → CLEANED.
//   - PR:       ACTIVE → MERGED | CLOSED (external state adopted, never dup).
//   - Inbox:    PENDING → DELIVERING → DELIVERED (delivery can recycle).
//   - Side effect: PENDING → EXECUTING → DONE | FAILED (attempts/backoff).

export const ENTITY_TYPES = [
  "issue",
  "work_item",
  "triage",
  "session",
  "worktree",
  "pull_request",
  "inbox",
  "side_effect",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export interface TransitionRule {
  /** Current state; a transition rule always names a real source state. */
  from: string;
  /** Destination state. */
  to: string;
  /** The event labels under which this (from, to) edge is legal. */
  events: readonly string[];
}

export interface StateMachine {
  states: readonly string[];
  transitions: readonly TransitionRule[];
}

// ---- Issue -------------------------------------------------------------------

const issueStates = [
  "BASELINE_EXCLUDED",
  "NEW",
  "TRIAGE_PENDING",
  "READY",
  "DUPLICATE",
  "MERGED",
  "PAUSED_TRIAGE",
  "BLOCKED",
  "REJECTED",
] as const;

const issueTransitions: readonly TransitionRule[] = [
  // BASELINE_EXCLUDED admits history ONLY through an explicit tissue enqueue.
  { from: "BASELINE_EXCLUDED", to: "NEW", events: ["enqueue", "manual_enqueue"] },
  // Normal discovery of a new issue enters NEW → TRIAGE_PENDING.
  { from: "NEW", to: "TRIAGE_PENDING", events: ["discovery", "schedule_triage"] },
  // Triage yields one of the six dispositions (R2/R9).
  { from: "TRIAGE_PENDING", to: "READY", events: ["triage_ready"] },
  { from: "TRIAGE_PENDING", to: "DUPLICATE", events: ["triage_duplicate"] },
  { from: "TRIAGE_PENDING", to: "MERGED", events: ["triage_merged"] },
  { from: "TRIAGE_PENDING", to: "PAUSED_TRIAGE", events: ["triage_paused"] },
  { from: "TRIAGE_PENDING", to: "BLOCKED", events: ["triage_blocked"] },
  { from: "TRIAGE_PENDING", to: "REJECTED", events: ["triage_rejected"] },
  // Pause / resume and dependency unblock re-enter triage for another pass.
  { from: "PAUSED_TRIAGE", to: "TRIAGE_PENDING", events: ["resume_triage", "unpause_triage"] },
  { from: "BLOCKED", to: "TRIAGE_PENDING", events: ["unblock_triage"] },
];

// ---- WorkItem ----------------------------------------------------------------

const workItemStates = [
  "READY",
  "QUEUED",
  "RUNNING",
  "WAITING",
  "COMPLETED",
  "PAUSED_WORK",
  "BLOCKED",
  "FAILED_HOLD",
  "FAILED",
  "REJECTED",
] as const;

const workItemTransitions: readonly TransitionRule[] = [
  // Primary lifecycle.
  { from: "READY", to: "QUEUED", events: ["enqueue", "queue"] },
  { from: "QUEUED", to: "RUNNING", events: ["claim"] },
  { from: "QUEUED", to: "READY", events: ["dequeue", "release"] },
  { from: "RUNNING", to: "WAITING", events: ["await_review", "needs_review"] },
  { from: "WAITING", to: "RUNNING", events: ["resume"] },
  { from: "WAITING", to: "RUNNING", events: ["timeout_retry"] },
  { from: "RUNNING", to: "COMPLETED", events: ["completed", "completion"] },
  // Pause / resume (R9). An artifact-owning item that is paused is queued again
  // on resume, preserving its lease/artifacts until capacity reclaims it.
  { from: "READY", to: "PAUSED_WORK", events: ["pause_work"] },
  { from: "QUEUED", to: "PAUSED_WORK", events: ["pause_work"] },
  { from: "RUNNING", to: "PAUSED_WORK", events: ["pause_work"] },
  { from: "WAITING", to: "PAUSED_WORK", events: ["pause_work"] },
  { from: "PAUSED_WORK", to: "QUEUED", events: ["resume_work"] },
  // BLOCKED stores blocked_by; dependency completion atomically re-readies it.
  { from: "READY", to: "BLOCKED", events: ["block"] },
  { from: "QUEUED", to: "BLOCKED", events: ["block"] },
  { from: "RUNNING", to: "BLOCKED", events: ["block"] },
  { from: "WAITING", to: "BLOCKED", events: ["block"] },
  { from: "PAUSED_WORK", to: "BLOCKED", events: ["block"] },
  { from: "BLOCKED", to: "READY", events: ["unblock"] },
  // Repeated wedge/drift/rogue effects/irreconcilable identity → FAILED_HOLD.
  { from: "RUNNING", to: "FAILED_HOLD", events: ["wedge", "drift", "rogue_effect", "irreconcilable_identity"] },
  { from: "WAITING", to: "FAILED_HOLD", events: ["wedge", "drift", "rogue_effect", "irreconcilable_identity"] },
  // FAILED_HOLD → FAILED ONLY via explicit human cleanup (preserved evidence).
  { from: "FAILED_HOLD", to: "FAILED", events: ["cleanup"] },
  // Direct failure/rejection paths (recoverable failure or human rejection).
  { from: "RUNNING", to: "FAILED", events: ["failed"] },
  { from: "QUEUED", to: "FAILED", events: ["failed"] },
  { from: "READY", to: "REJECTED", events: ["rejected"] },
  { from: "QUEUED", to: "REJECTED", events: ["rejected"] },
  { from: "RUNNING", to: "REJECTED", events: ["rejected"] },
  { from: "WAITING", to: "REJECTED", events: ["rejected"] },
];

// ---- Triage (per-repository triage pump) -------------------------------------

const triageStates = ["IDLE", "PROMPTING", "BACKOFF", "PAUSED_TRIAGE"] as const;

const triageTransitions: readonly TransitionRule[] = [
  { from: "IDLE", to: "PROMPTING", events: ["triage_start", "prompt"] },
  { from: "PROMPTING", to: "IDLE", events: ["triage_done"] },
  { from: "PROMPTING", to: "BACKOFF", events: ["triage_backoff"] },
  { from: "BACKOFF", to: "IDLE", events: ["backoff_complete", "retry"] },
  // Repeated consecutive failures escalate to PAUSED_TRIAGE.
  { from: "PROMPTING", to: "PAUSED_TRIAGE", events: ["escalate", "triage_escalated"] },
  { from: "BACKOFF", to: "PAUSED_TRIAGE", events: ["escalate", "triage_escalated"] },
  // Explicit pause / unpause (explicit unpause resets the pump to IDLE).
  { from: "IDLE", to: "PAUSED_TRIAGE", events: ["pause_triage"] },
  { from: "PROMPTING", to: "PAUSED_TRIAGE", events: ["pause_triage"] },
  { from: "BACKOFF", to: "PAUSED_TRIAGE", events: ["pause_triage"] },
  { from: "PAUSED_TRIAGE", to: "IDLE", events: ["unpause", "resume_triage"] },
];

// ---- Session (kind triage | resolution) --------------------------------------

const sessionStates = ["ACTIVE", "RETAINED"] as const;

const sessionTransitions: readonly TransitionRule[] = [
  // Completion mapping ACTIVE → RETAINED. A real session is never deleted.
  { from: "ACTIVE", to: "RETAINED", events: ["retained", "session_retained"] },
];

// ---- Worktree ----------------------------------------------------------------

const worktreeStates = ["ACTIVE", "CLEANING", "CLEANED"] as const;

const worktreeTransitions: readonly TransitionRule[] = [
  { from: "ACTIVE", to: "CLEANING", events: ["cleanup_start", "cleanup_started"] },
  { from: "CLEANING", to: "CLEANED", events: ["cleaned", "cleanup_done"] },
];

// ---- Pull request ------------------------------------------------------------

const prStates = ["ACTIVE", "MERGED", "CLOSED"] as const;

const prTransitions: readonly TransitionRule[] = [
  { from: "ACTIVE", to: "MERGED", events: ["merged", "pr_merged"] },
  { from: "ACTIVE", to: "CLOSED", events: ["closed", "pr_closed"] },
];

// ---- Inbox -------------------------------------------------------------------

const inboxStates = ["PENDING", "DELIVERING", "DELIVERED", "TERMINAL"] as const;

const inboxTransitions: readonly TransitionRule[] = [
  { from: "PENDING", to: "DELIVERING", events: ["deliver", "delivery_started"] },
  { from: "DELIVERING", to: "DELIVERED", events: ["delivered"] },
  // Bounded noReply / failed-delivery observation recycles to PENDING (R10).
  { from: "DELIVERING", to: "PENDING", events: ["recycle", "recycle_no_reply"] },
  // Terminal-unattached housekeeping for NULL-WorkItem rows on terminal issues.
  { from: "PENDING", to: "TERMINAL", events: ["terminal_housekeeping", "terminal_unattached_housekeeping"] },
];

// ---- Side effect -------------------------------------------------------------

const sideEffectStates = ["PENDING", "EXECUTING", "DONE", "FAILED"] as const;

const sideEffectTransitions: readonly TransitionRule[] = [
  { from: "PENDING", to: "EXECUTING", events: ["execute_start", "started"] },
  { from: "EXECUTING", to: "DONE", events: ["done", "succeeded"] },
  { from: "EXECUTING", to: "FAILED", events: ["failed"] },
];

// ---- Centralized registry ----------------------------------------------------

export const STATE_MACHINES: Record<EntityType, StateMachine> = {
  issue: { states: issueStates, transitions: issueTransitions },
  work_item: { states: workItemStates, transitions: workItemTransitions },
  triage: { states: triageStates, transitions: triageTransitions },
  session: { states: sessionStates, transitions: sessionTransitions },
  worktree: { states: worktreeStates, transitions: worktreeTransitions },
  pull_request: { states: prStates, transitions: prTransitions },
  inbox: { states: inboxStates, transitions: inboxTransitions },
  side_effect: { states: sideEffectStates, transitions: sideEffectTransitions },
};

export function getStateMachine(entity: EntityType): StateMachine {
  return STATE_MACHINES[entity];
}

export function isKnownState(entity: EntityType, state: string): boolean {
  return getStateMachine(entity).states.includes(state as never);
}

/**
 * True only when `(from, to, event)` is an exact legal triple in the entity's
 * centralized transition table.
 */
export function isLegalTransition(entity: EntityType, from: string, to: string, event: string): boolean {
  return getStateMachine(entity).transitions.some(
    (t) => t.from === from && t.to === to && t.events.includes(event),
  );
}

/** Iterate every legal (from, to, event) triple for an entity (test enumeration). */
export function* legalTransitions(entity: EntityType): Generator<{ from: string; to: string; event: string }> {
  for (const t of getStateMachine(entity).transitions) {
    for (const e of t.events) {
      yield { from: t.from, to: t.to, event: e };
    }
  }
}

/** A state with no outgoing edge in the entity's table is terminal. */
export function isTerminalState(entity: EntityType, state: string): boolean {
  return !getStateMachine(entity).transitions.some((t) => t.from === state);
}

/** All (non-terminal) states that have at least one outgoing transition. */
export function nonTerminalStates(entity: EntityType): string[] {
  return getStateMachine(entity).states.filter((s) => !isTerminalState(entity, s));
}

// ---- Issue triage dispositions usable in a typed agent envelope ---------------

export const ISSUE_TRIAGE_DISPOSITIONS = [
  "READY",
  "DUPLICATE",
  "MERGED",
  "PAUSED_TRIAGE",
  "BLOCKED",
  "REJECTED",
] as const;

export type IssueTriageDisposition = (typeof ISSUE_TRIAGE_DISPOSITIONS)[number];

/** Canonical FSM event that applies each issue triage disposition. */
export const ISSUE_DISPOSITION_EVENT: Record<IssueTriageDisposition, string> = {
  READY: "triage_ready",
  DUPLICATE: "triage_duplicate",
  MERGED: "triage_merged",
  PAUSED_TRIAGE: "triage_paused",
  BLOCKED: "triage_blocked",
  REJECTED: "triage_rejected",
};

// ---- Expected artifact-owning WorkItem set (R6/R13, drift scanning) ----------

/**
 * States in which a WorkItem is expected to own artifacts (branch/worktree/
 * session/PR). A FAILED_HOLD artifact is expected and cannot cascade to healthy
 * work; terminal states are never part of this set (no-terminal-relabel).
 */
export const ARTIFACT_OWNING_WORK_ITEM_STATES: ReadonlySet<string> = new Set([
  "QUEUED",
  "RUNNING",
  "WAITING",
  "PAUSED_WORK",
  "FAILED_HOLD",
  "BLOCKED",
]);
