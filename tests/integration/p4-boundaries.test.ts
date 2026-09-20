// tests/integration/p4-boundaries.test.ts
//
// P4-S3: verify the A'/D' boundary and the controller/agent boundary in code and
// docs. A' is the ONLY shell: no D' machinery (no `turn_in_flight` ledger, no
// detached-child reaping, no alternate `opencode run` shell), no fake sessions,
// no lifecycle-mutating Tissue tools on agent sessions, loopback-only serves.
// D' stays documented-only and is never implemented.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { OpenCodeDriver, type PromptEnvelope } from "../../src/integrations/opencode-driver.ts";
import type { OpenCodeHttp } from "../../src/integrations/opencode-http.ts";
import { lookupCommand, type CliContext } from "../../src/cli.ts";
import { OperationError } from "../../src/controller/ops.ts";
import { ARTIFACT_SKIP } from "../helpers/artifacts.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, ext));
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Remove line and block comments so documentation of a banned pattern is allowed. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SRC_TS = listFiles(join(ROOT, "src"), ".ts");

test("A' is the only shell: no D' machinery exists in src/ (comments excluded)", () => {
  const forbidden: Array<{ name: string; re: RegExp }> = [
    { name: "turn_in_flight ledger", re: /turn_in_flight/ },
    { name: "alternate opencode run shell", re: /\bopencode\s+run\b/ },
    { name: "detached child spawn", re: /detached\s*:\s*true/ },
    { name: "process-group kill (detached-child reaping)", re: /process\.kill\(\s*-/ },
    { name: "new session leader (setsid)", re: /\bsetsid\b/ },
    { name: "non-loopback bind", re: /0\.0\.0\.0/ },
  ];
  const violations: string[] = [];
  for (const file of SRC_TS) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const { name, re } of forbidden) {
      // Allow the literal word only inside a string/list when it is a guard, but
      // here we require it to be entirely absent from executable code.
      if (re.test(code)) {
        const relativePath = file.slice(ROOT.length).replace(/^\//, "");
        const intentionalInternalHealthBind =
          name === "non-loopback bind" && relativePath === "src/runtime/health-server.ts";
        if (!intentionalInternalHealthBind) violations.push(`${name} in ${relativePath}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("resident production assembly never owns an OpenCode serve", () => {
  const entrypoint = stripComments(readFileSync(join(ROOT, "src/runtime/entrypoint.ts"), "utf8"));
  const daemon = stripComments(readFileSync(join(ROOT, "src/runtime/daemon.ts"), "utf8"));
  assert.match(entrypoint, /TISSUE_OPENCODE_URL/);
  assert.match(entrypoint, /createProductionAssembly/);
  assert.doesNotMatch(entrypoint, /spawn\(|child_process|"opencode"/i);
  assert.doesNotMatch(daemon, /spawn\(|child_process|"opencode"/i);
});

test("agent sessions never receive lifecycle-mutating Tissue tools (driver omits `tools`)", () => {
  const driver = new OpenCodeDriver({ http: {} as OpenCodeHttp });
  const body = (
    driver as unknown as { buildPromptBody(p: PromptEnvelope): Record<string, unknown> }
  ).buildPromptBody({ text: "do the work", agent: "tissue-resolve" });
  assert.equal("tools" in body, false, "prompt body must not attach a tools map");
  assert.deepEqual(body["parts"], [{ type: "text", text: "do the work" }]);
  assert.equal(body["agent"], "tissue-resolve");
});

test("agent instruction files are semantic-only and grant no lifecycle tools", () => {
  const forbidden = /tissue_(enqueue|pause|resume|cleanup|inspect)|(^|[_-])(gh|github|merge|push|release)([_-]|$)/im;
  const triageAllowed = new Set(["read", "grep", "glob", "list", "search"]);
  for (const name of ["tissue-triage.md", "tissue-resolve.md"]) {
    const md = readFileSync(join(ROOT, "agents", name), "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
    assert.ok(fm.length > 0, `${name} has frontmatter`);
    assert.match(fm, /^\s*tools\s*:/m, `${name} declares an explicit restrictive tool profile`);
    assert.doesNotMatch(fm, /^\s*model\s*:/m, `${name} must not pin a concrete model (T8 (f) stays NEEDS_DECISION)`);
    assert.doesNotMatch(fm, /tools:[\s\S]*?(tissue_|github|merge|push|release)/i, `${name} must not enable lifecycle tools`);
    assert.doesNotMatch(md, /tissue_(enqueue|pause|resume|cleanup|inspect)\b/, `${name} must not expose lifecycle tools`);
    assert.match(md, /semantic/i, `${name} declares a semantic-only role`);
    assert.match(md, /controller owns/i, `${name} defers lifecycle to the controller`);
    if (name === "tissue-triage.md") {
      const enabled = [...fm.matchAll(/^\s{2}([A-Za-z_]+):\s*true\s*$/gm)].map((m) => m[1]!);
      assert.ok(enabled.length > 0, "triage enables at least one restrictive tool");
      for (const tool of enabled) {
        assert.ok(triageAllowed.has(tool), `triage tool '${tool}' must be read/inspect only`);
      }
    }
  }
});

test("D' remains documented-only and is never co-built", { skip: ARTIFACT_SKIP }, () => {
  const design = readFileSync(join(ROOT, "artifacts/designs/pending/DD-tissue-design.md"), "utf8");
  assert.match(design, /D[′']/);
  assert.match(design, /documented[- ]only|retained alternative|never co-built/i);
});

test("operational command handlers are wired through structured operations", async () => {
  for (const name of ["inspect", "history", "pause", "resume", "unpause", "cleanup"] as const) {
    const entry = lookupCommand(name);
    assert.ok(entry, `${name} is registered`);
  }
  const pause = lookupCommand("pause")!;
  await assert.rejects(
    pause.run({} as unknown as CliContext, []),
    (err: unknown) => err instanceof OperationError && err.code === "INVALID_ARGUMENT",
  );
  assert.notEqual(OperationError, undefined);
});
