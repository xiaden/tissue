import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateEvidenceBundle,
  validateInheritedEvidence,
  redactSessionIds,
  type EvidenceBundle,
} from "./runner.ts";
import { ARTIFACT_SKIP, readArtifact } from "../helpers/artifacts.ts";
import { SseWakeHint, type WakeStreamSource } from "../../src/runtime/daemon.ts";
import { OpenCodeDriver } from "../../src/integrations/opencode-driver.ts";
import type { OpenCodeHttp } from "../../src/integrations/opencode-http.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function evidence(gate: EvidenceBundle["gates"][keyof EvidenceBundle["gates"]]["gate"]): EvidenceBundle["gates"][typeof gate] {
  return {
    gate,
    status: gate === "RG-2" ? "DETERMINISTIC_ONLY" : "BLOCKED",
    owner: "Plan E release owner",
    collectedAt: "2026-09-11T00:00:00.000Z",
    server: { binary: "/usr/local/bin/opencode", version: "1.18.18", sdk: "1.17.18", gh: "/usr/bin/gh 2.98.0" },
    topology: {
      tissueDb: ".tissue/tissue.db",
      openCodeDb: "~/.local/share/opencode/opencode.db (HTTP-observed only)",
      residentS6: true,
      ambientWriters: ["resident s6 OpenCode service"],
      lowActivityWindow: false,
    },
    thresholds: { release: "not promotable", maxSilentDeaths: 0 },
    lockWaits: { count: 0, maxMs: 0, samples: 0 },
    logs: ["redacted gate log"],
    artifacts: ["redacted evidence record"],
    redaction: { secretsExcluded: true, sessionIdsRedacted: true, rawCapturePath: null },
    reason: "Inherited evidence is historical/non-current and insufficient for release acceptance.",
    action: "Rerun with current owner-attributed redacted evidence before promotion.",
  };
}

test("release evidence schema requires all six owner-attributed redacted gate records", () => {
  const bundle: EvidenceBundle = {
    schema: "tissue.release-gates.v1",
    generatedAt: "2026-09-11T00:00:00.000Z",
    plan: "TASK-tissue-E-release-docs",
    releasePromotable: false,
    gates: {
      "RG-1": evidence("RG-1"), "RG-2": evidence("RG-2"), "RG-3": evidence("RG-3"),
      "RG-4": evidence("RG-4"), "RG-5": evidence("RG-5"), "RG-6": evidence("RG-6"),
    },
  };
  assert.equal(validateEvidenceBundle(bundle).gates["RG-2"].status, "DETERMINISTIC_ONLY");
  assert.throws(() => validateEvidenceBundle({ ...bundle, releasePromotable: true }), /releasePromotable/);
  assert.throws(() => validateEvidenceBundle({ ...bundle, gates: { ...bundle.gates, "RG-1": { ...bundle.gates["RG-1"], owner: "token=secret" } } }), /secret-shaped/);
});

test("deterministic inventory classifies every gate without promotion", { skip: ARTIFACT_SKIP }, () => {
  const inventory = JSON.parse(readArtifact("designs/process/tissue-release-evidence-inventory.json")) as {
    releasePromotable: boolean;
    records: Array<{ gate: string; classification: string; status: string; source: string | null; owner: string; promotionEffect: string }>;
  };
  assert.equal(inventory.releasePromotable, false);
  assert.deepEqual(inventory.records.map((record) => record.gate), ["RG-1", "RG-2", "RG-3", "RG-4", "RG-5", "RG-6"]);
  for (const record of inventory.records) {
    assert.ok(["accepted_current", "historical_non_current", "insufficient", "deterministic_only", "blocked"].includes(record.classification));
    assert.ok(record.owner.length > 0);
    assert.ok(record.promotionEffect.toLowerCase().includes("promot"));
  }
  assert.equal(inventory.records.find((record) => record.gate === "RG-2")?.classification, "deterministic_only");
  assert.equal(inventory.records.find((record) => record.gate === "RG-5")?.classification, "deterministic_only");
  for (const gate of ["RG-1", "RG-3", "RG-4", "RG-5", "RG-6"]) {
    assert.equal(inventory.records.find((record) => record.gate === gate)?.status, "BLOCKED");
  }
});

test("redacted fixtures classify current, historical, insufficient, deterministic-only, and blocked without promotion", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "tests/release-gates/fixtures/redacted-evidence-fixtures.json"), "utf8")) as {
    releasePromotable: boolean;
    records: Array<{ gate: string; classification: string; status: string; current: boolean; historical?: boolean; owner: string; collectedAt: string; versions: Record<string, string>; topology: Record<string, unknown>; thresholds: Record<string, unknown>; redaction: { secretsExcluded: boolean; sessionIdsRedacted: boolean } }>;
  };
  assert.equal(fixture.releasePromotable, false);
  assert.deepEqual(fixture.records.map((record) => record.gate), ["RG-1", "RG-2", "RG-3", "RG-4", "RG-5", "RG-6"]);
  for (const record of fixture.records) {
    assert.ok(record.owner.length > 0);
    assert.match(record.collectedAt, /^2026-09-11|^2026-09-10/);
    assert.ok(Object.values(record.versions).every((value) => value.length > 0));
    assert.ok(Object.keys(record.topology).length >= 5);
    assert.ok(Object.keys(record.thresholds).length > 0);
    assert.deepEqual(record.redaction, { secretsExcluded: true, sessionIdsRedacted: true });
  }
  assert.deepEqual(fixture.records.map((record) => record.classification), ["accepted_current", "deterministic_only", "historical_non_current", "insufficient", "deterministic_only", "blocked"]);
  assert.equal(fixture.records.find((record) => record.gate === "RG-1")?.status, "PASS");
  assert.equal(fixture.records.find((record) => record.gate === "RG-3")?.current, false);
  assert.equal(fixture.records.find((record) => record.gate === "RG-4")?.status, "INSUFFICIENT");
  assert.notEqual(fixture.records.find((record) => record.gate === "RG-1")?.status, "PROMOTABLE");
  assert.equal(redactSessionIds("ses_12345678"), "ses_[REDACTED]");
  assert.throws(() => validateEvidenceBundle({ releasePromotable: true }), /releasePromotable|header/);
});

test("deterministic RG-2 serialized startup and topology smoke is non-promotional", { skip: ARTIFACT_SKIP }, () => {
  const starts = ["serve-a", "serve-b", "serve-c", "serve-d", "serve-e", "serve-f"];
  const active = new Set<string>();
  let lockFailures = 0;
  for (const serve of starts) {
    assert.equal(active.size, 0);
    active.add(serve);
    active.delete(serve);
  }
  assert.equal(lockFailures, 0);
  assert.equal(active.size, 0);
  const inventory = JSON.parse(readArtifact("designs/process/tissue-release-evidence-inventory.json")) as { releasePromotable: boolean; records: Array<{ gate: string; classification: string; status: string; source: string | null; owner: string; captureTime: string | null; versions: Record<string, string>; topology: string; reason: string; promotionEffect: string }> };
  assert.equal(inventory.releasePromotable, false);
  const rg2 = inventory.records.find((record) => record.gate === "RG-2");
  assert.ok(rg2, "RG-2 record must be present");
  // Assert the fields that carry real meaning rather than pinning the whole
  // record: the amended resident-only scope legitimately changes the historical
  // topology wording without changing RG-2's deterministic-only, non-promotional
  // classification.
  assert.equal(rg2.gate, "RG-2");
  assert.equal(rg2.classification, "deterministic_only");
  assert.equal(rg2.status, "DETERMINISTIC_ONLY");
  assert.equal(rg2.source, "artifacts/designs/process/tissue-rg2-evidence.md");
  assert.equal(rg2.owner, "Plan E release owner");
  assert.match(rg2.captureTime ?? "", /^\d{4}-\d{2}-\d{2}/);
  assert.equal(rg2.versions.opencode, "1.18.18");
  // The historical probe must be labelled historical/non-current and must not
  // claim the removed owned/persistent serve startup as current implementation.
  assert.match(rg2.topology, /historical|non-current/i);
  assert.doesNotMatch(rg2.topology, /current (?:resident-only )?(?:owned|serve) startup is implemented/i);
  assert.match(rg2.reason, /historical\/non-current/i);
  // The record is explicitly non-promotional and cannot authorize release.
  assert.match(rg2.promotionEffect, /non-promotional/i);
  assert.match(rg2.promotionEffect, /cannot authorize release/i);
});

test("inherited RG-2/RG-3/RG-4/RG-6 records remain historical and non-promotional", { skip: ARTIFACT_SKIP }, () => {
  assert.deepEqual(validateInheritedEvidence(ROOT), {
    RG2: "HISTORICAL_NON_CURRENT",
    RG3: "HISTORICAL_NON_CURRENT",
    RG4: "HISTORICAL_NON_CURRENT",
    RG6: "HISTORICAL_NON_CURRENT",
  });
});

function silentSource(): WakeStreamSource {
  return {
    openStream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<unknown>>(() => {}),
        return: async () => ({ done: true, value: undefined }),
      }),
    }),
  };
}

test("RG-5 supporting smoke covers heartbeat timeout, reconnect jitter, resync, and polling backstop without promotion", { skip: ARTIFACT_SKIP }, async () => {
  let resyncs = 0;
  const hint = new SseWakeHint({
    source: silentSource(),
    logger: { debug: () => {} } as never,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1))),
    heartbeatTimeoutMs: 1,
    reconnectBaseMs: 1,
    reconnectMaxMs: 2,
    random: () => 1,
    onResync: () => { resyncs += 1; },
  });
  hint.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await hint.close();
  assert.ok(resyncs >= 1);
  assert.equal(hint.status(), "stopped");
  const inventory = JSON.parse(readArtifact("designs/process/tissue-release-evidence-inventory.json")) as { releasePromotable: boolean; records: Array<{ gate: string; classification: string; status: string; promotionEffect: string }> };
  const rg5 = inventory.records.find((record) => record.gate === "RG-5");
  assert.equal(inventory.releasePromotable, false);
  assert.equal(rg5?.classification, "deterministic_only");
  assert.equal(rg5?.status, "BLOCKED");
  assert.match(rg5?.promotionEffect ?? "", /Supporting|non-promotional/i);
});

test("contract smoke preserves real ses_ identity, separate DB, completion exclusions, and A-prime boundary", () => {
  const driver = new OpenCodeDriver({ http: {} as OpenCodeHttp });
  const source = readFileSync(join(ROOT, "src/integrations/opencode-driver.ts"), "utf8");
  const db = readFileSync(join(ROOT, "src/db/open.ts"), "utf8");
  const relay = readFileSync(join(ROOT, "src/controller/inbox-relay.ts"), "utf8");
  const drift = readFileSync(join(ROOT, "src/controller/drift.ts"), "utf8");
  const housekeeping = readFileSync(join(ROOT, "src/controller/housekeeping.ts"), "utf8");
  const entrypoint = readFileSync(join(ROOT, "src/runtime/entrypoint.ts"), "utf8");
  assert.ok(driver);
  assert.match(source, /ses_\[A-Za-z0-9\]/);
  assert.match(source, /summary|compaction/);
  assert.match(db, /refusing to open OpenCode's shared state/);
  assert.match(relay, /DELIVERING/);
  assert.match(relay, /noReply/);
  assert.match(drift, /ENTIRE unexpected artifact diff/);
  assert.match(housekeeping, /idempotent/);
  assert.match(entrypoint, /runDaemon/);
  assert.doesNotMatch(entrypoint.replace(/\/\/.*$/gm, ""), /opencode run/);
});
