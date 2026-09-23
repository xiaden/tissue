// tests/integration/inbox-relay.test.ts
//
// P2-S2 spec-first tests for ordered durable inbox delivery. Exercises the REAL
// OpenCodeDriver over the pessimistic fake OpenCode server so the completion
// semantics are the production ones (RG-3/RG-4, T8 G1-G5):
//   - 204 / observed idle alone are NEVER completion;
//   - DELIVERED requires a nonce-bearing user message + parent-linked assistant
//     turn, excluding summary=true / mode=compaction;
//   - durable single-flight (DELIVERING is resumed, never duplicated);
//   - bounded noReply window recycles DELIVERING->PENDING + human-inspect;
//   - past W_wedge the WorkItem is held FAILED_HOLD;
//   - idle gate holds (never prompts) while the session is busy.
//
// TASK-tissue-G Phase 1 spec-first coverage: a resolution session that is
// genuinely `missing` (deleted server-side) escalates to FAILED_HOLD instead of
// holding `busy_hold` forever — both for a PENDING bundle (never claimed) and
// for an in-flight DELIVERING bundle (evidence preserved, no relabelling).

import test from "node:test";
import assert from "node:assert/strict";

import { OpenCodeHttp } from "../../src/integrations/opencode-http.ts";
import { OpenCodeDriver } from "../../src/integrations/opencode-driver.ts";
import {
  attachIssueToWorkItem,
  insertInboxEvent,
  insertWorkItem,
  insertWorktree,
  listInboxByWorkItem,
  markInboxDelivering,
} from "../../src/db/repositories.ts";
import { runWrite } from "../../src/db/open.ts";
import { relayOldestInbox } from "../../src/controller/inbox-relay.ts";
import { decideCurrentGithubProse, type ProvenanceEnvelope } from "../../src/controller/trust.ts";
import { startPessimisticServer, type PessimisticOpenCodeServer } from "../helpers/pessimistic-opencode-server.ts";
import { createTestDb, seedIssue, seedRepository } from "../helpers/db.ts";
import { createTempRepo } from "../helpers/git.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Harness {
  db: ReturnType<typeof createTestDb>["db"];
  driver: OpenCodeDriver;
  server: PessimisticOpenCodeServer;
  workItemId: string;
  issueId: string;
  sessionId: string;
  configPath: string;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const t = createTestDb();
  const server = await startPessimisticServer();
  // A real local checkout: relay delivery resolves the active worktree's HEAD
  // sha, so the worktree path must be a real git repository — never a
  // host-specific path that only exists on one machine.
  const checkout = await createTempRepo();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  // Plan J: createRealSession writes the ses_* marker into this writable dir.
  const registryDir = mkdtempSync(join(tmpdir(), "tissue-inbox-registry-"));
  const configPath = join(registryDir, "tissue.yml");
  writeConfig(configPath, []);
  const driver = new OpenCodeDriver({ http, db: t.db, registryDir });
  const repo = seedRepository(t.db);
  const workItem = insertWorkItem(t.db, {
    id: "wi-xiaden-nomarr-7",
    repo_id: repo.id,
    state: "RUNNING",
    base_branch: "main",
    head_branch: "tissue/wi_abc",
  });
  const issue = seedIssue(t.db, repo.id, { number: 7, state: "READY" });
  attachIssueToWorkItem(t.db, issue.id, workItem.id);
  insertWorktree(t.db, {
    id: `wt-${workItem.id}`,
    work_item_id: workItem.id,
    path: checkout.clone,
    branch: "tissue/wi_abc",
    state: "ACTIVE",
  });
  const ref = await driver.createRealSession("resolution", checkout.clone, {
    repoId: repo.id,
    directory: checkout.clone,
    kind: "resolution",
    workItemId: workItem.id,
  });
  return {
    db: t.db,
    driver,
    server,
    workItemId: workItem.id,
    issueId: issue.id,
    sessionId: ref.sessionId,
    configPath,
    cleanup: async () => {
      await server.close();
      t.cleanup();
      checkout.cleanup();
      rmSync(registryDir, { recursive: true, force: true });
    },
  };
}

function writeConfig(path: string, users: readonly string[]): void {
  writeFileSync(path, [
    "pollIntervalSeconds: 300",
    "maxConcurrentGlobal: 3",
    "retentionDays: 90",
    "repos: []",
    "security:",
    "  trustedGithubUsers:",
    ...(users.length > 0 ? users.map((user) => `    - ${user}`) : ["    - maintainer"]),
  ].join("\n"));
  if (users.length === 0) writeFileSync(path, [
    "pollIntervalSeconds: 300",
    "maxConcurrentGlobal: 3",
    "retentionDays: 90",
    "repos: []",
  ].join("\n"));
}

function envelope(rawLogin: string, sourceKind: "issue_comment" | "pr_comment" = "issue_comment"): ProvenanceEnvelope {
  return {
    repository: "xiaden/nomarr",
    sourceKind,
    objectId: rawLogin,
    contentId: rawLogin,
    observedVersion: "v1",
    contentHash: "hash",
    authoritativeAt: new Date().toISOString(),
    policyRevision: "unavailable",
    actor: { present: true, rawLogin, normalizedLogin: rawLogin.toLowerCase(), presence: "PRESENT" },
    decision: "UNTRUSTED",
    reason: "UNTRUSTED",
    deliveryClass: "DENIED_PROSE",
  };
}

function seedEvent(h: Harness, key: string): number {
  return insertInboxEvent(h.db, {
    work_item_id: h.workItemId,
    issue_id: h.issueId,
    event_key: key,
    kind: "issue_updated",
    payload_json: JSON.stringify({ key }),
  });
}

function seedComment(
  h: Harness,
  key: string,
  author: string,
  body: string,
  kind: "issue_comment" | "pr_comment" = "issue_comment",
  envelopeAuthor: string | null = author,
): number {
  return insertInboxEvent(h.db, {
    work_item_id: h.workItemId,
    issue_id: h.issueId,
    event_key: key,
    kind,
    payload_json: JSON.stringify({
      target: kind === "pr_comment" ? "pull_request" : "issue",
      number: 7,
      ...(kind === "pr_comment" ? { pr_number: 7 } : {}),
      comment_id: key,
      author,
      body_preview: body,
      hostile_extra: "must-not-forward",
    }),
    envelope: envelopeAuthor === null ? null : envelope(envelopeAuthor, kind),
  });
}

const OPTS = { kIdleSamples: 1, idleGapMs: 0, nonce: () => "dlv_test123" } as const;

function relayOpts(h: Harness) {
  return { ...OPTS, configPath: h.configPath };
}

test("bundles oldest events in global inbox order and DELIVERS only after a parent-linked turn", async () => {
  const h = await harness();
  try {
    const id1 = seedEvent(h, "e1");
    const id2 = seedEvent(h, "e2");

    const first = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(first.status, "observing", "204 + idle must not be completion");
    assert.deepEqual(first.inboxIds, [id1, id2]);

    // Accepted async prompt: nonce user message persisted, no assistant turn yet.
    const rec = h.server.getRec(h.sessionId);
    assert.ok(rec && rec.messages.length === 1, "one nonce user message persisted by the fake server");
    assert.ok(!rec?.messages.some((m) => m.info.role === "assistant"), "no assistant turn yet");

    h.server.flushAsync(h.sessionId, { text: JSON.stringify({ kind: "resolution", envelope_id: "env-delivery-1", work_item_id: h.workItemId, outcome: "completed", reason: "repair complete" }) });
    const second = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(second.status, "delivered");
    assert.deepEqual(second.inboxIds, [id1, id2], "global inbox.id order preserved");

    const rows = listInboxByWorkItem(h.db, h.workItemId);
    assert.ok(rows.every((r) => r.state === "DELIVERED"));
    assert.ok(rows.every((r) => r.delivered_at !== null));

    const again = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(again.status, "no_pending", "a duplicate delivery is an auditable no-op");
  } finally {
    await h.cleanup();
  }
});

test("real relay applies awaiting_decision resolution without lifecycle side effects", async () => {
  const h = await harness();
  try {
    const id = seedEvent(h, "awaiting-decision-1");
    const first = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(first.status, "observing");

    h.server.flushAsync(h.sessionId, {
      text: JSON.stringify({
        kind: "resolution",
        envelope_id: "env-awaiting-decision-1",
        work_item_id: h.workItemId,
        outcome: "awaiting_decision",
        reason: "human input required",
      }),
    });
    const second = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));

    assert.equal(second.status, "delivered");
    assert.equal(h.db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", h.workItemId)?.state, "AWAITING_DECISION");
    assert.equal(listInboxByWorkItem(h.db, h.workItemId).find((row) => row.id === id)?.state, "DELIVERED");
    assert.equal(h.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM side_effects")?.c, 0, "awaiting decision creates no lifecycle effects");
  } finally {
    await h.cleanup();
  }
});

test("real relay applies deferred resolution with exactly one durable dependency and no effects", async () => {
  const h = await harness();
  try {
    const id = seedEvent(h, "deferred-1");
    const first = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(first.status, "observing");

    h.server.flushAsync(h.sessionId, {
      text: JSON.stringify({
        kind: "resolution",
        envelope_id: "env-deferred-1",
        work_item_id: h.workItemId,
        outcome: "deferred",
        dependency: { kind: "issue", id: h.issueId },
        reason: "waiting for issue dependency",
      }),
    });
    const second = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));

    assert.equal(second.status, "delivered");
    assert.equal(h.db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", h.workItemId)?.state, "DEFERRED");
    assert.equal(listInboxByWorkItem(h.db, h.workItemId).find((row) => row.id === id)?.state, "DELIVERED");
    const relations = h.db.sql.all<{ dependency_issue_id: string | null; dependency_work_item_id: string | null }>(
      "SELECT dependency_issue_id, dependency_work_item_id FROM work_item_dependencies WHERE dependent_work_item_id = ?",
      h.workItemId,
    );
    assert.equal(relations.length, 1, "deferred relay persists exactly one dependency relation");
    assert.equal(relations[0]?.dependency_issue_id, h.issueId);
    assert.equal(relations[0]?.dependency_work_item_id, null);
    assert.equal(h.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM side_effects")?.c, 0, "deferred resolution creates no lifecycle effects");
  } finally {
    await h.cleanup();
  }
});

test("does not prompt while the session is busy (idle gate, no busy-rejection reliance)", async () => {
  const h = await harness();
  try {
    seedEvent(h, "busy-1");
    h.server.setBusy(h.sessionId);
    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(res.status, "busy_hold");
    const rows = listInboxByWorkItem(h.db, h.workItemId);
    assert.equal(rows[0]?.state, "PENDING", "no row claimed while not idle");
    assert.equal(h.server.getRec(h.sessionId)?.messages.length, 0, "no prompt sent while busy");
  } finally {
    await h.cleanup();
  }
});

test("summary=true / mode=compaction turns are excluded, so delivery stays observing", async () => {
  const h = await harness();
  try {
    const id = seedEvent(h, "compact-1");
    await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    const rec = h.server.getRec(h.sessionId);
    const parent = rec?.pendingAsyncUserMsgId;
    assert.ok(parent);
    h.server.appendAssistantTurn(h.sessionId, { parentID: parent!, text: "compaction", summary: true, mode: "compaction" });

    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, { ...OPTS, now: new Date(Date.now() + 1000) });
    assert.equal(res.status, "observing", "a compaction turn never completes delivery");
    assert.deepEqual(res.inboxIds, [id]);
  } finally {
    await h.cleanup();
  }
});

test("noReply past W_turn recycles DELIVERING->PENDING (+ human inspect) without losing the event", async () => {
  const h = await harness();
  try {
    seedEvent(h, "noreply-1");
    await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, {
      ...OPTS,
      now: new Date(Date.now() + 121_000),
    });
    assert.equal(res.status, "recycled");
    assert.equal(res.reason, "no_turn");
    const rows = listInboxByWorkItem(h.db, h.workItemId);
    assert.equal(rows[0]?.state, "PENDING");
    assert.equal(rows[0]?.delivery_nonce, null);
  } finally {
    await h.cleanup();
  }
});

test("noReply past W_wedge holds the WorkItem FAILED_HOLD with evidence preserved", async () => {
  const h = await harness();
  try {
    seedEvent(h, "wedge-1");
    await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, {
      ...OPTS,
      now: new Date(Date.now() + 241_000),
    });
    assert.equal(res.status, "failed_hold");
    const rows = listInboxByWorkItem(h.db, h.workItemId);
    assert.equal(rows[0]?.state, "DELIVERING", "evidence left in place until cleanup");
    const wi = h.db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", h.workItemId);
    assert.equal(wi?.state, "FAILED_HOLD");
  } finally {
    await h.cleanup();
  }
});

test("crash window: an existing DELIVERING row with a completed turn is adopted, never re-prompted", async () => {
  const h = await harness();
  try {
    const id = seedEvent(h, "crash-1");
    // Simulate a pre-crash attempt: nonce recorded + prompt accepted + turn completed.
    runWrite(h.db, (tx) => markInboxDelivering(tx, [id], "dlv_crash"));
    h.server.appendUserMessage(h.sessionId, "tissue delivery nonce: dlv_crash");
    const rec = h.server.getRec(h.sessionId)!;
    const parent = rec.messages[0]!.info.id;
    h.server.appendAssistantTurn(h.sessionId, { parentID: parent, text: JSON.stringify({ kind: "resolution", envelope_id: "env-crash-1", work_item_id: h.workItemId, outcome: "completed" }) });
    const before = rec.messages.length;

    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(res.status, "delivered");
    assert.equal(h.server.getRec(h.sessionId)?.messages.length, before, "completion adopted without a second prompt");
    const rows = listInboxByWorkItem(h.db, h.workItemId);
    assert.equal(rows[0]?.state, "DELIVERED");
  } finally {
    await h.cleanup();
  }
});

test("pending bundle for a missing resolution session escalates FAILED_HOLD instead of busy_hold", async () => {
  const h = await harness();
  try {
    const id = seedEvent(h, "pending-missing-1");
    h.server.deleteSession(h.sessionId);

    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(res.status, "session_missing", "a nonexistent session never yields busy_hold");
    assert.notEqual(res.status, "busy_hold");

    const wi = h.db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", h.workItemId);
    assert.equal(wi?.state, "FAILED_HOLD", "the owning WorkItem is put in an explicit recoverable state");

    const rows = listInboxByWorkItem(h.db, h.workItemId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, id);
    assert.equal(rows[0]?.state, "PENDING", "the bundle is never claimed");
    assert.equal(rows[0]?.delivery_nonce, null);
    assert.equal(h.server.getRec(h.sessionId)?.messages.length, 0, "no prompt is sent to a missing session");
  } finally {
    await h.cleanup();
  }
});

test("delivery-time session loss holds FAILED_HOLD and preserves the DELIVERING evidence", async () => {
  const h = await harness();
  try {
    const id = seedEvent(h, "delivery-missing-1");
    const first = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(first.status, "observing");
    const nonce = first.nonce;
    assert.ok(nonce, "an in-flight delivery records its durable nonce");

    h.server.deleteSession(h.sessionId);
    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(res.status, "session_missing");

    const wi = h.db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", h.workItemId);
    assert.equal(wi?.state, "FAILED_HOLD");

    const row = listInboxByWorkItem(h.db, h.workItemId).find((r) => r.id === id);
    assert.equal(row?.state, "DELIVERING", "the DELIVERING evidence is left in place until cleanup");
    assert.equal(row?.delivery_nonce, nonce, "the original nonce is preserved");
  } finally {
    await h.cleanup();
  }
});

test("a transport failure while sampling idle propagates and is never read as a lost session", async () => {
  const h = await harness();
  try {
    seedEvent(h, "transport-failure-1");
    // A thrown getSessionStatus is a transport failure, NOT evidence the session
    // is gone: the relay must surface it rather than convert it to `missing`.
    const throwing = {
      getSessionStatus: async (): Promise<never> => {
        throw new Error("resident OpenCode transport failure");
      },
      promptAsync: h.driver.promptAsync.bind(h.driver),
      observeCompletion: h.driver.observeCompletion.bind(h.driver),
    };

    await assert.rejects(() => relayOldestInbox(h.db, h.workItemId, throwing, OPTS), /transport failure/);

    const wi = h.db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", h.workItemId);
    assert.equal(wi?.state, "RUNNING", "a transport failure is not evidence the session is gone");
    const rows = listInboxByWorkItem(h.db, h.workItemId);
    assert.equal(rows[0]?.state, "PENDING");
    assert.equal(rows[0]?.delivery_nonce, null);
  } finally {
    await h.cleanup();
  }
});


test("real relay filters trusted, denied, and mixed-author prose while preserving objective fields", async () => {
  const h = await harness();
  try {
    writeConfig(h.configPath, ["maintainer"]);
    assert.equal(decideCurrentGithubProse("Maintainer", h.configPath), "TRUSTED");
    const trusted = seedComment(h, "trusted-comment", "Maintainer", "trusted prose");
    const denied = seedComment(h, "denied-comment", "attacker", "UNTRUSTED_SECRET");
    const first = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(first.status, "observing");
    const trustedRow = listInboxByWorkItem(h.db, h.workItemId).find((row) => row.id === trusted);
    assert.equal(trustedRow?.envelope_actor_raw_login, "Maintainer");
    assert.equal(decideCurrentGithubProse(trustedRow?.envelope_actor_raw_login, h.configPath), "TRUSTED");
    const prompt = JSON.stringify(h.server.getRec(h.sessionId)?.messages ?? []);
    assert.match(prompt, /trusted prose/);
    assert.doesNotMatch(prompt, /UNTRUSTED_SECRET/);
    assert.match(prompt, /issue_comment/);
    assert.match(prompt, /\\"number\\":7/);
    assert.doesNotMatch(prompt, /hostile_extra/);
    assert.deepEqual(first.inboxIds, [trusted, denied]);
  } finally {
    await h.cleanup();
  }
});

test("real relay fails closed for missing, unknown, and malformed issue-comment authors while retaining objectives", async () => {
  const h = await harness();
  try {
    writeConfig(h.configPath, ["maintainer"]);
    const missing = seedComment(h, "missing-author", "maintainer", "MISSING_SECRET", "issue_comment", null);
    const unknown = seedComment(h, "unknown-author", "attacker", "UNKNOWN_SECRET");
    const malformed = seedComment(h, "malformed-author", " maintainer", "MALFORMED_SECRET");

    const result = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(result.status, "observing");
    assert.deepEqual(result.inboxIds, [missing, unknown, malformed]);

    const prompt = JSON.stringify(h.server.getRec(h.sessionId)?.messages ?? []);
    for (const secret of ["MISSING_SECRET", "UNKNOWN_SECRET", "MALFORMED_SECRET"]) {
      assert.doesNotMatch(prompt, new RegExp(secret));
    }
    for (const id of ["missing-author", "unknown-author", "malformed-author"]) {
      assert.match(prompt, new RegExp(id));
    }
    assert.match(prompt, /issue_comment/);
    assert.match(prompt, /\\\"number\\\":7/);
    assert.doesNotMatch(prompt, /hostile_extra/);
  } finally {
    await h.cleanup();
  }
});

test("real relay delivers trusted PR-comment prose and omits denied PR-comment prose", async () => {
  const h = await harness();
  try {
    writeConfig(h.configPath, ["maintainer"]);
    const trusted = seedComment(h, "trusted-pr-comment", "Maintainer", "TRUSTED_PR_SECRET", "pr_comment");
    const denied = seedComment(h, "denied-pr-comment", "attacker", "DENIED_PR_SECRET", "pr_comment");

    const result = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(result.status, "observing");
    assert.deepEqual(result.inboxIds, [trusted, denied]);

    const prompt = JSON.stringify(h.server.getRec(h.sessionId)?.messages ?? []);
    assert.match(prompt, /TRUSTED_PR_SECRET/);
    assert.doesNotMatch(prompt, /DENIED_PR_SECRET/);
    assert.match(prompt, /pr_comment/);
    assert.match(prompt, /trusted-pr-comment/);
    assert.match(prompt, /denied-pr-comment/);
    assert.match(prompt, /\\\"pr_number\\\":7/);
    assert.doesNotMatch(prompt, /hostile_extra/);
  } finally {
    await h.cleanup();
  }
});

test("config changes after ingestion filter a pending relay without repolling", async () => {
  const h = await harness();
  try {
    writeConfig(h.configPath, ["maintainer"]);
    seedComment(h, "config-change", "maintainer", "CONFIG_SECRET");
    writeConfig(h.configPath, []);
    const result = await relayOldestInbox(h.db, h.workItemId, h.driver, relayOpts(h));
    assert.equal(result.status, "observing");
    const prompt = JSON.stringify(h.server.getRec(h.sessionId)?.messages ?? []);
    assert.doesNotMatch(prompt, /CONFIG_SECRET/);
    assert.match(prompt, /issue_comment/);
    assert.match(prompt, /\\"number\\":7/);
  } finally {
    await h.cleanup();
  }
});

test("resumed DELIVERING rows do not re-prompt or expose prose after config denial", async () => {
  const h = await harness();
  try {
    writeConfig(h.configPath, ["maintainer"]);
    const id = seedComment(h, "resume-denied", "maintainer", "RESUMED_SECRET");
    const nonce = "dlv_resume_denied";
    runWrite(h.db, (tx) => {
      markInboxDelivering(tx, [id], nonce);
    });
    writeConfig(h.configPath, []);
    const before = h.server.getRec(h.sessionId)?.messages.length ?? 0;
    const result = await relayOldestInbox(h.db, h.workItemId, h.driver, { ...relayOpts(h), now: new Date() });
    assert.equal(result.status, "observing");
    assert.equal(h.server.getRec(h.sessionId)?.messages.length ?? 0, before);
    assert.doesNotMatch(JSON.stringify(h.server.getRec(h.sessionId)?.messages ?? []), /RESUMED_SECRET/);
  } finally {
    await h.cleanup();
  }
});
