// tests/integration/opencode-driver.test.ts
//
// M6 Phase 3 (P3-S3) contract tests for the REAL OpenCode driver
// (src/integrations/opencode-driver.ts) against the TEST-ONLY pessimistic fake
// server (tests/helpers/pessimistic-opencode-server.ts). The driver runs on its
// production raw-HTTP transport (src/integrations/opencode-http.ts), so these
// tests exercise the real code path end-to-end — no SDK client, no real serve,
// no opencode.db. Real-server probes (create/list/status/history/SSE/prompt
// transport) live in tests/integration/opencode-real-probe.test.ts and are
// gated behind TISSUE_REAL_OPENCODE=1 so `npm test` stays green without a server.
//
// Coverage (CONTRACTS/DD RG-4):
//   - ses_... identity enforcement + server-assigned projectID (never derived)
//   - directory mapping (session created with ?directory= maps to that dir)
//   - busy/retry reported non-idle; idle-vs-missing disambiguated
//   - acceptance != completion (204 alone is never completion)
//   - observeCompletion requires nonce-bearing user message + subsequent
//     assistant turn with parentID = that message, excluding summary=true and
//     mode=compaction
//   - never-concurrent prompt guard; sync desync never reported as completion
//   - no lifecycle-mutating Tissue tools reachable by sessions
//   - real transcript retention (history readable after completion)
//   - mapping persisted only in the Tissue opencode_sessions table
//   - fake never hard-codes rejection (can succeed or fail per scenario)

import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenCodeHttp, OpenCodeHttpError } from "../../src/integrations/opencode-http.ts";
import { OpenCodeDriver } from "../../src/integrations/opencode-driver.ts";
import { SessionDriverError } from "../../src/controller/session-driver.ts";
import { startPessimisticServer, type PessimisticOpenCodeServer } from "../helpers/pessimistic-opencode-server.ts";
import { createTestDb, seedRepository } from "../helpers/db.ts";

const DIR = "/workspace/nomarr";
// Plan J: every real driver construction must supply a writable registry dir so
// createRealSession can write the ses_* marker. The pessimistic fake server
// reuses ses_1/ses_2 per instance, so each driver gets a fresh temp dir.
function newRegistryDir(): string {
  return mkdtempSync(join(tmpdir(), "tissue-opencode-driver-registry-"));
}

interface Harness {
  driver: OpenCodeDriver;
  http: OpenCodeHttp;
  server: PessimisticOpenCodeServer;
  cleanup: () => Promise<void>;
  sessionId: string;
}

async function harness(serverOpts: Parameters<typeof startPessimisticServer>[0] = {}, withDb = false): Promise<Harness> {
  const server = await startPessimisticServer(serverOpts);
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  let dbCleanup: (() => void) | undefined;
  let db: ReturnType<typeof createTestDb>["db"] | undefined;
  let repoId = "xiaden/nomarr";
  if (withDb) {
    const t = createTestDb();
    db = t.db;
    dbCleanup = t.cleanup;
    const repo = seedRepository(db);
    repoId = repo.id;
  }
  const registryDir = newRegistryDir();
  const driver = new OpenCodeDriver({ http, ...(db ? { db } : {}), registryDir });
  const ref = await driver.createRealSession("triage", DIR, {
    repoId,
    directory: DIR,
    kind: "triage",
  });
  return {
    driver,
    http,
    server,
    sessionId: ref.sessionId,
    cleanup: async () => {
      await server.close();
      dbCleanup?.();
      rmSync(registryDir, { recursive: true, force: true });
    },
  };
}

test("createRealSession returns only an OpenCode-created ses_... identity (refuses others)", async () => {
  const server = await startPessimisticServer({ sessionIdPrefix: "ses_" });
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  try {
    const ref = await driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" });
    assert.match(ref.sessionId, /^ses_[A-Za-z0-9]+$/, "identity must be ses_...");
    assert.equal(ref.directory, DIR);
  } finally {
    await server.close();
  }
});

test("createRealSession rejects a non-ses_ server identity (real-session identity is only real)", async () => {
  const server = await startPessimisticServer({ sessionIdPrefix: "foo_" });
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  try {
    await assert.rejects(
      driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" }),
      /non-ses_/,
    );
  } finally {
    await server.close();
  }
});

test("session created with ?directory= maps to that directory; projectID is server-assigned, never derived", async () => {
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  try {
    const ref = await driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" });
    const rec = server.sessionByDirectory(DIR);
    assert.ok(rec, "fake server must record the directory-scoped session");
    assert.equal(rec.id, ref.sessionId);

    const dirScoped = await driver.listSessions(DIR);
    assert.ok(dirScoped.some((s) => s.id === ref.sessionId), "list by directory must return the session");

    const other = await driver.listSessions("/workspace/other");
    assert.ok(!other.some((s) => s.id === ref.sessionId), "list is exact-directory scoped");

    const fetched = await driver.getSession(ref.sessionId);
    // projectID is whatever the server assigned; the driver must not derive it.
    assert.equal(fetched.projectID, rec.projectID);
    assert.ok(fetched.projectID !== DIR && fetched.projectID !== ref.sessionId, "projectID is an independent server id");
  } finally {
    await server.close();
  }
});

test("getSessionStatus maps idle/busy/retry/missing and never confuses idle with missing", async () => {
  const { driver, sessionId, cleanup } = await harness();
  try {
    // Fresh session is idle even though the status map reports only non-idle.
    assert.equal(await driver.getSessionStatus(sessionId), "idle");
  } finally {
    await cleanup();
  }
});

test("busy and retry are reported NON-idle; a deleted session is missing", async () => {
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  const { sessionId } = await driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" });
  try {
    server.setBusy(sessionId);
    assert.equal(await driver.getSessionStatus(sessionId), "busy");

    server.setRetry(sessionId, 2, "rate limited", Date.now() + 5000);
    assert.equal(await driver.getSessionStatus(sessionId), "retry");

    server.deleteSession(sessionId);
    assert.equal(await driver.getSessionStatus(sessionId), "missing");
  } finally {
    await server.close();
  }
});

test("RG-3 alignment: a busy prompt is accepted and persisted, never busy-rejected by default", async () => {
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  const { sessionId } = await driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" });
  try {
    server.setBusy(sessionId);
    const nonce = `rg3-busy-${Date.now()}`;
    // Real 1.18.18 does NOT busy-reject; the aligned fake must accept (204/accept).
    const accepted = await driver.promptAsync(sessionId, { text: `second ${nonce}`, nonce });
    assert.equal(accepted.kind, "accepted");
    // The nonce user message persists even though the session stays busy.
    const history = await driver.readHistory(sessionId);
    const persisted = history.some(
      (h) => h.info.role === "user" && h.parts.some((p) => p.type === "text" && (p as { text?: string }).text?.includes(nonce)),
    );
    assert.equal(persisted, true, "busy prompt must persist its user message");
    // Acceptance is NOT completion: no qualifying parent-linked turn yet.
    assert.deepEqual(await driver.observeCompletion(sessionId, nonce), { matched: false, reason: "no_turn" });
    // Persist-and-queue: the accepted message can still complete later.
    server.flushAsync(sessionId);
    const after = await driver.observeCompletion(sessionId, nonce);
    assert.equal(after.matched, true, "queued accepted prompt completes when its turn arrives");
  } finally {
    await server.close();
  }
});

test("RG-3 alignment: 409 busy rejection is an explicit opt-in scenario, not the default", async () => {
  const server = await startPessimisticServer();
  server.promptWhileBusy = "http_409";
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  const { sessionId } = await driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" });
  try {
    server.setBusy(sessionId);
    await assert.rejects(
      driver.promptAsync(sessionId, { text: "rejected only when explicitly configured" }),
      OpenCodeHttpError,
    );
  } finally {
    await server.close();
  }
});

test("acceptance != completion: a 204 async prompt is never completion until a turn is observed", async () => {
  const { driver, server, sessionId, cleanup } = await harness();
  const nonce = `nonce-204-${Date.now()}`;
  try {
    const obs = await driver.promptAsync(sessionId, { text: `resolve ${nonce}`, nonce });
    assert.equal(obs.kind, "accepted");

    // 204 acceptance alone is NOT completion — the transcript has the nonce user
    // message but no parent-linked assistant turn yet.
    const before = await driver.observeCompletion(sessionId, nonce, obs);
    assert.deepEqual(before, { matched: false, reason: "no_turn" });

    // The fake flushes the accepted async prompt into a real assistant turn.
    server.flushAsync(sessionId);
    const after = await driver.observeCompletion(sessionId, nonce, obs);
    assert.equal(after.matched, true);
    if (after.matched) assert.equal(after.mode, "normal");
  } finally {
    await cleanup();
  }
});

test("promptSession is a sync turn barrier and observeCompletion matches the parent-linked turn", async () => {
  const { driver, sessionId, cleanup } = await harness();
  const nonce = `nonce-turn-${Date.now()}`;
  try {
    const obs = await driver.promptSession(sessionId, { text: `resolve ${nonce}`, nonce });
    assert.equal(obs.kind, "turn");
    assert.equal(obs.mode, "normal");
    assert.equal(obs.summary, false);

    const match = await driver.observeCompletion(sessionId, nonce, obs);
    assert.equal(match.matched, true);
    if (match.matched) {
      assert.equal(match.assistantId, obs.assistantId);
      assert.equal(match.mode, "normal");
    }
  } finally {
    await cleanup();
  }
});

test("observeCompletion: a lone nonce user message (noReply-equivalent) is not completion", async () => {
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  const { sessionId } = await driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" });
  try {
    const nonce = `nonce-only-${Date.now()}`;
    server.appendUserMessage(sessionId, `hello ${nonce}`);
    const m = await driver.observeCompletion(sessionId, nonce);
    assert.deepEqual(m, { matched: false, reason: "no_turn" });
  } finally {
    await server.close();
  }
});

test("observeCompletion excludes summary=true / mode=compaction turns, then matches a later real turn", async () => {
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  const { sessionId } = await driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" });
  try {
    const nonce = `nonce-compaction-${Date.now()}`;
    const userMsgId = server.appendUserMessage(sessionId, `resolve ${nonce}`);
    server.appendAssistantTurn(sessionId, { parentID: userMsgId, summary: true, mode: "compaction", text: "summary" });

    // Compaction summary parented to the nonce is explicitly NOT completion.
    const blocked = await driver.observeCompletion(sessionId, nonce);
    assert.deepEqual(blocked, { matched: false, reason: "only_summary_or_compaction" });

    // A later genuine assistant turn parented to the same nonce completes.
    const realTurn = server.appendAssistantTurn(sessionId, { parentID: userMsgId, mode: "normal", text: "done" });
    const match = await driver.observeCompletion(sessionId, nonce);
    assert.equal(match.matched, true);
    if (match.matched) {
      assert.equal(match.assistantId, realTurn);
      assert.equal(match.nonceUserMessageId, userMsgId);
      assert.equal(match.mode, "normal");
    }
  } finally {
    await server.close();
  }
});

test("observeCompletion requires parentID = the nonce user message (a different parent is not completion)", async () => {
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  const { sessionId } = await driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" });
  try {
    const nonce = `nonce-parent-${Date.now()}`;
    server.appendUserMessage(sessionId, `resolve ${nonce}`);
    // An assistant turn parented to a DIFFERENT message must not satisfy matching.
    server.appendAssistantTurn(sessionId, { parentID: "msg_some_other", mode: "normal", text: "unrelated" });
    const m = await driver.observeCompletion(sessionId, nonce);
    assert.deepEqual(m, { matched: false, reason: "no_turn" });
  } finally {
    await server.close();
  }
});

test("missing session (deleted) resolves to missing status and session_missing completion", async () => {
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  const { sessionId } = await driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" });
  try {
    server.deleteSession(sessionId);
    assert.equal(await driver.getSessionStatus(sessionId), "missing");
    const m = await driver.observeCompletion(sessionId, "any-nonce");
    assert.deepEqual(m, { matched: false, reason: "session_missing" });
  } finally {
    await server.close();
  }
});

test("never issues controller prompts concurrently (defensive guard)", async () => {
  const { driver, sessionId, cleanup } = await harness();
  try {
    const first = driver.promptSession(sessionId, { text: "first" });
    await assert.rejects(driver.promptSession(sessionId, { text: "second" }), SessionDriverError);
    const obs = await first;
    assert.equal(obs.kind, "turn");
  } finally {
    await cleanup();
  }
});

test("a sync desync (no assistant turn returned) surfaces as an error, never as completion", async () => {
  const { driver, sessionId, cleanup } = await harness();
  try {
    // noReply = user injection with no AI turn; the driver must not report a turn.
    await assert.rejects(driver.promptSession(sessionId, { text: "note only", noReply: true }), OpenCodeHttpError);
  } finally {
    await cleanup();
  }
});

test("real transcript is retained and readable after completion", async () => {
  const { driver, sessionId, cleanup } = await harness();
  const nonce = `nonce-retain-${Date.now()}`;
  try {
    await driver.promptSession(sessionId, { text: `resolve ${nonce}`, nonce });
    const history = await driver.readHistory(sessionId);
    const userTexts = history.map((h) => h.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
    assert.ok(userTexts.some((t) => t.includes(nonce)), "nonce user message retained in transcript");
    const assistants = history.filter((h) => h.info.role === "assistant");
    assert.ok(assistants.length >= 1, "assistant turn retained in transcript");
  } finally {
    await cleanup();
  }
});

test("mapping is persisted only in the Tissue opencode_sessions table", async () => {
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const driver = new OpenCodeDriver({ http, db: t.db, registryDir: newRegistryDir() });
    const ref = await driver.createRealSession("triage", DIR, {
      repoId: repo.id,
      directory: DIR,
      kind: "triage",
    });
    const row = t.db.sql.get<{ id: string; directory: string; kind: string; state: string }>(
      "SELECT id, directory, kind, state FROM opencode_sessions WHERE id = ?",
      ref.sessionId,
    );
    assert.ok(row, "session mapping row must exist in opencode_sessions");
    assert.equal(row.id, ref.sessionId);
    assert.equal(row.directory, DIR);
    assert.equal(row.kind, "triage");
    assert.equal(row.state, "ACTIVE");
  } finally {
    await server.close();
    t.cleanup();
  }
});

test("the driver exposes no lifecycle-mutating Tissue tool surface to sessions", async () => {
  const { driver, cleanup } = await harness();
  try {
    const protoMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(driver)).filter((n) => n !== "constructor").sort();
    const expected = [
      "abortSession",
      "buildPromptBody",
      "createRealSession",
      "ensureSession",
      "getSession",
      "getSessionStatus",
      "listSessions",
      "observeCompletion",
      "promptAsync",
      "promptSession",
      "readHistory",
      "readResolutionResult",
      "promptTriage",
    ].sort();
    assert.deepEqual(protoMethods, expected, "driver method surface is the closed session-op set");
    const lifecycle = /(command|shell|worktree|pull_request|pr\b|effect|enqueue|issue_lifecycle|applyEnvelope)/i;
    for (const m of protoMethods) {
      assert.ok(!lifecycle.test(m), `driver must not expose lifecycle tool '${m}'`);
    }
  } finally {
    await cleanup();
  }
});

test("the fake server is pessimistic: prompts can succeed OR fail per scenario (never hard-coded)", async () => {
  const server = await startPessimisticServer();
  const http = new OpenCodeHttp({ baseUrl: server.baseUrl() });
  const driver = new OpenCodeDriver({ http, registryDir: newRegistryDir() });
  const { sessionId } = await driver.createRealSession("triage", DIR, { repoId: "r1", directory: DIR, kind: "triage" });
  try {
    // Succeeds by default (fake CAN succeed).
    const obs = await driver.promptSession(sessionId, { text: "ok" });
    assert.equal(obs.kind, "turn");

    // Configured failure path (fake does NOT assume prompts always succeed).
    server.syncPromptErrorCode = 503;
    await assert.rejects(driver.promptSession(sessionId, { text: "boom" }), OpenCodeHttpError);
  } finally {
    await server.close();
  }
});
