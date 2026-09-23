import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createTestDb, seedIssue, seedRepository } from "../helpers/db.ts";
import { buildTriageDigest } from "../../src/controller/triage.ts";
import { OpenCodeHttp, OpenCodeHttpError } from "../../src/integrations/opencode-http.ts";
import { OpenCodeDriver } from "../../src/integrations/opencode-driver.ts";

const fixture = join(import.meta.dirname, "../fixtures/opencode-http-fixture/server.mjs");
const directory = "/workspace/fixture-smoke";
const openapiPath = join(import.meta.dirname, "../fixtures/opencode-http-fixture/openapi/openapi.v1.18.31.json");
const baselinePath = join(import.meta.dirname, "../fixtures/opencode-http-fixture/openapi/active-baseline.v1.json");
const operationsPath = join(import.meta.dirname, "../fixtures/opencode-http-fixture/openapi/consumed-operations.v1.json");

async function startFixture(): Promise<{ child: ChildProcess | undefined; baseUrl: string }> {
  const configured = process.env.FIXTURE_BASE_URL;
  if (configured) return { child: undefined, baseUrl: configured };
  const child = spawn(process.execPath, [fixture], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture did not become ready")), 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      const match = /FIXTURE_READY (\d+)/.exec(chunk.toString());
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fixture exited before ready: ${code}`)));
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

function stopFixture(child: ChildProcess | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      resolve();
    };
    const forceKill = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      finish();
    }, 500);
    child.once("exit", finish);
    child.kill();
    if (child.exitCode !== null) finish();
  });
}

test("pinned baseline bytes and consumed operations remain exact", () => {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { version: string; openapi: string; sha256: string };
  const spec = readFileSync(openapiPath, "utf8");
  const operations = JSON.parse(readFileSync(operationsPath, "utf8")) as { method: string; path: string }[];
  assert.equal(baseline.version, "1.18.31");
  assert.equal(baseline.openapi, "3.1.0");
  assert.equal(createHash("sha256").update(spec).digest("hex"), baseline.sha256);
  assert.equal(operations.length, 10);
  const document = JSON.parse(spec) as { paths: Record<string, Record<string, unknown>> };
  for (const operation of operations) assert.ok(document.paths[operation.path]?.[operation.method.toLowerCase()], `${operation.method} ${operation.path} missing from pinned OpenAPI`);
});

test("real OpenCodeDriver triage prompt carries only the filtered projection", async () => {
  const { child, baseUrl } = await startFixture();
  const registryDir = mkdtempSync(join(tmpdir(), "tissue-fixture-triage-registry-"));
  const configPath = join(registryDir, "tissue.yml");
  writeFileSync(configPath, "security:\n  trustedGithubUsers: [TrustedUser]\n");
  const database = createTestDb();
  const repo = seedRepository(database.db);
  const issue = seedIssue(database.db, repo.id, {
    id: "fixture-issue",
    number: 7,
    title: "denied-title",
    body_json: JSON.stringify("denied-body"),
    envelope: {
      repository: repo.id,
      sourceKind: "issue",
      objectId: "7",
      contentId: null,
      observedVersion: "v1",
      contentHash: "hash",
      authoritativeAt: "2026-09-09T00:00:00.000Z",
      policyRevision: "fixture",
      actor: { present: true, rawLogin: "Mallory", normalizedLogin: "mallory", presence: "PRESENT" },
      decision: "TRUSTED",
      reason: "fixture",
      deliveryClass: "TRUSTED_PROSE",
    },
  });
  const http = new OpenCodeHttp({ baseUrl, timeoutMs: 2_000 });
  const driver = new OpenCodeDriver({ http, registryDir });
  try {
    const ref = await driver.createRealSession("triage", directory, { repoId: "fixture/repo", directory, kind: "triage" });
    const digest = buildTriageDigest(database.db, repo, issue, configPath);
    await driver.promptTriage(ref.sessionId, digest);
    const user = (await driver.readHistory(ref.sessionId)).find((entry) => entry.info.role === "user");
    const text = user?.parts.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join(" ") ?? "";
    assert.match(text, new RegExp(`issue_id=${issue.id}`));
    assert.match(text, /title=\n/);
    assert.match(text, /body=\n/);
    assert.match(text, /number=7/);
    assert.doesNotMatch(text, /denied-title|denied-body/);
  } finally {
    if (child?.exitCode === null) await stopFixture(child);
    database.cleanup();
    rmSync(registryDir, { recursive: true, force: true });
  }
});

test("fixture is not compatibility or plugin-loading evidence", () => {
  const source = readFileSync(fixture, "utf8");
  assert.doesNotMatch(source, /plugin|beacon|credential|model output|opencode serve/i);
  assert.match(source, /deterministic|logicalTime/);
});

test("dependency-free fixture exercises the real OpenCode HTTP/driver boundary", async () => {
  const { child, baseUrl } = await startFixture();
  const registryDir = mkdtempSync(join(tmpdir(), "tissue-fixture-registry-"));
  const http = new OpenCodeHttp({ baseUrl, timeoutMs: 2_000 });
  const driver = new OpenCodeDriver({ http, registryDir });
  try {
    const ref = await driver.createRealSession("triage", directory, { repoId: "fixture/repo", directory, kind: "triage" });
    assert.match(ref.sessionId, /^ses_[A-Za-z0-9]+$/);
     const session = await driver.getSession(ref.sessionId);
     assert.equal(session.directory, directory);
     assert.match(session.projectID, /^fixture-project-/);
     assert.equal(await driver.getSessionStatus(ref.sessionId), "idle");

     const scopedSessions = await http.listSessions(directory);
     assert.ok(scopedSessions.some((candidate) => candidate.id === ref.sessionId));
     assert.deepEqual(await http.firstEvent(), {
       type: "server.connected",
       properties: { fixture: true, logicalTime: 1_700_000_000_001 },
     });

     await http.abortSession(ref.sessionId);
     assert.equal((await http.getSession(ref.sessionId)).id, ref.sessionId);

     const syncNonce = `sync-${Date.now()}`;
    const sync = await driver.promptSession(ref.sessionId, { text: `sync ${syncNonce}`, nonce: syncNonce });
    assert.equal(sync.kind, "turn");
    assert.deepEqual(await driver.observeCompletion(ref.sessionId, syncNonce), {
      matched: true,
       nonceUserMessageId: sync.parentId ?? undefined,
      assistantId: sync.assistantId,
      mode: "normal",
    });

    const asyncNonce = `async-${Date.now()}`;
    const accepted = await driver.promptAsync(ref.sessionId, { text: `async ${asyncNonce}`, nonce: asyncNonce });
    assert.equal(accepted.kind, "accepted");
    assert.deepEqual(await driver.observeCompletion(ref.sessionId, asyncNonce, accepted), { matched: false, reason: "no_turn" });
    const retryNonce = `retry-${Date.now()}`;
    await driver.promptAsync(ref.sessionId, { text: `retry ${retryNonce}`, nonce: retryNonce });
    const retryStatus = await driver.getSessionStatus(ref.sessionId);
    assert.equal(retryStatus, "retry");
    let completion = await driver.observeCompletion(ref.sessionId, asyncNonce, accepted);
    for (let attempt = 0; attempt < 20 && !completion.matched; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completion = await driver.observeCompletion(ref.sessionId, asyncNonce, accepted);
    }
    assert.equal(completion.matched, true);
     assert.equal((await driver.readHistory(ref.sessionId)).some((entry) => entry.info.role === "assistant" && entry.info.parentID === completion.nonceUserMessageId), true);

     await http.deleteSession(ref.sessionId);
     await assert.rejects(http.getSession(ref.sessionId), (error: unknown) => error instanceof OpenCodeHttpError && error.status === 404);

     if (child) {
      await stopFixture(child);
      await assert.rejects(http.getSession(ref.sessionId), (error: unknown) => error instanceof OpenCodeHttpError && error.status === 0);
    }
  } finally {
    if (child?.exitCode === null) await stopFixture(child);
    rmSync(registryDir, { recursive: true, force: true });
  }
});
