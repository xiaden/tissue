// tests/unit/bootstrap.test.ts
//
// P1-S1 spec-first tests: Node 26 native TypeScript stripping, node:test,
// no-emit type-check wiring, lockfile/.gitignore artifact exclusion, local CI,
// and the s6 A' entrypoint template (empty-safe startup, loopback-only, no-D').

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

import { emptySafeStartup, type StartupReport } from "../../src/runtime/entrypoint.ts";

const execFileP = promisify(execFile);
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const NODE = process.execPath;

test("native TypeScript type-stripping is available in this Node runtime", () => {
  const report = emptySafeStartup(".tissue");
  assert.equal(report.tsTypeStrip, true, "process.features.typescript must be 'strip'");
});

test("empty-safe startup requires no config file, db, or log directory", async () => {
  const report: StartupReport = emptySafeStartup(".tissue");
  assert.ok(report.nodeVersion.length > 0);
  assert.equal(typeof report.sqliteAvailable, "boolean");
  assert.equal(report.stateDir, ".tissue");

  // Running the entrypoint directly (no args, no state on disk) must exit 0
  // and emit a JSON report — proving the bootstrap is empty-safe.
  const { stdout, stderr } = await execFileP(NODE, [join(ROOT, "src", "runtime", "entrypoint.ts"), "probe"]);
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as StartupReport;
  assert.ok(parsed.nodeVersion.length > 0);
  assert.equal(parsed.tsTypeStrip, true);
});

test("package.json exposes test, typecheck, lint, and local-CI scripts", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const script of ["test", "typecheck", "lint", "ci"]) {
    assert.ok(pkg.scripts[script], `expected npm script '${script}'`);
  }
  assert.ok(pkg.scripts.ci?.includes("typecheck"));
  assert.ok(pkg.scripts.ci?.includes("lint"));
  assert.ok(pkg.scripts.ci?.includes("test"));
  assert.match(pkg.scripts.test ?? "", /node --test/);
  assert.match(pkg.scripts.typecheck ?? "", /tsc --noEmit/);
});

test("type-check is no-emit and locked to erasable (strip-compatible) syntax", () => {
  const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
  };
  assert.equal(tsconfig.compilerOptions.noEmit, true);
  assert.equal(tsconfig.compilerOptions.erasableSyntaxOnly, true);
  assert.equal(tsconfig.compilerOptions.allowImportingTsExtensions, true);
});

test("runtime artifacts (db, state dir, dependencies) are excluded from source control", async () => {
  const candidates = [".tissue/state", "tissue.db", "opencode.db-wal", "node_modules/pkg"];
  const { stdout } = await execFileP("git", ["check-ignore", ...candidates], { cwd: ROOT });
  const ignored = stdout.split("\n").filter(Boolean);
  assert.equal(ignored.length, candidates.length, `expected all candidates ignored, got: ${ignored}`);
});

test("s6 A' entrypoint template is loopback-only and free of D' machinery", () => {
  const run = readFileSync(join(ROOT, "deploy", "s6-rc", "tissue", "run"), "utf8");
  const type = readFileSync(join(ROOT, "deploy", "s6-rc", "tissue", "type"), "utf8");
  const typeLines = type.trim().split("\n");
  assert.equal(typeLines[typeLines.length - 1], "longrun");
  assert.match(run, /127\.0\.0\.1|localhost/);
  assert.doesNotMatch(run, /0\.0\.0\.0/);
  assert.doesNotMatch(run, /turn_in_flight/);
  assert.doesNotMatch(run, /opencode run/);
});

test("lockfile exists so dependencies are reproducible", () => {
  assert.doesNotThrow(() => readFileSync(join(ROOT, "package-lock.json"), "utf8"));
});
