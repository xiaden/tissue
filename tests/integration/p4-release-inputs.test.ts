// P4-S3..P4-S7: release artifacts and operational documentation are deterministic, redacted, and truthful.
//
// Amended pre-release scope: this anchor no longer pins a brittle GLOBAL declared
// test count. A legitimate test add/remove must not fail it. It keeps only the
// non-brittle drift checks that guard real current artifacts: producer-derived
// count consistency, the exact T8 split, the absence of any current
// READY_WITH_BLOCKERS / READY_WITH_RELEASE_BLOCKERS promotion label, and DD /
// Plan E coverage. Current docs may report this pass's exact deterministic
// result; that exact number is not asserted here (regenerate docs + the
// machine-derived snapshot together instead).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { ARTIFACT_SKIP, readArtifact } from "../helpers/artifacts.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Release artifacts under artifacts/ are untracked local work products (see
// .gitignore), so a clean checkout (CI) has none. The artifact-backed anchors
// below skip there instead of failing; the src-only anchor still runs everywhere.
const artifactText = (rel: string): string => (typeof ARTIFACT_SKIP === "string" ? "" : readArtifact(rel));
const traceability = artifactText("designs/process/tissue-p4-traceability.md");
const releaseInputs = artifactText("designs/process/tissue-p4-release-inputs.md");
const releaseArtifacts = artifactText("release/tissue-release-artifacts.md");
const t8Register = artifactText("designs/process/tissue-t8-register.md");
// The DD and the Plan E report are also authoritative reconciliation documents;
// both are drift-anchored for the T8 authorized split and the current
// non-release-ready classification.
const ddDesign = artifactText("designs/pending/DD-tissue-design.md");
const planEReport = artifactText("release/tissue-plan-e-final-report.md");
const rgEvidence = Object.fromEntries(
  (["rg2", "rg3", "rg4", "rg6"] as const).map((gate) => [gate, artifactText(`designs/process/tissue-${gate}-evidence.md`)]),
) as Record<"rg2" | "rg3" | "rg4" | "rg6", string>;

test("P4 traceability enumerates every immutable R1-R22 requirement", { skip: ARTIFACT_SKIP }, () => {
  const rows = traceability.split("\n").filter((line) => /^\| R\d+ \|/.test(line));
  assert.equal(rows.length, 22, "traceability must contain exactly one row for each R1-R22 requirement");
  for (let n = 1; n <= 22; n += 1) {
    const row = rows.find((line) => line.startsWith(`| R${n} |`));
    assert.ok(row, `missing R${n} traceability row`);
    const cells = row!.split("|").slice(1, -1).map((cell) => cell.trim());
    assert.ok(cells[2], `R${n} must have non-empty evidence mapping`);
    assert.ok(cells[3], `R${n} must have non-empty status or gap classification`);
    assert.match(cells[3]!, /PASS|PARTIAL|BLOCKED|NEEDS_DECISION|RELEASE GAP|REQUIREMENT_DRIFT/,
      `R${n} status must use a valid conformance/gap classification`);
  }
  assert.match(traceability, /REQUIREMENT_DRIFT/);
  assert.match(traceability, /infrastructure and boundary audit/i);
});

test("P4 release inputs reconcile the exact npm test producer and a self-consistent machine-derived result", { skip: ARTIFACT_SKIP }, () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: { test?: string } };
  const producer = packageJson.scripts?.test;
  assert.equal(producer, 'node --test "tests/**/*.test.ts"');
  const result = JSON.parse(readArtifact("designs/process/tissue-p4-test-result.json")) as {
    command: string;
    producer: string;
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    provenance: {
      exact_command: string;
      producer: string;
      generated_at: string;
      relationship: string;
    };
  };
  assert.equal(result.command, "npm test");
  assert.equal(result.producer, producer);
  assert.equal(result.provenance.exact_command, "npm test");
  assert.equal(result.provenance.producer, producer);
  assert.match(result.provenance.generated_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(result.provenance.relationship, /machine-derived/i);
  assert.match(result.provenance.relationship, /captured from the exact producer output/i);
  assert.doesNotMatch(result.provenance.relationship, /manually|not independently generated/i);

  // Counts are internally consistent with the recorded producer run. This is
  // deliberately NOT compared against a global declared-test inventory: adding
  // or removing a legitimate test must not fail this anchor.
  for (const [label, value] of [["passed", result.passed], ["failed", result.failed], ["skipped", result.skipped], ["total", result.total]] as const) {
    assert.ok(Number.isInteger(value) && value >= 0, `recorded ${label} must be a non-negative integer`);
  }
  assert.ok(result.total > 0, "the producer ran at least one test");
  assert.equal(result.total, result.passed + result.failed + result.skipped);
  assert.equal(result.failed, 0, "the recorded deterministic result has zero failures");

  // The release documents must carry the producer and the non-promotional,
  // fail-closed gate language (not an exact repinned global count).
  assert.match(releaseInputs, /\*\*Command:\*\* `npm test`/);
  assert.match(releaseInputs, /\*\*Producer:\*\* `node --test "tests\/\*\*\/\*\.test\.ts"`/);
  assert.match(releaseInputs, /opt-in resident OpenCode skip is not a pass/);
  assert.match(releaseInputs, /RG-3.*RG-6.*BLOCKED/s);
  assert.match(releaseInputs, /credentials/);
  assert.match(releaseInputs, /issue-text/);
  assert.match(releaseInputs, /transcript/);
  assert.match(releaseInputs, /A[′'] only/);
  for (const doc of [releaseInputs, traceability, releaseArtifacts, planEReport]) {
    // Historical reports must remain explicitly labelled superseded; the exact
    // superseded count token is not pinned, so it may legitimately be removed
    // from current docs without failing this anchor.
    assert.match(doc, /superseded historical/i);
  }
});

test("DD and Plan E report are drift-anchored for the T8 split and non-release-ready status", { skip: ARTIFACT_SKIP }, () => {
  // (a) The old 253/254 result must be explicitly labelled superseded historical
  // in the DD; its current result must be described as machine-derived, not
  // manually fabricated. The exact current count is not asserted here.
  assert.match(ddDesign, /253 passing tests[\s\S]{0,160}superseded historical|superseded historical[\s\S]{0,160}253 passing tests/i,
    "DD must label the old 253 count as superseded historical");
  assert.match(ddDesign, /machine-derived \d{4}-\d{2}-\d{2}/, "DD must describe its current result as machine-derived with a generation date");
  // The Plan E report is a superseded record; its counts must be labelled historical.
  assert.match(planEReport, /superseded/i);
  assert.match(planEReport, /2026-09-11/);
  assert.doesNotMatch(planEReport, /the current exact producer result is machine-derived as 253\/0\/1\/254/i);

  // (b) T8 authorized split must be present in both documents.
  const accepted = ["(a)", "(g)", "(h)"];
  const unresolved = ["(b)", "(c)", "(d)", "(e)", "(f)", "(i)", "(j)"];
  for (const doc of [ddDesign, planEReport]) {
    for (const question of accepted) {
      const q = question[1];
      assert.match(doc, new RegExp(`\\(${q}\\)[^\n]{0,200}ACCEPTED`, "i"),
        `${question} must be recorded ACCEPTED`);
    }
    for (const question of unresolved) {
      const q = question[1];
      assert.match(doc, new RegExp(`\\(${q}\\)[^\n]{0,220}NEEDS_DECISION`, "i"),
        `${question} must remain NEEDS_DECISION`);
    }
  }

  // (c) No current READY_WITH_RELEASE_BLOCKERS status may remain in either doc.
  assert.doesNotMatch(planEReport, /^\*\*Status:\*\*\s*READY_WITH_RELEASE_BLOCKERS/m,
    "Plan E report Status must not be READY_WITH_RELEASE_BLOCKERS");
  assert.match(planEReport, /NOT RELEASE-READY|NOT-RELEASE-READY|retired/i,
    "Plan E report must carry a retired / NOT-RELEASE-READY classification");
  assert.doesNotMatch(ddDesign, /READY_WITH_RELEASE_BLOCKERS/,
    "DD must not carry a current READY_WITH_RELEASE_BLOCKERS status");
});

test("P4 documentation agrees on A-prime runtime, boundaries, and blocked release language", { skip: ARTIFACT_SKIP }, () => {
  const cli = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
  const entrypoint = readFileSync(join(ROOT, "src/runtime/entrypoint.ts"), "utf8");
  const run = readFileSync(join(ROOT, "deploy/s6-rc/tissue/run"), "utf8");
  const type = readFileSync(join(ROOT, "deploy/s6-rc/tissue/type"), "utf8");
  const s6Readme = readFileSync(join(ROOT, "deploy/s6-rc/README.md"), "utf8");
  const dd = readArtifact("designs/pending/DD-tissue-design.md");
  for (const source of [cli, entrypoint, run, type, s6Readme]) assert.match(source, /daemon/);
  assert.match(cli, /tick.*one pass|one pass.*tick/s);
  assert.match(cli, /resident.*runDaemon/s);
  assert.match(entrypoint, /runProductionDaemon/);
  assert.match(run, /entrypoint\.ts daemon/);
  assert.match(type, /longrun/);
  assert.match(s6Readme, /D'.*not.*release implementation|D'.*documented only/i);
  assert.match(dd, /A[′'].*D[′']/);
  assert.match(dd, /real OpenCode-created/);
  assert.match(dd, /no lifecycle-mutating tool/);
  assert.match(releaseInputs, /BLOCKED/);
  assert.match(releaseInputs, /Plan E/);

  // Current release status must be explicitly non-promotional and NOT release-ready.
  assert.match(releaseInputs, /NOT RELEASE-READY/);
  assert.doesNotMatch(releaseInputs, /READY_WITH_RELEASE_BLOCKERS/);
  assert.match(releaseArtifacts, /NOT RELEASE-READY/);
  assert.doesNotMatch(releaseArtifacts, /READY_WITH_RELEASE_BLOCKERS/);
});

test("P4 retained probe records cannot be mistaken for current release evidence", { skip: ARTIFACT_SKIP }, () => {
  for (const [gate, evidence] of Object.entries(rgEvidence)) {
    assert.match(evidence, /historical\/non-current/i, `${gate} must be historical/non-current`);
    assert.match(evidence, /insufficient for (?:current )?release (?:acceptance|promotion)/i, `${gate} must be insufficient`);
    assert.match(evidence, /Owner:/);
    assert.match(evidence, /Reason:/);
    assert.match(evidence, /Action:/);
  }
  assert.match(releaseInputs, /RG-1 and RG-3–RG-6 remain \*\*BLOCKED\*\*/);
  assert.match(releaseInputs, /RG-2 is deterministic-only\/non-promotional/);
  assert.match(releaseInputs, /opt-in resident OpenCode skip is not a pass/);
});

test("T8 register records the authorized split with one canonical row per decision", { skip: ARTIFACT_SKIP }, () => {
  const accepted = ["(a)", "(g)", "(h)"];
  const unresolved = ["(b)", "(c)", "(d)", "(e)", "(f)", "(i)", "(j)"];
  for (const question of [...accepted, ...unresolved]) {
    const rows = t8Register.split("\n").filter((line) => line.startsWith(`| ${question} |`));
    assert.equal(rows.length, 1, `${question} must have exactly one canonical row`);
    const columns = rows[0]!.split("|").map((column) => column.trim());
    assert.ok(columns[3], `${question} must retain an owner`);
    assert.ok(columns[4], `${question} must retain a deadline`);
    if (accepted.includes(question)) {
      assert.match(columns[5] ?? "", /ACCEPTED/, `${question} must be ACCEPTED`);
      assert.doesNotMatch(rows[0]!, /NEEDS_DECISION/, `${question} must not be NEEDS_DECISION`);
    } else {
      assert.match(columns[5] ?? "", /NEEDS_DECISION/, `${question} must remain NEEDS_DECISION`);
      assert.match(rows[0]!, /NEEDS_DECISION/, `${question} must remain NEEDS_DECISION`);
    }
  }
  assert.match(t8Register, /releasePromotable`? remains `?false|releasePromotable=false/);
  // The reconciliation documents carry the same split.
  for (const doc of [releaseInputs]) {
    for (const question of accepted) assert.match(doc, new RegExp(`T8\\(${question[1]}\\)[^\\n]*\\|\\s*ACCEPTED`));
    for (const question of unresolved) assert.match(doc, new RegExp(`T8\\(${question[1]}\\)[^\\n]*\\|\\s*NEEDS_DECISION`));
  }
});

test("P4 amendment cleanup leaves no stale export/comment or M0/M1 wording", () => {
  const reconcile = readFileSync(join(ROOT, "src/controller/reconcile.ts"), "utf8");
  const load = readFileSync(join(ROOT, "src/config/load.ts"), "utf8");
  const types = readFileSync(join(ROOT, "src/config/types.ts"), "utf8");
  const lint = readFileSync(join(ROOT, "scripts/lint.ts"), "utf8");
  assert.doesNotMatch(reconcile, /not-yet-wired|NotWiredError/);
  for (const source of [load, types, lint]) assert.doesNotMatch(source, /M0|M1/);
});
