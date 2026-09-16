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
import { startPessimisticServer, type PessimisticOpenCodeServer } from "../helpers/pessimistic-opencode-server.ts";
import { createTestDb, seedIssue, seedRepository } from "../helpers/db.ts";
import { createTempRepo } from "../helpers/git.ts";

interface Harness {
  db: ReturnType<typeof createTestDb>["db"];
  driver: OpenCodeDriver;
  server: PessimisticOpenCodeServer;
  workItemId: string;
  issueId: string;
  sessionId: string;
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
  const driver = new OpenCodeDriver({ http, db: t.db });
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
    cleanup: async () => {
      await server.close();
      t.cleanup();
      checkout.cleanup();
    },
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

const OPTS = { kIdleSamples: 1, idleGapMs: 0, nonce: () => "dlv_test123" } as const;

test("bundles oldest events in global inbox order and DELIVERS only after a parent-linked turn", async () => {
  const h = await harness();
  try {
    const id1 = seedEvent(h, "e1");
    const id2 = seedEvent(h, "e2");

    const first = await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
    assert.equal(first.status, "observing", "204 + idle must not be completion");
    assert.deepEqual(first.inboxIds, [id1, id2]);

    // Accepted async prompt: nonce user message persisted, no assistant turn yet.
    const rec = h.server.getRec(h.sessionId);
    assert.ok(rec && rec.messages.length === 1, "one nonce user message persisted by the fake server");
    assert.ok(!rec?.messages.some((m) => m.info.role === "assistant"), "no assistant turn yet");

    h.server.flushAsync(h.sessionId, { text: JSON.stringify({ kind: "resolution", envelope_id: "env-delivery-1", work_item_id: h.workItemId, outcome: "completed", reason: "repair complete" }) });
    const second = await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
    assert.equal(second.status, "delivered");
    assert.deepEqual(second.inboxIds, [id1, id2], "global inbox.id order preserved");

    const rows = listInboxByWorkItem(h.db, h.workItemId);
    assert.ok(rows.every((r) => r.state === "DELIVERED"));
    assert.ok(rows.every((r) => r.delivered_at !== null));

    const again = await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
    assert.equal(again.status, "no_pending", "a duplicate delivery is an auditable no-op");
  } finally {
    await h.cleanup();
  }
});

test("does not prompt while the session is busy (idle gate, no busy-rejection reliance)", async () => {
  const h = await harness();
  try {
    seedEvent(h, "busy-1");
    h.server.setBusy(h.sessionId);
    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
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
    await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
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
    await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
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
    await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
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

    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
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

    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
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
    const first = await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
    assert.equal(first.status, "observing");
    const nonce = first.nonce;
    assert.ok(nonce, "an in-flight delivery records its durable nonce");

    h.server.deleteSession(h.sessionId);
    const res = await relayOldestInbox(h.db, h.workItemId, h.driver, OPTS);
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
