// tests/integration/p4-daemon.test.ts
//
// P4-S1: the A' supervised reconcile daemon. Proves the normal loop owns queue
// promotion + claiming + relay, that one failing phase cannot starve the rest,
// and that SSE is a WAKE HINT ONLY backed by a heartbeat watchdog, jittered
// reconnect, durable resync, and the polling backstop (RG-5).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTestDb, seedRepository } from "../helpers/db.ts";
import { insertSession, insertWorkItem } from "../../src/db/repositories.ts";
import { claimNextWorkItem } from "../../src/controller/queue.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import type { TissueConfig } from "../../src/config/types.ts";
import { ingestRepositorySnapshot } from "../../src/controller/ingest.ts";
import type { GhSnapshot } from "../../src/controller/poll.ts";
import {
  jitteredDelayMs,
  promoteReadyWorkItems,
  reconnectDelayMs,
  runDaemon,
  runNormalLoopPass,
  SseWakeHint,
  type NormalLoopIo,
  type WakeStreamSource,
} from "../../src/runtime/daemon.ts";

const CONFIG: TissueConfig = {
  pollIntervalSeconds: 300,
  maxConcurrentGlobal: 3,
  retentionDays: 90,
  agents: {},
  repos: [],
};

function makeLogger(): JsonLogger {
  return new JsonLogger(new CapturingSink().writeable());
}

const REPO_ID = "xiaden/nomarr";

function emptySnapshot(repoId: string): GhSnapshot {
  return {
    repoId,
    owner: "xiaden",
    name: "nomarr",
    baselineAt: null,
    cursor: null,
    watermark: "2026-09-10T00:00:00.000Z",
    collectedAt: "2026-09-10T00:00:00.000Z",
    issues: [],
    pullRequests: [],
    checks: [],
    reviews: [],
    conflicts: [],
    comments: [],
  };
}

function fakeIo(overrides: Partial<NormalLoopIo> = {}): NormalLoopIo {
  const base: NormalLoopIo = {
    now: () => new Date("2026-09-10T00:00:00.000Z"),
    logger: makeLogger(),
    pollRepository: async (repo) => emptySnapshot(repo.id),
    ingest: (db, snapshot) => ingestRepositorySnapshot(db, snapshot),
    runTriage: async () => ({ ran: false, reason: "no_due" }),
    claimNext: () => null,
    ensureResolution: async () => null,
    relay: async () => ({ status: "no_pending" }),
    executeEffects: async () => 0,
  };
  return { ...base, ...overrides };
}

test("normal loop promotes READY->QUEUED once, claims it, and relays active items", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { maxConcurrentPerRepo: 2 });
    insertWorkItem(db, { id: "wi-x", repo_id: REPO_ID, state: "READY", base_branch: "main" });
    insertWorkItem(db, { id: "wi-y", repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });
    insertSession(db, {
      id: "ses_resy",
      kind: "resolution",
      work_item_id: "wi-y",
      directory: "/tmp/wt-wi-y",
      state: "ACTIVE",
    });

    let ensured: string[] = [];
    const relayed: string[] = [];
    const io = fakeIo({
      // Use the REAL queue claim so promotion -> claim mutates durable state.
      claimNext: (db, at) => claimNextWorkItem(db, at, { globalLimit: 3 }),
      ensureResolution: async (_db, claim) => {
        ensured = [...ensured, claim.workItemId];
        return null;
      },
      relay: async (_db, workItemId) => {
        relayed.push(workItemId);
        return { status: "no_pending" };
      },
    });

    const first = await runNormalLoopPass(db, CONFIG, io);
    assert.equal(first.promoted, 1);
    assert.deepEqual(first.claimed, ["wi-x"]);
    assert.deepEqual(ensured, ["wi-x"]);
    assert.ok(relayed.includes("wi-y"));
    assert.deepEqual(first.errors, []);

    // Idempotent: the promoted item is RUNNING (claimed + leased), not READY, so a
    // second pass does not re-promote or re-claim it.
    const second = await runNormalLoopPass(db, CONFIG, io);
    assert.equal(second.promoted, 0);
    assert.deepEqual(second.claimed, []);

    const state = db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = 'wi-x'")?.state;
    assert.equal(state, "RUNNING");
  } finally {
    cleanup();
  }
});

test("a failing phase is recorded and later phases still run", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db);
    let effectsRan = 0;
    const io = fakeIo({
      pollRepository: async () => {
        throw new Error("gh rate limited");
      },
      executeEffects: async () => {
        effectsRan += 1;
        return 2;
      },
    });
    const summary = await runNormalLoopPass(db, CONFIG, io);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0]?.phase, `poll:${REPO_ID}`);
    assert.equal(effectsRan, 1);
    assert.equal(summary.effects, 2);
  } finally {
    cleanup();
  }
});

test("promoteReadyWorkItems skips disabled repositories and is a no-op when empty", () => {
  const { db, cleanup } = createTestDb();
  try {
    assert.equal(promoteReadyWorkItems(db), 0);
    seedRepository(db);
    insertWorkItem(db, { id: "wi-z", repo_id: REPO_ID, state: "READY", base_branch: "main" });
    db.sql.run("UPDATE repositories SET enabled = 0 WHERE id = ?", REPO_ID);
    assert.equal(promoteReadyWorkItems(db), 0);
  } finally {
    cleanup();
  }
});

/** Build a wake source whose single iterator is created per connection. */
function wakeSource(makeIterator: () => AsyncIterator<unknown>): WakeStreamSource {
  return {
    openStream(): AsyncIterable<unknown> {
      const iterator = makeIterator();
      return {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
          return iterator;
        },
      };
    },
  };
}

/** A silent stream: `next()` never resolves, `return()` resolves immediately. */
function silentSource(): WakeStreamSource {
  return wakeSource(() => ({
    next(): Promise<IteratorResult<unknown>> {
      return new Promise<IteratorResult<unknown>>(() => {});
    },
    return(): Promise<IteratorResult<unknown>> {
      return Promise.resolve({ done: true, value: undefined });
    },
  }));
}

test("SSE is a wake hint only: passes still run on the polling backstop with a silent stream", async () => {
  const { db, cleanup } = createTestDb();
  const logger = makeLogger();
  try {
    seedRepository(db);
    let reconciles = 0;
    const hint = new SseWakeHint({
      source: silentSource(),
      logger,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 1))),
      heartbeatTimeoutMs: 1,
      reconnectBaseMs: 1,
      reconnectMaxMs: 2,
      random: () => 1,
    });
    const io = fakeIo();
    const report = await runDaemon({
      config: CONFIG,
      logger,
      db,
      reconcile: async () => {
        reconciles += 1;
      },
      normalLoop: io,
      wakeHint: hint,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 1))),
      pollIntervalMs: 2,
      maxIterations: 3,
    });
    assert.equal(reconciles, 1);
    assert.equal(report.iterations, 3);
    assert.equal(report.passes.length, 3);
    assert.equal(hint.status(), "stopped");
  } finally {
    cleanup();
  }
});

test("AbortSignal stops an unbounded daemon and closes its wake hint", async () => {
  const { db, cleanup } = createTestDb();
  const logger = makeLogger();
  const controller = new AbortController();
  const hint = new SseWakeHint({ source: silentSource(), logger, sleep: async () => {}, heartbeatTimeoutMs: 1 });
  let passes = 0;
  try {
    seedRepository(db);
    const report = await runDaemon({
      config: CONFIG,
      logger,
      db,
      reconcile: async () => {},
      normalLoop: fakeIo({ executeEffects: async () => { passes += 1; controller.abort(); return 0; } }),
      wakeHint: hint,
      sleep: async () => {},
      pollIntervalMs: 1,
      signal: controller.signal,
    });
    assert.equal(report.iterations, 1);
    assert.equal(passes, 1);
    assert.equal(hint.status(), "stopped");
  } finally {
    cleanup();
  }
});

test("heartbeat watchdog reconnects a silent stream and resyncs durable status", async () => {
  const logger = makeLogger();
  let resyncs = 0;
  let signalResync: () => void = () => {};
  const resynced = new Promise<void>((resolve) => {
    signalResync = resolve;
  });
  const hint = new SseWakeHint({
    source: silentSource(),
    logger,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 1))),
    heartbeatTimeoutMs: 1,
    reconnectBaseMs: 1,
    reconnectMaxMs: 1,
    random: () => 1,
    onResync: () => {
      resyncs += 1;
      signalResync();
    },
  });
  hint.start();
  hint.start(); // idempotent: never double-starts a loop
  await Promise.race([
    resynced,
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]);
  await hint.close();
  assert.ok(resyncs >= 1, `expected at least one reconnect resync, saw ${resyncs}`);
  assert.equal(hint.status(), "stopped");
});

test("a stream event wakes a waiting pass immediately without being treated as truth", async () => {
  const logger = makeLogger();
  let first = true;
  const source = wakeSource(() => ({
    next(): Promise<IteratorResult<unknown>> {
      if (first) {
        first = false;
        // Emit after the waiter is registered so the wake is not lost.
        return new Promise<IteratorResult<unknown>>((resolve) => {
          setTimeout(() => resolve({ done: false, value: { type: "server.connected" } }), 10);
        });
      }
      return new Promise<IteratorResult<unknown>>(() => {});
    },
    return(): Promise<IteratorResult<unknown>> {
      return Promise.resolve({ done: true, value: undefined });
    },
  }));
  const hint = new SseWakeHint({
    source,
    logger,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 50))),
    heartbeatTimeoutMs: 200,
  });
  hint.start();
  const reason = await hint.waitForWakeOrTimeout(1000);
  assert.equal(reason, "wake");
  await hint.close();
});

test("jittered reconnect delay is bounded, capped, non-zero, and deterministic", () => {
  assert.equal(jitteredDelayMs(100, () => 0), 0);
  assert.equal(jitteredDelayMs(100, () => 0.5), 50);
  assert.equal(jitteredDelayMs(100, () => 1), 100);
  assert.equal(jitteredDelayMs(100, () => 5), 100);
  assert.equal(reconnectDelayMs(0, 1000, 30_000, () => 1), 1000);
  assert.equal(reconnectDelayMs(3, 1000, 30_000, () => 1), 8000);
  assert.equal(reconnectDelayMs(10, 1000, 30_000, () => 1), 30_000);
  assert.ok(reconnectDelayMs(0, 1000, 30_000, () => 0) >= 1);
});


// ---------------------------------------------------------------------------
// TASK-tissue-G Phase 6  reconcile -> daemon seam fail-closed gate
// ---------------------------------------------------------------------------

test("daemon: a failed resident census gates every prompt-dependent phase while OpenCode-independent work still runs", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db);
    const sink = new CapturingSink();
    const calls = { triage: 0, claim: 0, ensure: 0, relay: 0, poll: 0, ingest: 0, effects: 0 };
    const spyIo = fakeIo({
      logger: new JsonLogger(sink.writeable()),
      pollRepository: async (repo) => {
        calls.poll += 1;
        return emptySnapshot(repo.id);
      },
      ingest: (database, snapshot) => {
        calls.ingest += 1;
        return ingestRepositorySnapshot(database, snapshot);
      },
      runTriage: async () => {
        calls.triage += 1;
        return { ran: true };
      },
      claimNext: () => {
        calls.claim += 1;
        return null;
      },
      ensureResolution: async () => {
        calls.ensure += 1;
        return null;
      },
      relay: async () => {
        calls.relay += 1;
        return { status: "no_pending" };
      },
      executeEffects: async () => {
        calls.effects += 1;
        return 0;
      },
    });

    let reconciles = 0;
    const report = await runDaemon({
      config: CONFIG,
      logger: new JsonLogger(sink.writeable()),
      db,
      reconcile: async () => {
        reconciles += 1;
        // A failed resident census: the seam must seed the gate from this value.
        return { residentOpenCodeAvailable: false };
      },
      normalLoop: spyIo,
      sleep: async () => {},
      pollIntervalMs: 1,
      maxIterations: 2,
    });

    assert.equal(reconciles, 1, "reconcile runs exactly once");
    assert.equal(report.iterations, 2, "more than one iteration is exercised");
    assert.equal(report.passes.length, 2);
    assert.ok(report.passes.every((p) => p.gated === true), "the reconcile-seeded gate holds every pass");

    assert.equal(calls.triage, 0, "no triage prompt while the dependency is unobservable");
    assert.equal(calls.claim, 0, "no WorkItem claim while the dependency is unobservable");
    assert.equal(calls.ensure, 0, "no resolution session ensure while the dependency is unobservable");
    assert.equal(calls.relay, 0, "no relay prompt while the dependency is unobservable");

    assert.ok(calls.poll >= 2, "polling still runs");
    assert.ok(calls.ingest >= 2, "ingest still runs");
    assert.ok(calls.effects >= 2, "effects still run");
  } finally {
    cleanup();
  }
});

test("daemon: an injected health probe resumes prompt-dependent work on the next iteration without a restart", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db);
    insertWorkItem(db, { id: "wi-seam", repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });
    const sink = new CapturingSink();
    const logger = new JsonLogger(sink.writeable());
    const calls = { triage: 0, claim: 0, ensure: 0, relay: 0 };

    let claimSeq = 0;
    const io = fakeIo({
      logger,
      runTriage: async () => {
        calls.triage += 1;
        return { ran: true };
      },
      claimNext: () => {
        calls.claim += 1;
        claimSeq += 1;
        return claimSeq === 1
          ? { workItemId: "wi-seam", repoId: REPO_ID, leaseToken: "lease-x", leaseUntil: "2026-09-10T00:05:00.000Z", priority: 0 }
          : null;
      },
      ensureResolution: async () => {
        calls.ensure += 1;
        return null;
      },
      relay: async () => {
        calls.relay += 1;
        return { status: "no_pending" };
      },
    });

    let healthCalls = 0;
    const report = await runDaemon({
      config: CONFIG,
      logger,
      db,
      reconcile: async () => ({ residentOpenCodeAvailable: false }),
      checkResidentHealth: async () => {
        healthCalls += 1;
        return healthCalls > 1;
      },
      normalLoop: io,
      sleep: async () => {},
      pollIntervalMs: 1,
      maxIterations: 3,
    });

    assert.equal(healthCalls, 3, "the probe is re-evaluated every iteration");
    assert.equal(report.iterations, 3, "a single runDaemon call, no restart");
    assert.equal(report.passes.length, 3);
    assert.equal(report.passes[0]!.gated, true, "iteration 1 is gated");
    assert.equal(report.passes[1]!.gated, false, "iteration 2 resumes as soon as the probe reports healthy");
    assert.equal(report.passes[2]!.gated, false);

    assert.equal(calls.triage, 2, "triage ran on the two healthy iterations only");
    assert.ok(calls.claim >= 1, "claim ran after health was restored");
    assert.equal(calls.ensure, 1, "ensure-resolution ran after health was restored");
    assert.ok(calls.relay >= 1, "relay ran after health was restored");

    const gated = sink.records().filter((r) => r.event === "daemon.dependency_gated");
    assert.equal(gated.length, 1, "exactly one gate warning for the single gated pass");
    assert.equal(gated[0]!.lvl, "warn");
    assert.equal(gated[0]!.reason, "opencode_unavailable");
  } finally {
    cleanup();
  }
});

test("normal loop back-compat: an absent health signal is not gated and an explicit healthy signal runs today's phases", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db);
    insertWorkItem(db, { id: "wi-compat", repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });

    // 3-arg call (legacy direct callers): undefined health is NOT gated.
    const legacyCalls = { triage: 0, claim: 0, relay: 0 };
    const legacy = fakeIo({
      runTriage: async () => {
        legacyCalls.triage += 1;
        return { ran: true };
      },
      claimNext: () => {
        legacyCalls.claim += 1;
        return null;
      },
      relay: async () => {
        legacyCalls.relay += 1;
        return { status: "no_pending" };
      },
    });
    const legacySummary = await runNormalLoopPass(db, CONFIG, legacy);
    assert.equal(legacySummary.gated, false, "undefined health preserves prior behavior");
    assert.equal(legacySummary.gateReason, undefined);
    assert.equal(legacyCalls.triage, 1);
    assert.ok(legacyCalls.claim >= 1);
    assert.ok(legacyCalls.relay >= 1);

    // 4-arg call with an explicit healthy signal: prompt phases run as today.
    const healthyCalls = { triage: 0, claim: 0, relay: 0 };
    const healthy = fakeIo({
      runTriage: async () => {
        healthyCalls.triage += 1;
        return { ran: true };
      },
      claimNext: () => {
        healthyCalls.claim += 1;
        return null;
      },
      relay: async () => {
        healthyCalls.relay += 1;
        return { status: "no_pending" };
      },
    });
    const healthySummary = await runNormalLoopPass(db, CONFIG, healthy, { openCodeAvailable: true });
    assert.equal(healthySummary.gated, false);
    assert.equal(healthySummary.gateReason, undefined);
    assert.equal(healthyCalls.triage, 1);
    assert.ok(healthyCalls.claim >= 1);
    assert.ok(healthyCalls.relay >= 1);
  } finally {
    cleanup();
  }
});


// ---------------------------------------------------------------------------
// TASK-tissue-G QA round 2  health-probe fail-closed + gate-vs-promotion seam
// ---------------------------------------------------------------------------

test("daemon: a rejecting health probe fails closed and never crashes the loop", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db);
    const sink = new CapturingSink();
    const calls = { triage: 0, claim: 0, ensure: 0, relay: 0, poll: 0, ingest: 0, effects: 0 };
    const spyIo = fakeIo({
      logger: new JsonLogger(sink.writeable()),
      pollRepository: async (repo) => {
        calls.poll += 1;
        return emptySnapshot(repo.id);
      },
      ingest: (database, snapshot) => {
        calls.ingest += 1;
        return ingestRepositorySnapshot(database, snapshot);
      },
      runTriage: async () => {
        calls.triage += 1;
        return { ran: true };
      },
      claimNext: () => {
        calls.claim += 1;
        return null;
      },
      ensureResolution: async () => {
        calls.ensure += 1;
        return null;
      },
      relay: async () => {
        calls.relay += 1;
        return { status: "no_pending" };
      },
      executeEffects: async () => {
        calls.effects += 1;
        return 0;
      },
    });

    const report = await runDaemon({
      config: CONFIG,
      logger: new JsonLogger(sink.writeable()),
      db,
      // Healthy seed, but the per-iteration probe rejects and must override it.
      reconcile: async () => ({ residentOpenCodeAvailable: true }),
      checkResidentHealth: async () => {
        throw new Error("resident unreachable");
      },
      normalLoop: spyIo,
      sleep: async () => {},
      pollIntervalMs: 1,
      maxIterations: 2,
    });

    assert.equal(report.iterations, 2, "the loop resolves and survives the rejected probe");
    assert.equal(report.passes.length, 2);
    assert.ok(report.passes.every((p) => p.gated === true), "the rejection overrides the healthy seed");

    assert.equal(calls.triage, 0, "no triage prompt while the dependency is unobservable");
    assert.equal(calls.claim, 0, "no WorkItem claim while the dependency is unobservable");
    assert.equal(calls.ensure, 0, "no resolution session ensure while the dependency is unobservable");
    assert.equal(calls.relay, 0, "no relay prompt while the dependency is unobservable");

    assert.ok(calls.poll >= 2, "polling still runs");
    assert.ok(calls.ingest >= 2, "ingest still runs");
    assert.ok(calls.effects >= 2, "effects still run");

    const gated = sink.records().filter((r) => r.event === "daemon.dependency_gated");
    assert.equal(gated.length, 2, "one gate warning per gated pass");
    assert.ok(gated.every((r) => r.lvl === "warn"));
    assert.ok(gated.every((r) => r.reason === "opencode_unavailable"));
  } finally {
    cleanup();
  }
});

test("daemon: a gated pass still promotes READY->QUEUED and reports the gate reason", async () => {
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db);
    insertWorkItem(db, { id: "wi-gated", repo_id: REPO_ID, state: "READY", base_branch: "main" });
    const sink = new CapturingSink();
    const calls = { triage: 0, claim: 0, ensure: 0, relay: 0 };
    const spyIo = fakeIo({
      logger: new JsonLogger(sink.writeable()),
      runTriage: async () => {
        calls.triage += 1;
        return { ran: true };
      },
      claimNext: () => {
        calls.claim += 1;
        return null;
      },
      ensureResolution: async () => {
        calls.ensure += 1;
        return null;
      },
      relay: async () => {
        calls.relay += 1;
        return { status: "no_pending" };
      },
    });

    const report = await runDaemon({
      config: CONFIG,
      logger: new JsonLogger(sink.writeable()),
      db,
      reconcile: async () => ({ residentOpenCodeAvailable: false }),
      normalLoop: spyIo,
      sleep: async () => {},
      pollIntervalMs: 1,
      maxIterations: 1,
    });

    assert.equal(report.passes.length, 1);
    assert.equal(report.passes[0]!.gated, true);
    assert.equal(report.passes[0]!.gateReason, "opencode_unavailable");
    assert.equal(report.passes[0]!.promoted, 1, "promotion is outside the gate");

    const state = db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = 'wi-gated'")?.state;
    assert.equal(state, "QUEUED", "the gated pass still promoted the READY WorkItem");

    assert.equal(calls.triage, 0, "no triage prompt while the dependency is unobservable");
    assert.equal(calls.claim, 0, "no WorkItem claim while the dependency is unobservable");
    assert.equal(calls.ensure, 0, "no resolution session ensure while the dependency is unobservable");
    assert.equal(calls.relay, 0, "no relay prompt while the dependency is unobservable");
  } finally {
    cleanup();
  }
});
