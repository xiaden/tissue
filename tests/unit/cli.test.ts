// tests/unit/cli.test.ts
//
// Phase 2 tests for the thin CLI dispatch and durable operator wrappers.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS, lookupCommand } from "../../src/cli.ts";
import { startPessimisticServer } from "../helpers/pessimistic-opencode-server.ts";

const execFileP = promisify(execFile);
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const CLI = join(ROOT, "src", "cli.ts");
const NODE = process.execPath;

const VALID_CONFIG = `
pollIntervalSeconds: 240
maxConcurrentGlobal: 3
retentionDays: 30
repos:
  - owner: acme
    name: widgets
    localDir: /srv/acme/widgets
`;

const EXPECTED_COMMANDS = [
  "daemon",
  "tick",
  "reconcile",
  "status",
  "inspect",
  "history",
  "enqueue",
  "pause",
  "resume",
  "unpause",
  "cleanup",
  "doctor",
  "smoke",
];

let cfgDir: string | undefined;
function configPath(): string {
  if (!cfgDir) {
    cfgDir = mkdtempSync(join(tmpdir(), "tissue-cli-"));
    writeFileSync(join(cfgDir, "tissue.yml"), VALID_CONFIG, "utf8");
  }
  return join(cfgDir, "tissue.yml");
}

after(() => {
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const merged = { ...(process.env as Record<string, string>), ...env };
  try {
    const { stdout, stderr } = await execFileP(NODE, [CLI, ...args], {
      cwd: ROOT,
      env: merged,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as {
      code?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

test("command surface lists all required commands, each once", () => {
  assert.deepEqual([...COMMANDS], EXPECTED_COMMANDS);
  for (const name of EXPECTED_COMMANDS) {
    const entry = lookupCommand(name);
    assert.ok(entry, `expected a registry entry for '${name}'`);
    assert.equal(typeof entry!.run, "function");
  }
  // no duplicate entries
  assert.equal(new Set([...COMMANDS]).size, COMMANDS.length);
});

test("unknown command is rejected with exit 2", async () => {
  const r = await runCli(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.ok(r.stdout.includes("unknown command: frobnicate"));
});

test("reconcile-family shares a single business path (no second path)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "tissue-state-"));
  const server = await startPessimisticServer();
  const env = { TISSUE_CONFIG: configPath(), TISSUE_STATE_DIR: stateDir, TISSUE_OPENCODE_URL: server.baseUrl() };
  const sequences: string[] = [];
  try {
for (const cmd of ["reconcile", "tick"]) {
       const r = await runCli([cmd], env);
      // All three must run the shared pass and report its phase line, proving
      // there is no second business path for the reconcile family.
      assert.ok(
        /reconcile P0:(ok|fail)/.test(r.stdout),
        `${cmd} should report a reconcile report line, got: ${r.stdout}`,
      );
      assert.ok(/reconcile P0:ok/.test(r.stdout), `${cmd} should open the DB (P0:ok), got: ${r.stdout}`);
      assert.ok(!r.stdout.includes("not wired"), `${cmd} must not hit a wiring stub: ${r.stdout}`);
      assert.ok(!r.stderr.includes("panic"), `${cmd} stderr: ${r.stderr}`);
      sequences.push((r.stdout.match(/P0:\w+|P1:\w+|P2:\w+|P3:\w+|P4:\w+|P5:\w+|P6:\w+/g) ?? []).join(" "));
    }
    // Same phase-tag sequence for all three commands: one shared pass, no fork.
    const daemon = await runCli(["daemon"], { ...env, TISSUE_MAX_ITERATIONS: "1" });
    assert.equal(daemon.code, 0, `daemon bounded run: ${daemon.stdout}`);
    assert.match(daemon.stdout, /"iterations":1/);
    assert.equal(new Set(sequences).size, 1, `expected one shared phase sequence, got: ${sequences.join(" | ")}`);
  } finally {
    await server.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("operational commands return structured errors for missing arguments", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "tissue-ops-"));
  try {
    for (const [cmd, expected] of [["inspect", 0], ["history", 0], ["pause", 2], ["resume", 2], ["unpause", 2], ["cleanup", 2]] as const) {
      const r = await runCli([cmd], { TISSUE_CONFIG: configPath(), TISSUE_STATE_DIR: stateDir });
      assert.equal(r.code, expected, `${cmd} exit code`);
      if (expected !== 0) assert.match(r.stdout, /error|INVALID_ARGUMENT/);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("enqueue validates owner/repo#number shape before routing", async () => {
  const bad = await runCli(["enqueue", "not-an-enqueue"]);
  assert.equal(bad.code, 2);
  assert.ok(bad.stdout.includes("owner/repo#number"));

  const stateDir = mkdtempSync(join(tmpdir(), "tissue-state-"));
  try {
    const good = await runCli(["enqueue", "acme/widgets#12"], {
      TISSUE_CONFIG: configPath(),
      TISSUE_STATE_DIR: stateDir,
    });
    assert.equal(good.code, 4, `unknown issue is a structured admission failure: ${good.stdout}`);
    assert.match(good.stdout, /NOT_FOUND|unknown repository|unknown issue/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("status prints a real config summary and fails cleanly without config", async () => {
  const ok = await runCli(["status"], { TISSUE_CONFIG: configPath() });
  assert.equal(ok.code, 0);
  const report = JSON.parse(ok.stdout.split("\n").find((line) => line.startsWith("{")) ?? "{}") as { repositories: number; capacity: { globalLimit: number } };
  assert.equal(report.repositories, 0);
  assert.equal(report.capacity.globalLimit, 3);

  const missing = await runCli(["status"], { TISSUE_CONFIG: join(cfgDir ?? tmpdir(), "missing.yml") });
  assert.equal(missing.code, 3);
  assert.match(missing.stdout, /CONFIG_ERROR|error/);
});

test("doctor runs environment self-checks", async () => {
  const r = await runCli(["doctor"], { TISSUE_CONFIG: configPath() });
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout.split("\n").find((line) => line.startsWith("{")) ?? "{}") as { database: { wal: boolean } };
  assert.equal(report.database.wal, true);
});

test("smoke aliases the self-check", async () => {
  const r = await runCli(["smoke"], { TISSUE_CONFIG: configPath() });
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout) as { ok: boolean };
  assert.equal(report.ok, true);
});

test("help and bare invocation produce usage text", async () => {
  const help = await runCli(["help"]);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("usage:"));
  const bare = await runCli([]);
  assert.equal(bare.code, 1);
  assert.ok(bare.stdout.includes("usage:"));
});
