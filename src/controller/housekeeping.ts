// src/controller/housekeeping.ts
//
// Terminal-unattached NULL-WorkItem housekeeping wrapper (DD R10/R22, P3-S3).
//
// The durable transaction lives in repositories.ts
// (`housekeepTerminalUnattachedInbox`) — this module wires it into the single
// reconcile business path, emits the structured JSONL telemetry, and exposes the
// retained counters + last action for status/history. It does NOT fork the
// transaction: repeated runs are a byte-for-byte no-op, and the L1 decision is
// preserved (the `reparentInboxByIssue` guard `WHERE terminal_action IS NULL`
// remains, so a later explicit enqueue cannot resurrect a housekept row).

import type { TissueDb } from "../db/open.ts";
import {
  housekeepTerminalUnattachedInbox,
  housekeepingCounters,
  listHousekeepingActions,
  type HousekeepingAction,
  type HousekeepingResult,
} from "../db/repositories.ts";
import type { JsonLogger } from "../logging/jsonl.ts";

export interface HousekeepingRunResult extends HousekeepingResult {
  counters: { terminalMarked: number; pruned: number; lastAt: string | null };
  lastAction: HousekeepingAction | null;
}

/**
 * Run one idempotent terminal-unattached housekeeping pass, emit structured
 * JSONL, and return the retained audit counters/action for status/history.
 */
export function runTerminalUnattachedHousekeeping(
  db: TissueDb,
  now: Date = new Date(),
  logger?: JsonLogger,
): HousekeepingRunResult {
  const result = housekeepTerminalUnattachedInbox(db, now);
  if (logger) {
    if (result.terminalMarked > 0) {
      logger.info("housekeeping.terminal_unattached", {
        checked: result.checked,
        terminalMarked: result.terminalMarked,
        pruned: result.pruned,
        issueIds: result.issueIds,
        at: result.at,
      });
    } else {
      logger.debug("housekeeping.terminal_unattached", { checked: result.checked, terminalMarked: 0 });
    }
  }
  return {
    ...result,
    counters: housekeepingCounters(db),
    lastAction: listHousekeepingActions(db, 1)[0] ?? null,
  };
}

/** Read-only housekeeping counters + most recent action (status/history surface). */
export function housekeepingObservability(db: TissueDb): {
  counters: { terminalMarked: number; pruned: number; lastAt: string | null };
  lastAction: HousekeepingAction | null;
} {
  return {
    counters: housekeepingCounters(db),
    lastAction: listHousekeepingActions(db, 1)[0] ?? null,
  };
}
