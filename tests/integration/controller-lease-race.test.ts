// tests/integration/controller-lease-race.test.ts
//
// M4 durability under real concurrency: many child processes race to claim the
// SAME SQLite file. Proves the DB (BEGIN IMMEDIATE + busy retry) is the only
// correct mutex — claimants never double-claim, and capacity holds exactly at the
// global cap. No in-process mutex correctness is claimed anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createTestDb, seedRepository } from "../helpers/db.ts";
import { insertWorkItem, listWorkItemsByRepo } from "../../src/db/repositories.ts";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, "..", "fixtures", "claim-worker.ts");

function runWorker(dbPath: string, globalLimit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, dbPath, String(globalLimit)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`claim worker failed (${code}): ${err}`));
        return;
      }
      const line = out.split("\n").find((l) => l.startsWith("CLAIM\t"));
      if (!line) return resolve(null);
      const payload = line.slice("CLAIM\t".length);
      if (payload === "null") return resolve(null);
      try {
        resolve((JSON.parse(payload) as { workItemId: string }).workItemId);
      } catch {
        resolve(null);
      }
    });
  });
}

test("concurrent child claimants never double-claim and capacity holds at the global cap", async () => {
  const { db, path, cleanup } = createTestDb();
  try {
    const repo = seedRepository(db, { owner: "xiaden", name: "racerepo", maxConcurrentPerRepo: 20 });
    for (let i = 0; i < 8; i++) {
      insertWorkItem(db, {
        id: `wi-race-${i}`,
        repo_id: repo.id,
        state: "QUEUED",
        title: `race ${i}`,
        base_branch: "main",
      });
    }

    const workers = Array.from({ length: 8 }, () => runWorker(path, 3));
    const results = await Promise.all(workers);
    const claimed = results.filter((id): id is string => id !== null);

    assert.equal(claimed.length, 3, "exactly the global cap of claims must succeed");
    assert.equal(new Set(claimed).size, 3, "no two claimants may receive the same work item");

    const running = listWorkItemsByRepo(db, repo.id).filter((r) => r.state === "RUNNING");
    assert.equal(running.length, 3, "DB must show exactly 3 RUNNING items after the race");
  } finally {
    cleanup();
  }
});
