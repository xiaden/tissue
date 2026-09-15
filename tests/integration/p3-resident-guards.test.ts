// tests/integration/p3-resident-guards.test.ts
//
// Round-2 QA coverage for the A' resident boundary (cluster 5). Proves:
//   B2a. The resident endpoint is validated BEFORE any credential is attached:
//        unsafe endpoints reject with zero requests/zero auth attempts.
//   B2b. Loopback/private endpoints are accepted and then authenticated.
//   B2c. parseProviderModel rejects malformed provider/model values.
//   B2d. validateTissueAgentDefinitions surfaces missing/invalid triage/resolution
//        definitions; triage is read-only and resolution may edit/test but never
//        expose a GitHub lifecycle tool/effect.
// All boundaries are local fakes (pessimistic OpenCode server, temp agent dir);
// no real remote, service, or OpenCode DB is touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createProductionAssembly } from "../../src/runtime/entrypoint.ts";
import {
  parseProviderModel,
  validateResidentOpenCodeEndpoint,
  validateTissueAgentDefinitions,
  ResidentEndpointError,
  redactResidentEndpoint,
} from "../../src/runtime/resident.ts";
import { statusOperation } from "../../src/controller/ops.ts";
import { openTissueDb, closeDb } from "../../src/db/open.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import { startPessimisticServer } from "../helpers/pessimistic-opencode-server.ts";
import type { TissueConfig } from "../../src/config/types.ts";

const CONFIG: TissueConfig = { pollIntervalSeconds: 60, maxConcurrentGlobal: 1, retentionDays: 30, agents: {}, repos: [] };

function agentFile(name: string, tools: Record<string, boolean>, extra: string[] = []): string {
  const lines = ["---", "mode: primary", "tools:", ...Object.entries(tools).map(([k, v]) => `  ${k}: ${v}`), ...extra, "---", "", "instructions", ""];
  return lines.join("\n");
}

function makeAgentsDir(triage: string, resolve: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tissue-agents-"));
  writeFileSync(join(dir, "tissue-triage.md"), triage, "utf8");
  writeFileSync(join(dir, "tissue-resolve.md"), resolve, "utf8");
  return dir;
}

test("resident endpoint validation rejects public/unsafe hosts before any credential is attached", async () => {
  const server = await startPessimisticServer({ username: "tissue", password: "s3cret" });
  const stateDir = mkdtempSync(join(tmpdir(), "tissue-resident-"));
  const agentsDir = makeAgentsDir(agentFile("tissue-triage", { read: true }), agentFile("tissue-resolve", { read: true, edit: true, bash: true }));
  const db = openTissueDb(join(stateDir, "tissue.db"));
  const logger = new JsonLogger(new CapturingSink().writeable(), "info", "p3-resident");
  try {
    const unsafe = [
      "https://93.184.216.34:4096", // public IP
      "https://example.com:4096", // public hostname
      "http://0.0.0.0:4096", // wildcard bind
      "ftp://127.0.0.1:4096", // non-http(s) scheme
      "127.0.0.1:4096", // not an absolute URL
      "https://user:pass@127.0.0.1:4096", // embedded credentials
      "", // missing
    ];
    for (const endpoint of unsafe) {
      await assert.rejects(
        createProductionAssembly({
          config: CONFIG, logger, db, stateDir, endpoint, agentsDir,
          credentials: { username: "tissue", password: "s3cret" },
        }),
        ResidentEndpointError,
        `endpoint must reject: ${endpoint || "<empty>"}`,
      );
    }
    // Validation happened before credentials: the transport never saw a request.
    assert.equal(server.requestCount, 0, "no request may reach an unsafe endpoint");
    assert.equal(server.authRejections, 0, "no Authorization header may be sent to an unsafe endpoint");

    // Loopback/private is accepted, and credentials then authenticate successfully.
    const assembly = await createProductionAssembly({
      config: CONFIG, logger, db, stateDir, endpoint: server.baseUrl(), agentsDir,
      credentials: { username: "tissue", password: "s3cret" },
    });
    assert.ok(server.requestCount > 0, "loopback endpoint is queried after validation");
    assert.equal(server.authRejections, 0, "validated endpoint receives valid credentials");
    assert.equal(assembly.endpoint, `http://127.0.0.1:${new URL(server.baseUrl()).port}`);
    assert.equal(assembly.agentDefinitions.ok, true);
  } finally {
    closeDb(db);
    await server.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
  }
});

test("validateResidentOpenCodeEndpoint accepts loopback/private and rejects unsafe hosts", () => {
  for (const ok of ["http://127.0.0.1:4096", "http://localhost:4096", "https://10.0.0.5:4096", "http://172.16.4.4:4096", "http://192.168.1.9:4096", "http://[::1]:4096"]) {
    assert.doesNotThrow(() => validateResidentOpenCodeEndpoint(ok), `should accept ${ok}`);
  }
  for (const bad of ["http://8.8.8.8:4096", "http://169.0.0.1:4096", "https://evil.example", "http://0.0.0.0:4096", "file:///etc/passwd", "not a url", ""]) {
    assert.throws(() => validateResidentOpenCodeEndpoint(bad), ResidentEndpointError, `should reject ${bad || "<empty>"}`);
  }
});

test("parseProviderModel rejects malformed provider/model identifiers without selecting a model", () => {
  for (const bad of ["claude-3-5-sonnet", "/sonnet", "anthropic/", "pro vider/model", "provider/mo\u0000del", "", "  "]) {
    assert.throws(() => parseProviderModel(bad), /provider\/model/, `should reject ${bad || "<empty>"}`);
  }
  assert.deepEqual(parseProviderModel("anthropic/claude-3-5-sonnet"), { providerID: "anthropic", modelID: "claude-3-5-sonnet" });
  // Only the first slash splits, so nested model ids survive.
  assert.deepEqual(parseProviderModel("openrouter/anthropic/claude-3"), { providerID: "openrouter", modelID: "anthropic/claude-3" });
});

test("validateTissueAgentDefinitions fails missing/invalid definitions and keeps triage restrictive / resolution local-only", () => {
  const validTriage = agentFile("tissue-triage", { read: true, grep: true });
  const validResolve = agentFile("tissue-resolve", { read: true, edit: true, bash: true });

  const missingDir = join(tmpdir(), `tissue-agents-absent-${process.pid}-${Date.now()}`);
  const missing = validateTissueAgentDefinitions({ agentsDir: missingDir });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /missing host-global triage agent definition/.test(e)));
  assert.ok(missing.errors.some((e) => /missing host-global resolution agent definition/.test(e)));

  const ok = validateTissueAgentDefinitions({ agentsDir: makeAgentsDir(validTriage, validResolve) });
  assert.equal(ok.ok, true, ok.errors.join("; "));
  const triage = ok.agents.find((a) => a.role === "triage")!;
  const resolution = ok.agents.find((a) => a.role === "resolution")!;
  assert.deepEqual(triage.enabledTools.sort(), ["grep", "read"]);
  assert.ok(triage.enabledTools.every((t) => ["read", "grep", "glob", "list", "search"].includes(t)));
  assert.deepEqual(resolution.enabledTools.sort(), ["bash", "edit", "read"]);
  // Resolution permits local edit/test only: no GitHub lifecycle tool is enabled.
  assert.ok(resolution.enabledTools.every((t) => !/gh|github|merge|push|release|workflow|issue|pr|admin/i.test(t)));

  const badTriage = validateTissueAgentDefinitions({ agentsDir: makeAgentsDir(agentFile("tissue-triage", { read: true, edit: true }), validResolve) });
  assert.equal(badTriage.ok, false);
  assert.ok(badTriage.errors.some((e) => /outside the triage allowed profile/.test(e)));

  const noTools = validateTissueAgentDefinitions({ agentsDir: makeAgentsDir(agentFile("tissue-triage", { read: false }), validResolve) });
  assert.equal(noTools.ok, false);
  assert.ok(noTools.errors.some((e) => /at least one allowlisted triage tool/.test(e)));

  const lifecycle = validateTissueAgentDefinitions({ agentsDir: makeAgentsDir(validTriage, agentFile("tissue-resolve", { read: true, gh: true, merge: true })) });
  assert.equal(lifecycle.ok, false);
  assert.ok(lifecycle.errors.some((e) => /forbidden lifecycle\/GitHub tool 'gh'/.test(e)));
  assert.ok(lifecycle.errors.some((e) => /forbidden lifecycle\/GitHub tool 'merge'/.test(e)));

  const pinned = validateTissueAgentDefinitions({ agentsDir: makeAgentsDir(validTriage, agentFile("tissue-resolve", { read: true, edit: true }, ["model: anthropic/claude-3"])) });
  assert.equal(pinned.ok, false);
  assert.ok(pinned.errors.some((e) => /T8 \(f\)/.test(e)));
});

test("redactResidentEndpoint strips userinfo and path and marks unparseable values invalid", () => {
  assert.equal(redactResidentEndpoint("http://user:pass@127.0.0.1:4096/secret"), "http://127.0.0.1:4096");
  assert.equal(redactResidentEndpoint("https://alice:tok@10.0.0.5:4096/v1/status?x=1"), "https://10.0.0.5:4096");
  assert.equal(redactResidentEndpoint("not a url"), "[invalid]");
});

test("statusOperation exposes a credential-free opencode endpoint when TISSUE_OPENCODE_URL embeds credentials", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "tissue-resident-status-"));
  const previous = process.env.TISSUE_OPENCODE_URL;
  try {
    process.env.TISSUE_OPENCODE_URL = "http://leakyuser:leakypass@127.0.0.1:4096/secret";
    const logger = new JsonLogger(new CapturingSink().writeable(), "info", "p3-resident");
    const status = statusOperation({ config: CONFIG, stateDir, logger }) as {
      opencode: { configured: boolean; endpoint: string | null };
    };
    assert.equal(status.opencode.configured, true);
    assert.equal(status.opencode.endpoint, "http://127.0.0.1:4096");
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes("leakyuser"), false, "status must not echo the URL username");
    assert.equal(serialized.includes("leakypass"), false, "status must not echo the URL password");
    assert.equal(serialized.includes("/secret"), false, "status must not echo the URL path");
  } finally {
    if (previous === undefined) delete process.env.TISSUE_OPENCODE_URL;
    else process.env.TISSUE_OPENCODE_URL = previous;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
