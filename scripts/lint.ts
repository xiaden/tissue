// scripts/lint.ts
//
// Local structural lint for the source/configuration boundary. This is a lightweight,
// dependency-free guard that runs in `npm run lint` and in local CI. It is
// deliberately conservative (no codegen, no auto-fix) and must exit non-zero on
// any violation so CI is real and green.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const SCAN_DIRS = ["src", "tests", "scripts", "deploy", "agents"];
const SCAN_FILES = ["package.json", "tsconfig.json", ".gitignore"];

const TEXT_EXTENSIONS = new Set([
  ".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".gitignore",
]);

function isBinaryish(p: string): boolean {
  // run/type files have no extension; treat as text by default.
  const ext = p.slice(p.lastIndexOf("."));
  if (ext === "") return true;
  return TEXT_EXTENSIONS.has(ext);
}

function collectFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // directory does not exist yet (e.g. agents before P1-S4)
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (e === "node_modules" || e === ".tissue") continue;
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
    } else {
      out.push(full);
    }
  }
}

const problems: string[] = [];

function fail(rel: string, message: string): void {
  problems.push(`${rel}: ${message}`);
}

function check(rel: string, content: string): void {
  if (/console\.(log|warn|error|info)\(/.test(content)) {
    // Only enforced under src/ (routing through the structured logger), and the
    // lint script itself is exempt because it is an operational harness.
    if (rel.startsWith("src/")) fail(rel, "console.* call found (must route through the structured JSONL logger)");
  }
  content.split("\n").forEach((line, idx) => {
    if (/[ \t]+$/.test(line)) fail(rel, `trailing whitespace on line ${idx + 1}`);
    if (/\t/.test(line)) fail(rel, `tab character on line ${idx + 1}`);
  });
}

function secretScan(rel: string, content: string): void {
  // Credential-value leakage guards: real GitHub/generic token shapes and
  // private-key markers must never appear in tracked config/templates/code.
  const tokenPatterns = [
    /\bgh[pousr]_[A-Za-z0-9]{10,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{10,}\b/,
    /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  ];
  for (const re of tokenPatterns) {
    if (re.test(content)) fail(rel, `potential secret material matched ${re}`);
  }
}

function s6TemplateGuards(): void {
  const runPath = join(ROOT, "deploy", "s6-rc", "tissue", "run");
  const typePath = join(ROOT, "deploy", "s6-rc", "tissue", "type");
  try {
    const run = readFileSync(runPath, "utf8");
    const type = readFileSync(typePath, "utf8");
    const relRun = relative(ROOT, runPath);
    if (!type.includes("longrun")) fail("deploy/s6-rc/tissue/type", "expected 'longrun' service type");
    if (!/127\.0\.0\.1|localhost/.test(run)) fail(relRun, "A' template must be loopback-only (127.0.0.1/localhost)");
    if (/0\.0\.0\.0/.test(run)) fail(relRun, "A' template must not bind 0.0.0.0 (public binding forbidden)");
    if (/turn_in_flight/.test(run)) fail(relRun, "D' turn_in_flight ledger must not appear in A' template");
  } catch {
    fail("deploy/s6-rc/tissue", "s6-rc service files missing");
  }
}

function run(): void {
  const files: string[] = [];
  for (const d of SCAN_DIRS) collectFiles(join(ROOT, d), files);
  for (const f of SCAN_FILES) {
    const full = join(ROOT, f);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      /* ignore missing optional file */
    }
  }

  for (const full of files) {
    const rel = relative(ROOT, full);
    if (rel.includes("node_modules")) continue;
    if (!isBinaryish(rel)) continue;
    const content = readFileSync(full, "utf8");
    check(rel, content);
    if (rel.startsWith("src/") || rel.startsWith("deploy/") || rel.endsWith(".example.yml")) {
      secretScan(rel, content);
    }
  }

  s6TemplateGuards();

  if (problems.length > 0) {
    process.stderr.write("lint violations:\n" + problems.map((p) => "  - " + p).join("\n") + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("lint: clean\n");
  }
}

run();
