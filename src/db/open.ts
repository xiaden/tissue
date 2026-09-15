// src/db/open.ts
//
// M2 durable store opening and transaction primitive (R1/R7/R21).
//
// Contract: `openTissueDb(path, options) -> TissueDb` opens ONLY Tissue's own
// SQLite database. It never opens, writes, migrates, or deletes OpenCode's
// shared database (~/.local/share/opencode/opencode.db) or any
// ~/.config/opencode state. It configures foreign keys, WAL journal mode, FULL
// synchronous durability, and a busy timeout, then applies numbered migrations
// before any effects are available.
//
// `runWrite(db, operation)` executes the operation inside one short
// `BEGIN IMMEDIATE` transaction, committing atomically on success and rolling
// back on any failure. Every durable write goes through runWrite.
//
// SQLite is Release-Candidate stability in node:sqlite; this module uses only
// its tested subset (DatabaseSync.exec/prepare with run/get/all, PRAGMA via
// exec). SQLITE_BUSY (errcode 5) is classified as transient/retryable here so a
// later phase can back off instead of treating it as correctness-by-mutex.

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { applyMigrations, type MigrationResult } from "./migrations.ts";

/** Anything node:sqlite can bind as a parameter (validated at the boundary). */
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** Minimal statement surface over the live DatabaseSync. */
export interface Sql {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): RunResult;
  get<T extends object>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T extends object>(sql: string, ...params: SqlValue[]): T[];
}

/** Error raised for Tissue DB problems; `code` may carry the SQLite code. */
export class TissueDbError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "TissueDbError";
    this.code = code;
  }
}

/** SQLITE_BUSY — classified transient/retryable, never correctness-by-mutex. */
export const SQLITE_BUSY = 5;

/** True when `err` is a SQLITE_BUSY (database is locked) condition. */
export function isBusyError(err: unknown): boolean {
  if (err instanceof TissueDbError) return err.code === SQLITE_BUSY;
  if (err instanceof Error) {
    const code = (err as Error & { errcode?: unknown }).errcode;
    if (typeof code === "number") return code === SQLITE_BUSY;
    return /database is locked|SQLITE_BUSY/i.test(err.message);
  }
  return false;
}

function sqlOf(raw: DatabaseSync): Sql {
  return {
    exec(sql: string): void {
      raw.exec(sql);
    },
    run(sql: string, ...params: SqlValue[]): RunResult {
      const st = raw.prepare(sql);
      const r = st.run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get<T extends object>(sql: string, ...params: SqlValue[]): T | undefined {
      const st = raw.prepare(sql);
      return st.get(...params) as T | undefined;
    },
    all<T extends object>(sql: string, ...params: SqlValue[]): T[] {
      const st = raw.prepare(sql);
      return st.all(...params) as T[];
    },
  };
}

// ---- OpenCode shared-state guard (R21/R17) ---------------------------------
// Tissue must never open/write/migrate/delete OpenCode's shared SQLite store or
// its ~/.config state. The canonical locations are derived from the real HOME,
// not guessed, and any path beneath them is refused before a handle is created.

const OPENDATA_DIR = join(homedir(), ".local", "share", "opencode");
const OPCONFIG_DIR = join(homedir(), ".config", "opencode");

/** Throws unless `path` points somewhere that is not OpenCode's shared state. */
export function assertNotOpencodeState(path: string): void {
  const abs = resolve(path);
  const under = (dir: string): boolean => abs === dir || abs.startsWith(dir + sep);
  if (under(OPENDATA_DIR) || under(OPCONFIG_DIR)) {
    throw new TissueDbError(
      `refusing to open OpenCode's shared state at '${abs}' — Tissue uses its own separate database`,
    );
  }
}

export interface DbOptions {
  /** History/audit retention window in days, used for housekeeping deadlines (R22). */
  retentionDays?: number;
  /** Busy timeout in ms (default 5000). SQLITE_BUSY beyond it surfaces distinctly. */
  busyTimeoutMs?: number;
  /** When false, open the database without applying migrations (default true). */
  migrate?: boolean;
}

export interface TissueDb {
  /** Absolute path of the opened Tissue database file. */
  readonly path: string;
  /** Configured retention window in days (R22). */
  readonly retentionDays: number;
  /** Statement surface (read/write) for repository access. */
  readonly sql: Sql;
  /** Raw DatabaseSync for low-level transactional control (BEGIN IMMEDIATE). */
  readonly raw: DatabaseSync;
}

/** A write-transaction handle — the same TissueDb while a BEGIN IMMEDIATE is open. */
export type WriteTx = TissueDb;

/**
 * Open Tissue's own durable SQLite database at `path`.
 *
 * Enables foreign keys, WAL journal mode, FULL synchronous durability, and a
 * busy timeout, then (unless `migrate: false`) applies numbered migrations
 * before returning. Throws if `path` resolves into OpenCode's shared state.
 */
export function openTissueDb(path: string, options: DbOptions = {}): TissueDb {
  assertNotOpencodeState(path);
  const retentionDays = options.retentionDays ?? 90;
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;

  const raw = new DatabaseSync(path);
  try {
    raw.exec("PRAGMA foreign_keys = ON;");
    const journal = raw.prepare("PRAGMA journal_mode = WAL").get() as {
      journal_mode: string;
    };
    if (journal.journal_mode !== "wal") {
      throw new TissueDbError(`expected WAL journal mode, got '${journal.journal_mode}'`);
    }
    raw.exec("PRAGMA synchronous = FULL;");
    raw.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  } catch (err) {
    try {
      raw.close();
    } catch {
      /* already closed */
    }
    throw err;
  }

  const db: TissueDb = { path: resolve(path), retentionDays, sql: sqlOf(raw), raw };
  if (options.migrate !== false) applyMigrations(db);
  return db;
}

/**
 * Execute `operation` inside one short `BEGIN IMMEDIATE` transaction.
 * Commits atomically on success; rolls back on any thrown error. Callers must
 * not nest runWrite on the same db.
 */
export function runWrite<T>(db: TissueDb, operation: (tx: WriteTx) => T): T {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const out = operation(db);
    db.raw.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.raw.exec("ROLLBACK");
    } catch {
      /* rollback failure is best-effort; original error is authoritative */
    }
    throw err;
  }
}

/** Close the underlying database (idempotent). */
export function closeDb(db: TissueDb): void {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
}

/** UTC ISO-8601 timestamp convention (Date.toISOString: ms precision, Z suffix). */
export function nowIso(): string {
  return new Date().toISOString();
}

export type { MigrationResult };
