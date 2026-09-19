import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeHttp, OpenCodeHttpError } from "../../src/integrations/opencode-http.ts";
import { OpenCodeDriver } from "../../src/integrations/opencode-driver.ts";

const fixture = join(import.meta.dirname, "../fixtures/opencode-http-fixture/server.mjs");
const directory = "/workspace/fixture-smoke";

async function startFixture(): Promise<{ child: ChildProcess; baseUrl: string }> {
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

function stopFixture(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  });
}

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

    const syncNonce = `sync-${Date.now()}`;
    const sync = await driver.promptSession(ref.sessionId, { text: `sync ${syncNonce}`, nonce: syncNonce });
    assert.equal(sync.kind, "turn");
    assert.deepEqual(await driver.observeCompletion(ref.sessionId, syncNonce), {
      matched: true,
      nonceUserMessageId: sync.parentId ? (await driver.readHistory(ref.sessionId)).find((entry) => entry.info.id === sync.assistantId)?.info.parentID : undefined,
      assistantId: sync.assistantId,
      mode: "normal",
    });

    const asyncNonce = `async-${Date.now()}`;
    const accepted = await driver.promptAsync(ref.sessionId, { text: `async ${asyncNonce}`, nonce: asyncNonce });
    assert.equal(accepted.kind, "accepted");
    assert.deepEqual(await driver.observeCompletion(ref.sessionId, asyncNonce, accepted), { matched: false, reason: "no_turn" });
    let completion = await driver.observeCompletion(ref.sessionId, asyncNonce, accepted);
    for (let attempt = 0; attempt < 20 && !completion.matched; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completion = await driver.observeCompletion(ref.sessionId, asyncNonce, accepted);
    }
    assert.equal(completion.matched, true);
    assert.equal((await driver.readHistory(ref.sessionId)).some((entry) => entry.info.role === "assistant" && entry.info.parentID === completion.nonceUserMessageId), true);

    await stopFixture(child);
    await assert.rejects(http.getSession(ref.sessionId), (error: unknown) => error instanceof OpenCodeHttpError && error.status === 0);
  } finally {
    if (child.exitCode === null) await stopFixture(child);
    rmSync(registryDir, { recursive: true, force: true });
  }
});
