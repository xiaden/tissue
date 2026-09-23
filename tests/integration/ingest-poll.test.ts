// tests/integration/ingest-poll.test.ts
//
// P2-S1 spec-first tests: level-triggered polling + ONE-transaction ingest.
// Covers snapshot commit atomicity, watermark, snapshot_hash change suppression,
// event_key dedup, NULL-WorkItem inbox rows re-parented by Issue id, the L1
// terminal-action guard (BASELINE_EXCLUDED housekeeping vs R14 enqueue), baseline
// exclusion, and transactional outbox idempotency.

import test from "node:test";
import assert from "node:assert/strict";

import { GhClient } from "../../src/integrations/gh-client.ts";
import { pollRepository, snapshotHash, type GhSnapshot } from "../../src/controller/poll.ts";
import { ingestRepositorySnapshot } from "../../src/controller/ingest.ts";
import { createTrustedGithubPolicy } from "../../src/controller/trust.ts";
import { enqueueIssue } from "../../src/controller/enqueue.ts";
import {
  envelopeForRow,
  getInboxById,
  getIssueByRepoNumber,
  getPollWatermark,
  getSideEffectFull,
  attachIssueToWorkItem,
  insertInboxEvent,
  insertWorkItem,
  listInboxByWorkItem,
  listNullWorkItemInboxByIssue,
  reparentInboxByIssue,
  housekeepTerminalUnattachedInbox,
  setWorkItemState,
} from "../../src/db/repositories.ts";
import { createTestDb, seedIssue, seedRepository } from "../helpers/db.ts";
import { writeFakeGh, defaultNomarrMeta } from "../helpers/fake-gh.ts";

const REPO_ID = "xiaden/nomarr";
const BASELINE = "2026-09-01T00:00:00.000Z";

function snapshot(overrides: Partial<GhSnapshot> = {}): GhSnapshot {
  const collectedAt = overrides.collectedAt ?? "2026-09-10T00:00:00.000Z";
  return {
    repoId: REPO_ID,
    owner: "xiaden",
    name: "nomarr",
    baselineAt: BASELINE,
    cursor: null,
    watermark: collectedAt,
    collectedAt,
    issues: [],
    pullRequests: [],
    checks: [],
    reviews: [],
    conflicts: [],
    comments: [],
    ...overrides,
  };
}

function issue(number: number, createdAt: string, title = `issue ${number}`) {
  return {
    number,
    title,
    state: "OPEN",
    updatedAt: createdAt,
    createdAt,
    labels: [] as string[],
    snapshotHash: snapshotHash({ number, title, createdAt }),
  };
}

test("ingest commits a post-baseline issue as TRIAGE_PENDING with a NULL-WorkItem inbox row and watermark", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const res = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [issue(7, "2026-09-09T00:00:00.000Z")] }),
    );

    assert.equal(res.issuesNew, 1);
    assert.equal(res.inboxInserted, 1);
    const stored = getIssueByRepoNumber(t.db, repo.id, 7);
    assert.equal(stored?.state, "TRIAGE_PENDING");
    assert.ok(stored?.snapshot_hash);

    const rows = listNullWorkItemInboxByIssue(t.db, `issue-${repo.id}-7`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, "issue_discovered");
    assert.equal(rows[0]?.state, "PENDING");
    assert.equal(getPollWatermark(t.db, "xiaden", "nomarr"), "2026-09-10T00:00:00.000Z");
  } finally {
    t.cleanup();
  }
});

test("baseline history is BASELINE_EXCLUDED and never emits an inbox event", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const res = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [issue(1, "2026-08-01T00:00:00.000Z")] }),
    );
    assert.equal(res.issuesExcludedBaseline, 1);
    assert.equal(res.inboxInserted, 0);
    const stored = getIssueByRepoNumber(t.db, repo.id, 1);
    assert.equal(stored?.state, "BASELINE_EXCLUDED");
    assert.equal(listNullWorkItemInboxByIssue(t.db, `issue-${repo.id}-1`).length, 0);
  } finally {
    t.cleanup();
  }
});

test("re-ingesting an unchanged snapshot is a no-op (snapshot_hash + event_key dedup)", () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    const s = snapshot({ issues: [issue(7, "2026-09-09T00:00:00.000Z")] });
    const first = ingestRepositorySnapshot(t.db, s);
    assert.equal(first.issuesNew, 1);
    assert.equal(first.inboxInserted, 1);

    const second = ingestRepositorySnapshot(t.db, { ...s, collectedAt: "2026-09-10T01:00:00.000Z", watermark: "2026-09-10T01:00:00.000Z" });
    assert.equal(second.issuesChanged, 0);
    assert.equal(second.inboxInserted, 0);
    assert.equal(getIssueByRepoNumber(t.db, REPO_ID, 7)?.state, "TRIAGE_PENDING");
  } finally {
    t.cleanup();
  }
});

test("a changed issue emits one new event and preserves its existing state", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    ingestRepositorySnapshot(t.db, snapshot({ issues: [issue(7, "2026-09-09T00:00:00.000Z")] }));
    const res = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [issue(7, "2026-09-09T00:00:00.000Z", "renamed")] }),
    );
    assert.equal(res.issuesChanged, 1);
    assert.equal(res.inboxInserted, 1);
    assert.equal(getIssueByRepoNumber(t.db, repo.id, 7)?.state, "TRIAGE_PENDING");
  } finally {
    t.cleanup();
  }
});

test("NULL-WorkItem inbox rows re-parent by Issue id once an attachment exists", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const existing = seedIssue(t.db, repo.id, { number: 7, state: "READY" });
    const wi = insertWorkItem(t.db, {
      id: `wi-xiaden-nomarr-7`,
      repo_id: repo.id,
      state: "RUNNING",
      base_branch: "main",
      head_branch: "tissue/wi_abc",
    });
    attachIssueToWorkItem(t.db, existing.id, wi.id);
    insertInboxEvent(t.db, {
      work_item_id: null,
      issue_id: existing.id,
      event_key: "issue:xiaden/nomarr:7:pre",
      kind: "issue_updated",
      payload_json: "{}",
    });

    const res = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [issue(7, "2026-09-09T00:00:00.000Z")] }),
    );
    assert.ok(res.reparented >= 1);
    const rows = listInboxByWorkItem(t.db, wi.id);
    assert.ok(rows.every((r) => r.work_item_id === wi.id));
  } finally {
    t.cleanup();
  }
});

test("L1 guard: reparentInboxByIssue never re-attaches a terminal-marked (housekept) row", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const existing = seedIssue(t.db, repo.id, { number: 7, state: "BASELINE_EXCLUDED" });
    const wi = insertWorkItem(t.db, {
      id: `wi-xiaden-nomarr-7`,
      repo_id: repo.id,
      state: "READY",
      base_branch: "main",
    });
    insertInboxEvent(t.db, {
      work_item_id: null,
      issue_id: existing.id,
      event_key: "issue:xiaden/nomarr:7:old",
      kind: "issue_discovered",
      payload_json: "{}",
    });
    // Terminal housekeeping marks the unattached row.
    const hk = housekeepTerminalUnattachedInbox(t.db, new Date("2026-09-10T00:00:00.000Z"));
    assert.equal(hk.terminalMarked, 1);
    // R14 enqueue admits the issue later; attachment happens.
    attachIssueToWorkItem(t.db, existing.id, wi.id);
    const moved = reparentInboxByIssue(t.db, existing.id, wi.id);
    assert.equal(moved, 0, "terminal-marked row must stay unattached (R14/R22 balance)");
    const nullRows = listNullWorkItemInboxByIssue(t.db, existing.id);
    assert.equal(nullRows.length, 1);
    assert.equal(nullRows[0]?.state, "TERMINAL");
    assert.equal(listInboxByWorkItem(t.db, wi.id).length, 0);
  } finally {
    t.cleanup();
  }
});

test("ingest commits side-effect intents idempotently (transactional outbox)", () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    const intent = {
      id: "eff-1",
      kind: "comment",
      effect_key: "comment:xiaden/nomarr:7:rejected",
      payload_json: JSON.stringify({ owner: "xiaden", name: "nomarr", issue_number: 7, body: "closed" }),
    };
    const first = ingestRepositorySnapshot(t.db, snapshot(), { sideEffects: [intent] });
    assert.equal(first.sideEffectsInserted, 1);
    const second = ingestRepositorySnapshot(t.db, snapshot(), { sideEffects: [intent] });
    assert.equal(second.sideEffectsDuplicate, 1);
    assert.equal(getSideEffectFull(t.db, "eff-1")?.state, "PENDING");
  } finally {
    t.cleanup();
  }
});

test("ingest rolls back atomically when an outbox intent is invalid (watermark unchanged)", () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    assert.throws(() =>
      ingestRepositorySnapshot(t.db, snapshot({ issues: [issue(7, "2026-09-09T00:00:00.000Z")] }), {
        sideEffects: [{ id: "bad", kind: "comment", effect_key: "k", payload_json: "not-json" }],
      }),
    );
    assert.equal(getPollWatermark(t.db, "xiaden", "nomarr"), null);
    assert.equal(getIssueByRepoNumber(t.db, REPO_ID, 7), undefined);
  } finally {
    t.cleanup();
  }
});

test("pollRepository reads typed argv through the fake binary, filters by watermark, and links PR snapshots", async () => {
  const fake = writeFakeGh({
    meta: defaultNomarrMeta(),
    issueList: {
      "xiaden/nomarr": [
        { number: 7, title: "new", state: "OPEN", updatedAt: "2026-09-09T00:00:00.000Z", createdAt: "2026-09-09T00:00:00.000Z", labels: [] },
        { number: 8, title: "old", state: "OPEN", updatedAt: "2026-08-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z", labels: [] },
      ],
    },
    prList: {
      "xiaden/nomarr": [
        { number: 21, state: "OPEN", headRefName: "tissue/wi_abc", headRefOid: "a".repeat(40), updatedAt: "2026-09-09T12:00:00.000Z", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false, url: "https://example/pr/21" },
      ],
    },
    prChecks: {
      "xiaden/nomarr#21": [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    },
    prReviews: {
      "xiaden/nomarr#21": [{ id: "REV_1", state: "APPROVED", submittedAt: "2026-09-09T12:00:00.000Z" }],
    },
  });
  try {
    const gh = new GhClient({ binary: fake.binary });
    const res = await pollRepository(
      { id: REPO_ID, owner: "xiaden", name: "nomarr", baselineAt: BASELINE },
      { watermark: "2026-09-09T00:00:00.000Z" },
      gh,
    );
    assert.equal(res.snapshot.issues.length, 1);
    assert.equal(res.snapshot.issues[0]?.number, 7);
    assert.equal(res.snapshot.pullRequests.length, 1);
    assert.equal(res.snapshot.checks.length, 1);
    assert.equal(res.snapshot.reviews.length, 1);
    assert.equal(res.snapshot.conflicts.length, 1);
    assert.ok(res.snapshot.watermark.length > 0);
  } finally {
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P2-S4/S5 adversarial specs: label admission + bounded comment events
// ---------------------------------------------------------------------------

function labeledIssue(number: number, createdAt: string, labels: string[], title = `issue ${number}`) {
  return { ...issue(number, createdAt, title), labels };
}

test("empty configured labels admit every eligible issue; non-empty admit any matching label", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    // No labels configured: an unlabeled issue is admitted.
    const empty = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [labeledIssue(7, "2026-09-09T00:00:00.000Z", [])] }),
    );
    assert.equal(empty.issuesNew, 1);
    assert.equal(getIssueByRepoNumber(t.db, repo.id, 7)?.state, "TRIAGE_PENDING");

    // Non-empty configured labels: only a matching label is admitted.
    t.db.sql.run("UPDATE repositories SET labels_json = ? WHERE id = ?", JSON.stringify(["bug"]), repo.id);
    const mismatch = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [labeledIssue(8, "2026-09-09T00:00:00.000Z", ["chore"])] }),
    );
    assert.equal(mismatch.issuesExcludedLabel, 1);
    assert.equal(getIssueByRepoNumber(t.db, repo.id, 8)?.state, "BASELINE_EXCLUDED");
    assert.equal(listNullWorkItemInboxByIssue(t.db, `issue-${repo.id}-8`).length, 0);

    const match = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [labeledIssue(9, "2026-09-09T00:00:00.000Z", ["bug", "p1"])] }),
    );
    assert.equal(match.issuesNew, 1);
    assert.equal(getIssueByRepoNumber(t.db, repo.id, 9)?.state, "TRIAGE_PENDING");
  } finally {
    t.cleanup();
  }
});

test("explicit enqueue admits a label-excluded issue without resurrecting terminal-housekept history", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    t.db.sql.run("UPDATE repositories SET labels_json = ? WHERE id = ?", JSON.stringify(["bug"]), repo.id);
    ingestRepositorySnapshot(t.db, snapshot({ issues: [labeledIssue(8, "2026-09-09T00:00:00.000Z", ["chore"])] }));
    assert.equal(getIssueByRepoNumber(t.db, repo.id, 8)?.state, "BASELINE_EXCLUDED");

    // Explicit enqueue is the sole historical override; the next ingest schedules triage.
    const enqueued = enqueueIssue(t.db, { id: repo.id }, 8);
    assert.equal(enqueued.outcome, "admitted");
    const res = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [labeledIssue(8, "2026-09-09T00:00:00.000Z", ["chore"])] }),
    );
    assert.equal(getIssueByRepoNumber(t.db, repo.id, 8)?.state, "TRIAGE_PENDING");
    assert.equal(res.inboxInserted, 1);
  } finally {
    t.cleanup();
  }
});

test("same-session ordered inbox routing: deterministic comment dedup keyed by comment id + body hash", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const comment = {
      target: "issue" as const,
      number: 7,
      commentId: "C_1",
      author: "bob",
      createdAt: "2026-09-09T00:00:00.000Z",
      bodyPreview: "please fix",
      bodyHash: "h1",
    };
    const first = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [issue(7, "2026-09-09T00:00:00.000Z")], comments: [comment] }),
    );
    assert.equal(first.commentsSeen, 1);
    assert.equal(first.inboxInserted, 2, "discovery + comment");
    const rows = listNullWorkItemInboxByIssue(t.db, `issue-${repo.id}-7`);
    assert.equal(rows.length, 2);
    assert.ok(rows[0]!.id < rows[1]!.id, "comment routed after discovery in one session");
    assert.equal(rows[1]?.kind, "issue_comment");

    // Same comment (same id + body hash) is a deterministic no-op.
    const second = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [issue(7, "2026-09-09T00:00:00.000Z")], comments: [comment] }),
    );
    assert.equal(second.inboxInserted, 0);

    // An edited comment produces a distinct event key.
    const edited = ingestRepositorySnapshot(
      t.db,
      snapshot({
        issues: [issue(7, "2026-09-09T00:00:00.000Z")],
        comments: [{ ...comment, bodyPreview: "please fix now", bodyHash: "h2" }],
      }),
    );
    assert.equal(edited.inboxInserted, 1);
  } finally {
    t.cleanup();
  }
});

test("real ingest projects trusted comments with policy-bound actor provenance and body preview", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const policy = createTrustedGithubPolicy({ security: { trustedGithubUsers: ["Alice"] } });
    const comment = {
      target: "issue" as const,
      number: 7,
      commentId: "C_TRUSTED",
      author: "Alice",
      createdAt: "2026-09-09T00:00:00.000Z",
      bodyPreview: "please fix this safely",
      bodyHash: "trusted-hash",
    };

    const result = ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [issue(7, "2026-09-09T00:00:00.000Z")], comments: [comment] }),
      { policy },
    );

    assert.equal(result.commentsSeen, 1);
    const row = listNullWorkItemInboxByIssue(t.db, `issue-${repo.id}-7`).find((candidate) => candidate.kind === "issue_comment");
    assert.ok(row);
    assert.deepEqual(JSON.parse(row.payload_json), {
      target: "issue",
      number: 7,
      comment_id: "C_TRUSTED",
      author: "Alice",
      body_preview: "please fix this safely",
    });
    assert.equal(row.quarantine_json, null);
    assert.deepEqual(envelopeForRow(row), {
      repository: repo.id,
      sourceKind: "issue_comment",
      objectId: "7",
      contentId: "C_TRUSTED",
      observedVersion: "trusted-hash",
      contentHash: "trusted-hash",
      authoritativeAt: "2026-09-09T00:00:00.000Z",
      policyRevision: policy.revision,
      actor: { present: true, rawLogin: "Alice", normalizedLogin: "alice", presence: "PRESENT" },
      decision: "TRUSTED",
      reason: "TRUSTED",
      deliveryClass: "TRUSTED_PROSE",
    });
  } finally {
    t.cleanup();
  }
});

test("real ingest keeps denied comments body-free while persisting explicit policy denial", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const policy = createTrustedGithubPolicy({ security: { trustedGithubUsers: ["Alice"] } });
    const comment = {
      target: "issue" as const,
      number: 8,
      commentId: "C_DENIED",
      author: " malformed ",
      createdAt: "2026-09-09T00:00:00.000Z",
      bodyPreview: "secret denied prose",
      bodyHash: "denied-hash",
    };

    ingestRepositorySnapshot(
      t.db,
      snapshot({ issues: [issue(8, "2026-09-09T00:00:00.000Z")], comments: [comment] }),
      { policy },
    );

    const row = listNullWorkItemInboxByIssue(t.db, `issue-${repo.id}-8`).find((candidate) => candidate.kind === "issue_comment");
    if (!row) assert.fail("denied comment inbox row was not persisted");
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    assert.deepEqual(payload, { target: "issue", number: 8, comment_id: "C_DENIED", denied: true });
    for (const forbidden of ["body", "body_preview", "title", "digest", "quote", "derivedProse"]) {
      assert.equal(forbidden in payload, false, `denied payload must omit ${forbidden}`);
    }

    assert.deepEqual(JSON.parse(row.quarantine_json ?? "null"), {
      sourceKind: "issue_comment",
      objectId: "8",
      contentId: "C_DENIED",
      observedVersion: "denied-hash",
      contentHash: "denied-hash",
      authoritativeAt: "2026-09-09T00:00:00.000Z",
      actor: { present: true, rawLogin: " malformed ", normalizedLogin: null, presence: "MALFORMED" },
      decision: "MALFORMED_ACTOR",
      reason: "MALFORMED_ACTOR",
      deliveryClass: "DENIED_PROSE",
    });
    const storedRow = getInboxById(t.db, row.id);
    if (!storedRow) assert.fail("denied comment inbox row could not be reloaded");
    assert.deepEqual(envelopeForRow(storedRow), {
      repository: repo.id,
      sourceKind: "issue_comment",
      objectId: "8",
      contentId: "C_DENIED",
      observedVersion: "denied-hash",
      contentHash: "denied-hash",
      authoritativeAt: "2026-09-09T00:00:00.000Z",
      policyRevision: policy.revision,
      actor: { present: true, rawLogin: " malformed ", normalizedLogin: null, presence: "MALFORMED" },
      decision: "MALFORMED_ACTOR",
      reason: "MALFORMED_ACTOR",
      deliveryClass: "DENIED_PROSE",
    });
  } finally {
    t.cleanup();
  }
});

test("a foreign fork on the controller branch is recorded ROGUE not linked as the controller PR", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, {
      id: "wi-xiaden-nomarr-7",
      repo_id: repo.id,
      state: "RUNNING",
      base_branch: "main",
      head_branch: "tissue/wi_abc",
    });
    const res = ingestRepositorySnapshot(
      t.db,
      snapshot({
        pullRequests: [
          {
            number: 77,
            state: "OPEN",
            headRefName: "tissue/wi_abc",
            headRefOid: "a".repeat(40),
            headOwner: "attacker",
            headRepo: "attacker/nomarr",
            updatedAt: "2026-09-09T12:00:00.000Z",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            isDraft: false,
            url: "https://example/pr/77",
          },
        ],
      }),
    );
    assert.equal(res.prsRogue, 1);
    assert.equal(res.prsLinked, 0);
    const pr = t.db.sql.get<{ state: string; origin: string }>(
      "SELECT state, origin FROM pull_requests WHERE number = 77",
    );
    assert.equal(pr?.state, "ROGUE");
    assert.equal(pr?.origin, "rogue");
  } finally {
    t.cleanup();
  }
});

test("R10 per-event-class identity: deterministic dedup keys for issue/PR/check/review/conflict/comment changes", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const wi = "wi-xiaden-nomarr-7";
    insertWorkItem(t.db, { id: wi, repo_id: repo.id, state: "RUNNING", base_branch: "main", head_branch: "tissue/wi_abc" });
    const issueId = `issue-${repo.id}-7`;

    const issueSnap = (title: string, state: string, updatedAt: string) => ({
      number: 7, title, state, updatedAt, createdAt: "2026-09-09T00:00:00.000Z",
      labels: [] as string[], snapshotHash: snapshotHash({ number: 7, title, state, updatedAt }),
    });
    const prSnap = (overrides: Record<string, unknown> = {}) => ({
      number: 77, state: "OPEN", headRefName: "tissue/wi_abc", headRefOid: "a".repeat(40),
      headOwner: "xiaden", headRepo: "xiaden/nomarr", updatedAt: "2026-09-09T00:00:00.000Z",
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false, url: "https://example/pr/77", ...overrides,
    });
    const checkSnap = (conclusion: string) => ({ prNumber: 77, name: "ci", status: "COMPLETED", conclusion, checkKey: `77:ci:COMPLETED:${conclusion}` });
    const reviewSnap = (state: string) => ({ prNumber: 77, reviewId: "R1", state, submittedAt: "2026-09-09T00:00:00.000Z" });
    const conflictSnap = (status: string) => ({ prNumber: 77, mergeable: "CONFLICTING", mergeStateStatus: status });
    const commentSnap = (target: "issue" | "pr", number: number, commentId: string, bodyHash: string) => ({
      target, number, commentId, author: "bob", createdAt: "2026-09-09T00:00:00.000Z", bodyPreview: "p", bodyHash,
    });

    // Discovery first, then link the issue to the work item so PR-class events route.
    assert.equal(ingestRepositorySnapshot(t.db, snapshot({ issues: [issueSnap("issue 7", "OPEN", "2026-09-09T00:00:00.000Z")] })).issuesNew, 1);
    attachIssueToWorkItem(t.db, issueId, wi);

    let curIssue = issueSnap("issue 7 renamed", "OPEN", "2026-09-09T01:00:00.000Z");
    let curPr = prSnap();
    let curCheck = checkSnap("SUCCESS");
    let curReview = reviewSnap("APPROVED");
    let curConflict = conflictSnap("DIRTY");
    let curComments = [commentSnap("issue", 7, "C_1", "h1"), commentSnap("pr", 77, "C_2", "h2")];
    const snapNow = (collectedAt: string) => snapshot({
      collectedAt, issues: [curIssue], pullRequests: [curPr], checks: [curCheck], reviews: [curReview], conflicts: [curConflict], comments: curComments,
    });
    const inboxRows = () => t.db.sql.all<{ kind: string; event_key: string; work_item_id: string | null }>(
      "SELECT kind, event_key, work_item_id FROM inbox WHERE work_item_id = ? ORDER BY id", wi,
    );

    // One snapshot carrying every event class at once.
    const first = ingestRepositorySnapshot(t.db, snapNow("2026-09-09T01:00:00.000Z"));
    assert.equal(first.inboxInserted, 7, "issue+pr+check+review+conflict+issue-comment+pr-comment");
    const rows = inboxRows();
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["issue_discovered", "issue_updated", "pr_updated", "check_updated", "review_updated", "pr_conflict", "issue_comment", "pr_comment"],
      "events are ordered and delivered into the SAME work item/session",
    );
    assert.ok(rows.every((r) => r.work_item_id === wi));
    const keys = new Set(rows.map((r) => r.event_key));
    assert.equal(keys.size, rows.length, "every event class has a distinct deterministic key");
    for (const expected of [
      `issue:${repo.id}:7:${curIssue.snapshotHash}`,
      `pr:${repo.id}:77:${"a".repeat(40)}:OPEN`,
      `check:${repo.id}:77:ci:COMPLETED:SUCCESS`,
      `review:${repo.id}:77:R1:APPROVED`,
      `conflict:${repo.id}:77:DIRTY`,
      `comment:${repo.id}:issue:7:C_1:h1`,
      `comment:${repo.id}:pr:77:C_2:h2`,
    ]) {
      assert.ok(keys.has(expected), `missing key ${expected}`);
    }

    // Re-ingesting the identical snapshot dedups every class.
    assert.equal(ingestRepositorySnapshot(t.db, snapNow("2026-09-09T01:00:00.000Z")).inboxInserted, 0);

    // Reopen: CLOSED then OPEN, each a distinct deterministic key (state/time in the hash).
    curIssue = issueSnap("issue 7 renamed", "CLOSED", "2026-09-09T02:00:00.000Z");
    assert.equal(ingestRepositorySnapshot(t.db, snapNow("2026-09-09T02:00:00.000Z")).inboxInserted, 1);
    const closedKey = inboxRows().filter((r) => r.kind === "issue_updated").at(-1)!.event_key;
    curIssue = issueSnap("issue 7 renamed", "OPEN", "2026-09-09T03:00:00.000Z");
    assert.equal(ingestRepositorySnapshot(t.db, snapNow("2026-09-09T03:00:00.000Z")).inboxInserted, 1);
    const reopenedKey = inboxRows().filter((r) => r.kind === "issue_updated").at(-1)!.event_key;
    assert.notEqual(closedKey, reopenedKey, "reopen is a new event, not a dedup");

    // A meaningful title edit is a new issue event.
    curIssue = issueSnap("issue 7 retitled", "OPEN", "2026-09-09T04:00:00.000Z");
    assert.equal(ingestRepositorySnapshot(t.db, snapNow("2026-09-09T04:00:00.000Z")).inboxInserted, 1);
    assert.equal(inboxRows().filter((r) => r.kind === "issue_updated").at(-1)!.event_key, `issue:${repo.id}:7:${curIssue.snapshotHash}`);

    // PR state change.
    curPr = prSnap({ state: "MERGED" });
    assert.equal(ingestRepositorySnapshot(t.db, snapNow("2026-09-09T05:00:00.000Z")).inboxInserted, 1);
    assert.ok(inboxRows().some((r) => r.event_key === `pr:${repo.id}:77:${"a".repeat(40)}:MERGED`));

    // CI/check change.
    curCheck = checkSnap("FAILURE");
    assert.equal(ingestRepositorySnapshot(t.db, snapNow("2026-09-09T06:00:00.000Z")).inboxInserted, 1);
    assert.ok(inboxRows().some((r) => r.event_key === `check:${repo.id}:77:ci:COMPLETED:FAILURE`));

    // PR review change.
    curReview = reviewSnap("CHANGES_REQUESTED");
    assert.equal(ingestRepositorySnapshot(t.db, snapNow("2026-09-09T07:00:00.000Z")).inboxInserted, 1);
    assert.ok(inboxRows().some((r) => r.event_key === `review:${repo.id}:77:R1:CHANGES_REQUESTED`));

    // Conflict state change.
    curConflict = conflictSnap("BEHIND");
    assert.equal(ingestRepositorySnapshot(t.db, snapNow("2026-09-09T08:00:00.000Z")).inboxInserted, 1);
    assert.ok(inboxRows().some((r) => r.event_key === `conflict:${repo.id}:77:BEHIND`));

    // Meaningful issue-body edit (bodyHash change) is a new comment event.
    curComments = [{ ...curComments[0]!, bodyHash: "h3" }, curComments[1]!];
    assert.equal(ingestRepositorySnapshot(t.db, snapNow("2026-09-09T09:00:00.000Z")).inboxInserted, 1);
    assert.ok(inboxRows().some((r) => r.event_key === `comment:${repo.id}:issue:7:C_1:h3`));

    // Meaningful PR-body edit (bodyHash change) is a new comment event.
    curComments = [curComments[0]!, { ...curComments[1]!, bodyHash: "h4" }];
    assert.equal(ingestRepositorySnapshot(t.db, snapNow("2026-09-09T10:00:00.000Z")).inboxInserted, 1);
    assert.ok(inboxRows().some((r) => r.event_key === `comment:${repo.id}:pr:77:C_2:h4`));
  } finally {
    t.cleanup();
  }
});
