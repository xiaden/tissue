// Plan O — Docker-free structural coverage for the container CI job.
// Runtime Docker/GitHub execution remains owned by the workflow; these assertions
// protect the executable contract from silent topology drift.
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

test("container job preserves the nine individually named executable legs", () => {
  assert.ok(container, "container job must exist");
  assert.equal(container["runs-on"], "ubuntu-latest");
  assert.equal(container["timeout-minutes"], 30);
  assert.deepEqual(container.permissions, { contents: "read" });
  assert.equal(container.steps[0].uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.equal(container.steps[1].uses, "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
  assert.equal(container.steps[1].with["node-version"], "26");
  assert.equal(container.steps[2].run, "npm ci");

  const legNames = [
    "Leg 1 — Docker build",
    "Leg 2 — Compose config",
    "Leg 3 — Boot tissue and stand-in",
    "Leg 4 — tissue-net membership",
    "Leg 5 — Registry RW/RO and mounts",
    "Leg 6 — Registry mount failure is loud",
    "Leg 7 — Healthy tissue doctor",
    "Leg 8 — Real ses_* behavioural smoke",
    "Leg 9 — Fresh-process resolution (Plan M owned)",
  ];
  assert.deepEqual(
    legNames.map((name) => stepNamed(name).name),
    legNames,
    "each contracted leg must remain individually addressable",
  );

  const legScripts = legNames.map((name) => {
    const run = stepNamed(name).run;
    assert.equal(typeof run, "string");
    return run as string;
  });
  const leg = (index: number): string => {
    const script = legScripts[index];
    assert.equal(typeof script, "string");
    return script as string;
  };
  assert.match(leg(0), /docker build --tag tissue:ci/);
  assert.match(leg(1), /docker compose .* config/);
  assert.match(leg(2), /docker compose .* up -d tissue opencode/);
  assert.match(leg(3), /docker network inspect tissue-net/);
  assert.match(leg(4), /docker inspect .*Mounts/);
  assert.match(leg(5), /test \"\$rc\" -ne 0/);
  assert.match(leg(6), /report\.ok!==true/);
  assert.match(leg(7), /p6-moderation-behaviour\.test\.ts/);
  assert.match(leg(8), /p6-plugin-deployment\.test\.ts.*fresh-process-resolution/);
});

test("container diagnostics and teardown always run, while failures stay loud", () => {
  const upload = stepNamed("Upload container leg logs");
  const teardown = stepNamed("Tear down CI topology");
  assert.equal(upload.if, "always()");
  assert.equal(upload.uses, "actions/upload-artifact@65462800fd760344b1a7b4382951275a0abb4808");
  assert.equal(upload.with.path, "leg-*.log");
  assert.equal(teardown.if, "always()");
  assert.match(teardown.run, /docker compose .* down --volumes --remove-orphans/);

  const legRuns = steps()
    .filter((step) => /^Leg [1-9] /.test(step.name ?? ""))
    .map((step) => step.run as string);
  assert.equal(legRuns.length, 9);
  for (const run of legRuns) {
    assert.match(run, /set -euo pipefail/, "each leg must fail loudly on command errors");
  }
  const leg9 = stepNamed("Leg 9 — Fresh-process resolution (Plan M owned)").run as string;
  assert.match(leg9, /debug_rc/);
  assert.match(leg9, /test \"\$debug_rc\" -eq 0/);
  assert.match(leg9, /tissue-moderation\.ts/);
});


test("leg 3 rejects exited or unhealthy services and emits diagnostics", () => {
  const leg3 = stepNamed("Leg 3 — Boot tissue and stand-in").run as string;
  assert.match(leg3, /docker inspect/);
  assert.match(leg3, /State.Status/);
  assert.match(leg3, /Health.Status/);
  assert.match(leg3, /unhealthy|not running|exited/i);
  assert.match(leg3, /docker compose .* ps/);
  assert.match(leg3, /docker logs/);
});

test("leg 5 proves exact source/destination identity and Tissue-private isolation", () => {
  const leg5 = stepNamed("Leg 5 — Registry RW/RO and mounts").run as string;
  assert.match(leg5, /.Source/);
  assert.match(leg5, /.Destination/);
  assert.match(leg5, /tissue-session-registry/);
  assert.match(leg5, /var\/lib\/tissue\/state/);
  assert.match(leg5, /private|leak|absent|forbidden/i);
  assert.match(leg5, /workspace\/subarr/);
});

test("leg 9 parses machine-readable debug config and exact plugin-set membership", () => {
  const leg9 = stepNamed("Leg 9 — Fresh-process resolution (Plan M owned)").run as string;
  assert.match(leg9, /debug config.*--json|--json.*debug config/);
  assert.match(leg9, /JSON.parse/);
  assert.match(leg9, /plugin/i);
  assert.match(leg9, /split\(.*pop|basename|endsWith/);
  assert.match(leg9, /tissue-moderation\.ts/);
});
