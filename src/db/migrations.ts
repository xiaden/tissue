// src/db/migrations.ts
//
// Numbered, idempotent, transactional migrations (R1). Migrations are applied
// before any effects are available (openTissueDb calls applyMigrations). Each
// migration is recorded by version in `schema_migrations`; re-running
// applyMigrations is a no-op. The whole pending batch runs inside one
// BEGIN IMMEDIATE transaction, so a failure mid-batch rolls back every effect —
// no partial schema, no recorded version — and a later run can succeed cleanly.
//
// DDL is transactional in SQLite, so tables created earlier in a failed batch
// disappear on rollback. Migrations never touch OpenCode's database.
//
// Tissue is unreleased: the numbered, idempotent migration set currently contains
// `initial_schema` (version 1) and `work_item_dependencies` (version 2). The
// canonical schema is still pre-release and has no released-schema compatibility
// shims or upgrade-path promises; future schema changes must be added as numbered
// migrations rather than rewriting this history.

import type { Sql, SqlValue, TissueDb } from "./open.ts";
import { runWrite, nowIso } from "./open.ts";

export interface MigrationDef {
  version: number;
  name: string;
  /** Statements executed in order; DDL is transactional in SQLite. */
  statements: string[];
}

export interface MigrationResult {
  /** Highest version recorded before this run. */
  previousVersion: number;
  /** Highest version now recorded (== latest when applyMigrations succeeds). */
  version: number;
  /** Versions applied by this run (empty when already up to date). */
  applied: number[];
}

// ---- initial_schema: the complete current Tissue schema -----------------------
// Plan A envelope columns are folded into this unreleased initial migration. The
// repository has no released upgrade boundary, so a second ALTER migration would
// invent an upgrade path and is intentionally not used.
// Reproduced from the authoritative DD schema contract (entities + FKs), including
// repository target/push/config-managed/capability columns and requested-vs-observed
// session metadata. Every entity uses a TEXT primary key supplied by the controller;
// timestamps are UTC ISO-8601 TEXT; JSON boundary columns hold validated JSON strings.
// There is no owned_serves table: production topology is resident-only.
const INITIAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS repositories(
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    remote TEXT NOT NULL,
    target_owner TEXT NOT NULL DEFAULT '',
    target_name TEXT NOT NULL DEFAULT '',
    push_owner TEXT NOT NULL DEFAULT '',
    push_name TEXT NOT NULL DEFAULT '',
    push_remote TEXT,
    local_dir TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    baseline_at TEXT NOT NULL,
    poll_watermark TEXT,
    poll_interval_seconds INTEGER NOT NULL,
    max_concurrent_per_repo INTEGER NOT NULL DEFAULT 1,
    base_branch TEXT,
    labels_json TEXT,
    auto_merge INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    triage_session_id TEXT,
    triage_state TEXT NOT NULL DEFAULT 'IDLE',
    triage_attempts INTEGER NOT NULL DEFAULT 0,
    triage_failures INTEGER NOT NULL DEFAULT 0,
    triage_next_attempt_at TEXT,
    issues_enabled INTEGER,
    protection_json TEXT,
    policy_json TEXT,
    config_managed INTEGER NOT NULL DEFAULT 0,
    capability_state TEXT,
    capability_json TEXT,
    capability_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner, name)
  );`,
  `CREATE TABLE IF NOT EXISTS issues(
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id),
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    body_json TEXT,
    state TEXT NOT NULL,
    snapshot_hash TEXT,
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
     disposition_json TEXT,
      blocked_by TEXT,
      envelope_repository TEXT,
      envelope_source_kind TEXT,
      envelope_object_id TEXT,
     envelope_content_id TEXT,
     envelope_observed_version TEXT,
     envelope_content_hash TEXT,
     envelope_authoritative_at TEXT,
     envelope_policy_revision TEXT,
     envelope_actor_present INTEGER,
     envelope_actor_presence TEXT,
     envelope_actor_raw_login TEXT,
     envelope_actor_normalized_login TEXT,
     envelope_decision TEXT,
     envelope_reason TEXT,
     envelope_delivery_class TEXT,
     quarantine_json TEXT,
     UNIQUE(repo_id, number)
    );`,
   `CREATE TABLE IF NOT EXISTS work_items(
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id),
    state TEXT NOT NULL,
    title TEXT,
    base_branch TEXT NOT NULL,
    head_branch TEXT UNIQUE,
    lease_token TEXT,
    lease_until TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     priority INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS issue_work_items(
    issue_id TEXT NOT NULL REFERENCES issues(id),
    work_item_id TEXT NOT NULL REFERENCES work_items(id),
    state TEXT NOT NULL DEFAULT 'ACTIVE',
    attached_at TEXT NOT NULL,
    detached_at TEXT,
    PRIMARY KEY(issue_id, work_item_id)
  );`,
  `CREATE TABLE IF NOT EXISTS opencode_sessions(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('triage', 'resolution')),
    repo_id TEXT REFERENCES repositories(id),
    work_item_id TEXT REFERENCES work_items(id),
    directory TEXT NOT NULL,
    agent TEXT,
    model_json TEXT,
    requested_agent TEXT,
    requested_model_json TEXT,
    observed_agent TEXT,
    observed_model_json TEXT,
    observed_at TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS worktrees(
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id),
    path TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    cleaned_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS pull_requests(
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id),
    repo_id TEXT NOT NULL REFERENCES repositories(id),
    number INTEGER NOT NULL,
    head_ref TEXT NOT NULL,
    head_sha TEXT,
    state TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'expected',
    snapshot_hash TEXT,
    created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
      envelope_repository TEXT,
      envelope_source_kind TEXT,
      envelope_object_id TEXT,
     envelope_content_id TEXT,
     envelope_observed_version TEXT,
     envelope_content_hash TEXT,
     envelope_authoritative_at TEXT,
     envelope_policy_revision TEXT,
     envelope_actor_present INTEGER,
     envelope_actor_presence TEXT,
     envelope_actor_raw_login TEXT,
     envelope_actor_normalized_login TEXT,
     envelope_decision TEXT,
     envelope_reason TEXT,
     envelope_delivery_class TEXT,
     quarantine_json TEXT,
     UNIQUE(repo_id, number)
    );`,
   `CREATE TABLE IF NOT EXISTS inbox(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id TEXT,
    issue_id TEXT NOT NULL REFERENCES issues(id),
    event_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING',
    delivery_nonce TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    terminal_action TEXT,
    terminal_reason TEXT,
    retention_deadline TEXT,
     housekept_at TEXT,
      envelope_repository TEXT,
      envelope_source_kind TEXT,
     envelope_object_id TEXT,
     envelope_content_id TEXT,
     envelope_observed_version TEXT,
     envelope_content_hash TEXT,
     envelope_authoritative_at TEXT,
     envelope_policy_revision TEXT,
     envelope_actor_present INTEGER,
     envelope_actor_presence TEXT,
     envelope_actor_raw_login TEXT,
     envelope_actor_normalized_login TEXT,
     envelope_decision TEXT,
     envelope_reason TEXT,
     envelope_delivery_class TEXT,
     quarantine_json TEXT
    );`,
   `CREATE TABLE IF NOT EXISTS state_transitions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    event TEXT NOT NULL,
    reason_json TEXT,
    actor TEXT NOT NULL,
    at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS side_effects(
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    effect_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS controller_leases(
    resource_key TEXT PRIMARY KEY,
    owner_token TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    lease_until TEXT NOT NULL
  );`,
  // Partial unique indexes: at most one ACTIVE child per owning WorkItem / Issue.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_issue_one_active
    ON issue_work_items(issue_id) WHERE state = 'ACTIVE';`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_resolution_one_active
    ON opencode_sessions(work_item_id) WHERE kind = 'resolution' AND state = 'ACTIVE';`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_worktree_one_active
    ON worktrees(work_item_id) WHERE state = 'ACTIVE';`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pr_one_active
    ON pull_requests(work_item_id) WHERE state = 'ACTIVE';`,
  // Ordered delivery: global inbox.id order per WorkItem, and re-parent by Issue.
  `CREATE INDEX IF NOT EXISTS ix_inbox_wi_order ON inbox(work_item_id, id);`,
  `CREATE INDEX IF NOT EXISTS ix_inbox_issue ON inbox(issue_id, id);`,
  // Housekeeping: NULL-WorkItem inbox rows by terminal Issue (join on issues).
  `CREATE INDEX IF NOT EXISTS ix_inbox_null_wi ON inbox(work_item_id, state);`,
  // Queue claim ordering and due-effect scans.
  `CREATE INDEX IF NOT EXISTS ix_work_items_state_priority
    ON work_items(state, priority DESC, created_at);`,
  `CREATE INDEX IF NOT EXISTS ix_side_effects_due ON side_effects(state, next_attempt_at);`,
];

const DEPENDENCY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS work_item_dependencies(
     id TEXT PRIMARY KEY,
     dependent_work_item_id TEXT NOT NULL REFERENCES work_items(id),
     dependency_issue_id TEXT REFERENCES issues(id),
     dependency_work_item_id TEXT REFERENCES work_items(id),
     state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE', 'SETTLED')),
     created_at TEXT NOT NULL,
     settled_at TEXT,
     CHECK ((dependency_issue_id IS NOT NULL) != (dependency_work_item_id IS NOT NULL)),
     CHECK (settled_at IS NULL OR state = 'SETTLED'),
     UNIQUE(dependent_work_item_id, dependency_issue_id),
     UNIQUE(dependent_work_item_id, dependency_work_item_id)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_work_item_dependencies_issue
     ON work_item_dependencies(dependency_issue_id, state, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS ix_work_item_dependencies_work_item
     ON work_item_dependencies(dependency_work_item_id, state, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS ix_work_item_dependencies_dependents
     ON work_item_dependencies(dependent_work_item_id, state, created_at, id);`,
];

export const MIGRATIONS: readonly MigrationDef[] = [
  { version: 1, name: "initial_schema", statements: INITIAL_SCHEMA },
  { version: 2, name: "work_item_dependencies", statements: DEPENDENCY_SCHEMA },
];

/** Highest schema version this build knows how to reach. */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]!.version;

const MIGRATION_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

function asRow(v: SqlValue): number {
  return Number(v);
}

/**
 * Apply a specific migration list to the given database. Exposed for tests that
 * exercise transactional rollback; production callers use `applyMigrations`.
 */
export function installMigrations(db: TissueDb, list: readonly MigrationDef[]): MigrationResult {
  db.sql.exec(MIGRATION_TABLE);
  const appliedRows = db.sql
    .all<{ version: SqlValue }>("SELECT version FROM schema_migrations")
    .map((r) => asRow(r.version));
  const previousVersion = appliedRows.length === 0 ? 0 : Math.max(...appliedRows);

  const pending = list
    .filter((m) => m.version > previousVersion)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    return { previousVersion, version: previousVersion, applied: [] };
  }

  runWrite(db, (tx) => {
    for (const m of pending) {
      for (const statement of m.statements) tx.sql.exec(statement);
      tx.sql.run(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)",
        m.version,
        m.name,
        nowIso(),
      );
    }
  });

  const finalVersion = Math.max(previousVersion, ...pending.map((m) => m.version));
  return {
    previousVersion,
    version: finalVersion,
    applied: pending.map((m) => m.version),
  };
}

/**
 * Apply numbered migrations to bring `db` to the latest schema version.
 * Idempotent: re-running after success is a no-op (returns applied: []).
 */
export function applyMigrations(db: TissueDb): MigrationResult {
  return installMigrations(db, MIGRATIONS);
}

export type { Sql };
