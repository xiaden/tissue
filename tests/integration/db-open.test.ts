// tests/integration/db-open.test.ts
//
// P2-S1 spec-first tests: openTissueDb configures foreign keys / WAL / FULL
// synchronous / busy timeout; numbered migrations apply to the latest version
// and re-running is a no-op; migrations are transactional (a mid-batch failure
// rolls back every effect); runWrite commits and rolls back atomically; and
// openTissueDb never opens/writes/delete OpenCode's shared DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Create a fresh, unique temporary path for a Tissue db file. */
function mkdtempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "tissue-open-")), "tissue.db");
}

import {
  openTissueDb,
  runWrite,
  closeDb,
  assertNotOpencodeState,
  isBusyError,
  TissueDbError,
  SQLITE_BUSY,
} from "../../src/db/open.ts";
import { applyMigrations, installMigrations, SCHEMA_VERSION, type MigrationDef } from "../../src/db/migrations.ts";
import { upsertRepository } from "../../src/db/repositories.ts";
import { createTestDb } from "../helpers/db.ts";


test("openTissueDb applies migrations to the latest version on a fresh file", () => {
  const { db, cleanup } = createTestDb();
  try {
    const versions = db.sql
      .all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")
      .map((r) => r.version);
    assert.deepEqual(versions, Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
    assert.equal(db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM repositories")?.c, 0);
  } finally {
    cleanup();
  }
});

test("applyMigrations is idempotent: re-running after success is a no-op", () => {
  const { db, cleanup } = createTestDb();
  try {
    const again = applyMigrations(db);
    assert.equal(again.previousVersion, SCHEMA_VERSION);
    assert.equal(again.version, SCHEMA_VERSION);
    assert.deepEqual(again.applied, []);
  } finally {
    cleanup();
  }
});

test("openTissueDb configures foreign keys, WAL, FULL synchronous, and busy timeout", () => {
  const { db, cleanup } = createTestDb();
  try {
    const fk = db.sql.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!;
    assert.equal(fk.foreign_keys, 1, "foreign keys must be ON");
    const journal = db.sql.get<{ journal_mode: string }>("PRAGMA journal_mode")!;
    assert.equal(journal.journal_mode, "wal", "journal mode must be WAL");
    const sync = db.sql.get<{ synchronous: number }>("PRAGMA synchronous")!;
    assert.equal(sync.synchronous, 2, "synchronous must be FULL (=2)");
    const timeout = db.sql.get<{ timeout: number }>("PRAGMA busy_timeout")!;
    assert.equal(timeout.timeout, 5000, "default busy timeout is 5000ms");
  } finally {
    cleanup();
  }
});

test("runWrite commits a multi-statement write atomically", () => {
  const { db, cleanup } = createTestDb();
  try {
    const id = runWrite(db, (tx) => {
      const row = upsertRepository(tx, {
        id: "repo-rw",
        owner: "xiaden",
        name: "rwrepo",
        remote: "https://github.com/xiaden/rwrepo.git",
        local_dir: "/workspace/rwrepo",
        baseline_at: "2026-09-01T00:00:00.000Z",
        poll_interval_seconds: 300,
      });
      return row.id;
    });
    assert.equal(id, "repo-rw");
    assert.equal(upsertRepository(db, {
      id: "x",
      owner: "xiaden",
      name: "rwrepo",
      remote: "https://github.com/xiaden/rwrepo.git",
      local_dir: "/workspace/rwrepo",
      baseline_at: "2026-09-01T00:00:00.000Z",
      poll_interval_seconds: 300,
    }).id, "repo-rw", "upsert on (owner,name) keeps the first id");
  } finally {
    cleanup();
  }
});

test("runWrite rolls back atomically when the operation throws", () => {
  const { db, cleanup } = createTestDb();
  try {
    assert.throws(() =>
      runWrite(db, () => {
        upsertRepository(db, {
          id: "repo-rollback",
          owner: "xiaden",
          name: "rollback",
          remote: "https://github.com/xiaden/rollback.git",
          local_dir: "/workspace/rollback",
          baseline_at: "2026-09-01T00:00:00.000Z",
          poll_interval_seconds: 300,
        });
        throw new Error("boom after insert");
      }),
    /boom/,
    );
    const count = db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM repositories")?.c ?? 0;
    assert.equal(count, 0, "inserted row must be rolled back");
    // db is still usable after rollback
    upsertRepository(db, {
      id: "repo-after",
      owner: "xiaden",
      name: "after",
      remote: "https://github.com/xiaden/after.git",
      local_dir: "/workspace/after",
      baseline_at: "2026-09-01T00:00:00.000Z",
      poll_interval_seconds: 300,
    });
    assert.equal(db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM repositories")?.c, 1);
  } finally {
    cleanup();
  }
});

test("a failed migration batch rolls back every effect and leaves a clean schema_migrations", () => {
  // Open WITHOUT migrations, then attempt a broken batch that creates a real table
  // and then fails. Both the created table and the recorded version must roll back.
  const dir = mkdtempFile();
  const open2 = openTissueDb(dir, { migrate: false });
  try {
    const broken: MigrationDef[] = [
      {
        version: 1,
        name: "good_first",
        statements: ["CREATE TABLE IF NOT EXISTS good_table(x INTEGER);"],
      },
      {
        version: 2,
        name: "bad_second",
        statements: ["CREATE TABLE bad_table(y TEXT);", "INSERT INTO no_such_table VALUES(1);"],
      },
    ];
    assert.throws(() => installMigrations(open2, broken), /no such table|no_such_table/i);
    const names = open2.sql
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name);
    assert.ok(!names.includes("good_table"), "earlier migration's table must be rolled back");
    assert.ok(!names.includes("bad_table"), "failing migration's table must be rolled back");
    const versions = open2.sql.all<{ version: number }>("SELECT version FROM schema_migrations");
    assert.equal(versions.length, 0, "no migration version may be recorded on failure");
    const res = applyMigrations(open2);
    assert.equal(res.version, SCHEMA_VERSION);
    assert.deepEqual(res.applied, Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
  } finally {
    closeDb(open2);
    rmSync(dir, { force: true });
  }
});



test("openTissueDb refuses OpenCode shared state before creating any handle", () => {
  const ocDb = join(homedir(), ".local", "share", "opencode", "opencode.db");
  const ocConfig = join(homedir(), ".config", "opencode", "opencode.json");
  assert.throws(() => openTissueDb(ocDb), /refusing to open OpenCode/i);
  assert.throws(() => assertNotOpencodeState(ocConfig), /refusing to open OpenCode/i);
  // A normal temp path is allowed.
  const { db, cleanup } = createTestDb();
  try {
    assert.ok(db.path.endsWith("tissue.db"));
  } finally {
    cleanup();
  }
});

test("isBusyError classifies SQLITE_BUSY distinctly from other errors", () => {
  assert.equal(isBusyError(new TissueDbError("database is locked", SQLITE_BUSY)), true);
  const rawErr = Object.assign(new Error("SQLITE_BUSY: database is locked"), { errcode: SQLITE_BUSY });
  assert.equal(isBusyError(rawErr), true);
  assert.equal(isBusyError(new Error("FOREIGN KEY constraint failed")), false);
  assert.equal(isBusyError(null), false);
});

// NOTE: refusal of OpenCode's shared DB is proven behaviourally by the
// "openTissueDb refuses OpenCode shared state" test above, not by scanning
// source text (doc comments legitimately name the file).
