// tests/integration/p6-registry.test.ts
//
// Phase 1 (plan I, spec-first) specification for the two-state managed-session
// registry (`src/controller/session-registry.ts`).
//
// NORMATIVE CONTRACT (plan I / DD §8; ledger L11/L12/L13/L18 as amended by
// OWNER AMENDMENT 2, 2026-09-16; ADR-005, which supersedes ADR-004):
//
//   * TWO-STATE classification only:
//         marker exists               => MANAGED   => plugin moderation applies
//         marker absent or unreadable => UNMANAGED => plugin completely inert
//     Classification is a single `statSync` existence check on the marker path.
//     Marker CONTENTS are never read; classification never uses a readdir
//     snapshot, never HTTP, and never a cache; it never throws.
//
//   * SINGLE INVARIANT (normative): Tissue MUST NOT prompt or resume an OpenCode
//     session unless that session's marker currently exists.
//
//   * Registration ordering is: create OpenCode session -> create `ses_*` marker
//     -> persist the durable Tissue DB mapping -> first prompt. Plan J owns the
//     call sites; this file owns the marker primitive and its startup handling.
//
//   * Startup reconciliation is PRUNE-EXTRAS ONLY, in exactly this order:
//         assert the registry is a real, host-persisted, writable mount
//         -> prune marker files whose session id has no DB row
//         -> continue.
//     It never globally invalidates the registry and never automatically marks
//     every DB session.
//
//   * The marker filesystem is host-persisted (a persistent volume): markers
//     survive a restart, the module never writes under a `/run` tmpfs path, and
//     the module never deletes the registry directory.
//
//   * There is NO `.ready`/`.initialized` sentinel, NO UNKNOWN classification,
//     NO registry-wide readiness state, NO freshness state, and NO
//     classification cache. Those belonged to the superseded ADR-004 model and
//     are named here only to record their ABSENCE (ADR-005).
//
// SPEC-FIRST: `src/controller/session-registry.ts` does not exist yet, so every
// specification below is expected to fail on import/resolution until Phase 2
// implements the module. A specification that passes before implementation is
// reported, never silently weakened.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createTestDb, seedRepository, REPO_ID } from "../helpers/db.ts";
import { closeDb, openTissueDb, type TissueDb } from "../../src/db/open.ts";
import { insertSession } from "../../src/db/repositories.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import { doctorOperation, statusOperation } from "../../src/controller/ops.ts";
import { installAgentDefinitions } from "../../src/runtime/resident.ts";
import { runProductionDaemonEntrypoint, type ProductionAssembly } from "../../src/runtime/entrypoint.ts";
import type { DaemonRunReport } from "../../src/runtime/daemon.ts";
import type { TissueConfig } from "../../src/config/types.ts";
import {
  assertRegistryMount,
  classifySessionMarker,
  createSessionMarker,
  deleteSessionMarker,
  ensureSessionMarkerBeforeResume,
  listMarkerSessionIds,
  markerPath,
  pruneMarkersWithoutDbRow,
  resolveSessionRegistryDir,
  runStartupRegistryReconciliation,
  type RegistryMountStatus,
  type RegistryStartupReport,
} from "../../src/controller/session-registry.ts";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

function makeTemp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `tissue-p6-registry-${tag}-`));
}

function makeLogger(): JsonLogger {
  return new JsonLogger(new CapturingSink().writeable(), "debug");
}

/**
 * Write a minimal `/proc/self/mountinfo`-shaped file. Field 5 (1-based) is the
 * mount point. The registry path is treated as a real mounted volume only when
 * the probe reports it here; a path absent from this list is a container-local
 * directory (the mount-failure case).
 */
function writeFakeMountInfo(file: string, mountPoints: string[]): void {
  const lines = mountPoints.map((mountPoint, i) => {
    const id = 40 + i;
    const dev = 100 + i;
    const disk = `/dev/sd${String.fromCharCode("a".charCodeAt(0) + i)}`;
    return `${id} ${id - 20} 0:${dev} / ${mountPoint} rw,relatime - ext4 ${disk} rw`;
  });
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

/**
 * Model the container entry sequence's startup pre-step: the mount assertion is
 * converted into a non-zero process exit (Phase 3 wires the real entrypoint).
 * A thrown assertion fails the phase; a report means startup may continue.
 */
async function runStartupPreStep(
  db: TissueDb,
  env: NodeJS.ProcessEnv,
  logger: JsonLogger,
  opts?: { mountInfoPath?: string },
): Promise<{ exitCode: number; report?: RegistryStartupReport }> {
  try {
    const report = await runStartupRegistryReconciliation(db, env, logger, opts);
    return { exitCode: 0, report };
  } catch {
    return { exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// P1-S1 — the normative contract is the header comment above. The directory
// resolution and the explicit absence of readiness state are exercised here.
// ---------------------------------------------------------------------------

test("P1-S1 resolveSessionRegistryDir uses TISSUE_SESSION_REGISTRY_DIR or the host default (never a /run tmpfs path)", () => {
  const dir = makeTemp("resolve");
  try {
    assert.equal(resolveSessionRegistryDir({ TISSUE_SESSION_REGISTRY_DIR: dir }), dir);
    assert.equal(resolveSessionRegistryDir({}), "/tissue-session-registry");
    assert.equal(
      resolveSessionRegistryDir({}).startsWith("/run"),
      false,
      "the registry must be host-persisted, never a per-container /run tmpfs path",
    );
    assert.throws(() => resolveSessionRegistryDir({ TISSUE_SESSION_REGISTRY_DIR: "relative/registry" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1-S2 — two-state classification, throw-free, single statSync, content-blind
// ---------------------------------------------------------------------------

test("P1-S2 classifySessionMarker: marker present => MANAGED; marker absent => UNMANAGED", () => {
  const dir = makeTemp("classify");
  try {
    const present = "ses_present01";
    createSessionMarker(dir, present);
    assert.equal(classifySessionMarker(dir, present), "MANAGED");
    assert.equal(classifySessionMarker(dir, "ses_absent01"), "UNMANAGED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-S2 classifySessionMarker: absent registry directory => UNMANAGED and never throws", () => {
  const parent = makeTemp("classify-absent");
  const dir = join(parent, "missing-registry");
  try {
    let observed: string | undefined;
    assert.doesNotThrow(() => {
      observed = classifySessionMarker(dir, "ses_absent02");
    });
    assert.equal(observed, "UNMANAGED");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("P1-S2 classifySessionMarker: unreadable registry directory => UNMANAGED and never throws", () => {
  const dir = makeTemp("classify-unreadable");
  try {
    chmodSync(dir, 0o000);
    let observed: string | undefined;
    assert.doesNotThrow(() => {
      observed = classifySessionMarker(dir, "ses_unreadable1");
    });
    assert.equal(observed, "UNMANAGED");
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-S2 classifySessionMarker: a readdir-visible non-ses_* file is not any session", () => {
  const dir = makeTemp("classify-nonses");
  try {
    writeFileSync(join(dir, "notes.txt"), "not a marker", "utf8");
    assert.equal(classifySessionMarker(dir, "ses_anything01"), "UNMANAGED");
    assert.deepEqual(listMarkerSessionIds(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-S2 classifySessionMarker: exactly one statSync on the marker path and contents are never read", () => {
  const dir = makeTemp("classify-single-stat");
  try {
    const id = "ses_single01";
    const marker = markerPath(dir, id);
    createSessionMarker(dir, id);

    const calls: string[] = [];
    const status = classifySessionMarker(dir, id, {
      statSync: (path) => {
        calls.push(path);
        return statSync(path);
      },
    });
    assert.equal(status, "MANAGED");
    assert.equal(calls.length, 1, "classification must perform exactly one statSync");
    assert.equal(calls[0], marker, "the single statSync must target the marker path");

    // Content-blindness: a marker that is a DIRECTORY (not readable as a file)
    // still classifies MANAGED, because only existence is inspected.
    const dirMarker = "ses_dir00001";
    mkdirSync(markerPath(dir, dirMarker));
    assert.equal(classifySessionMarker(dir, dirMarker), "MANAGED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-S2 markerPath refuses a non-ses_* session id", () => {
  const dir = makeTemp("markerpath");
  try {
    assert.equal(markerPath(dir, "ses_AbC123"), join(dir, "ses_AbC123"));
    assert.throws(() => markerPath(dir, "../evil"));
    assert.throws(() => markerPath(dir, "not-a-session"));
    // The normative suffix is alphanumeric only (DD §8.2; plan I Contracts):
    // an underscore-bearing id is NOT a valid `ses_*` id and must be refused.
    assert.throws(() => markerPath(dir, "ses_orphan_no_row"));
    assert.equal(classifySessionMarker(dir, "ses_orphan_no_row"), "UNMANAGED");
    assert.deepEqual(listMarkerSessionIds(dir), [], "an underscore-bearing id is never listed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1-S3 — the named mount assertion (missing / unwritable / container-local all
// fail loudly; a real mounted writable path passes)
// ---------------------------------------------------------------------------

test("registry-mount-assertion", async () => {
  const root = makeTemp("mount");
  const dir = join(root, "registry");
  const mountInfo = join(root, "mountinfo");
  const logger = makeLogger();
  const { db, cleanup } = createTestDb();
  const env: NodeJS.ProcessEnv = { TISSUE_SESSION_REGISTRY_DIR: dir };
  try {
    // (1) missing path: listed by the probe but does not exist.
    writeFakeMountInfo(mountInfo, [dir]);
    const missing: RegistryMountStatus = assertRegistryMount(dir, { mountInfoPath: mountInfo });
    assert.equal(missing.ok, false, "a missing registry path must fail the assertion");
    const missingStep = await runStartupPreStep(db, env, logger, { mountInfoPath: mountInfo });
    assert.notEqual(missingStep.exitCode, 0, "a failed mount assertion must exit non-zero");
    // doctor.ok is the mount assertion's ok flag (Phase 3 wires doctorOperation).
    assert.equal(missing.ok, false, "doctor.ok === false when the mount assertion fails");

    // (2) container-local empty directory: exists and writable, but the mount
    // probe does not report it as a real mounted volume.
    mkdirSync(dir, { recursive: true });
    writeFakeMountInfo(mountInfo, ["/"]);
    const local: RegistryMountStatus = assertRegistryMount(dir, { mountInfoPath: mountInfo });
    assert.equal(local.ok, false);
    assert.equal(local.realMount, false, "a container-local directory is not a real mounted volume");
    const localStep = await runStartupPreStep(db, env, logger, { mountInfoPath: mountInfo });
    assert.notEqual(localStep.exitCode, 0);

    // (3) unwritable path: a real mount that Tissue cannot write.
    chmodSync(dir, 0o555);
    writeFakeMountInfo(mountInfo, [dir]);
    const unwritable: RegistryMountStatus = assertRegistryMount(dir, { mountInfoPath: mountInfo });
    assert.equal(unwritable.ok, false);
    assert.equal(unwritable.writable, false, "an unwritable registry must fail the assertion");
    const unwritableStep = await runStartupPreStep(db, env, logger, { mountInfoPath: mountInfo });
    assert.notEqual(unwritableStep.exitCode, 0);
    chmodSync(dir, 0o755);

    // (4) a real mounted, writable path passes.
    const ok: RegistryMountStatus = assertRegistryMount(dir, { mountInfoPath: mountInfo });
    assert.equal(ok.ok, true);
    assert.equal(ok.writable, true);
    assert.equal(ok.realMount, true);
    const okStep = await runStartupPreStep(db, env, logger, { mountInfoPath: mountInfo });
    assert.equal(okStep.exitCode, 0);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1-S4 — ordered prune-extras startup reconciliation
// ---------------------------------------------------------------------------

test("P1-S4 runStartupRegistryReconciliation asserts the mount before pruning and before any daemon work", async () => {
  const root = makeTemp("startup-order");
  const dir = join(root, "registry");
  const mountInfo = join(root, "mountinfo");
  const logger = makeLogger();
  const { db, cleanup } = createTestDb();
  const env: NodeJS.ProcessEnv = { TISSUE_SESSION_REGISTRY_DIR: dir };
  try {
    mkdirSync(dir, { recursive: true });
    const orphan = "ses_orphan01";
    createSessionMarker(dir, orphan);

    // The mount probe does not report the registry as a mount, so the assertion
    // must fail first: prune must NOT have run and the daemon is never reached.
    writeFakeMountInfo(mountInfo, ["/"]);
    const step = await runStartupPreStep(db, env, logger, { mountInfoPath: mountInfo });
    assert.notEqual(step.exitCode, 0);
    assert.equal(step.report, undefined, "no startup report is produced after a failed mount assertion");
    assert.equal(classifySessionMarker(dir, orphan), "MANAGED", "prune must not run before the mount assertion");
    assert.equal(listMarkerSessionIds(dir).includes(orphan), true);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-S4 runStartupRegistryReconciliation prunes no-DB-row markers, keeps DB-row markers, and creates no marker", async () => {
  const root = makeTemp("startup-prune");
  const dir = join(root, "registry");
  const mountInfo = join(root, "mountinfo");
  const logger = makeLogger();
  const { db, cleanup } = createTestDb();
  const env: NodeJS.ProcessEnv = { TISSUE_SESSION_REGISTRY_DIR: dir };
  try {
    mkdirSync(dir, { recursive: true });
    writeFakeMountInfo(mountInfo, [dir]);
    seedRepository(db, { id: REPO_ID });
    insertSession(db, { id: "ses_keep", kind: "triage", repo_id: REPO_ID, directory: "/work", state: "RETAINED" });
    createSessionMarker(dir, "ses_keep");
    createSessionMarker(dir, "ses_orphanNoRow");

    const report = await runStartupRegistryReconciliation(db, env, logger, { mountInfoPath: mountInfo });
    assert.equal(report.mountAsserted, true, "the startup report records a successful mount assertion");
    assert.ok(report.pruned.includes("ses_orphanNoRow"), "the marker with no DB row is pruned at startup");
    assert.equal(classifySessionMarker(dir, "ses_keep"), "MANAGED", "a marker with a DB row is never pruned");
    assert.equal(classifySessionMarker(dir, "ses_orphanNoRow"), "UNMANAGED");

    // NEVER automatically mark every DB session: a DB row with no marker stays
    // unmarked and the marker count is unchanged by startup.
    insertSession(db, { id: "ses_onlyDb", kind: "triage", repo_id: REPO_ID, directory: "/work", state: "RETAINED" });
    const beforeCount = listMarkerSessionIds(dir).length;
    const second = await runStartupRegistryReconciliation(db, env, logger, { mountInfoPath: mountInfo });
    assert.equal(second.mountAsserted, true);
    assert.deepEqual(second.pruned, [], "startup prune is idempotent");
    assert.equal(classifySessionMarker(dir, "ses_onlyDb"), "UNMANAGED", "startup must not create a marker for a DB row");
    assert.equal(listMarkerSessionIds(dir).length, beforeCount, "startup creates no marker");
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1-S5 — marker removal (closed/parked), prune removal, and resume recreation
// ---------------------------------------------------------------------------

test("closed-parked-marker-removal", () => {
  const dir = makeTemp("closed-parked");
  try {
    const id = "ses_closed01";
    createSessionMarker(dir, id);
    assert.equal(classifySessionMarker(dir, id), "MANAGED");
    // Plan J owns the caller contract (removal is never invoked during an
    // executing agent turn); this spec owns the removal primitive only.
    assert.equal(deleteSessionMarker(dir, id), true, "removing a closed/parked session's marker reports a removal");
    assert.equal(classifySessionMarker(dir, id), "UNMANAGED");
    assert.equal(deleteSessionMarker(dir, id), false, "marker removal is idempotent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-S5 pruneMarkersWithoutDbRow removes only markers with no DB row, idempotently", () => {
  const dir = makeTemp("prune-direct");
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    insertSession(db, { id: "ses_keep", kind: "triage", repo_id: REPO_ID, directory: "/work", state: "RETAINED" });
    createSessionMarker(dir, "ses_keep");
    createSessionMarker(dir, "ses_orphanNoRow");

    const pruned = pruneMarkersWithoutDbRow(dir, db);
    assert.deepEqual(pruned, ["ses_orphanNoRow"]);
    assert.equal(classifySessionMarker(dir, "ses_orphanNoRow"), "UNMANAGED");
    assert.equal(classifySessionMarker(dir, "ses_keep"), "MANAGED");
    assert.deepEqual(pruneMarkersWithoutDbRow(dir, db), [], "the prune is idempotent");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-S5 a removed marker is recreated by ensureSessionMarkerBeforeResume before a resume", () => {
  const dir = makeTemp("resume");
  try {
    const id = "ses_resume01";
    createSessionMarker(dir, id);
    assert.equal(deleteSessionMarker(dir, id), true);

    // Single invariant: a session whose marker is absent is UNMANAGED, so a
    // prompt/resume gate would refuse until the marker exists again.
    assert.equal(classifySessionMarker(dir, id), "UNMANAGED");

    ensureSessionMarkerBeforeResume(dir, id);
    assert.equal(classifySessionMarker(dir, id), "MANAGED", "resume recreates the marker before the prompt");

    // Idempotent when the marker already exists.
    ensureSessionMarkerBeforeResume(dir, id);
    assert.equal(classifySessionMarker(dir, id), "MANAGED");
    assert.equal(listMarkerSessionIds(dir).filter((marker) => marker === id).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1-S6 — host persistence across a simulated restart
// ---------------------------------------------------------------------------

test("P1-S6 markers survive a fresh process view over the same directory and the directory is never removed", () => {
  const dir = makeTemp("persist");
  try {
    const a = "ses_persist01";
    const b = "ses_persist02";
    createSessionMarker(dir, a);
    createSessionMarker(dir, b);

    // A fresh process (new module instance) sees the same host-persisted markers.
    const moduleUrl = new URL("../../src/controller/session-registry.ts", import.meta.url).href;
    const script =
      `import { classifySessionMarker } from ${JSON.stringify(moduleUrl)};` +
      `process.stdout.write(classifySessionMarker(${JSON.stringify(dir)}, ${JSON.stringify(a)}));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "MANAGED", "a marker must survive a fresh process view");

    // The module never deletes the registry directory and never writes under /run.
    assert.equal(existsSync(dir), true, "the registry directory must never be deleted");
    assert.deepEqual(listMarkerSessionIds(dir).sort(), [a, b].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P3-S1/S4 — the ordered startup pre-step in runProductionDaemon
// ---------------------------------------------------------------------------

/** Minimal assembly surface touched by runProductionDaemon before the loop. */
function fakeAssembly(): ProductionAssembly {
  return {
    transport: { eventStream: () => (async function* () {})() },
    reconcile: async () => ({}),
    normalLoop: {},
  } as unknown as ProductionAssembly;
}

function emptyDaemonReport(): DaemonRunReport {
  return { reconciled: true, iterations: 0, passes: [] };
}

test("P3-S4 runProductionDaemonEntrypoint asserts the registry mount strictly before the assembly/daemon and fails closed", async () => {
  const root = makeTemp("entrypoint");
  const registryDir = join(root, "registry");
  const mountInfo = join(root, "mountinfo");
  const stateDir = join(root, "state");
  const configPath = join(root, "tissue.yml");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    configPath,
    "pollIntervalSeconds: 60\nmaxConcurrentGlobal: 3\nretentionDays: 30\nrepos: []\n",
    "utf8",
  );
  const priorState = process.env.TISSUE_STATE_DIR;
  const priorConfig = process.env.TISSUE_CONFIG;
  process.env.TISSUE_STATE_DIR = stateDir;
  process.env.TISSUE_CONFIG = configPath;
  try {
    // (a) mount assertion failure: non-zero exit, no assembly, no daemon call.
    writeFakeMountInfo(mountInfo, ["/"]);
    const failedCalls: string[] = [];
    const failureSink = new CapturingSink();
    const failureCode = await runProductionDaemonEntrypoint({
      env: { TISSUE_SESSION_REGISTRY_DIR: registryDir },
      mountInfoPath: mountInfo,
      logger: new JsonLogger(failureSink.writeable(), "debug"),
      createAssembly: async () => {
        failedCalls.push("assembly");
        return fakeAssembly();
      },
      runDaemonLoop: async () => {
        failedCalls.push("daemon");
        return emptyDaemonReport();
      },
    });
    assert.notEqual(failureCode, 0, "a failed registry mount assertion must yield a non-zero exit");
    assert.deepEqual(failedCalls, [], "neither createProductionAssembly nor runDaemon may be reached");
    assert.ok(
      failureSink.records().some((record) => record.event === "registry.mount_assertion_failed"),
      "the failure must be a loud structured log event",
    );

    // (b) success: the prune runs before the daemon call and the startup report is
    // logged, in the order assert -> prune -> continue.
    writeFakeMountInfo(mountInfo, [registryDir]);
    const orphan = "ses_entryOrphan";
    createSessionMarker(registryDir, orphan);
    let markerStateAtDaemon: string | undefined;
    const okCalls: string[] = [];
    const okSink = new CapturingSink();
    const okCode = await runProductionDaemonEntrypoint({
      env: { TISSUE_SESSION_REGISTRY_DIR: registryDir },
      mountInfoPath: mountInfo,
      logger: new JsonLogger(okSink.writeable(), "debug"),
      createAssembly: async () => {
        okCalls.push("assembly");
        return fakeAssembly();
      },
      runDaemonLoop: async () => {
        okCalls.push("daemon");
        markerStateAtDaemon = classifySessionMarker(registryDir, orphan);
        return emptyDaemonReport();
      },
    });
    assert.equal(okCode, 0, "a healthy mount and prune must reach the daemon");
    assert.deepEqual(okCalls, ["assembly", "daemon"]);
    assert.equal(
      markerStateAtDaemon,
      "UNMANAGED",
      "markers with no DB row must be pruned before the daemon starts",
    );
    assert.equal(listMarkerSessionIds(registryDir).includes(orphan), false, "the orphan marker is gone");
    const startup = okSink.records().find((record) => record.event === "registry.startup") as
      | Record<string, unknown>
      | undefined;
    assert.ok(startup, "the startup reconciliation report must be logged");
    assert.equal(startup.mountAsserted, true);
    assert.equal(startup.markerCount, 0);
    assert.deepEqual(startup.pruned, [orphan]);
  } finally {
    if (priorState === undefined) delete process.env.TISSUE_STATE_DIR;
    else process.env.TISSUE_STATE_DIR = priorState;
    if (priorConfig === undefined) delete process.env.TISSUE_CONFIG;
    else process.env.TISSUE_CONFIG = priorConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P3-S2/S3 — the registry view surfaced by doctor/status
// ---------------------------------------------------------------------------

test("P3-S2/S3 doctor fails closed and both doctor/status expose the registry mount state and marker count", () => {
  const root = makeTemp("ops");
  const registryDir = join(root, "registry");
  const mountInfo = join(root, "mountinfo");
  const stateDir = join(root, "state");
  const agentsDir = join(root, "agents");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const config: TissueConfig = {
    pollIntervalSeconds: 60,
    maxConcurrentGlobal: 3,
    retentionDays: 30,
    agents: {},
    repos: [],
  };
  const priorAgentsDir = process.env.TISSUE_OPENCODE_AGENTS_DIR;
  process.env.TISSUE_OPENCODE_AGENTS_DIR = agentsDir;
  try {
    const install = installAgentDefinitions({ targetDir: agentsDir });
    assert.equal(install.ok, true, install.errors.join("; "));

    // One retained DB session and two markers: exactly one marker is a prune
    // candidate (no DB row), matching the startup prune set.
    const seed = openTissueDb(join(stateDir, "tissue.db"));
    seedRepository(seed, { id: REPO_ID });
    insertSession(seed, { id: "ses_keep", kind: "triage", repo_id: REPO_ID, directory: "/work", state: "RETAINED" });
    closeDb(seed);
    createSessionMarker(registryDir, "ses_keep");
    createSessionMarker(registryDir, "ses_orphanNoRow");

    const ctx = { config, stateDir, logger: makeLogger() };
    const opts = { env: { TISSUE_SESSION_REGISTRY_DIR: registryDir }, mountInfoPath: mountInfo };

    // Mount failure: doctor fails closed and reports the registry state.
    writeFakeMountInfo(mountInfo, ["/"]);
    const bad = doctorOperation(ctx, opts) as Record<string, unknown>;
    const badRegistry = bad.registry as Record<string, unknown>;
    assert.equal(bad.ok, false, "a failed registry mount assertion must fail doctor");
    assert.equal(badRegistry.mountAsserted, false);
    assert.equal(badRegistry.realMount, false);
    assert.equal(badRegistry.writable, true);
    assert.equal(badRegistry.markerCount, 2);
    assert.deepEqual(badRegistry.prunedAtStartup, ["ses_orphanNoRow"]);
    assert.equal(typeof bad.database, "object");
    assert.equal(Array.isArray(bad.repositories), true);
    assert.equal(typeof bad.agents, "object");
    assert.equal(typeof bad.opencode, "object");

    // Mount success: doctor.ok now tracks the agents check; no existing key moved.
    writeFakeMountInfo(mountInfo, [registryDir]);
    const good = doctorOperation(ctx, opts) as Record<string, unknown>;
    const goodRegistry = good.registry as Record<string, unknown>;
    assert.equal(goodRegistry.mountAsserted, true);
    assert.equal(goodRegistry.dir, registryDir);
    assert.equal(good.ok, (good.agents as Record<string, unknown>).ok, "doctor.ok is agents.ok when the mount asserts");
    assert.equal(typeof good.stateDir, "string");

    // Status adds the registry surface without changing any existing key.
    const status = statusOperation(ctx, opts) as Record<string, unknown>;
    const statusRegistry = status.registry as Record<string, unknown>;
    assert.equal(statusRegistry.mountAsserted, true);
    assert.equal(statusRegistry.markerCount, 2);
    assert.equal(typeof status.capacity, "object");
    assert.equal(typeof status.sessions, "object");
    assert.equal(typeof status.opencode, "object");
    assert.equal(typeof status.repositoryReadiness, "object");
  } finally {
    if (priorAgentsDir === undefined) delete process.env.TISSUE_OPENCODE_AGENTS_DIR;
    else process.env.TISSUE_OPENCODE_AGENTS_DIR = priorAgentsDir;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round 2 — the mount-table override is self-announcing (visibility/hardening)
// ---------------------------------------------------------------------------

test("R2 default production path ignores the override and reports overridden:false", () => {
  const root = makeTemp("override-default");
  const stateDir = join(root, "state");
  const agentsDir = join(root, "agents");
  mkdirSync(stateDir, { recursive: true });
  const config: TissueConfig = {
    pollIntervalSeconds: 60,
    maxConcurrentGlobal: 3,
    retentionDays: 30,
    agents: {},
    repos: [],
  };
  const priorAgentsDir = process.env.TISSUE_OPENCODE_AGENTS_DIR;
  const priorMountInfo = process.env.TISSUE_SESSION_REGISTRY_MOUNTINFO;
  process.env.TISSUE_OPENCODE_AGENTS_DIR = agentsDir;
  delete process.env.TISSUE_SESSION_REGISTRY_MOUNTINFO;
  try {
    const install = installAgentDefinitions({ targetDir: agentsDir });
    assert.equal(install.ok, true, install.errors.join("; "));

    const ctx = { config, stateDir, logger: makeLogger() };
    // No opts and no env seam: the production default path is in effect, so the
    // view must report the override as inactive and use the real mount table.
    const doctor = doctorOperation(ctx) as Record<string, unknown>;
    const doctorRegistry = doctor.registry as Record<string, unknown>;
    assert.equal(doctorRegistry.overridden, false, "the default production path is not an override");
    assert.equal(
      resolveSessionRegistryDir(process.env),
      "/tissue-session-registry",
      "with no override the real default registry path is in effect",
    );

    const status = statusOperation(ctx) as Record<string, unknown>;
    const statusRegistry = status.registry as Record<string, unknown>;
    assert.equal(statusRegistry.overridden, false, "status also reports the default path as not overridden");
  } finally {
    if (priorAgentsDir === undefined) delete process.env.TISSUE_OPENCODE_AGENTS_DIR;
    else process.env.TISSUE_OPENCODE_AGENTS_DIR = priorAgentsDir;
    if (priorMountInfo === undefined) delete process.env.TISSUE_SESSION_REGISTRY_MOUNTINFO;
    else process.env.TISSUE_SESSION_REGISTRY_MOUNTINFO = priorMountInfo;
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 an active mount-table override is reported as overridden:true", () => {
  const root = makeTemp("override-active");
  const registryDir = join(root, "registry");
  const mountInfo = join(root, "mountinfo");
  const stateDir = join(root, "state");
  const agentsDir = join(root, "agents");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFakeMountInfo(mountInfo, [registryDir]);
  const config: TissueConfig = {
    pollIntervalSeconds: 60,
    maxConcurrentGlobal: 3,
    retentionDays: 30,
    agents: {},
    repos: [],
  };
  const priorAgentsDir = process.env.TISSUE_OPENCODE_AGENTS_DIR;
  process.env.TISSUE_OPENCODE_AGENTS_DIR = agentsDir;
  try {
    const install = installAgentDefinitions({ targetDir: agentsDir });
    assert.equal(install.ok, true, install.errors.join("; "));

    const ctx = { config, stateDir, logger: makeLogger() };
    // (b1) the opts.mountInfoPath seam is an active override.
    const viaOpts = doctorOperation(ctx, {
      env: { TISSUE_SESSION_REGISTRY_DIR: registryDir },
      mountInfoPath: mountInfo,
    }) as Record<string, unknown>;
    assert.equal((viaOpts.registry as Record<string, unknown>).overridden, true, "opts.mountInfoPath is an override");

    // (b2) the env seam is equally observable through status.
    const status = statusOperation(ctx, {
      env: { TISSUE_SESSION_REGISTRY_DIR: registryDir },
      mountInfoPath: mountInfo,
    }) as Record<string, unknown>;
    assert.equal((status.registry as Record<string, unknown>).overridden, true, "status reports the active override");
  } finally {
    if (priorAgentsDir === undefined) delete process.env.TISSUE_OPENCODE_AGENTS_DIR;
    else process.env.TISSUE_OPENCODE_AGENTS_DIR = priorAgentsDir;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P4-S3 — ownership closure: the mocked-vs-real caller pair for the registry
// storage helpers (prune + resume-recreate). The REAL caller is the
// controlling/authoritative case; the mocked caller only pins the injectable
// seams. Neither half replaces the other and no existing test is weakened.
// ---------------------------------------------------------------------------

test("P4-S3 mocked-caller: injected fs statSync counter + fake mount probe drive the registry helpers", async () => {
  const root = makeTemp("p4-mocked");
  const dir = join(root, "registry");
  const mountInfo = join(root, "mountinfo");
  const logger = makeLogger();
  const { db, cleanup } = createTestDb();
  try {
    mkdirSync(dir, { recursive: true });

    // (a) Injected fs: classification follows the injected statSync counter, not
    // the real filesystem. The marker path is queried exactly once, content-blind.
    const calls: string[] = [];
    const managed = classifySessionMarker(dir, "ses_injected1", {
      statSync: (path) => {
        calls.push(path);
        return { isDirectory: () => false };
      },
    });
    assert.equal(managed, "MANAGED", "the injected probe's existence result is authoritative");
    assert.deepEqual(calls, [markerPath(dir, "ses_injected1")], "the injected statSync is called exactly once on the marker path");
    const unmanaged = classifySessionMarker(dir, "ses_injected1", {
      statSync: () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(unmanaged, "UNMANAGED", "an injected absent/throwing statSync yields UNMANAGED");
    assert.equal(existsSync(markerPath(dir, "ses_injected1")), false, "mocked classification never wrote to the real fs");

    // (b) Fake mount probe: the assertion's realMount verdict follows the probe.
    writeFakeMountInfo(mountInfo, [dir]);
    const mounted = assertRegistryMount(dir, { mountInfoPath: mountInfo });
    assert.equal(mounted.realMount, true);
    assert.equal(mounted.ok, true);
    writeFakeMountInfo(mountInfo, ["/"]);
    const local = assertRegistryMount(dir, { mountInfoPath: mountInfo });
    assert.equal(local.realMount, false);
    assert.equal(local.ok, false);

    // (c) The startup caller threads the fake mount probe into the assertion.
    const step = await runStartupPreStep(db, { TISSUE_SESSION_REGISTRY_DIR: dir }, logger, { mountInfoPath: mountInfo });
    assert.notEqual(step.exitCode, 0, "the injected not-a-mount probe makes the startup caller fail closed");
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("P4-S3 real-caller: real module against a real temp registry dir and a real TissueDb (prune + resume-recreate)", () => {
  const dir = makeTemp("p4-real");
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    insertSession(db, { id: "ses_keep", kind: "triage", repo_id: REPO_ID, directory: "/work", state: "RETAINED" });
    createSessionMarker(dir, "ses_keep");
    createSessionMarker(dir, "ses_orphanNoRow");

    // Real prune against a real temp directory and a real DB: only the marker
    // file with no opencode_sessions row is removed on disk.
    const pruned = pruneMarkersWithoutDbRow(dir, db);
    assert.deepEqual(pruned, ["ses_orphanNoRow"]);
    assert.equal(existsSync(markerPath(dir, "ses_orphanNoRow")), false, "the orphan marker file is really gone");
    assert.equal(existsSync(markerPath(dir, "ses_keep")), true, "the DB-backed marker file remains");

    // Real resume-recreate: remove the DB-backed marker, then recreate the real
    // file immediately before resume per the single invariant.
    assert.equal(deleteSessionMarker(dir, "ses_keep"), true);
    assert.equal(existsSync(markerPath(dir, "ses_keep")), false);
    assert.equal(classifySessionMarker(dir, "ses_keep"), "UNMANAGED");
    ensureSessionMarkerBeforeResume(dir, "ses_keep");
    assert.equal(existsSync(markerPath(dir, "ses_keep")), true, "resume recreates a real marker file");
    assert.equal(classifySessionMarker(dir, "ses_keep"), "MANAGED");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Plan I P1-S1/P1-S5/P1-S3/P2-S4 — regression specs for the normative
// host-persistence guard, the fail-closed marker removal, the fail-closed
// unreadable mount table, and the registry.marker_pruned observability
// contract. These exercise error/degraded branches the existing suite leaves
// uncovered; no existing assertion is weakened.
// ---------------------------------------------------------------------------

test("P1-S1b resolveSessionRegistryDir refuses an explicit /run or /run/* override but accepts other absolute paths", () => {
  const dir = makeTemp("resolve-run");
  try {
    // Explicit /run values are refused before any persistence assertion: a
    // tmpfs registry mounted at /run/... would itself be a real mount yet lose
    // every marker on restart (L13).
    assert.throws(
      () => resolveSessionRegistryDir({ TISSUE_SESSION_REGISTRY_DIR: "/run" }),
      /host-persisted/,
      "an explicit /run registry must be refused",
    );
    assert.throws(
      () => resolveSessionRegistryDir({ TISSUE_SESSION_REGISTRY_DIR: "/run/tissue-session-registry" }),
      /host-persisted/,
      "an explicit /run/* registry must be refused",
    );
    // The guard is not over-broad: non-/run absolute values are returned
    // verbatim, including the host default.
    assert.equal(resolveSessionRegistryDir({ TISSUE_SESSION_REGISTRY_DIR: "/tmp/registry" }), "/tmp/registry");
    assert.equal(resolveSessionRegistryDir({ TISSUE_SESSION_REGISTRY_DIR: dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-S5b deleteSessionMarker rethrows a non-ENOENT unlink failure and swallows only ENOENT", () => {
  const dir = makeTemp("delete-rethrow");
  const id = "ses_dir00001";
  try {
    // A DIRECTORY at the marker path: unlinkSync fails with EISDIR/EPERM, never
    // ENOENT, so the fail-closed path must rethrow rather than report false.
    mkdirSync(markerPath(dir, id));
    let thrown: unknown;
    try {
      deleteSessionMarker(dir, id);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "a non-ENOENT unlink failure must be rethrown, not swallowed");
    assert.notEqual(
      (thrown as NodeJS.ErrnoException).code,
      "ENOENT",
      "only ENOENT may be swallowed as an already-absent marker",
    );

    // The absent-marker idempotency path still returns false without throwing.
    assert.equal(deleteSessionMarker(dir, "ses_absent99"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-S3b assertRegistryMount fails closed when the mount table is unreadable", () => {
  const dir = makeTemp("mountinfo-dir");
  const mountInfoRoot = makeTemp("mountinfo-nofile");
  try {
    // A real existing writable directory for `dir`, so only the mount-table read
    // fails: the catch in isListedMountPoint returns false and the assertion
    // must fail closed rather than throw.
    const mountInfoPath = join(mountInfoRoot, "missing-mountinfo");
    const status = assertRegistryMount(dir, { mountInfoPath });
    assert.equal(status.exists, true, "the registry directory itself exists");
    assert.equal(status.writable, true, "the registry directory itself is writable");
    assert.equal(status.realMount, false, "an unreadable mount table must not report a real mount");
    assert.equal(status.ok, false, "an unreadable mount table must fail the assertion");
    assert.equal(typeof status.reason, "string", "a failed assertion carries a reason");
  } finally {
    rmSync(mountInfoRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2-S4 pruneMarkersWithoutDbRow emits exactly one structured registry.marker_pruned per pruned id and never marker contents", () => {
  const dir = makeTemp("prune-log");
  const sink = new CapturingSink();
  const logger = new JsonLogger(sink.writeable(), "debug");
  const { db, cleanup } = createTestDb();
  try {
    seedRepository(db, { id: REPO_ID });
    insertSession(db, { id: "ses_keep", kind: "triage", repo_id: REPO_ID, directory: "/work", state: "RETAINED" });
    createSessionMarker(dir, "ses_keep");
    createSessionMarker(dir, "ses_orphanNoRow");

    const pruned = pruneMarkersWithoutDbRow(dir, db, logger);
    assert.deepEqual(pruned, ["ses_orphanNoRow"]);

    const prunedRecords = sink.records().filter((entry) => entry.event === "registry.marker_pruned");
    assert.equal(prunedRecords.length, 1, "exactly one registry.marker_pruned record per pruned id");
    const record = prunedRecords[0];
    assert.ok(record, "the prune must emit a registry.marker_pruned record");
    assert.equal(record.id, "ses_orphanNoRow");
    assert.equal(record.reason, "no-db-row");
    // The record carries the id and reason and never marker contents: the only
    // non-envelope payload keys are the event's own id and reason.
    const payloadKeys = Object.keys(record).filter((key) => !["ts", "lvl", "event"].includes(key));
    assert.deepEqual(payloadKeys.sort(), ["id", "reason"]);
    assert.equal("contents" in record, false);

    // A retained id is never logged.
    assert.equal(sink.records().some((entry) => entry.id === "ses_keep"), false);

    // Idempotent: a second prune removes nothing and emits no further record.
    const before = sink.records().length;
    assert.deepEqual(pruneMarkersWithoutDbRow(dir, db, logger), []);
    assert.equal(sink.records().length, before, "an idempotent prune must emit no further marker_pruned record");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// R2 survival — the marker primitive's fail-closed and degraded paths, plus
// octal-unescaped mount-table parsing. These exercise error branches the suite
// above leaves uncovered: the `createSessionMarker` throw (`session-registry.ts:154`),
// the `readdirSync` catch in `listMarkerSessionIds` (`:181`), and
// `decodeMountField`'s octal branch (`:192`, reached via
// `assertRegistryMount`'s mount-table parser). No existing assertion is weakened.
// ---------------------------------------------------------------------------

test("R2 createSessionMarker is fail-closed: a missing registry directory throws ENOENT and a repeated id throws EEXIST", () => {
  const parent = makeTemp("marker-failclosed");
  const dir = join(parent, "no-registry-dir");
  const presentId = "ses_exclusive01";
  try {
    // The parent registry directory does not exist, so the single atomic
    // O_CREAT|O_EXCL create (`openSync(marker, "wx")`) throws and NO session is
    // handed to a caller that would prompt.
    let missingErr: unknown;
    try {
      createSessionMarker(dir, "ses_missing01");
    } catch (err) {
      missingErr = err;
    }
    assert.ok(
      missingErr instanceof Error,
      "a marker create under a missing registry directory must throw, never silently succeed",
    );
    assert.equal((missingErr as NodeJS.ErrnoException).code, "ENOENT");

    // Exclusive-create property: once the directory exists, a second bare create
    // for the same id must throw (EEXIST) rather than silently succeed, so the
    // create is never a truncating overwrite of a live marker.
    mkdirSync(dir, { recursive: true });
    createSessionMarker(dir, presentId);
    assert.throws(
      () => createSessionMarker(dir, presentId),
      (err: NodeJS.ErrnoException) => err.code === "EEXIST",
      "a second create for an already-present marker must throw EEXIST",
    );
    // The failed create left exactly the one valid marker behind.
    assert.deepEqual(listMarkerSessionIds(dir), [presentId]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("R2 listMarkerSessionIds yields [] for a missing and for an unreadable registry directory", () => {
  const parent = makeTemp("list-degraded");
  const missingDir = join(parent, "no-registry-dir");
  const unreadableDir = join(parent, "unreadable-registry");
  try {
    // Absent registry directory: the readdirSync catch yields [] (no markers to
    // act on). This is the degraded path prune and doctor/status rely on.
    assert.deepEqual(listMarkerSessionIds(missingDir), []);

    // Unreadable registry directory: readdirSync throws EACCES, which is
    // swallowed to [] rather than propagated.
    mkdirSync(unreadableDir, { recursive: true });
    createSessionMarker(unreadableDir, "ses_hidden01");
    chmodSync(unreadableDir, 0o000);
    assert.deepEqual(
      listMarkerSessionIds(unreadableDir),
      [],
      "an unreadable registry must not throw and must yield no ids",
    );

    // After restoring permissions the same directory lists the real marker, so
    // the [] above came from the unreadable readdir, not from an empty directory.
    chmodSync(unreadableDir, 0o755);
    assert.deepEqual(listMarkerSessionIds(unreadableDir), ["ses_hidden01"]);
  } finally {
    if (existsSync(unreadableDir)) chmodSync(unreadableDir, 0o755);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("R2 assertRegistryMount decodes an octal-escaped mount point so a registry path containing a space asserts as a real mount", () => {
  const root = makeTemp("mount-octal");
  const dir = join(root, "registry with space");
  const mountInfo = join(root, "mountinfo");
  try {
    mkdirSync(dir, { recursive: true });
    // Real /proc/self/mountinfo escapes spaces as \040; the fixture receives the
    // already-escaped field exactly as the kernel would emit it.
    writeFakeMountInfo(mountInfo, [dir.replaceAll(" ", "\\040")]);

    const listed = assertRegistryMount(dir, { mountInfoPath: mountInfo });
    assert.equal(
      listed.realMount,
      true,
      "an octal-escaped mount point must decode back to the real registry path",
    );
    assert.equal(listed.ok, true, "a writable real mount whose path contains a space passes the assertion");

    // Negative control: a path absent from the mount table still reports
    // realMount === false, so the decode did not make matching vacuously true.
    writeFakeMountInfo(mountInfo, ["/"]);
    const unlisted = assertRegistryMount(dir, { mountInfoPath: mountInfo });
    assert.equal(unlisted.realMount, false, "a space-bearing path that is not listed is not a real mount");
    assert.equal(unlisted.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
