// tests/unit/domain-state-machines.test.ts
//
// P3-S3 spec-first tests for the pure (DB-free) state-machine data: every entity
// exposes a centralized transition table; every legal (from,to,event) triple is
// accepted and every out-of-table triple is rejected; terminal states have no
// outgoing edge (so terminal rows can never be relabelled); the expected
// artifact-owning WorkItem set is exact; and the baseline/manual-enqueue rule
// admits history only through an explicit enqueue edge.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ENTITY_TYPES,
  STATE_MACHINES,
  legalTransitions,
  isLegalTransition,
  isTerminalState,
  isKnownState,
  ARTIFACT_OWNING_WORK_ITEM_STATES,
  type EntityType,
} from "../../src/domain/state-machine.ts";

const WORK_ITEM_TERMINAL = ["COMPLETED", "REJECTED", "FAILED"];

test("all eight entities expose a centralized transition table with non-empty states", () => {
  for (const e of ENTITY_TYPES) {
    const m = STATE_MACHINES[e];
    assert.ok(m.states.length >= 2, `${e}: expected at least two states`);
    assert.ok(m.transitions.length >= 1, `${e}: expected at least one transition`);
  }
});

test("every entity state is known to its own machine", () => {
  for (const e of ENTITY_TYPES) {
    for (const s of STATE_MACHINES[e].states) {
      assert.ok(isKnownState(e, s), `${e}: '${s}' should be a known state`);
    }
  }
});

test("every listed legal triple is legal, and every out-of-table triple is illegal", () => {
  for (const e of ENTITY_TYPES) {
    const machine = STATE_MACHINES[e];
    const eventTokens = new Set<string>();
    for (const t of machine.transitions) for (const ev of t.events) eventTokens.add(ev);
    const events = [...eventTokens];

    // 1) Every table entry is accepted.
    let count = 0;
    for (const { from, to, event } of legalTransitions(e)) {
      assert.ok(isLegalTransition(e, from, to, event), `${e}: ${from}->${to} '${event}' must be legal`);
      count += 1;
    }
    assert.ok(count > 0, `${e}: expected legal triples to enumerate`);

    // 2) Every (from,to) pair with NO listed edge rejects any event token.
    for (const from of machine.states) {
      for (const to of machine.states) {
        const hasEdge = machine.transitions.some((t) => t.from === from && t.to === to);
        if (hasEdge) continue;
        for (const ev of events) {
          assert.ok(
            !isLegalTransition(e, from, to, ev),
            `${e}: ${from}->${to} '${ev}' must NOT be legal (no edge)`,
          );
        }
      }
    }
  }
});

test("a wrong event on a real edge is rejected (edges are keyed by event too)", () => {
  // WorkItem READY -> QUEUED is legal only via enqueue/queue, not 'claim'.
  assert.ok(isLegalTransition("work_item", "READY", "QUEUED", "enqueue"));
  assert.ok(!isLegalTransition("work_item", "READY", "QUEUED", "claim"));
  // Issue TRIAGE_PENDING -> READY is legal only via triage_ready.
  assert.ok(isLegalTransition("issue", "TRIAGE_PENDING", "READY", "triage_ready"));
  assert.ok(!isLegalTransition("issue", "TRIAGE_PENDING", "READY", "triage_duplicate"));
});

test("WorkItem primary lifecycle chain is present and complete", () => {
  const chain: Array<[string, string, string]> = [
    ["READY", "QUEUED", "enqueue"],
    ["QUEUED", "RUNNING", "claim"],
    ["RUNNING", "WAITING", "await_review"],
    ["WAITING", "RUNNING", "resume"],
    ["RUNNING", "COMPLETED", "completed"],
  ];
  for (const [from, to, event] of chain) {
    assert.ok(
      isLegalTransition("work_item", from, to, event),
      `work_item ${from}->${to} '${event}' should be legal`,
    );
  }
});

test("terminal WorkItem states cannot be relabelled (no outgoing edge to FAILED_HOLD or anywhere)", () => {
  for (const s of WORK_ITEM_TERMINAL) {
    assert.ok(isTerminalState("work_item", s), `work_item '${s}' must be terminal`);
    for (const dest of STATE_MACHINES.work_item.states) {
      assert.ok(
        !isLegalTransition("work_item", s, dest, "wedge"),
        `work_item ${s}->${dest} must never be legal (no-terminal-relabel)`,
      );
      assert.ok(
        !isLegalTransition("work_item", s, dest, "drift"),
        `work_item ${s}->${dest} must never be legal (no-terminal-relabel)`,
      );
    }
  }
  // FAILED_HOLD is NOT terminal: it reaches FAILED only via explicit cleanup.
  assert.ok(!isTerminalState("work_item", "FAILED_HOLD"));
  assert.ok(isLegalTransition("work_item", "FAILED_HOLD", "FAILED", "cleanup"));
});

test("expected artifact-owning WorkItem set is exact and excludes terminal states", () => {
  const expected = new Set(["QUEUED", "RUNNING", "WAITING", "PAUSED_WORK", "FAILED_HOLD", "BLOCKED"]);
  assert.deepEqual([...ARTIFACT_OWNING_WORK_ITEM_STATES].sort(), [...expected].sort());
  for (const s of ARTIFACT_OWNING_WORK_ITEM_STATES) {
    assert.ok(STATE_MACHINES.work_item.states.includes(s as never), `work_item '${s}' must be a state`);
  }
  // Terminal rows are never artifact-owning expected.
  for (const s of WORK_ITEM_TERMINAL) {
    assert.ok(!ARTIFACT_OWNING_WORK_ITEM_STATES.has(s), `work_item '${s}' must not be artifact-owning`);
  }
});

test("baseline/manual enqueue admission: BASELINE_EXCLUDED leaves only via an enqueue edge (R14)", () => {
  const b = "BASELINE_EXCLUDED";
  assert.ok(isLegalTransition("issue", b, "NEW", "enqueue"));
  assert.ok(isLegalTransition("issue", b, "NEW", "manual_enqueue"));
  // No disposition can admit a baseline-excluded issue directly.
  for (const dest of STATE_MACHINES.issue.states) {
    if (dest === "NEW") continue;
    for (const ev of ["discovery", "triage_ready", "triage_rejected", "triage_duplicate"]) {
      assert.ok(!isLegalTransition("issue", b, dest, ev), `issue ${b}->${dest} '${ev}' must be illegal`);
    }
  }
  // Normal discovery is NEW -> TRIAGE_PENDING; an issue cannot skip triage.
  assert.ok(isLegalTransition("issue", "NEW", "TRIAGE_PENDING", "discovery"));
  assert.ok(!isLegalTransition("issue", "NEW", "READY", "triage_ready"));
  assert.ok(!isLegalTransition("issue", "NEW", "REJECTED", "triage_rejected"));
});

test("pause/block/unblock edges exist for WorkItem and issue-triage flows", () => {
  // Work pause + resume.
  assert.ok(isLegalTransition("work_item", "RUNNING", "PAUSED_WORK", "pause_work"));
  assert.ok(isLegalTransition("work_item", "PAUSED_WORK", "QUEUED", "resume_work"));
  // Work block (stores blocked_by) + dependency completion auto re-ready.
  assert.ok(isLegalTransition("work_item", "RUNNING", "BLOCKED", "block"));
  assert.ok(isLegalTransition("work_item", "BLOCKED", "READY", "unblock"));
  // Issue triage pause / resume and dependency unblock.
  assert.ok(isLegalTransition("issue", "TRIAGE_PENDING", "PAUSED_TRIAGE", "triage_paused"));
  assert.ok(isLegalTransition("issue", "PAUSED_TRIAGE", "TRIAGE_PENDING", "resume_triage"));
  assert.ok(isLegalTransition("issue", "TRIAGE_PENDING", "BLOCKED", "triage_blocked"));
  assert.ok(isLegalTransition("issue", "BLOCKED", "TRIAGE_PENDING", "unblock_triage"));
});

test("FAILED_HOLD preserves evidence: its only exit is FAILED via cleanup", () => {
  const exits = STATE_MACHINES.work_item.transitions
    .filter((t) => t.from === "FAILED_HOLD")
    .map((t) => t.to);
  assert.deepEqual(exits, ["FAILED"]);
  const cleanup = STATE_MACHINES.work_item.transitions.find(
    (t) => t.from === "FAILED_HOLD" && t.to === "FAILED",
  );
  assert.ok(cleanup?.events.includes("cleanup"));
});

test("non-work-item machines expose their expected core edges", () => {
  // Session mapping ACTIVE -> RETAINED, never deleted.
  assert.ok(isLegalTransition("session", "ACTIVE", "RETAINED", "retained"));
  // Worktree ACTIVE -> CLEANING -> CLEANED.
  assert.ok(isLegalTransition("worktree", "ACTIVE", "CLEANING", "cleanup_start"));
  assert.ok(isLegalTransition("worktree", "CLEANING", "CLEANED", "cleaned"));
  // PR ACTIVE -> MERGED | CLOSED.
  assert.ok(isLegalTransition("pull_request", "ACTIVE", "MERGED", "merged"));
  assert.ok(isLegalTransition("pull_request", "ACTIVE", "CLOSED", "closed"));
  // Side effect PENDING -> EXECUTING -> DONE | FAILED.
  assert.ok(isLegalTransition("side_effect", "PENDING", "EXECUTING", "execute_start"));
  assert.ok(isLegalTransition("side_effect", "EXECUTING", "DONE", "done"));
  assert.ok(isLegalTransition("side_effect", "EXECUTING", "FAILED", "failed"));
  // Inbox PENDING -> DELIVERING -> DELIVERED (R10) plus recycle and housekeeping.
  assert.ok(isLegalTransition("inbox", "PENDING", "DELIVERING", "deliver"));
  assert.ok(isLegalTransition("inbox", "DELIVERING", "DELIVERED", "delivered"));
  assert.ok(isLegalTransition("inbox", "DELIVERING", "PENDING", "recycle_no_reply"));
  assert.ok(isLegalTransition("inbox", "PENDING", "TERMINAL", "terminal_unattached_housekeeping"));
  // Triage pump IDLE -> PROMPTING -> IDLE, BACKOFF, PAUSED_TRIAGE; unpause resets.
  assert.ok(isLegalTransition("triage", "IDLE", "PROMPTING", "triage_start"));
  assert.ok(isLegalTransition("triage", "PROMPTING", "IDLE", "triage_done"));
  assert.ok(isLegalTransition("triage", "PROMPTING", "BACKOFF", "triage_backoff"));
  assert.ok(isLegalTransition("triage", "BACKOFF", "IDLE", "backoff_complete"));
  assert.ok(isLegalTransition("triage", "PROMPTING", "PAUSED_TRIAGE", "escalate"));
  assert.ok(isLegalTransition("triage", "PAUSED_TRIAGE", "IDLE", "unpause"));
});

test("terminal-state helper agrees with absence of outgoing edges for every entity", () => {
  for (const e of ENTITY_TYPES as readonly EntityType[]) {
    for (const s of STATE_MACHINES[e].states) {
      const hasOutgoing = STATE_MACHINES[e].transitions.some((t) => t.from === s);
      assert.equal(isTerminalState(e, s), !hasOutgoing, `${e} '${s}' terminal mismatch`);
    }
  }
});
