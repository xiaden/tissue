import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTrustedGithubPolicy,
  decideCurrentGithubProse,
  normalizeGithubLogin,
} from "../../src/controller/trust.ts";

test("normalizes ASCII case only and rejects ambiguous or padded logins", () => {
  assert.equal(normalizeGithubLogin("Alice-Bot"), "alice-bot");
  assert.equal(normalizeGithubLogin(" alice"), null);
  assert.equal(normalizeGithubLogin("alice "), null);
  assert.equal(normalizeGithubLogin("alice\u0000"), null);
  assert.equal(normalizeGithubLogin("Ａlice"), null);
  assert.equal(normalizeGithubLogin(""), null);
  assert.equal(normalizeGithubLogin("a".repeat(40)), null);
});

test("deduplicates and sorts normalized policy entries", () => {
  const first = createTrustedGithubPolicy({ security: { trustedGithubUsers: ["Alice", "alice"] } });
  const second = createTrustedGithubPolicy({ security: { trustedGithubUsers: ["alice"] } });
  assert.equal(first.usable, true);
  assert.deepEqual([...first.normalizedUsers], ["alice"]);
  assert.deepEqual([...second.normalizedUsers], ["alice"]);
});

test("policy membership cannot be mutated externally", () => {
  const policy = createTrustedGithubPolicy({ security: { trustedGithubUsers: ["Alice"] } });

  assert.equal(policy.normalizedUsers.has("alice"), true);
  assert.throws(() => (policy.normalizedUsers as Set<string>).add("mallory"), /immutable/);
  assert.throws(() => (policy.normalizedUsers as Set<string>).delete("alice"), /immutable/);
  assert.throws(() => (policy.normalizedUsers as Set<string>).clear(), /immutable/);

  assert.equal(policy.normalizedUsers.has("alice"), true);
  assert.equal(policy.normalizedUsers.has("mallory"), false);
});

test("fails closed for missing, empty, or malformed policy", () => {
  for (const config of [null, undefined, {}, { security: { trustedGithubUsers: [] } }, { security: { trustedGithubUsers: ["bad user"] } }]) {
    const parsed = createTrustedGithubPolicy(config as never);
    assert.equal(parsed.usable, false);
    assert.equal(parsed.normalizedUsers.size, 0);
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
