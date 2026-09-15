// tests/unit/config.test.ts
//
// P1-S2 spec-first config contract tests: scalar YAML repository/poll/limit/
// baseline/base-branch/labels/auto-merge/priority/model/retention fields are
// loaded; secrets and policy DSL are rejected; defaults are applied.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig, loadConfig, ConfigError } from "../../src/config/load.ts";
import {
  DEFAULT_MAX_CONCURRENT_GLOBAL,
  DEFAULT_MAX_CONCURRENT_PER_REPO,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_BASE_BRANCH,
} from "../../src/config/types.ts";

const VALID = `
pollIntervalSeconds: 240
maxConcurrentGlobal: 2
retentionDays: 30
agents:
  triage:
    agent: tissue-triage
repos:
  - owner: acme
    name: widgets
    remote: https://github.com/acme/widgets.git
    localDir: /srv/acme/widgets
    enabled: true
    pollIntervalSeconds: 120
    maxConcurrentPerRepo: 1
    baseBranch: main
    labels: [maintenance]
    autoMerge: false
    priority: 5
    baselineBefore: '2026-09-01T00:00:00Z'
`;

test("parses a fully-specified valid config with expected structure", () => {
  const cfg = parseConfig(VALID, "valid.yml");
  assert.equal(cfg.pollIntervalSeconds, 240);
  assert.equal(cfg.maxConcurrentGlobal, 2);
  assert.equal(cfg.retentionDays, 30);
  assert.equal(cfg.agents.triage?.agent, "tissue-triage");
  // The dedicated resolution identity is defaulted (not omitted): enabled
  // production work never falls back to the resident OpenCode default agent.
  assert.equal(cfg.agents.resolution?.agent, "tissue-resolve");
  assert.equal(cfg.agents.triage?.model, undefined);
  assert.equal(cfg.agents.resolution?.model, undefined);
  assert.equal(cfg.repos.length, 1);
  const r = cfg.repos[0]!;
  assert.equal(r.owner, "acme");
  assert.equal(r.name, "widgets");
  assert.equal(r.remote, "https://github.com/acme/widgets.git");
  assert.equal(r.localDir, "/srv/acme/widgets");
  assert.equal(r.enabled, true);
  assert.equal(r.pollIntervalSeconds, 120);
  assert.equal(r.maxConcurrentPerRepo, 1);
  assert.equal(r.baseBranch, "main");
  assert.deepEqual(r.labels, ["maintenance"]);
  assert.equal(r.autoMerge, false);
  assert.equal(r.priority, 5);
  assert.equal(r.baselineBefore, "2026-09-01T00:00:00Z");
});

test("applies defaults when only owner/name/local paths are given", () => {
  const cfg = parseConfig(`
repos:
  - owner: acme
    name: widgets
    localDir: /srv/acme/widgets
`, "min.yml");
  const r = cfg.repos[0]!;
  assert.equal(r.enabled, true);
  assert.equal(r.pollIntervalSeconds, cfg.pollIntervalSeconds);
  assert.equal(r.maxConcurrentPerRepo, DEFAULT_MAX_CONCURRENT_PER_REPO);
  assert.equal(r.baseBranch, DEFAULT_BASE_BRANCH);
  assert.deepEqual(r.labels, []);
  assert.equal(r.autoMerge, false);
  assert.equal(r.priority, 0);
  assert.equal(r.remote, undefined);
});

test("empty config (no repos) applies top-level defaults", () => {
  const cfg = parseConfig("repos: []\n", "empty.yml");
  assert.equal(cfg.maxConcurrentGlobal, DEFAULT_MAX_CONCURRENT_GLOBAL);
  assert.equal(cfg.pollIntervalSeconds, DEFAULT_POLL_INTERVAL_SECONDS);
  assert.equal(cfg.retentionDays, DEFAULT_RETENTION_DAYS);
  assert.deepEqual(cfg.repos, []);
});

test("loadConfig reads a YAML file from disk and rejects a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tissue-cfg-"));
  const file = join(dir, "tissue.yml");
  try {
    writeFileSync(file, VALID, "utf8");
    const cfg = loadConfig(file);
    assert.equal(cfg.repos.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => loadConfig(join(dir, "nope.yml")), ConfigError);
});

test("defaults both dedicated Tissue agent identities and rejects a divergent agent", () => {
  // Omission means the dedicated Tissue agent, never the resident default.
  const omitted = parseConfig("repos: []\n", "agents-omitted.yml");
  assert.equal(omitted.agents.triage?.agent, "tissue-triage");
  assert.equal(omitted.agents.resolution?.agent, "tissue-resolve");
  assert.equal(omitted.agents.triage?.model, undefined, "model stays an optional T8 (f) choice");
  assert.equal(omitted.agents.resolution?.model, undefined);

  // An explicitly divergent agent identity is refused outright.
  assert.throws(
    () => parseConfig("agents:\n  triage:\n    agent: nyx\nrepos: []\n", "agents-divergent.yml"),
    (e: unknown) => e instanceof ConfigError && /never falls back/.test(e.message),
  );
  assert.throws(
    () => parseConfig("agents:\n  resolution:\n    agent: build\nrepos: []\n", "agents-divergent2.yml"),
    (e: unknown) => e instanceof ConfigError && /tissue-resolve/.test(e.message),
  );

  // Explicitly naming the required identity is accepted.
  const explicit = parseConfig("agents:\n  triage:\n    agent: tissue-triage\n    model: anthropic/claude-3-5-sonnet\nrepos: []\n", "agents-explicit.yml");
  assert.equal(explicit.agents.triage?.agent, "tissue-triage");
  assert.equal(explicit.agents.triage?.model, "anthropic/claude-3-5-sonnet");
});

test("rejects a top-level policy-DSL key", () => {
  assert.throws(
    () => parseConfig("repos: []\npolicy:\n  rules: [x]\n", "p.yml"),
    (e: unknown) => e instanceof ConfigError && /unknown key/.test(e.message),
  );
});

test("rejects an unknown/DSL key inside a repository entry", () => {
  assert.throws(
    () => parseConfig("repos:\n  - owner: acme\n    name: w\n    localDir: /a\n    rules: {when: 'x'}\n"),
    (e: unknown) => e instanceof ConfigError && /rules/.test(e.message),
  );
});

test("rejects secret-like keys at any depth", () => {
  assert.throws(() => parseConfig("password: hunter2\nrepos: []\n"), ConfigError);
  assert.throws(
    () => parseConfig("repos:\n  - owner: acme\n    name: w\n    localDir: /a\n    token: abc\n"),
    (e: unknown) => e instanceof ConfigError && /token/.test(e.message),
  );
});

test("rejects a remote that embeds credentials", () => {
  assert.throws(
    () => parseConfig("repos:\n  - owner: acme\n    name: w\n    remote: https://user:pass@github.com/acme/w.git\n    localDir: /a\n"),
    (e: unknown) => e instanceof ConfigError && /credential/i.test(e.message),
  );
});

test("rejects credential-shaped token values embedded in an allowed field", () => {
  // A GitHub-token-shaped segment smuggled into the (otherwise allowed) remote
  // URL must be rejected as credential material, not accepted.
  assert.throws(
    () =>
      parseConfig(
        "repos:\n  - owner: acme\n    name: w\n    remote: https://github.com/acme/gho_" +
          "x".repeat(25) +
          ".git\n    localDir: /a\n",
      ),
    (e: unknown) => e instanceof ConfigError && /credential/i.test(e.message),
  );
});

test("rejects unsafe repository identity (shell/path metacharacters)", () => {
  assert.throws(
    () => parseConfig("repos:\n  - owner: 'acme; rm -rf /'\n    name: w\n    localDir: /a\n"),
    (e: unknown) => e instanceof ConfigError && /owner/.test(e.message),
  );
  assert.throws(
    () => parseConfig("repos:\n  - owner: acme\n    name: 'w/../x'\n    localDir: /a\n"),
    (e: unknown) => e instanceof ConfigError && /name/.test(e.message),
  );
});

test("rejects non-absolute or control-character paths", () => {
  assert.throws(
    () => parseConfig("repos:\n  - owner: acme\n    name: w\n    localDir: relative\n"),
    (e: unknown) => e instanceof ConfigError && /absolute/.test(e.message),
  );
  assert.throws(
    () => parseConfig("repos:\n  - owner: acme\n    name: w\n    localDir: /a\u0000b\n"),
    ConfigError,
  );
});

test("rejects out-of-range limits and invalid baseline", () => {
  assert.throws(() => parseConfig("maxConcurrentGlobal: 0\nrepos: []\n"), ConfigError);
  assert.throws(() => parseConfig("pollIntervalSeconds: 5\nrepos: []\n"), ConfigError);
  assert.throws(() => parseConfig("repos:\n  - owner: a\n    name: w\n    localDir: /x\n    baselineBefore: 'not-a-date'\n"), ConfigError);
});

test("rejects invalid YAML", () => {
  assert.throws(() => parseConfig("repos: [unclosed\n", "bad.yml"), ConfigError);
});
