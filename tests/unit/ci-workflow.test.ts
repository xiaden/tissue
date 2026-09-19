import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "../..");
const workflowText = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const workflow = parse(workflowText) as Record<string, any>;
const container = workflow.jobs?.container as Record<string, any> | undefined;
const steps = (): Record<string, any>[] => container?.steps ?? [];
function stepNamed(name: string): Record<string, any> {
  const step = steps().find((candidate) => candidate.name === name);
  assert.ok(step, `container job must retain step ${name}`);
  return step;
}

test("container job has exactly eight deterministic fixture legs", () => {
  assert.ok(container);
  assert.equal(container["runs-on"], "ubuntu-latest");
  assert.equal(container["timeout-minutes"], 30);
  assert.deepEqual(container.permissions, { contents: "read" });
  assert.equal(container.steps[0].uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.equal(container.steps[1].uses, "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
  assert.equal(container.steps[1].with["node-version"], "26");
  assert.equal(container.steps[2].run, "npm ci");
  const names = [
    "Leg 1 — Build Tissue and HTTP fixture images",
    "Leg 2 — Compose config",
    "Leg 3 — Boot Tissue and HTTP fixture",
    "Leg 4 — tissue-net membership",
    "Leg 5 — Exact shared mounts and private-state isolation",
    "Leg 6 — Registry failure is loud and doctor unhealthy",
    "Leg 7 — Healthy Tissue doctor",
    "Leg 8 — Deterministic fixture HTTP driver smoke",
  ];
  assert.deepEqual(steps().filter((step) => /^Leg [1-8] /.test(step.name ?? "")).map((step) => step.name), names);
  for (const name of names) assert.match(stepNamed(name).run, /set -euo pipefail/);
});

test("fixture workflow has no actual OpenCode or plugin prerequisite", () => {
  assert.match(workflowText, /opencode-http-fixture/);
  assert.match(workflowText, /tests\/fixtures\/opencode-http-fixture/);
  assert.match(workflowText, /opencode-fixture/);
  assert.doesNotMatch(workflowText, /opencode-ai@|opencode web|debug config|npm install|install-plugin|install-agents/);
  assert.doesNotMatch(workflowText, /plugin.*mount|agent.*mount/i);
  assert.doesNotMatch(workflowText, /fired|beacon|resident plugin|hook execution/i);
});

test("diagnostics and teardown always run and fixture smoke is a real network caller", () => {
  assert.equal(stepNamed("Upload container leg logs").if, "always()");
  assert.equal(stepNamed("Upload container leg logs").uses, "actions/upload-artifact@65462800fd760344b1a7b4382951275a0abb4808");
  assert.equal(stepNamed("Upload container leg logs").with.path, "leg-*.log");
  assert.equal(stepNamed("Tear down CI topology").if, "always()");
  assert.match(stepNamed("Tear down CI topology").run, /down --volumes --remove-orphans/);
  assert.match(stepNamed("Leg 8 — Deterministic fixture HTTP driver smoke").run, /opencode-http-fixture\.test\.ts/);
});

test("fixture context is dependency-free and exposes the contracted routes", () => {
  const dockerfile = readFileSync(resolve(ROOT, "tests/fixtures/opencode-http-fixture/Dockerfile"), "utf8");
  const server = readFileSync(resolve(ROOT, "tests/fixtures/opencode-http-fixture/server.mjs"), "utf8");
  assert.match(dockerfile, /FROM node:26-bookworm-slim/);
  assert.doesNotMatch(dockerfile, /npm (ci|install)|opencode-ai/);
  for (const route of ["/session", "/session/status", "/message", "/prompt_async", "/abort", "/event"]) assert.match(server, new RegExp(route.replace("/", "\\/")));
  assert.match(server, /ses_/);
  assert.match(server, /projectID/);
});


test("verify is deterministic and OpenCode-independent", () => {
  const verify = workflow.jobs?.verify as Record<string, any> | undefined;
  assert.ok(verify);
  assert.deepEqual(verify.permissions, undefined);
  const commands = (verify.steps as Record<string, any>[]).map((step) => String(step.run ?? "")).join("\n");
  assert.match(commands, /npm run typecheck/);
  assert.match(commands, /npm run lint/);
  assert.match(commands, /npm test/);
  assert.doesNotMatch(commands, /docker|opencode|model|github_token|OPENCODE_SERVER/i);
  assert.doesNotMatch(JSON.stringify(verify), /opencode-ai|opencode web|live OpenCode|debug config/i);
});

test("real compatibility is a distinct opt-in 1.18.31 job", () => {
  const compat = workflow.jobs?.["opencode-compat"] as Record<string, any> | undefined;
  assert.ok(compat);
  assert.equal(compat.name, "opencode-compat");
  assert.match(String(compat.if), /run-opencode-compat/);
  assert.equal(compat["timeout-minutes"], 10);
  const text = JSON.stringify(compat);
  assert.match(text, /1\.18\.31/);
  assert.match(text, /deploy-plugin/);
  assert.match(text, /compat-smoke/);
  assert.doesNotMatch(text, /npm install|opencode-ai@|model|github_token|live database|docker compose/i);
  assert.notEqual(compat, container);
});
