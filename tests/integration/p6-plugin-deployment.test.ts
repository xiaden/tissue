// Plan M Phase 1 — spec-first deployment contract.
//
// Normative contract: DD-tissue-container-migration.md §9.2, §15–§16 and
// TASK-tissue-M-plugin-deployment. The deploy directory is absolute and
// CWD-independent; installation is idempotent; divergent Tissue-owned files
// are refused without --force; SHA drift is scoped to tissue-moderation.ts;
// unrelated sibling plugins are preserved. The fresh-process-resolution case
// owns acceptance N(a): this test declares the claim, while Plan O's pinned
// OpenCode container leg supplies the actual process-spawning venue. It never
// claims that a resident process loaded the file.
//
// These tests are intentionally written before the Phase 2 implementation.
// Each RED result must be recorded on P1-S1–P1-S7; no existing test is
// weakened, deleted, skipped, or converted to TODO.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  clearPluginLoadBeacon,
  installAgentDefinitions,
  resolveOpenCodeGlobalPluginsDir,
  verifyModerationPluginLoaded,
} from "../../src/runtime/resident.ts";
import { doctorOperation, statusOperation } from "../../src/controller/ops.ts";
import { createProductionAssembly } from "../../src/runtime/entrypoint.ts";
import { OpenCodeDriver } from "../../src/integrations/opencode-driver.ts";
import { OpenCodeHttp } from "../../src/integrations/opencode-http.ts";
import { startPessimisticServer } from "../helpers/pessimistic-opencode-server.ts";
import { createTestDb, seedRepository } from "../helpers/db.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import { main, usage } from "../../src/cli.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE = join(ROOT, "plugin", "tissue-moderation.ts");
const PLUGIN = "tissue-moderation.ts";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function deployRecord(dir: string, deployedSha256: string, restartEpoch: number): void {
  writeFileSync(join(dir, "deploy-record.json"), JSON.stringify({
    deployedSha256,
    restartEpoch,
    deployedAt: new Date().toISOString(),
    pluginVersion: "1.0.0",
  }));
}

async function resident(): Promise<typeof import("../../src/runtime/resident.ts")> {
  return import("../../src/runtime/resident.ts");
}

test("global plugin resolver honors an absolute explicit directory independent of CWD", async () => {
  const originalCwd = process.cwd();
  const cwd = tempDir("tissue-plugin-cwd-");
  try {
    process.chdir(cwd);
    const explicit = join(cwd, "..", "resolved-plugins");
    assert.equal(
      resolveOpenCodeGlobalPluginsDir({ TISSUE_OPENCODE_PLUGINS_DIR: explicit }),
      resolve(explicit),
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("global plugin resolver falls back from XDG_CONFIG_HOME to HOME and rejects relative paths", () => {
  assert.equal(
    resolveOpenCodeGlobalPluginsDir({ XDG_CONFIG_HOME: "/tmp/tissue-xdg", HOME: "/tmp/tissue-home" }),
    join("/tmp/tissue-xdg", "opencode", "plugins"),
  );
  assert.equal(
    resolveOpenCodeGlobalPluginsDir({ HOME: "/tmp/tissue-home" }),
    join("/tmp/tissue-home", ".config", "opencode", "plugins"),
  );
  assert.throws(
    () => resolveOpenCodeGlobalPluginsDir({ TISSUE_OPENCODE_PLUGINS_DIR: "plugins" }),
    /absolute/,
  );
});

test("deployment SHA equals the checked-in source after install", async () => {
  const dir = tempDir("tissue-plugin-");
  try {
    const { installModerationPlugin } = await resident();
    const result = installModerationPlugin({ pluginsDir: dir, sourceDir: join(ROOT, "plugin") });
    assert.equal(result.ok, true, result.errors?.join("; "));
    assert.equal(result.deployedSha256, sha256(SOURCE));
    assert.equal(sha256(join(dir, PLUGIN)), sha256(SOURCE));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("installation is idempotent and refuses divergent content until --force", async () => {
  const dir = tempDir("tissue-plugin-");
  try {
    const { installModerationPlugin, validateModerationPlugin } = await resident();
    assert.equal(installModerationPlugin({ pluginsDir: dir, sourceDir: join(ROOT, "plugin") }).ok, true);
    const unchanged = installModerationPlugin({ pluginsDir: dir, sourceDir: join(ROOT, "plugin") });
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.action, "unchanged");
    writeFileSync(join(dir, PLUGIN), `${readFileSync(join(dir, PLUGIN), "utf8")}\n// edited\n`);
    const drift = validateModerationPlugin({ pluginsDir: dir, sourceDir: join(ROOT, "plugin") });
    assert.equal(drift.ok, false);
    const refused = installModerationPlugin({ pluginsDir: dir, sourceDir: join(ROOT, "plugin") });
    assert.equal(refused.ok, false);
    assert.match(JSON.stringify(refused), /force|diverg/i);
    assert.equal(installModerationPlugin({ pluginsDir: dir, sourceDir: join(ROOT, "plugin"), force: true }).ok, true);
    assert.equal(sha256(join(dir, PLUGIN)), sha256(SOURCE));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("drift makes doctor unhealthy while a sibling plugin remains untouched", async () => {
  const pluginsDir = tempDir("tissue-plugin-");
  const stateDir = tempDir("tissue-state-");
  try {
    const sibling = join(pluginsDir, "unrelated-plugin.ts");
    writeFileSync(sibling, "export const Unrelated = {};\n");
    const { installModerationPlugin } = await resident();
    assert.equal(installModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin") }).ok, true);
    const before = readFileSync(sibling, "utf8");
    writeFileSync(join(pluginsDir, PLUGIN), "export const TissueModeration = async () => ({});\n");
    const report = doctorOperation({ config: { repos: [], agents: {}, pollIntervalSeconds: 1, maxConcurrentGlobal: 1, retentionDays: 1 }, stateDir, logger: { } as never }, { pluginsDir });
    assert.equal(report.ok, false);
    assert.equal(readFileSync(sibling, "utf8"), before);
    assert.deepEqual(readdirSync(pluginsDir).sort(), [PLUGIN, "unrelated-plugin.ts"].sort());
  } finally { rmSync(pluginsDir, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); }
});

test("fresh-process-resolution declares the N(a) ownership without claiming resident load", async () => {
  const pluginsDir = tempDir("tissue-plugin-");
  try {
    const { installModerationPlugin, validateModerationPlugin } = await resident();
    const installed = installModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin") });
    assert.equal(installed.ok, true);
    assert.equal(validateModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin") }).sha256, sha256(SOURCE));
    assert.equal(installed.freshProcessResolution, "plan-O-container-venue");
  } finally { rmSync(pluginsDir, { recursive: true, force: true }); }
});

test("beacon is loaded only when SHA matches and server boot is after restart epoch", async () => {
  const moderationDir = tempDir("tissue-moderation-");
  const pluginsDir = tempDir("tissue-plugin-");
  try {
    const { installModerationPlugin, verifyModerationPluginLoaded } = await resident();
    const expected = sha256(SOURCE);
    assert.equal(installModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin") }).ok, true);
    deployRecord(moderationDir, expected, 2_000);
    writeFileSync(join(moderationDir, "plugin-loaded.json"), JSON.stringify({ kind: "loaded", pluginSha256: expected, serverStartedAt: 2_001 }));
    assert.equal(verifyModerationPluginLoaded({ moderationDir, pluginsDir, expectedSha256: expected }).loaded, true);
    writeFileSync(join(moderationDir, "plugin-loaded.json"), JSON.stringify({ kind: "loaded", pluginSha256: expected, serverStartedAt: 1_999 }));
    assert.equal(verifyModerationPluginLoaded({ moderationDir, pluginsDir, expectedSha256: expected }).loaded, false);
  } finally { rmSync(moderationDir, { recursive: true, force: true }); rmSync(pluginsDir, { recursive: true, force: true }); }
});

for (const [name, beacon] of [
  ["missing beacon", undefined],
  ["unparseable beacon", "{"],
  ["SHA mismatch", JSON.stringify({ kind: "loaded", pluginSha256: "wrong", serverStartedAt: Date.now() })],
] as const) {
  test(`beacon failure is closed: ${name}`, async () => {
    const moderationDir = tempDir("tissue-moderation-");
    const pluginsDir = tempDir("tissue-plugin-");
    try {
      const { verifyModerationPluginLoaded } = await resident();
      if (beacon !== undefined) writeFileSync(join(moderationDir, "plugin-loaded.json"), beacon);
      const verdict = verifyModerationPluginLoaded({ moderationDir, pluginsDir, expectedSha256: sha256(SOURCE) });
      assert.equal(verdict.loaded, false);
      assert.equal(typeof verdict.reason, "string");
    } finally { rmSync(moderationDir, { recursive: true, force: true }); rmSync(pluginsDir, { recursive: true, force: true }); }
  });
}

test("absent moderation mount is closed, never skipped", async () => {
  const { verifyModerationPluginLoaded } = await resident();
  const verdict = verifyModerationPluginLoaded({ moderationDir: join(tmpdir(), "does-not-exist-tissue-moderation"), pluginsDir: tempDir("tissue-plugin-"), expectedSha256: sha256(SOURCE) });
  assert.equal(verdict.loaded, false);
});

test("install path is filesystem-only and does not open a controller DB", async () => {
  const dir = tempDir("tissue-plugin-");
  try {
    const { installModerationPlugin } = await resident();
    const result = installModerationPlugin({ pluginsDir: dir, sourceDir: join(ROOT, "plugin") });
    assert.equal(result.dbOpened, 0);
    assert.equal(result.reconciled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("non-writable target reports failure", async () => {
  const { installModerationPlugin } = await resident();
  const result = installModerationPlugin({ pluginsDir: join(tmpdir(), `missing-${process.pid}-${Date.now()}`, "nested"), sourceDir: join(ROOT, "plugin") });
  assert.equal(result.ok, false);
});

test("production assembly supplies a fail-closed managedGate predicate", async () => {
  const { createProductionAssemblyForTest } = await import("../../src/runtime/entrypoint.ts");
  const assembly = await createProductionAssemblyForTest({ beaconFailure: true });
  assert.equal(typeof assembly.managedGate, "function");
  assert.equal(assembly.managedGate().loaded, false);
});

test("mocked caller closes managed prompt when injected predicate refuses", async () => {
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({
    http,
    registryDir: tempDir("tissue-registry-"),
    managedGate: () => ({ loaded: false, reason: "stub beacon refusal" }),
  });
  try {
    await assert.rejects(
      driver.createRealSession("triage", "/workspace/mock", { repoId: "r1", directory: "/workspace/mock", kind: "triage" }),
      /stub beacon refusal/,
    );
    assert.equal(server.requestCount, 0, "closed gate refuses before creating a real session");
  } finally {
    await server.close();
  }
});

test("real production assembly gate rejects stale beacon and opens with a valid beacon", async () => {
  const pluginsDir = tempDir("tissue-plugin-");
  const moderationDir = tempDir("tissue-moderation-");
  const agentsDir = tempDir("tissue-agents-");
  const registryDir = tempDir("tissue-registry-");
  const stateDir = tempDir("tissue-state-");
  const server = await startPessimisticServer();
  const dbFixture = createTestDb();
  seedRepository(dbFixture.db);
  assert.equal(installAgentDefinitions({ targetDir: agentsDir }).ok, true);
  const priorModerationDir = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const logger = new JsonLogger(new CapturingSink().writeable());
  const config = { repos: [], agents: {}, pollIntervalSeconds: 1, maxConcurrentGlobal: 1, retentionDays: 1 };
  const installed = (await resident()).installModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin"), moderationDir, restartEpoch: 2_000 });
  assert.equal(installed.ok, true, installed.errors?.join("; "));
  const beaconPath = join(moderationDir, "plugin-loaded.json");
  try {
    writeFileSync(beaconPath, JSON.stringify({ kind: "loaded", pluginSha256: installed.deployedSha256, serverStartedAt: 1_999 }));
    const stale = await createProductionAssembly({ config, logger, db: dbFixture.db, stateDir, endpoint: server.baseUrl(), agentsDir, pluginsDir, registryDir });
    await assert.rejects(
      stale.driver.createRealSession("triage", "/workspace/stale", { repoId: "r1", directory: "/workspace/stale", kind: "triage" }),
      /server boot|restart|stale|epoch|missing|unparseable/i,
    );

    writeFileSync(beaconPath, JSON.stringify({ kind: "loaded", pluginSha256: installed.deployedSha256, serverStartedAt: 2_001 }));
    const valid = await createProductionAssembly({ config, logger, db: dbFixture.db, stateDir, endpoint: server.baseUrl(), agentsDir, pluginsDir, registryDir });
    const session = await valid.driver.createRealSession("triage", "/workspace/valid", { repoId: "xiaden/nomarr", directory: "/workspace/valid", kind: "triage" });
    assert.match(session.sessionId, /^ses_/);
  } finally {
    await server.close();
    dbFixture.cleanup();
    rmSync(pluginsDir, { recursive: true, force: true });
    rmSync(moderationDir, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
    rmSync(registryDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    if (priorModerationDir === undefined) delete process.env.TISSUE_MODERATION_DIR;
    else process.env.TISSUE_MODERATION_DIR = priorModerationDir;
  }
});

test("doctor reports plugin.loaded from a real installed file and beacon", async () => {
  const pluginsDir = tempDir("tissue-plugin-");
  const moderationDir = tempDir("tissue-moderation-");
  const stateDir = tempDir("tissue-state-");
  const prior = process.env.TISSUE_MODERATION_DIR;
  const { installModerationPlugin } = await resident();
  try {
    const installed = installModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin"), moderationDir, restartEpoch: 3_000 });
    assert.equal(installed.ok, true, installed.errors?.join("; "));
    writeFileSync(join(moderationDir, "plugin-loaded.json"), JSON.stringify({ kind: "loaded", pluginSha256: installed.deployedSha256, serverStartedAt: 3_001 }));
    process.env.TISSUE_MODERATION_DIR = moderationDir;
    const report = doctorOperation({ config: { repos: [], agents: {}, pollIntervalSeconds: 1, maxConcurrentGlobal: 1, retentionDays: 1 }, stateDir, logger: {} as never }, { pluginsDir }) as { ok: boolean; plugin: { loaded: boolean } };
    assert.equal(report.plugin.loaded, true);
  } finally {
    if (prior === undefined) delete process.env.TISSUE_MODERATION_DIR;
    else process.env.TISSUE_MODERATION_DIR = prior;
    rmSync(pluginsDir, { recursive: true, force: true });
    rmSync(moderationDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("doctor reports plugin.loaded and fired.attested without fired changing ok", async () => {
  const dir = tempDir("tissue-plugin-");
  const stateDir = tempDir("tissue-state-");
  try {
    const report = doctorOperation({ config: { repos: [], agents: {}, pollIntervalSeconds: 1, maxConcurrentGlobal: 1, retentionDays: 1 }, stateDir, logger: { } as never }, { pluginsDir: dir });
    assert.equal(typeof (report.plugin as { loaded: boolean }).loaded, "boolean");
    assert.equal(typeof (report.fired as { attested: boolean }).attested, "boolean");
    assert.equal(report.ok, (report as { plugin: { loaded: boolean }; registry: { mountAsserted: boolean }; agents: { ok: boolean } }).plugin.loaded && (report as { registry: { mountAsserted: boolean } }).registry.mountAsserted && (report as { agents: { ok: boolean } }).agents.ok);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); }
});

test("default doctor/status fail closed on missing, drifted, beacon-invalid, and healthy deployments", async () => {
  const pluginsDir = tempDir("tissue-plugin-default-");
  const moderationDir = tempDir("tissue-moderation-default-");
  const stateDir = tempDir("tissue-state-default-");
  const priorPluginsDir = process.env.TISSUE_OPENCODE_PLUGINS_DIR;
  const priorModerationDir = process.env.TISSUE_MODERATION_DIR;
  const { installModerationPlugin } = await resident();
  const config = { repos: [], agents: {}, pollIntervalSeconds: 1, maxConcurrentGlobal: 1, retentionDays: 1 };
  const ctx = { config, stateDir, logger: {} as never };
  try {
    process.env.TISSUE_OPENCODE_PLUGINS_DIR = pluginsDir;
    process.env.TISSUE_MODERATION_DIR = moderationDir;
    const installed = installModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin"), moderationDir, restartEpoch: 6_000 });
    assert.equal(installed.ok, true, installed.errors?.join("; "));
    const beaconPath = join(moderationDir, "plugin-loaded.json");
    const matchingBeacon = () => writeFileSync(beaconPath, JSON.stringify({ kind: "loaded", pluginSha256: installed.deployedSha256, serverStartedAt: 6_001 }));

    rmSync(join(pluginsDir, PLUGIN));
    const missingDoctor = doctorOperation(ctx) as { ok: boolean; plugin: { loaded: boolean } };
    const missingStatus = statusOperation(ctx) as { plugin: { loaded: boolean } };
    assert.equal(missingDoctor.plugin.loaded, false);
    assert.equal(missingStatus.plugin.loaded, false);
    assert.equal(missingDoctor.ok, false, "default doctor must not report healthy when the deployed plugin is missing");

    assert.equal(installModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin") }).ok, true);
    writeFileSync(join(pluginsDir, PLUGIN), "export const TissueModeration = async () => ({});\\n");
    matchingBeacon();
    const driftDoctor = doctorOperation(ctx) as { ok: boolean; plugin: { loaded: boolean } };
    const driftStatus = statusOperation(ctx) as { plugin: { loaded: boolean } };
    assert.equal(driftDoctor.plugin.loaded, false);
    assert.equal(driftStatus.plugin.loaded, false);
    assert.equal(driftDoctor.ok, false, "default doctor must not report healthy when the deployed plugin drifts");

    assert.equal(installModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin"), force: true, moderationDir, restartEpoch: 6_000 }).ok, true);
    rmSync(beaconPath);
    const missingBeacon = doctorOperation(ctx) as { ok: boolean; plugin: { loaded: boolean } };
    assert.equal(missingBeacon.plugin.loaded, false);
    assert.equal(missingBeacon.ok, false);

    matchingBeacon();
    const healthyDoctor = doctorOperation(ctx) as { plugin: { loaded: boolean } };
    const healthyStatus = statusOperation(ctx) as { plugin: { loaded: boolean } };
    assert.equal(healthyDoctor.plugin.loaded, true);
    assert.equal(healthyStatus.plugin.loaded, true);
  } finally {
    if (priorPluginsDir === undefined) delete process.env.TISSUE_OPENCODE_PLUGINS_DIR;
    else process.env.TISSUE_OPENCODE_PLUGINS_DIR = priorPluginsDir;
    if (priorModerationDir === undefined) delete process.env.TISSUE_MODERATION_DIR;
    else process.env.TISSUE_MODERATION_DIR = priorModerationDir;
    rmSync(pluginsDir, { recursive: true, force: true });
    rmSync(moderationDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("matching record and beacon cannot attest a deleted Tissue-owned plugin", async () => {
  const pluginsDir = tempDir("tissue-plugin-");
  const moderationDir = tempDir("tissue-moderation-");
  const stateDir = tempDir("tissue-state-");
  const priorModerationDir = process.env.TISSUE_MODERATION_DIR;
  try {
    const { installModerationPlugin } = await resident();
    const installed = installModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin"), moderationDir, restartEpoch: 5_000 });
    assert.equal(installed.ok, true, installed.errors?.join("; "));
    writeFileSync(join(moderationDir, "plugin-loaded.json"), JSON.stringify({
      kind: "loaded",
      pluginSha256: installed.deployedSha256,
      serverStartedAt: 5_001,
    }));
    rmSync(join(pluginsDir, PLUGIN));
    process.env.TISSUE_MODERATION_DIR = moderationDir;
    const verdict = verifyModerationPluginLoaded({ moderationDir, pluginsDir, expectedSha256: installed.deployedSha256! });
    assert.equal(verdict.loaded, false);
    assert.match(verdict.reason, /missing|unreadable|SHA/i);
    const ctx = { config: { repos: [], agents: {}, pollIntervalSeconds: 1, maxConcurrentGlobal: 1, retentionDays: 1 }, stateDir, logger: {} as never };
    const doctor = doctorOperation(ctx, { pluginsDir }) as { ok: boolean; plugin: { loaded: boolean } };
    const status = statusOperation(ctx, { pluginsDir }) as { plugin: { loaded: boolean } };
    assert.equal(doctor.plugin.loaded, false);
    assert.equal(status.plugin.loaded, false);
    assert.equal(doctor.ok, false);
  } finally {
    if (priorModerationDir === undefined) delete process.env.TISSUE_MODERATION_DIR;
    else process.env.TISSUE_MODERATION_DIR = priorModerationDir;
    rmSync(pluginsDir, { recursive: true, force: true });
    rmSync(moderationDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("status exposes credential-free plugin attestation and fails closed on missing or drifted deployment", async () => {
  const pluginsDir = tempDir("tissue-plugin-");
  const moderationDir = tempDir("tissue-moderation-");
  const stateDir = tempDir("tissue-state-");
  const priorModerationDir = process.env.TISSUE_MODERATION_DIR;
  try {
    const { installModerationPlugin } = await resident();
    const installed = installModerationPlugin({ pluginsDir, sourceDir: join(ROOT, "plugin"), moderationDir, restartEpoch: 4_000 });
    assert.equal(installed.ok, true, installed.errors?.join("; "));
    writeFileSync(join(moderationDir, "plugin-loaded.json"), JSON.stringify({
      kind: "loaded",
      pluginSha256: installed.deployedSha256,
      serverStartedAt: 4_001,
    }));
    process.env.TISSUE_MODERATION_DIR = moderationDir;
    const ctx = { config: { repos: [], agents: {}, pollIntervalSeconds: 1, maxConcurrentGlobal: 1, retentionDays: 1 }, stateDir, logger: {} as never };

    const valid = statusOperation(ctx, { pluginsDir }) as { plugin: { loaded: boolean; reason: string; deployedSha256: string | null; beacon?: { pluginSha256: string; serverStartedAt: number } } };
    assert.equal(valid.plugin.loaded, true);
    assert.equal(valid.plugin.deployedSha256, installed.deployedSha256);
    assert.equal(valid.plugin.beacon?.pluginSha256, installed.deployedSha256);
    assert.equal(valid.plugin.beacon?.serverStartedAt, 4_001);
    assert.match(valid.plugin.reason, /loaded/i);

    rmSync(join(pluginsDir, PLUGIN));
    const missing = statusOperation(ctx, { pluginsDir }) as { plugin: { loaded: boolean; reason: string } };
    assert.equal(missing.plugin.loaded, false);
    assert.match(missing.plugin.reason, /missing|unreadable|beacon/i);

    writeFileSync(join(pluginsDir, PLUGIN), "export const TissueModeration = async () => ({});\\n");
    const drifted = statusOperation(ctx, { pluginsDir }) as { plugin: { loaded: boolean; reason: string; deployedSha256: string | null } };
    assert.equal(drifted.plugin.loaded, false);
    assert.notEqual(drifted.plugin.deployedSha256, installed.deployedSha256);
    assert.match(drifted.plugin.reason, /SHA|missing|unreadable|beacon/i);
  } finally {
    if (priorModerationDir === undefined) delete process.env.TISSUE_MODERATION_DIR;
    else process.env.TISSUE_MODERATION_DIR = priorModerationDir;
    rmSync(pluginsDir, { recursive: true, force: true });
    rmSync(moderationDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("install-plugin is advertised with --force and has exit-code semantics", async () => {
  assert.match(usage("tissue"), /install-plugin \[--force\]/);
  assert.equal(await main(["node", "tissue", "install-plugin", "--force"]), 0);
});

test("clearPluginLoadBeacon deletes an existing beacon and returns true", () => {
  const moderationDir = tempDir("tissue-moderation-");
  const beaconPath = join(moderationDir, "plugin-loaded.json");
  try {
    writeFileSync(beaconPath, JSON.stringify({ kind: "loaded" }));
    assert.equal(clearPluginLoadBeacon(moderationDir), true);
    assert.equal(existsSync(beaconPath), false, "successful cleanup removes the beacon");
  } finally { rmSync(moderationDir, { recursive: true, force: true }); }
});

test("clearPluginLoadBeacon returns false without throwing for missing or unreadable beacons", () => {
  const missingDir = tempDir("tissue-moderation-");
  const invalidDir = tempDir("tissue-moderation-");
  try {
    assert.doesNotThrow(() => assert.equal(clearPluginLoadBeacon(missingDir), false));

    // A file used as the moderation path makes the beacon path unreadable as a directory.
    const moderationPath = join(invalidDir, "not-a-directory");
    writeFileSync(moderationPath, "not a directory");
    assert.doesNotThrow(() => assert.equal(clearPluginLoadBeacon(moderationPath), false));
  } finally {
    rmSync(missingDir, { recursive: true, force: true });
    rmSync(invalidDir, { recursive: true, force: true });
  }
});
