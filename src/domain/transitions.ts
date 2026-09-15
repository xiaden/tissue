// src/domain/transitions.ts
//
// M3 centralized transition ledger (R9/R11/R22).
//
// `recordTransition` is the ONE place a state change may be written to the
// audit `state_transitions` ledger. It validates that `(entity, from, to, event)`
// is a legal triple in the centralized state-machine tables and appends exactly
// one audit row, in the same transaction as the caller's state change (callers
// run inside `runWrite`). An illegal transition throws `IllegalTransitionError`
// and appends nothing, so an out-of-table transition can never leave an audit
// trail.
//
// State changes themselves are performed by the repository accessors; this
// module owns the legality gate and the audit row so the two cannot drift apart.

import type { WriteTx } from "../db/open.ts";
import { appendTransition, listTransitions, type TransitionRecord } from "../db/repositories.ts";
import { isLegalTransition, isKnownState, type EntityType } from "./state-machine.ts";

/** A JSON-serializable reason object (bounded at the boundary by callers). */
export type JsonObject = Record<string, unknown>;

/** Stable domain error for a transition that is absent from the legal table. */
export class IllegalTransitionError extends Error {
  readonly entityType: EntityType;
  readonly from: string;
  readonly to: string;
  readonly event: string;
  constructor(entityType: EntityType, from: string, to: string, event: string) {
    super(
      `illegal ${entityType} transition ${from} -> ${to} (event '${event}') is not in the legal transition table`,
    );
    this.name = "IllegalTransitionError";
    this.entityType = entityType;
    this.from = from;
    this.to = to;
    this.event = event;
  }
}

export interface EntityRef {
  type: EntityType;
  id: string;
}

/** Stable domain error for an unknown entity state supplied to a transition. */
export class UnknownStateError extends Error {
  constructor(entityType: EntityType, state: string) {
    super(`unknown state '${state}' for ${entityType} entity`);
    this.name = "UnknownStateError";
  }
}

/**
 * Validate that `(from, to, event)` is legal for the entity and append exactly
 * one audit row. Throws `IllegalTransitionError` (and writes nothing) when the
 * triple is not in the centralized table. `reason` is JSON-serialized into the
 * audit `reason_json` column; pass `null` when there is no structured reason.
 *
 * `at` is an optional deterministic timestamp. Production omits it (the audit
 * row then uses the real clock); deterministic controller tests that inject a
 * clock pass their clock timestamp so the durable audit ordering and the
 * bounded delivery windows agree on a single time source.
 */
export function recordTransition(
  tx: WriteTx,
  entity: EntityRef,
  from: string | null,
  to: string,
  event: string,
  reason: JsonObject | null,
  actor: string,
  at?: string,
): TransitionRecord {
  if (from !== null) {
    if (!isKnownState(entity.type, from)) throw new UnknownStateError(entity.type, from);
  }
  if (!isKnownState(entity.type, to)) throw new UnknownStateError(entity.type, to);
  if (!isLegalTransition(entity.type, from ?? "", to, event)) {
    throw new IllegalTransitionError(entity.type, from ?? "", to, event);
  }

  const reasonJson = reason === null ? null : JSON.stringify(reason);
  appendTransition(tx, {
    entity_type: entity.type,
    entity_id: entity.id,
    from_state: from,
    to_state: to,
    event,
    reason_json: reasonJson,
    actor,
    ...(at !== undefined ? { at } : {}),
  });
  // Return the persisted row (audit `at`/id are DB-assigned).
  const rows = listTransitions(tx, entity.type, entity.id);
  const inserted = rows[rows.length - 1];
  if (!inserted) throw new IllegalTransitionError(entity.type, from ?? "", to, event);
  return inserted;
}
