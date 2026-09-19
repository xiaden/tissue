// Plan N Phase 1 — health listener spec-first contract.
// The implementation is intentionally deferred to Phase 2; these tests define
// the listener and folded readiness contract without Docker.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHealthServer } from "../../src/runtime/health-server.ts";

function openDb(): { isOpen: () => boolean } {
  return { isOpen: () => true };
}

function closedDb(): { isOpen: () => boolean } {
  return { isOpen: () => false };
}

test("P1-S4 health listener reports liveness independently of resident readiness", async () => {
  const registryDir = mkdtempSync(join(tmpdir(), "tissue-health-registry-"));
  mkdirSync(registryDir, { recursive: true });
  const server = await startHealthServer({
    port: 0,
    db: openDb() as never,
    registryDir,
    residentReachable: async () => false,
  });
  try {
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    const body = await response.json() as { liveness: boolean; readiness: boolean; residentReachable: boolean };
    assert.equal(body.liveness, true);
    assert.equal(body.readiness, false);
    assert.equal(body.residentReachable, false);
  } finally {
    await server.close();
  }
});

test("P1-S4 health readiness folds registry assertion and resident reachability", async () => {
  const registryDir = mkdtempSync(join(tmpdir(), "tissue-health-ready-"));
  const server = await startHealthServer({
    port: 0,
    db: openDb() as never,
    registryDir,
    residentReachable: async () => true,
  });
  try {
    const first = await (await fetch(server.url)).json() as { liveness: boolean; readiness: boolean };
    assert.equal(first.liveness, true);
    assert.equal(first.readiness, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = await (await fetch(server.url)).json() as { liveness: boolean; readiness: boolean };
    assert.equal(body.liveness, true);
    assert.equal(body.readiness, true);
  } finally {
    await server.close();
  }
});

test("P5-S2 closed DB returns non-live response while listener remains available", async () => {
  const server = await startHealthServer({ port: 0, db: closedDb() as never });
  try {
    const response = await fetch(server.url);
    assert.equal(response.status, 503);
    const body = await response.json() as { liveness: boolean; readiness: boolean };
    assert.equal(body.liveness, false);
    assert.equal(body.readiness, false);
    const secondResponse = await fetch(server.url);
    assert.equal(secondResponse.status, 503);
  } finally {
    await server.close();
  }
});

test("P5-S2 unknown paths and unsupported methods return 404", async () => {
  const server = await startHealthServer({ port: 0, db: openDb() as never });
  try {
    assert.equal((await fetch(`${server.url}/unknown`)).status, 404);
    assert.equal((await fetch(server.url, { method: "POST" })).status, 404);
  } finally {
    await server.close();
  }
});

test("P5-S2 rejecting resident probe only changes informational readiness", async () => {
  const registryDir = mkdtempSync(join(tmpdir(), "tissue-health-reject-"));
  const server = await startHealthServer({
    port: 0,
    db: openDb() as never,
    registryDir,
    residentReachable: async () => { throw new Error("resident unavailable"); },
  });
  try {
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    const body = await response.json() as { liveness: boolean; readiness: boolean; residentReachable: boolean };
    assert.equal(body.liveness, true);
    assert.equal(body.readiness, false);
    assert.equal(body.residentReachable, false);
    assert.equal((await fetch(server.url)).status, 200);
  } finally {
    await server.close();
  }
});

test("P6 health responds before a never-settling resident probe and publishes only later", async () => {
  const registryDir = mkdtempSync(join(tmpdir(), "tissue-health-hang-"));
  let resolveProbe!: (value: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { resolveProbe = resolve; });
  const server = await startHealthServer({ port: 0, db: openDb() as never, registryDir, residentReachable: () => pending });
  try {
    const first = await Promise.race([
      fetch(server.url).then((response) => response.json() as Promise<{ liveness: boolean; readiness: boolean; residentReachable: boolean }>),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("health response deadline exceeded")), 100)),
    ]);
    assert.equal(first.liveness, true);
    assert.equal(first.readiness, false);
    assert.equal(first.residentReachable, false);
    resolveProbe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const later = await (await fetch(server.url)).json() as { liveness: boolean; readiness: boolean; residentReachable: boolean };
    assert.equal(later.liveness, true);
    assert.equal(later.readiness, true);
    assert.equal(later.residentReachable, true);
  } finally {
    await server.close();
  }
});

test("P1-S4 health server refuses an occupied port with a clear error", async () => {
  const first = await startHealthServer({ port: 0, db: openDb() as never });
  try {
    const occupiedPort = new URL(first.url).port;
    await assert.rejects(
      startHealthServer({ port: Number(occupiedPort), db: openDb() as never }),
      /EADDRINUSE|already in use/i,
    );
  } finally {
    await first.close();
  }
 });
