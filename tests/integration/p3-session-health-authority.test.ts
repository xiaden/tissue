// tests/integration/p3-session-health-authority.test.ts
//
// Regression coverage for the review findings on PR #2 (issue #1): the P2
// resident-health authority must not be established by an empty census, must not
// be published before the authoritative P2 work completes, and must never read a
// GLOBAL /session/status failure as per-session loss.
//
// Fakes are limited to external boundaries: the pessimistic loopback OpenCode
// server behind the REAL authenticated `OpenCodeHttp`/`OpenCodeDriver` transport,
// plus an isolated temp Tissue DB. No OpenCode database is touched and no real
// service is started, stopped, restarted, or reaped.

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifySessionCensus,
  runReconcilePass,
  type ReconcileDeps,
} from "../../src/controller/reconcile.ts";
import { getWorkItem, insertWorkItem, listSessions } from "../../src/db/repositories.ts";
import type { TissueDb } from "../../src/db/open.ts";
import { OpenCodeDriver } from "../../src/integrations/opencode-driver.ts";
import { OpenCodeHttp } from "../../src/integrations/opencode-http.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import type { TissueConfig } from "../../src/config/types.ts";
import { createTestDb, seedRepository } from "../helpers/db.ts";
import { startPessimisticServer } from "../helpers/pessimistic-opencode-server.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ID = "xiaden/nomarr";
const WI = "wi-xiaden-nomarr-7";

const MINIMAL_CONFIG: TissueConfig = {
  security: { trustedGithubUsers: ["trusted"] },
  pollIntervalSeconds: 60,
  maxConcurrentGlobal: 1,
  retentionDays: 30,
  agents: {},
  repos: [],
};

/** Inert reconcile deps with a working resident probe; overridden per test. */
function deps(db: TissueDb, overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  const housekeeping = {
    checked: 0,
    terminalMarked: 0,
    pruned: 0,
    issueIds: [] as string[],
    at: new Date().toISOString(),
    counters: { terminalMarked: 0, pruned: 0, lastAt: null as string | null },
    lastAction: null,
  };
  return {
    now: () => new Date(),
    openDb: () => db,
    closeDb: () => {},
    verifyRepos: async () => [],
    probeResident: async () => {},
    censusSessions: async () => [],
    reconcileArtifacts: async () => ({ expiredLeases: 0, effects: 0, cleaned: [], retained: [] }),
    scanDrift: async () => [],
    housekeep: async () => housekeeping,
    resumeNormalLoop: async () => ({ recovered: [], claimed: null }),
    ...overrides,
  };
}

function logger(): JsonLogger {
  return new JsonLogger(new CapturingSink().writeable(), "info");
}

test("reconcile: an EMPTY durable census cannot establish resident health (explicit P2 probe)", async () => {
  const { db, cleanup } = createTestDb();
  try {
    let seen: { openCodeAvailable: boolean } | undefined;
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: logger(),
      db,
      deps: deps(db, {
        // Zero durable sessions, and the resident is actually unavailable.
        probeResident: async () => {
          throw new Error("resident OpenCode unreachable");
        },
        resumeNormalLoop: async (_db, health) => {
          seen = health;
          return { recovered: [], claimed: null };
        },
      }),
    });

    assert.equal(listSessions(db).length, 0, "the census has nothing durable to iterate");
    const p2 = report.phases.find((p) => p.phase === "P2");
    assert.equal(p2?.ok, false, "P2 fails when the explicit probe fails");
    assert.match(String(p2?.error), /unreachable/);
    assert.equal(report.residentOpenCodeAvailable, false, "an empty census never proves health");
    assert.equal(seen?.openCodeAvailable, false, "P6 receives the unhealthy signal");

    // Safe, OpenCode-independent reconciliation still ran.
    for (const phase of ["P1", "P3", "P4", "P5"] as const) {
      assert.equal(report.phases.find((p) => p.phase === phase)?.ok, true, `${phase} still runs`);
    }
  } finally {
    cleanup();
  }
});

test("reconcile: health is published only after recovery succeeds (throwing recovery keeps P6 gated)", async () => {
  const { db, cleanup } = createTestDb();
  try {
    let seen: { openCodeAvailable: boolean } | undefined;
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: logger(),
      db,
      deps: deps(db, {
        injectFault: (boundary) => {
          if (boundary === "recovery") throw new Error("injected recovery failure");
        },
        resumeNormalLoop: async (_db, health) => {
          seen = health;
          return { recovered: [], claimed: null };
        },
      }),
    });

    const p2 = report.phases.find((p) => p.phase === "P2");
    assert.equal(p2?.ok, false, "P2 fails when recovery throws");
    assert.equal(p2?.error, "injected recovery failure");
    assert.equal(
      report.residentOpenCodeAvailable,
      false,
      "a broken P2 must never publish safe-to-resume health",
    );
    assert.equal(seen?.openCodeAvailable, false, "P6 stays gated");
    assert.equal(report.phases.find((p) => p.phase === "P6")?.ok, true, "P6 still runs, gated");
  } finally {
    cleanup();
  }
});

test("reconcile: a GLOBAL /session/status 404 is dependency failure, never per-session session loss", async () => {
  const server = await startPessimisticServer({ username: "tissue", password: "s3cret" });
  const { db, cleanup } = createTestDb();
  const registryDir = mkdtempSync(join(tmpdir(), "tissue-session-registry-health-"));
  try {
    seedRepository(db, { id: REPO_ID });
    insertWorkItem(db, { id: WI, repo_id: REPO_ID, state: "RUNNING", base_branch: "main" });

    const http = new OpenCodeHttp({
      baseUrl: server.baseUrl(),
      username: "tissue",
      password: "s3cret",
    });
    const driver = new OpenCodeDriver({ http, db, registryDir });
    const session = await driver.createRealSession("resolution", "/tmp/wt", {
      repoId: REPO_ID,
      workItemId: WI,
      directory: "/tmp/wt",
      kind: "resolution",
    });

    // Positive control: with the global route healthy an idle session resolves via
    // the per-session lookup fallback.
    assert.equal(await driver.getSessionStatus(session.sessionId), "idle");

    // Now the GLOBAL status route fails while GET /session/{id} still works.
    server.globalStatusErrorCode = 404;
    await assert.rejects(
      () => driver.getSessionStatus(session.sessionId),
      "a global-status 404 must surface as a dependency failure, not 'missing'",
    );

    let seen: { openCodeAvailable: boolean } | undefined;
    const report = await runReconcilePass({
      config: MINIMAL_CONFIG,
      logger: logger(),
      db,
      deps: deps(db, {
        // The service-level status route is down, but /session is still reachable.
        probeResident: async () => {
          await driver.listSessions();
        },
        censusSessions: async (open) =>
          classifySessionCensus(open, (id) => driver.getSessionStatus(id), new Date()),
        resumeNormalLoop: async (_db, health) => {
          seen = health;
          return { recovered: [], claimed: null };
        },
      }),
    });

    assert.equal(report.phases.find((p) => p.phase === "P2")?.ok, false);
    assert.equal(report.residentOpenCodeAvailable, false, "an unobservable census is not health");
    assert.equal(seen?.openCodeAvailable, false, "P6 stays gated");
    assert.equal(
      getWorkItem(db, WI)?.state,
      "RUNNING",
      "a global-status 404 must not drive a live WorkItem into FAILED_HOLD",
    );
    assert.equal(listSessions(db).length, 1, "the durable session row is untouched");
  } finally {
    cleanup();
    await server.close();
    // The registry is test-only state; never leave a marker directory behind.
    // The variable is initialized only in this test's try block.
    rmSync(registryDir, { recursive: true, force: true });
  }
});
