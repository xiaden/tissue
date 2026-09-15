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
