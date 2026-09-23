import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTrustedGithubPolicy,
  decideCurrentGithubProse,
  decideGithubActor,
  normalizeGithubLogin,
  type ActorObservation,
} from "../../src/controller/trust.ts";

const actor = (rawLogin: string | null, presence: ActorObservation["presence"] = "PRESENT"): ActorObservation => ({
  present: rawLogin !== null,
  rawLogin,
  normalizedLogin: rawLogin === null ? null : normalizeGithubLogin(rawLogin),
  presence,
});

test("normalizes ASCII case only and rejects ambiguous or padded logins", () => {
  assert.equal(normalizeGithubLogin("Alice-Bot"), "alice-bot");
  assert.equal(normalizeGithubLogin(" alice"), null);
  assert.equal(normalizeGithubLogin("alice "), null);
  assert.equal(normalizeGithubLogin("alice\u0000"), null);
  assert.equal(normalizeGithubLogin("Ａlice"), null);
  assert.equal(normalizeGithubLogin(""), null);
  assert.equal(normalizeGithubLogin("a".repeat(40)), null);
});

test("deduplicates normalized policy entries and computes deterministic revision", () => {
  const first = createTrustedGithubPolicy({ security: { trustedGithubUsers: ["Alice", "alice"] } });
  const second = createTrustedGithubPolicy({ security: { trustedGithubUsers: ["alice"] } });
  assert.equal(first.usable, true);
  assert.deepEqual([...first.normalizedUsers], ["alice"]);
  assert.equal(first.revision, second.revision);
});

test("policy membership cannot be mutated externally", () => {
  const policy = createTrustedGithubPolicy({ security: { trustedGithubUsers: ["Alice"] } });
  const originalRevision = policy.revision;

  assert.equal(policy.normalizedUsers.has("alice"), true);
  assert.throws(() => (policy.normalizedUsers as Set<string>).add("mallory"), /immutable/);
  assert.throws(() => (policy.normalizedUsers as Set<string>).delete("alice"), /immutable/);
  assert.throws(() => (policy.normalizedUsers as Set<string>).clear(), /immutable/);

  assert.equal(policy.normalizedUsers.has("alice"), true);
  assert.equal(policy.normalizedUsers.has("mallory"), false);
  assert.equal(policy.revision, originalRevision);
  assert.equal(decideGithubActor(policy, actor("Alice")).decision, "TRUSTED");
  assert.equal(decideGithubActor(policy, actor("mallory")).decision, "UNTRUSTED");
});

test("fails closed for missing, empty, or malformed policy", () => {
  for (const policy of [null, undefined, {}, { security: { trustedGithubUsers: [] } }, { security: { trustedGithubUsers: ["bad user"] } }]) {
    const parsed = createTrustedGithubPolicy(policy as never);
    assert.equal(decideGithubActor(parsed, actor("alice")).decision, "CONFIG_UNUSABLE");
  }
});

test("loads current config for each prose decision and fails closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "tissue-trust-"));
  const configPath = join(directory, "tissue.yml");
  try {
    writeFileSync(configPath, "security:\n  trustedGithubUsers: [Alice]\n");
    assert.equal(decideCurrentGithubProse("alice", configPath), "TRUSTED");
    assert.equal(decideCurrentGithubProse("mallory", configPath), "DENIED");
    writeFileSync(configPath, "security:\n  trustedGithubUsers: [Mallory]\n");
    assert.equal(decideCurrentGithubProse("alice", configPath), "DENIED");
    assert.equal(decideCurrentGithubProse("mallory", configPath), "TRUSTED");
    assert.equal(decideCurrentGithubProse(" alice", configPath), "DENIED");
    assert.equal(decideCurrentGithubProse(null, configPath), "DENIED");
    assert.equal(decideCurrentGithubProse("mallory", join(directory, "missing.yml")), "DENIED");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("distinguishes missing, unknown, malformed, trusted, and untrusted actors", () => {
  const policy = createTrustedGithubPolicy({ security: { trustedGithubUsers: ["Alice"] } });
  assert.equal(decideGithubActor(policy, actor(null, "MISSING")).decision, "MISSING_ACTOR");
  assert.equal(decideGithubActor(policy, actor("Alice", "UNKNOWN")).decision, "UNKNOWN_ACTOR");
  assert.equal(decideGithubActor(policy, actor("Alice", "MALFORMED")).decision, "MALFORMED_ACTOR");
  assert.equal(decideGithubActor(policy, actor("ALICE")).decision, "TRUSTED");
  assert.equal(decideGithubActor(policy, actor("mallory")).decision, "UNTRUSTED");
  assert.equal(decideGithubActor(policy, actor("mallory")).deliveryClass, "DENIED_PROSE");
});
