// tests/unit/agents-sample.test.ts
//
// P1-S4 guards: agent frontmatter + sample configuration exist, the T8
// register records onboarding/model status, and the sample config keeps its
// repository example commented while leaving the empty loaded configuration safe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig } from "../../src/config/load.ts";
import { ARTIFACT_SKIP } from "../helpers/artifacts.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

test("triage and resolve agent instruction files exist with frontmatter", () => {
  for (const name of ["tissue-triage.md", "tissue-resolve.md"]) {
    const content = readFileSync(join(ROOT, "agents", name), "utf8");
    assert.match(content, /^---\n/, `${name} must start with frontmatter`);
    assert.match(content, /description:/, `${name} must declare a description`);
    assert.match(content, /mode:\s*all/, `${name} must declare mode: all`);
  }
});

test("sample config exists, loads empty, and canonicalizes no monitored owner or model", () => {
  const sample = readFileSync(join(ROOT, "tissue.example.yml"), "utf8");
  // Loads cleanly (empty repo list) so `tissue status` works out of the box.
  const cfg = parseConfig(sample, "tissue.example.yml");
  assert.deepEqual(cfg.repos, []);
  assert.equal(cfg.maxConcurrentGlobal, 3);
  assert.equal(cfg.retentionDays, 90);

  // The template may show a commented fork/target example, but must not load
  // either candidate or pin a concrete model into the empty configuration.
  assert.match(sample, /owner:\s*coaxk/i);
  assert.match(sample, /pushOwner:\s*xiaden/i);
  assert.doesNotMatch(sample, /^\s*owner:\s*coaxk\s*$/m);
  assert.doesNotMatch(sample, /^\s*owner:\s*xiaden\s*$/m);
  assert.doesNotMatch(sample, /^\s*name:\s*subarr\s*$/m);
  assert.doesNotMatch(sample, /^\s*model:\s*provider\/model\s*$/m);
});

test("T8 register durably records (e) and (f) as NEEDS_DECISION with owner and deadline", { skip: ARTIFACT_SKIP }, () => {
  const reg = readFileSync(join(ROOT, "artifacts", "designs", "process", "tissue-t8-register.md"), "utf8");
  assert.match(reg, /NEEDS_DECISION/);
  assert.match(reg, /\(e\)/);
  assert.match(reg, /\(f\)/);
  // candidate owners remain explicitly open
  assert.match(reg, /coaxk\/subarr/);
  assert.match(reg, /xiaden\/subarr/);
  // each open question names a non-empty owner and deadline and remains decision-gated.
  const rows = reg.split("\n").filter((line) => line.includes("| (e) |") || line.includes("| (f) |"));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const columns = row.split("|").map((column) => column.trim());
    assert.ok(columns[3], "T8 question must name a non-empty owner");
    assert.ok(columns[4], "T8 question must name a non-empty deadline");
    assert.match(columns[5] ?? "", /NEEDS_DECISION/);
  }
});

test("agents reference T8 (f) rather than pinning a model", () => {
  for (const name of ["tissue-triage.md", "tissue-resolve.md"]) {
    const content = readFileSync(join(ROOT, "agents", name), "utf8");
    assert.match(content, /T8 \(f\)/, `${name} must defer model to T8 (f)`);
    assert.match(content, /NEEDS_DECISION/, `${name} must mark the model decision as open`);
    assert.doesNotMatch(content, /^\s*model:\s*\S+/m, `${name} must not pin a model`);
  }
});
