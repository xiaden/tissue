// tests/unit/gh-client.test.ts
//
// P1-S1: the M5 identifier-safe GitHub client. These tests exercise the client
// against an executable FAKE gh (tests/helpers/fake-gh.ts) through the same
// typed-argv spawn path used in production, so argv/security invariants hold for
// real while no GitHub network or credential is touched. Includes pure-unit
// tests for classification, redaction, and branch-shape guards.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GhClient,
  GhArgError,
  GhError,
  argvIssueComment,
  argvIssueList,
  argvPrList,
  argvPrReviews,
  assertControllerBranch,
  classifyGhFailure,
  parseGhVersion,
  redactGhText,
} from "../../src/integrations/gh-client.ts";
import { writeFakeGh, defaultNomarrMeta } from "../helpers/fake-gh.ts";

const PROTECTION_PATH = "repos/xiaden/nomarr/branches/main/protection";

test("constructor rejects a non-absolute binary (PATH shim guard)", () => {
  assert.throws(() => new GhClient({ binary: "gh" }), GhError);
  assert.throws(() => new GhClient({ binary: "bin/gh" }), GhError);
  // Absolute paths are accepted.
  const c = new GhClient({ binary: "/usr/bin/gh" });
  assert.equal(c.binary, "/usr/bin/gh");
});

test("validate() reads version + auth from the verified binary", async () => {
  const fg = writeFakeGh({ meta: defaultNomarrMeta() });
  try {
    const gh = new GhClient({ binary: fg.binary });
    const v = await gh.validate();
    assert.equal(v.versionOk, true);
    assert.match(v.version, /gh version \d+\.\d+\.\d+/);
    assert.equal(v.authenticated, true);
    assert.equal(v.account, "xiaden");
  } finally {
    fg.cleanup();
  }
});

test("validate() surfaces missing auth — never silently healthy", async () => {
  const fg = writeFakeGh({ auth: false, meta: defaultNomarrMeta() });
  try {
    const gh = new GhClient({ binary: fg.binary });
    const v = await gh.validate();
    assert.equal(v.authenticated, false);
    assert.equal(v.account, undefined);
  } finally {
    fg.cleanup();
  }
});

test("parseGhVersion handles gh security-release version strings", () => {
  assert.deepEqual(parseGhVersion("gh version 2.98.0 (2026-08-20)"), {
    major: 2,
    minor: 98,
    patch: 0,
  });
  assert.equal(parseGhVersion("not a version"), null);
});

test("classifyGhFailure maps rate-limit / auth / not-found / other", () => {
  assert.equal(classifyGhFailure(1, "", "API rate limit exceeded for 1.2.3.4"), "rate_limited");
  assert.equal(classifyGhFailure(1, "", "Bad credentials (HTTP 401)"), "auth");
  assert.equal(classifyGhFailure(1, "", "HTTP 404: Not Found"), "not_found");
  assert.equal(classifyGhFailure(1, "", "something else"), "unknown");
});

test("redactGhText masks token shapes and embedded url credentials", () => {
  const out = redactGhText("push https://ghp_abcdefghijklmnop:pass@github.com/x/y; gho_ABCDEFGHIJKL");
  assert.ok(!/gh[ousr]_[A-Za-z0-9]/.test(out), "no gh_ token shape should survive");
  assert.ok(!/ghp_abcdefghijklmnop/.test(out), "the secret value must not appear");
  assert.ok(out.includes("[REDACTED]"));
});

test("repoMeta decodes default branch / issues-enabled / permissions", async () => {
  const fg = writeFakeGh({ meta: defaultNomarrMeta() });
  try {
    const gh = new GhClient({ binary: fg.binary });
    const meta = await gh.repoMeta({ owner: "xiaden", name: "nomarr" });
    assert.equal(meta.defaultBranch, "main");
    assert.equal(meta.issuesEnabled, true);
    assert.equal(meta.permissions?.push, true);
  } finally {
    fg.cleanup();
  }
});

test("repoMeta surfaces issues-disabled as false (never silently healthy)", async () => {
  const fg = writeFakeGh({
    meta: {
      "repos/xiaden/nomarr": { default_branch: "main", has_issues: false, permissions: { admin: true, push: true, pull: true } },
    },
  });
  try {
    const gh = new GhClient({ binary: fg.binary });
    const meta = await gh.repoMeta({ owner: "xiaden", name: "nomarr" });
    assert.equal(meta.issuesEnabled, false);
  } finally {
    fg.cleanup();
  }
});

test("protection(): 404 (unprotected) surfaces enabled:false; protected returns reviews/checks", async () => {
  const open = writeFakeGh({ meta: defaultNomarrMeta() });
  const fg = writeFakeGh({
    meta: defaultNomarrMeta(),
    protection: {
      [PROTECTION_PATH]: {
        required_pull_request_reviews: { required_approving_review_count: 1 },
        enforce_admins: { enabled: true },
        required_status_checks: { contexts: ["ci"] },
      },
    },
  });
  try {
    const ghOpen = new GhClient({ binary: open.binary });
    const pOpen = await ghOpen.protection({ owner: "xiaden", name: "nomarr", branch: "main" });
    assert.equal(pOpen.enabled, false);

    const gh = new GhClient({ binary: fg.binary });
    const p = await gh.protection({ owner: "xiaden", name: "nomarr", branch: "main" });
    assert.equal(p.enabled, true);
    assert.equal(p.requiredApprovals, 1);
    assert.equal(p.enforceAdmins, true);
    assert.deepEqual(p.requiredChecks, ["ci"]);
  } finally {
    open.cleanup();
    fg.cleanup();
  }
});

test("effect body is delivered verbatim via stdin — never interpolated into argv", async () => {
  const fg = writeFakeGh({ meta: defaultNomarrMeta() });
  try {
    const gh = new GhClient({ binary: fg.binary });
    const marker = join(tmpdir(), `tissue-pwned-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
    try {
      rmSync(marker, { force: true });
    } catch {
      /* ignore */
    }
    const hostile = `$(id); \`rm -rf /\`; && touch ${marker}
second line with a token gho_ABCDEFGHIJKLMNOP but not executed`;
    await gh.run(argvIssueComment("xiaden", "nomarr", 42), { stdinData: hostile });
    const log = JSON.parse(readFileSync(fg.effectLogPath, "utf8"));
    assert.equal(log.length, 1);
    assert.equal(log[0].kind, "issue.comment");
    assert.equal(log[0].slug, "xiaden/nomarr");
    assert.equal(log[0].number, 42);
    assert.equal(log[0].body, hostile);
    assert.equal(existsSync(marker), false, "shell metachars must never be executed");
  } finally {
    fg.cleanup();
  }
});

test("supported projection argv includes bounded actor/version fields", () => {
  const issue = argvIssueList({ owner: "xiaden", name: "nomarr", state: "open", limit: 50 });
  const prs = argvPrList({ owner: "xiaden", name: "nomarr", state: "all", limit: 50 });
  const reviews = argvPrReviews("xiaden", "nomarr", 7);
  assert.match(issue.at(-1) ?? "", /author/);
  assert.match(prs.at(-1) ?? "", /author/);
  assert.deepEqual(reviews.slice(-2), ["--json", "number,reviews"]);
});

test("issue list/view/close argv are typed and identifier-safe", () => {
  const list = argvIssueList({ owner: "xiaden", name: "nomarr", state: "open", limit: 50 });
  assert.deepEqual(list.slice(0, 2), ["issue", "list"]);
  assert.ok(list.includes("xiaden/nomarr"));
  assert.ok(!list.some((a) => /[\s;|$`]/.test(a)), "no arg may carry shell metacharacters");
  assert.throws(() => argvIssueList({ owner: "xiaden", name: "nomarr", state: "open", limit: 0 }), GhArgError);
});

test("assertControllerBranch only admits tissue/wi_<opaque-id> shapes", () => {
  assert.equal(assertControllerBranch("tissue/wi_wi-xiaden-nomarr-3"), "tissue/wi_wi-xiaden-nomarr-3");
  assert.throws(() => assertControllerBranch("tissue/other"), GhArgError);
  assert.throws(() => assertControllerBranch("feature/foo"), GhArgError);
  assert.throws(() => assertControllerBranch("tissue/wi_x; rm -rf /"), GhArgError);
});
