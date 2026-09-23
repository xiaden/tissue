// tests/integration/controller-triage.test.ts
//
// M4 triage orchestration against the abstract driver boundary: READY attachment
// + WorkItem creation only after READY (no-resolution-before-READY), duplicate
// grouping without creating a second resolution WorkItem, disposition validation,
// backoff ladder, three-failure PAUSED_TRIAGE escalation + explicit unpause, and
// bounded digest previews (no full untrusted body dumps).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createTestDb, seedRepository, seedIssue, type TestDb } from "../helpers/db.ts";
import type { ProvenanceEnvelope } from "../../src/controller/trust.ts";
import { ScriptedTriageDriver, readySuggestion, duplicateSuggestion } from "../helpers/session-driver.ts";
import {
  getIssueById,
  getRepositoryById,
  getWorkItem,
  insertWorkItem,
  insertInboxEvent,
  listWorkItemsByRepo,
  listInboxByWorkItem,
  listNullWorkItemInboxByIssue,
  activeIssueLinksForIssue,
  updateIssueState,
  updateTriageState,
} from "../../src/db/repositories.ts";
import {
  runTriageRepo,
  runTriagePass,
  unpauseTriage,
  buildTriageDigest,
  TITLE_PREVIEW_MAX,
  BODY_PREVIEW_MAX,
} from "../../src/controller/triage.ts";

const NOW = new Date("2026-09-09T12:00:00.000Z");

function makePending(db: TestDb["db"], issueId: string): void {
  updateIssueState(db, issueId, "TRIAGE_PENDING");
}

test("READY disposition attaches the issue, creates ONE resolution WorkItem (post-READY) and reparents inbox", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { number: 7, title: "feature x" });
    makePending(db, issue.id);
    // A NEW (not-yet-triaged) issue must never trigger resolution work.
    const unready = seedIssue(db, repo.id, { number: 99, title: "brand new" });
    const inboxId = insertInboxEvent(db, {
      issue_id: issue.id,
      event_key: `comment-${issue.number}-1`,
      kind: "comment",
      payload_json: "{}",
    });

    const driver = new ScriptedTriageDriver([readySuggestion(issue.id)]);
    const summary = await runTriageRepo(db, repo.id, driver, NOW);

    assert.equal(summary.ran, true);
    assert.equal(summary.outcome, "disposition_applied");
    assert.equal(summary.disposition, "READY");
    assert.equal(summary.createdWorkItemId, `wi-xiaden-nomarr-7`);

    // Issue is READY and attached to exactly one active resolution WorkItem.
    assert.equal(getIssueById(db, issue.id)!.state, "READY");
    const wi = getWorkItem(db, `wi-xiaden-nomarr-7`)!;
    assert.equal(wi.state, "READY");
    const links = activeIssueLinksForIssue(db, issue.id);
    assert.equal(links.length, 1);
    assert.equal(links[0]!.work_item_id, wi.id);

    // The pending (NULL-WorkItem) inbox event was re-parented onto the WorkItem.
    assert.equal(listNullWorkItemInboxByIssue(db, issue.id).length, 0);
    assert.ok(listInboxByWorkItem(db, wi.id).some((r) => r.id === inboxId));

    // Pump resets to IDLE with zero failures.
    assert.equal(getRepositoryById(db, repo.id)!.triage_state, "IDLE");
    assert.equal(getRepositoryById(db, repo.id)!.triage_failures, 0);

    // The NEW issue was left untouched — no work before it is even TRIAGE_PENDING.
    assert.equal(getIssueById(db, unready.id)!.state, "NEW");
    assert.equal(listWorkItemsByRepo(db, repo.id).length, 1);
  } finally {
    cleanup();
  }
});

test("issues that are not TRIAGE_PENDING are never due (no-resolution-before-READY)", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    seedIssue(db, repo.id, { number: 1, title: "still new" }); // state NEW
    const driver = new ScriptedTriageDriver();
    const summary = await runTriageRepo(db, repo.id, driver, NOW);
    assert.equal(summary.ran, false);
    assert.equal(summary.reason, "no_due");
    assert.equal(listWorkItemsByRepo(db, repo.id).length, 0, "no resolution work for a non-READY issue");
  } finally {
    cleanup();
  }
});

test("an invalid disposition is rejected, nothing is applied, and the pump backs off", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { number: 3, title: "tricky" });
    makePending(db, issue.id);
    const driver = new ScriptedTriageDriver([
      { issueId: issue.id, disposition: "HACKED" } as never,
    ]);
    const summary = await runTriageRepo(db, repo.id, driver, NOW);

    assert.equal(summary.outcome, "failure");
    assert.ok(summary.error!.includes("not a legal triage disposition"));
    assert.equal(getIssueById(db, issue.id)!.state, "TRIAGE_PENDING", "untrusted disposition never applied");
    const after = getRepositoryById(db, repo.id)!;
    assert.equal(after.triage_state, "BACKOFF");
    assert.equal(after.triage_failures, 1);
    assert.equal(listWorkItemsByRepo(db, repo.id).length, 0);
  } finally {
    cleanup();
  }
});

test("a suggestion referencing the wrong issue is rejected (no cross-issue apply)", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { number: 4, title: "real one" });
    makePending(db, issue.id);
    const other = seedIssue(db, repo.id, { number: 5, title: "other" });
    const driver = new ScriptedTriageDriver([readySuggestion(other.id)]);
    const summary = await runTriageRepo(db, repo.id, driver, NOW);
    assert.equal(summary.outcome, "failure");
    assert.equal(getIssueById(db, issue.id)!.state, "TRIAGE_PENDING");
  } finally {
    cleanup();
  }
});

test("duplicate discovery groups onto the canonical WorkItem without creating a second one", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const canonical = insertWorkItem(db, {
      id: "wi-canonical",
      repo_id: repo.id,
      state: "RUNNING",
      title: "root cause",
      base_branch: "main",
    });
    const dup = seedIssue(db, repo.id, { number: 8, title: "dup of canonical" });
    makePending(db, dup.id);

    const driver = new ScriptedTriageDriver([duplicateSuggestion(dup.id, canonical.id)]);
    const summary = await runTriageRepo(db, repo.id, driver, NOW);

    assert.equal(summary.outcome, "disposition_applied");
    assert.equal(summary.disposition, "DUPLICATE");
    assert.equal(getIssueById(db, dup.id)!.state, "DUPLICATE");

    // Grouped onto the canonical WI; no second WorkItem created.
    const links = activeIssueLinksForIssue(db, dup.id);
    assert.equal(links.length, 1);
    assert.equal(links[0]!.work_item_id, canonical.id);
    assert.equal(listWorkItemsByRepo(db, repo.id).length, 1);
  } finally {
    cleanup();
  }
});

test("backoff ladder gates flights, then three consecutive failures pause triage; unpause resets", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { number: 9, title: "will fail" });
    makePending(db, issue.id);
    const failing = new ScriptedTriageDriver(); // always throws (no outcomes)

    // Failure 1 -> BACKOFF.
    let summary = await runTriageRepo(db, repo.id, failing, NOW);
    assert.equal(summary.outcome, "failure");
    let after = getRepositoryById(db, repo.id)!;
    assert.equal(after.triage_state, "BACKOFF");
    assert.equal(after.triage_failures, 1);
    assert.ok(after.triage_next_attempt_at && after.triage_next_attempt_at > NOW.toISOString());

    // Still inside the backoff window: no flight, driver untouched.
    const promptedBefore = failing.promptCalls.length;
    summary = await runTriageRepo(db, repo.id, failing, NOW);
    assert.equal(summary.ran, false);
    assert.equal(summary.reason, "backoff");
    assert.equal(failing.promptCalls.length, promptedBefore);

    // Expire the window, fail twice more -> PAUSED_TRIAGE.
    expireBackoff(db, repo.id);
    summary = await runTriageRepo(db, repo.id, failing, NOW);
    assert.equal(summary.outcome, "failure");
    after = getRepositoryById(db, repo.id)!;
    assert.equal(after.triage_failures, 2);
    assert.equal(after.triage_state, "BACKOFF");

    expireBackoff(db, repo.id);
    summary = await runTriageRepo(db, repo.id, failing, NOW);
    assert.equal(summary.outcome, "failure");
    after = getRepositoryById(db, repo.id)!;
    assert.equal(after.triage_failures, 3);
    assert.equal(after.triage_state, "PAUSED_TRIAGE");

    // Paused: further passes are no-ops and the issue remains TRIAGE_PENDING.
    summary = await runTriageRepo(db, repo.id, failing, NOW);
    assert.equal(summary.ran, false);
    assert.equal(summary.reason, "paused");
    assert.equal(getIssueById(db, issue.id)!.state, "TRIAGE_PENDING");

    // Explicit unpause resets failures and window.
    assert.equal(unpauseTriage(db, repo.id, NOW), true);
    after = getRepositoryById(db, repo.id)!;
    assert.equal(after.triage_state, "IDLE");
    assert.equal(after.triage_failures, 0);
    assert.equal(after.triage_next_attempt_at, null);

    // A healthy driver can now triage the issue.
    const healthy = new ScriptedTriageDriver([readySuggestion(issue.id)]);
    summary = await runTriageRepo(db, repo.id, healthy, NOW);
    assert.equal(summary.outcome, "disposition_applied");
    assert.equal(getIssueById(db, issue.id)!.state, "READY");
  } finally {
    cleanup();
  }
});

test("runTriagePass runs one flight per enabled repo and creates one triage session each", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repoA = seedRepository(db, { owner: "xiaden", name: "repoa" });
    const repoB = seedRepository(db, { owner: "xiaden", name: "repob" });
    const aIssue = seedIssue(db, repoA.id, { number: 1, title: "a" });
    const bIssue = seedIssue(db, repoB.id, { number: 1, title: "b" });
    makePending(db, aIssue.id);
    makePending(db, bIssue.id);

    const driver = new ScriptedTriageDriver([readySuggestion(aIssue.id), readySuggestion(bIssue.id)]);
    const summaries = await runTriagePass(db, [repoA, repoB], driver, NOW);

    assert.equal(summaries.length, 2);
    assert.deepEqual(summaries.map((s) => s.ran), [true, true]);
    assert.equal(driver.ensureCalls.length, 2, "one triage session per enabled repo");
  } finally {
    cleanup();
  }
});

test("triage digest counts AWAITING_DECISION as active and DEFERRED as capacity-exempt", () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = getRepositoryById(db, seedRepository(db).id)!;
    const issue = seedIssue(db, repo.id, { number: 12, state: "TRIAGE_PENDING" });
    insertWorkItem(db, { id: "wi-awaiting-decision", repo_id: repo.id, state: "AWAITING_DECISION", base_branch: "main" });
    insertWorkItem(db, { id: "wi-deferred", repo_id: repo.id, state: "DEFERRED", base_branch: "main" });
    const digest = buildTriageDigest(db, repo, issue);
    assert.equal(digest.repoCounts.running, 1);
  } finally {
    cleanup();
  }
});

function provenance(rawLogin: string | null): ProvenanceEnvelope {
  return {
    repository: "xiaden/nomarr",
    sourceKind: "issue",
    objectId: "11",
    contentId: null,
    observedVersion: "v1",
    contentHash: "hash",
    authoritativeAt: "2026-09-09T00:00:00.000Z",
    policyRevision: "fixture",
    actor: {
      present: rawLogin !== null,
      rawLogin,
      normalizedLogin: rawLogin?.toLowerCase() ?? null,
      presence: rawLogin === null ? "MISSING" : "PRESENT",
    },
    decision: "TRUSTED",
    reason: "fixture",
    deliveryClass: "TRUSTED_PROSE",
  };
}

test("triage digest filters trusted, untrusted, and missing author prose while preserving objective fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "tissue-triage-provenance-"));
  const configPath = join(directory, "tissue.yml");
  writeFileSync(configPath, "security:\n  trustedGithubUsers: [TrustedUser]\n");
  const { db, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db);
    const trusted = seedIssue(db, repo.id, { number: 21, title: "trusted-title", body_json: JSON.stringify("trusted-body"), envelope: provenance("TrustedUser") });
    const denied = seedIssue(db, repo.id, { number: 22, title: "denied-title", body_json: JSON.stringify("denied-body"), envelope: provenance("Mallory") });
    const missing = seedIssue(db, repo.id, { number: 23, title: "missing-title", body_json: JSON.stringify("missing-body"), envelope: null });

    const trustedDigest = buildTriageDigest(db, repo, trusted, configPath);
    const deniedDigest = buildTriageDigest(db, repo, denied, configPath);
    const missingDigest = buildTriageDigest(db, repo, missing, configPath);

    assert.equal(trustedDigest.titlePreview, "trusted-title");
    assert.equal(trustedDigest.bodyPreview, "trusted-body");
    for (const digest of [deniedDigest, missingDigest]) {
      assert.equal(digest.titlePreview, "");
      assert.equal(digest.bodyPreview, "");
      assert.equal(digest.repoId, repo.id);
      assert.equal(typeof digest.issueNumber, "number");
    }
    assert.equal(deniedDigest.issueNumber, 22);
    assert.equal(missingDigest.issueNumber, 23);
  } finally {
    cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("triage digest re-evaluates changed config after ingestion without repolling", () => {
  const directory = mkdtempSync(join(tmpdir(), "tissue-triage-config-"));
  const configPath = join(directory, "tissue.yml");
  const { db, cleanup } = createTestDb();
  try {
    writeFileSync(configPath, "security:\n  trustedGithubUsers: [TrustedUser]\n");
    const repo = seedRepository(db);
    const issue = seedIssue(db, repo.id, { number: 24, title: "config-sensitive-title", body_json: JSON.stringify("config-sensitive-body"), envelope: provenance("TrustedUser") });
    const delivered = buildTriageDigest(db, repo, issue, configPath);
    assert.equal(delivered.titlePreview, "config-sensitive-title");
    assert.equal(delivered.bodyPreview, "config-sensitive-body");

    writeFileSync(configPath, "security:\n  trustedGithubUsers: [DifferentUser]\n");
    const omitted = buildTriageDigest(db, repo, issue, configPath);
    assert.equal(omitted.titlePreview, "");
    assert.equal(omitted.bodyPreview, "");
    assert.equal(omitted.issueId, issue.id);
    assert.equal(omitted.issueNumber, 24);
    assert.equal(omitted.repoCounts.open, 1);
  } finally {
    cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("triage digest is bounded (no full untrusted body dumps)", async () => {
  const { db, cleanup } = createTestDb();
  try {
    const repo = getRepositoryById(db, seedRepository(db).id)!;
    const longTitle = "x".repeat(10_000);
    const longBody = "y".repeat(10_000);
    const issue = seedIssue(db, repo.id, {
      number: 11,
      title: longTitle,
      body_json: JSON.stringify(longBody),
      state: "TRIAGE_PENDING",
    });
    const digest = buildTriageDigest(db, repo, issue);
    assert.ok(digest.titlePreview.length <= TITLE_PREVIEW_MAX + 1, "title preview must be truncated");
    assert.ok(digest.bodyPreview.length <= BODY_PREVIEW_MAX + 1, "body preview must be truncated");
    assert.ok(!digest.bodyPreview.includes(longBody.slice(0, 5000)), "no full body leaked into digest");
  } finally {
    cleanup();
  }
});

function expireBackoff(db: TestDb["db"], repoId: string): void {
  updateTriageState(db, repoId, { nextAttemptAt: "2020-01-01T00:00:00.000Z" });
}
