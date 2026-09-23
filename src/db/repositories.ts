// src/db/repositories.ts
//
// M2 typed repository accessors over Tissue's own SQLite database (R7/R10/R22).
// These are data-access helpers — read/write of the schema created by
// migrations.ts. Multi-statement writes run through runWrite (BEGIN IMMEDIATE)
// so a set of changes commits or rolls back atomically. Column conventions:
//   - ids are controller-supplied TEXT (repo_id references repositories(id));
//   - timestamps are UTC ISO-8601 TEXT (Date.toISOString);
//   - *_json columns hold validated JSON strings (asserted at this boundary).
//
// Partial-unique indexes (ux_issue_one_active, ux_resolution_one_active,
// ux_worktree_one_active, ux_pr_one_active) and the UNIQUE event_key/effect_key
// constraints are enforced by SQLite itself; the accessors let the constraint
// surface as a thrown error rather than papering over it.
//
// Contract names that a later phase owns (recordTransition, applyEnvelope,
// claimNextWorkItem) are intentionally NOT defined here; this module provides
// the durable table accessors those phases compose. Lease primitives and
// terminal-unattached housekeeping (housekeepTerminalUnattachedInbox) are
// defined here because they are durable data operations scoped to P2.

import type { TissueDb, SqlValue } from "./open.ts";
import { randomUUID } from "node:crypto";
import { runWrite, TissueDbError, nowIso } from "./open.ts";
import type { TissueConfig } from "../config/types.ts";
import type { ActorPresence, DeliveryClass, ProvenanceEnvelope, TrustDecision } from "../controller/trust.ts";

// ---- Terminal issue states with no future attachment path (R10/R22) ---------
// NULL-WorkItem inbox rows for these terminal dispositions are housekept.
export const TERMINAL_UNATTACHED_ISSUE_STATES = new Set([
  "REJECTED",
  "DUPLICATE",
  "BASELINE_EXCLUDED",
]);

export interface HousekeepingResult {
  /** Inbox rows examined (NULL-WorkItem, not yet housekept, terminal issue). */
  checked: number;
  /** Rows terminal-marked this run (payload retained until retention deadline). */
  terminalMarked: number;
  /** Rows physically pruned this run (payload dropped; audit retained). */
  pruned: number;
  /** Issue ids whose unattached rows were housekept this run. */
  issueIds: string[];
  /** UTC ISO timestamp of this housekeeping action. */
  at: string;
}

// ---- Validation helpers ------------------------------------------------------

function assertValidJsonString(value: string, field: string): string {
  try {
    JSON.parse(value);
  } catch {
    throw new TissueDbError(`${field}: value is not valid JSON`);
  }
  return value;
}

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

// ---- Repositories ------------------------------------------------------------

export interface RepositoryRow {
  id: string;
  owner: string;
  name: string;
  remote: string;
  target_owner: string;
  target_name: string;
  push_owner: string;
  push_name: string;
  push_remote: string | null;
  local_dir: string;
  enabled: number;
  baseline_at: string;
  poll_watermark: string | null;
  poll_interval_seconds: number;
  max_concurrent_per_repo: number;
  base_branch: string | null;
  labels_json: string | null;
  auto_merge: number;
  priority: number;
  triage_session_id: string | null;
  triage_state: string;
  triage_attempts: number;
  triage_failures: number;
  triage_next_attempt_at: string | null;
  issues_enabled: number | null;
  protection_json: string | null;
  policy_json: string | null;
  created_at: string;
  updated_at: string;
  config_managed: number;
  capability_state: "ready" | "not_ready" | "unknown" | null;
  capability_json: string | null;
  capability_checked_at: string | null;
}

export interface RepositoryInput {
  id: string;
  owner: string;
  name: string;
  remote: string;
  target_owner?: string;
  target_name?: string;
  push_owner?: string;
  push_name?: string;
  push_remote?: string | null;
  local_dir: string;
  baseline_at: string;
  enabled?: boolean;
  poll_watermark?: string | null;
  poll_interval_seconds: number;
  max_concurrent_per_repo?: number;
  base_branch?: string | null;
  labels_json?: string | null;
  auto_merge?: boolean;
  priority?: number;
  triage_session_id?: string | null;
  triage_state?: string;
  triage_attempts?: number;
  triage_failures?: number;
  triage_next_attempt_at?: string | null;
  issues_enabled?: boolean | null;
  protection_json?: string | null;
  policy_json?: string | null;
}

/** Insert a repository, or update the mutable policy columns when (owner,name) exists. */
export function upsertRepository(db: TissueDb, input: RepositoryInput): RepositoryRow {
  if (input.labels_json) assertValidJsonString(input.labels_json, "labels_json");
  if (input.protection_json) assertValidJsonString(input.protection_json, "protection_json");
  if (input.policy_json) assertValidJsonString(input.policy_json, "policy_json");
  const at = nowIso();
  db.sql.run(
    `INSERT INTO repositories(
      id, owner, name, remote, target_owner, target_name, push_owner, push_name, push_remote, local_dir, enabled, baseline_at,
      poll_watermark, poll_interval_seconds, max_concurrent_per_repo, base_branch,
      labels_json, auto_merge, priority, triage_session_id, triage_state,
      triage_attempts, triage_failures, triage_next_attempt_at, issues_enabled,
      protection_json, policy_json, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(owner, name) DO UPDATE SET
      remote = excluded.remote,
      target_owner = excluded.target_owner,
      target_name = excluded.target_name,
      push_owner = excluded.push_owner,
      push_name = excluded.push_name,
      push_remote = excluded.push_remote,
      local_dir = excluded.local_dir,
      enabled = excluded.enabled,
      poll_interval_seconds = excluded.poll_interval_seconds,
      max_concurrent_per_repo = excluded.max_concurrent_per_repo,
      base_branch = excluded.base_branch,
      labels_json = excluded.labels_json,
      auto_merge = excluded.auto_merge,
      priority = excluded.priority,
      triage_state = excluded.triage_state,
      issues_enabled = excluded.issues_enabled,
      protection_json = excluded.protection_json,
      policy_json = excluded.policy_json,
      updated_at = excluded.updated_at`,
    input.id,
    input.owner,
    input.name,
    input.remote,
    input.target_owner ?? input.owner,
    input.target_name ?? input.name,
    input.push_owner ?? input.target_owner ?? input.owner,
    input.push_name ?? input.target_name ?? input.name,
    input.push_remote ?? null,
    input.local_dir,
    input.enabled === false ? 0 : 1,
    input.baseline_at,
    input.poll_watermark ?? null,
    input.poll_interval_seconds ?? 300,
    input.max_concurrent_per_repo ?? 1,
    input.base_branch ?? null,
    input.labels_json ?? null,
    input.auto_merge === true ? 1 : 0,
    input.priority ?? 0,
    input.triage_session_id ?? null,
    input.triage_state ?? "IDLE",
    input.triage_attempts ?? 0,
    input.triage_failures ?? 0,
    input.triage_next_attempt_at ?? null,
    input.issues_enabled === null ? null : input.issues_enabled === true ? 1 : input.issues_enabled === false ? 0 : null,
    input.protection_json ?? null,
    input.policy_json ?? null,
    at,
    at,
  );
  const row = db.sql.get<RepositoryRow>(
    "SELECT * FROM repositories WHERE owner = ? AND name = ?",
    input.owner,
    input.name,
  );
  if (!row) throw new TissueDbError(`repository ${input.owner}/${input.name} not found after upsert`);
  return row;
}

export interface RepositorySyncResult { inserted: number; updated: number; disabled: number; at: string; }
export type DispatchOperation = "poll" | "triage" | "claim" | "dispatch" | "effect";

export function synchronizeConfiguredRepositories(db: TissueDb, config: TissueConfig, now: Date = new Date()): RepositorySyncResult {
  const at = now.toISOString(); let inserted = 0; let updated = 0; const configured = new Set<string>();
  runWrite(db, (tx) => {
    for (const repo of config.repos) {
      const id = `${repo.owner}/${repo.name}`; configured.add(id);
      const existing = tx.sql.get<{ id: string }>("SELECT id FROM repositories WHERE owner = ? AND name = ?", repo.owner, repo.name);
      const remote = repo.remote ?? `https://github.com/${repo.owner}/${repo.name}.git`;
      const values = [id, repo.owner, repo.name, remote, repo.targetOwner ?? repo.owner, repo.targetName ?? repo.name,
        repo.pushOwner ?? repo.targetOwner ?? repo.owner, repo.pushName ?? repo.targetName ?? repo.name, repo.pushRemote ?? null,
        repo.localDir, repo.enabled ? 1 : 0, repo.baselineBefore ?? at, repo.pollIntervalSeconds ?? 300,
        repo.maxConcurrentPerRepo ?? 1, repo.baseBranch ?? "main", JSON.stringify(repo.labels), repo.autoMerge ? 1 : 0, repo.priority, "IDLE", at, at, 1] as SqlValue[];
      if (!existing) {
        tx.sql.run(`INSERT INTO repositories(id,owner,name,remote,target_owner,target_name,push_owner,push_name,push_remote,local_dir,enabled,baseline_at,poll_interval_seconds,max_concurrent_per_repo,base_branch,labels_json,auto_merge,priority,triage_state,created_at,updated_at,config_managed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...values);
        inserted++;
      } else {
        tx.sql.run(`UPDATE repositories SET remote=?,target_owner=?,target_name=?,push_owner=?,push_name=?,push_remote=?,local_dir=?,enabled=?,poll_interval_seconds=?,max_concurrent_per_repo=?,base_branch=?,labels_json=?,auto_merge=?,priority=?,config_managed=1,updated_at=? WHERE id=?`,
          remote, repo.targetOwner ?? repo.owner, repo.targetName ?? repo.name, repo.pushOwner ?? repo.targetOwner ?? repo.owner,
          repo.pushName ?? repo.targetName ?? repo.name, repo.pushRemote ?? null, repo.localDir,
          repo.enabled ? 1 : 0, repo.pollIntervalSeconds, repo.maxConcurrentPerRepo ?? 1, repo.baseBranch ?? "main", JSON.stringify(repo.labels), repo.autoMerge ? 1 : 0, repo.priority ?? 0, at, existing.id);
        updated++;
      }
    }
    // Disable (never delete) config-managed rows absent/disabled in current config.
    // Match by identity (owner/name), NOT by the stored id: a legacy/manual row can
    // carry a non-canonical id while still being the same configured repository.
    for (const row of tx.sql.all<{ id: string; owner: string; name: string }>("SELECT id,owner,name FROM repositories WHERE config_managed = 1"))
      if (!configured.has(`${row.owner}/${row.name}`)) tx.sql.run("UPDATE repositories SET enabled=0,updated_at=? WHERE id=?", at, row.id);
  });
  const disabled = db.sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM repositories WHERE config_managed=1 AND enabled=0")?.count ?? 0;
  return { inserted, updated, disabled, at };
}

export interface RepositoryCapabilityInput { state: "ready" | "not_ready" | "unknown"; capability: unknown; }
export function persistRepositoryCapability(db: TissueDb, repoId: string, capability: RepositoryCapabilityInput, now = new Date()): void {
  const at = now.toISOString(); db.sql.run("UPDATE repositories SET capability_state=?,capability_json=?,capability_checked_at=?,updated_at=? WHERE id=?", capability.state, JSON.stringify(capability.capability), at, at, repoId);
}
export function assertDispatchReady(db: TissueDb, repoId: string, operation: DispatchOperation): void {
  const row = db.sql.get<{ enabled: number; capability_state: string | null }>("SELECT enabled,capability_state FROM repositories WHERE id=?", repoId);
  if (!row || row.enabled !== 1 || row.capability_state !== "ready") throw new TissueDbError(`repository ${repoId} is not ready for ${operation}: ${!row ? "unknown repository" : row.enabled !== 1 ? "disabled" : (row.capability_state ?? "unknown")}`);
}

export function getRepository(db: TissueDb, owner: string, name: string): RepositoryRow | undefined {
  return db.sql.get<RepositoryRow>(
    "SELECT * FROM repositories WHERE owner = ? AND name = ?",
    owner,
    name,
  );
}

export function getRepositoryById(db: TissueDb, id: string): RepositoryRow | undefined {
  return db.sql.get<RepositoryRow>("SELECT * FROM repositories WHERE id = ?", id);
}

export function listRepositories(db: TissueDb): RepositoryRow[] {
  return db.sql.all<RepositoryRow>("SELECT * FROM repositories ORDER BY owner, name");
}

/** Set poll_watermark (level-triggered polling cursor). Returns nothing ("void"). */
export function setPollWatermark(db: TissueDb, owner: string, name: string, watermark: string | null): void {
  db.sql.run(
    "UPDATE repositories SET poll_watermark = ?, updated_at = ? WHERE owner = ? AND name = ?",
    watermark,
    nowIso(),
    owner,
    name,
  );
}

export function getPollWatermark(db: TissueDb, owner: string, name: string): string | null {
  const row = db.sql.get<{ poll_watermark: SqlValue }>(
    "SELECT poll_watermark FROM repositories WHERE owner = ? AND name = ?",
    owner,
    name,
  );
  return row?.poll_watermark == null ? null : String(row.poll_watermark);
}

// ---- Per-repository triage pump columns (M4, R2/R9) ---------------------------
// The repository row carries the triage pump state machine fields
// (triage_state / triage_failures / triage_next_attempt_at / triage_session_id).
// This accessor updates those columns durably; state-transition audit is the
// caller's job via recordTransition on the `triage` entity (entity_id = repo id).

export interface TriageStatePatch {
  state?: string;
  failures?: number;
  attempts?: number;
  nextAttemptAt?: string | null;
  sessionId?: string | null;
}

/** Update the per-repository triage pump columns. Only the supplied keys change. */
export function updateTriageState(db: TissueDb, repoId: string, patch: TriageStatePatch): void {
  const sets: string[] = [];
  const params: SqlValue[] = [];
  if (patch.state !== undefined) {
    sets.push("triage_state = ?");
    params.push(patch.state);
  }
  if (patch.failures !== undefined) {
    sets.push("triage_failures = ?");
    params.push(patch.failures);
  }
  if (patch.attempts !== undefined) {
    sets.push("triage_attempts = ?");
    params.push(patch.attempts);
  }
  if (patch.nextAttemptAt !== undefined) {
    sets.push("triage_next_attempt_at = ?");
    params.push(patch.nextAttemptAt); // null clears the backoff window
  }
  if (patch.sessionId !== undefined) {
    sets.push("triage_session_id = ?");
    params.push(patch.sessionId); // null clears the retained session mapping
  }
  if (sets.length === 0) return;
  db.sql.run(
    `UPDATE repositories SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
    ...params,
    nowIso(),
    repoId,
  );
}

// ---- Trust envelope -----------------------------------------------------------

export type EnvelopeSourceKind = string;
export type EnvelopeQuarantine = Readonly<{
  sourceKind: string;
  objectId: string;
  contentId: string | null;
  observedVersion: string;
  contentHash: string | null;
  authoritativeAt: string;
  actor: ProvenanceEnvelope["actor"];
  decision: TrustDecision;
  reason: string;
  deliveryClass: DeliveryClass;
}>;

const ENVELOPE_KEYS = new Set(["repository", "sourceKind", "objectId", "contentId", "observedVersion", "contentHash", "authoritativeAt", "policyRevision", "actor", "decision", "reason", "deliveryClass"]);
const ACTOR_KEYS = new Set(["present", "rawLogin", "normalizedLogin", "presence"]);
const FORBIDDEN_QUARANTINE_KEYS = new Set(["body", "bodyPreview", "title", "digest", "quote", "derivedProse"]);

function assertEnvelope(envelope: ProvenanceEnvelope): ProvenanceEnvelope {
  if (!envelope || typeof envelope !== "object") throw new TissueDbError("envelope: value must be an object");
  for (const [field, value] of Object.entries(envelope)) {
    if (!ENVELOPE_KEYS.has(field)) throw new TissueDbError(`envelope: unknown key ${field}`);
    if (field === "actor") continue;
    if (value !== null && typeof value !== "string") throw new TissueDbError(`envelope.${field}: expected string or null`);
  }
  if (!envelope.repository || !envelope.sourceKind || !envelope.objectId || !envelope.observedVersion || !envelope.authoritativeAt || !envelope.policyRevision || !envelope.reason) {
    throw new TissueDbError("envelope: required provenance is missing");
  }
  if (!["TRUSTED", "UNTRUSTED", "MISSING_ACTOR", "UNKNOWN_ACTOR", "MALFORMED_ACTOR", "CONFIG_UNUSABLE"].includes(envelope.decision)) throw new TissueDbError("envelope.decision: invalid value");
  if (!["OBJECTIVE", "TRUSTED_PROSE", "DENIED_PROSE"].includes(envelope.deliveryClass)) throw new TissueDbError("envelope.deliveryClass: invalid value");
  const actor = envelope.actor;
  if (!actor || typeof actor !== "object" || Object.keys(actor).some((key) => !ACTOR_KEYS.has(key)) || typeof actor.present !== "boolean" || !["PRESENT", "MISSING", "UNKNOWN", "MALFORMED"].includes(actor.presence)) throw new TissueDbError("envelope.actor: invalid value");
  if (actor.rawLogin !== null && typeof actor.rawLogin !== "string") throw new TissueDbError("envelope.actor.rawLogin: invalid value");
  if (actor.normalizedLogin !== null && typeof actor.normalizedLogin !== "string") throw new TissueDbError("envelope.actor.normalizedLogin: invalid value");
  return envelope;
}

type EnvelopeSqlValues = readonly [
  string | null, string | null, string | null, string | null, string | null,
  string | null, string | null, string | null, number | null, string | null,
  string | null, string | null, string | null, string | null, string | null,
];

function envelopeValues(envelope: ProvenanceEnvelope | null | undefined): EnvelopeSqlValues {
  if (!envelope) return [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null];
  const e = assertEnvelope(envelope);
  return [
    e.repository, e.sourceKind, e.objectId, e.contentId, e.observedVersion,
    e.contentHash, e.authoritativeAt, e.policyRevision, e.actor.present ? 1 : 0,
    e.actor.presence, e.actor.rawLogin, e.actor.normalizedLogin, e.decision,
    e.reason, e.deliveryClass,
  ];
}

const ENVELOPE_ROW_FIELDS = [
  "envelope_repository", "envelope_source_kind", "envelope_object_id", "envelope_content_id",
  "envelope_observed_version", "envelope_content_hash", "envelope_authoritative_at",
  "envelope_policy_revision", "envelope_actor_present", "envelope_actor_presence",
  "envelope_actor_raw_login", "envelope_actor_normalized_login", "envelope_decision",
  "envelope_reason", "envelope_delivery_class",
] as const;

function envelopeFromRow(row: Record<string, unknown>): ProvenanceEnvelope | null {
  const values = ENVELOPE_ROW_FIELDS.map((field) => row[field]);
  const requiredIndexes = [0, 1, 2, 4, 6, 7, 8, 9, 12, 13, 14];
  const requiredValues = requiredIndexes.map((index) => values[index]);
  if (requiredValues.every((value) => value == null)) return null;
  if (requiredValues.some((value) => value == null)) {
    throw new TissueDbError("envelope: partial persisted provenance");
  }
  const e: ProvenanceEnvelope = {
    repository: values[0] as string,
    sourceKind: values[1] as string,
    objectId: values[2] as string,
    contentId: values[3] as string,
    observedVersion: values[4] as string,
    contentHash: values[5] as string,
    authoritativeAt: values[6] as string,
    policyRevision: values[7] as string,
    actor: {
      present: Number(values[8]) === 1,
      rawLogin: values[10] as string,
      normalizedLogin: values[11] as string,
      presence: values[9] as ActorPresence,
    },
    decision: values[12] as TrustDecision,
    reason: values[13] as string,
    deliveryClass: values[14] as DeliveryClass,
  };
  return assertEnvelope(e);
}

/**
 * Validate and return a provenance envelope before persistence.
 *
 * Unknown keys, missing required provenance, invalid decision/delivery classes,
 * and malformed actor observations throw `TissueDbError`.
 */
export function validateProvenanceEnvelope(envelope: ProvenanceEnvelope): ProvenanceEnvelope { return assertEnvelope(envelope); }

/** Read the complete persisted envelope, or null when the row has no envelope. */
export function envelopeForRow(row: IssueRow | PullRequestRow | InboxRow): ProvenanceEnvelope | null { return envelopeFromRow(row as unknown as Record<string, unknown>); }

/** Return true when a row has no persisted provenance and is therefore legacy-unprovable. */
export function isLegacyUnprovable(row: IssueRow | PullRequestRow | InboxRow): boolean { return envelopeForRow(row) === null; }

function assertBodyFreeQuarantine(value: string | null | undefined): string | null {
  if (value == null) return null;
  assertValidJsonString(value, "quarantine_json");
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TissueDbError("quarantine_json: expected object");
  for (const key of Object.keys(parsed)) if (FORBIDDEN_QUARANTINE_KEYS.has(key)) throw new TissueDbError(`quarantine_json: forbidden field ${key}`);
  return value;
}

export function assertEnvelopeCompatible(existing: ProvenanceEnvelope | null, incoming: ProvenanceEnvelope): void {
  assertEnvelope(incoming);
  if (!existing) return;
  const fields: (keyof ProvenanceEnvelope)[] = ["repository", "sourceKind", "objectId", "contentId", "observedVersion", "contentHash", "authoritativeAt", "policyRevision", "decision", "reason", "deliveryClass"];
  for (const field of fields) if (existing[field] !== incoming[field]) throw new TissueDbError(`provenance mismatch: ${field}`);
  for (const field of ["present", "rawLogin", "normalizedLogin", "presence"] as const) if (existing.actor[field] !== incoming.actor[field]) throw new TissueDbError(`provenance mismatch: actor.${field}`);
}

// ---- Issues -------------------------------------------------------------------

export interface IssueRow {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body_json: string | null;
  state: string;
  snapshot_hash: string | null;
  first_seen_at: string;
  updated_at: string;
  disposition_json: string | null;
  blocked_by: string | null;
  envelope_repository: string | null;
  envelope_source_kind: string | null;
  envelope_object_id: string | null;
  envelope_content_id: string | null;
  envelope_observed_version: string | null;
  envelope_content_hash: string | null;
  envelope_authoritative_at: string | null;
  envelope_policy_revision: string | null;
  envelope_actor_present: number | null;
  envelope_actor_presence: string | null;
  envelope_actor_raw_login: string | null;
  envelope_actor_normalized_login: string | null;
  envelope_decision: string | null;
  envelope_reason: string | null;
  envelope_delivery_class: string | null;
  quarantine_json: string | null;
}

export interface IssueInput {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body_json?: string | null;
  state: string;
  snapshot_hash?: string | null;
  first_seen_at?: string;
  updated_at: string;
  disposition_json?: string | null;
  blocked_by?: string | null;
  envelope?: ProvenanceEnvelope | null;
  quarantine_json?: string | null;
}

/** Insert an issue; conflicts on (repo_id, number) are surfaced as errors. */
export function insertIssue(db: TissueDb, input: IssueInput): IssueRow {
  if (input.body_json) assertValidJsonString(input.body_json, "body_json");
  if (input.disposition_json) assertValidJsonString(input.disposition_json, "disposition_json");
  assertBodyFreeQuarantine(input.quarantine_json);
  db.sql.run(
    `INSERT INTO issues(id, repo_id, number, title, body_json, state, snapshot_hash,
       first_seen_at, updated_at, disposition_json, blocked_by,
       envelope_repository, envelope_source_kind, envelope_object_id, envelope_content_id, envelope_observed_version,
       envelope_content_hash, envelope_authoritative_at, envelope_policy_revision, envelope_actor_present,
       envelope_actor_presence, envelope_actor_raw_login, envelope_actor_normalized_login, envelope_decision,
       envelope_reason, envelope_delivery_class, quarantine_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.id,
    input.repo_id,
    input.number,
    input.title,
    input.body_json ?? null,
    input.state,
    input.snapshot_hash ?? null,
    input.first_seen_at ?? nowIso(),
    input.updated_at,
    input.disposition_json ?? null,
     input.blocked_by ?? null,
       ...envelopeValues(input.envelope).slice(0, 15), input.quarantine_json ?? null,
    );
   return getIssueById(db, input.id)!;
}

export function upsertIssueFromSnapshot(db: TissueDb, input: IssueInput): IssueRow {
  if (input.body_json) assertValidJsonString(input.body_json, "body_json");
  if (input.disposition_json) assertValidJsonString(input.disposition_json, "disposition_json");
  assertBodyFreeQuarantine(input.quarantine_json);
  const existing = getIssueByRepoNumber(db, input.repo_id, input.number);
  if (existing && input.envelope) assertEnvelopeCompatible(envelopeForRow(existing), input.envelope);
  db.sql.run(
    `INSERT INTO issues(id, repo_id, number, title, body_json, state, snapshot_hash,
       first_seen_at, updated_at, disposition_json, blocked_by,
       envelope_repository, envelope_source_kind, envelope_object_id, envelope_content_id, envelope_observed_version,
       envelope_content_hash, envelope_authoritative_at, envelope_policy_revision, envelope_actor_present,
       envelope_actor_presence, envelope_actor_raw_login, envelope_actor_normalized_login, envelope_decision,
       envelope_reason, envelope_delivery_class, quarantine_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(repo_id, number) DO UPDATE SET
        title = excluded.title,
        body_json = excluded.body_json,
        snapshot_hash = excluded.snapshot_hash,
        updated_at = excluded.updated_at,
        envelope_repository = COALESCE(excluded.envelope_repository, issues.envelope_repository),
        envelope_source_kind = COALESCE(excluded.envelope_source_kind, issues.envelope_source_kind),
        envelope_object_id = COALESCE(excluded.envelope_object_id, issues.envelope_object_id),
        envelope_content_id = COALESCE(excluded.envelope_content_id, issues.envelope_content_id),
        envelope_observed_version = COALESCE(excluded.envelope_observed_version, issues.envelope_observed_version),
        envelope_content_hash = COALESCE(excluded.envelope_content_hash, issues.envelope_content_hash),
        envelope_authoritative_at = COALESCE(excluded.envelope_authoritative_at, issues.envelope_authoritative_at),
        envelope_policy_revision = COALESCE(excluded.envelope_policy_revision, issues.envelope_policy_revision),
        envelope_actor_present = COALESCE(excluded.envelope_actor_present, issues.envelope_actor_present),
        envelope_actor_presence = COALESCE(excluded.envelope_actor_presence, issues.envelope_actor_presence),
        envelope_actor_raw_login = COALESCE(excluded.envelope_actor_raw_login, issues.envelope_actor_raw_login),
        envelope_actor_normalized_login = COALESCE(excluded.envelope_actor_normalized_login, issues.envelope_actor_normalized_login),
        envelope_decision = COALESCE(excluded.envelope_decision, issues.envelope_decision),
        envelope_reason = COALESCE(excluded.envelope_reason, issues.envelope_reason),
        envelope_delivery_class = COALESCE(excluded.envelope_delivery_class, issues.envelope_delivery_class),
        quarantine_json = COALESCE(excluded.quarantine_json, issues.quarantine_json)`,
    input.id, input.repo_id, input.number, input.title, input.body_json ?? null,
    input.state, input.snapshot_hash ?? null, input.first_seen_at ?? nowIso(), input.updated_at,
    input.disposition_json ?? null, input.blocked_by ?? null, ...envelopeValues(input.envelope), input.quarantine_json ?? null,
  );
  const row = getIssueByRepoNumber(db, input.repo_id, input.number);
  if (!row) throw new TissueDbError(`issue ${input.repo_id}#${input.number} not found after upsert`);
  return row;
}

/** Update only the snapshot columns of an already-seen issue (idempotent poll). */
export function updateIssueSnapshot(
  db: TissueDb,
  issueId: string,
  patch: { snapshotHash?: string | null; title?: string; bodyJson?: string | null; updatedAt?: string },
): void {
  if (patch.bodyJson) assertValidJsonString(patch.bodyJson, "body_json");
  const sets: string[] = [];
  const params: SqlValue[] = [];
  if (patch.snapshotHash !== undefined) {
    sets.push("snapshot_hash = ?");
    params.push(patch.snapshotHash);
  }
  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.bodyJson !== undefined) {
    sets.push("body_json = ?");
    params.push(patch.bodyJson);
  }
  if (patch.updatedAt !== undefined) {
    sets.push("updated_at = ?");
    params.push(patch.updatedAt);
  }
  if (sets.length === 0) return;
  db.sql.run(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`, ...params, issueId);
}

export function getIssueById(db: TissueDb, id: string): IssueRow | undefined {
  return db.sql.get<IssueRow>("SELECT * FROM issues WHERE id = ?", id);
}

export function getIssueByRepoNumber(db: TissueDb, repoId: string, number: number): IssueRow | undefined {
  return db.sql.get<IssueRow>("SELECT * FROM issues WHERE repo_id = ? AND number = ?", repoId, number);
}

export function listIssuesByRepo(db: TissueDb, repoId: string): IssueRow[] {
  return db.sql.all<IssueRow>("SELECT * FROM issues WHERE repo_id = ? ORDER BY number", repoId);
}

/** Update issue state/disposition, e.g. when applying a typed triage-envelope disposition. */
export function updateIssueState(
  db: TissueDb,
  issueId: string,
  state: string,
  dispositionJson?: string | null,
  blockedBy?: string | null,
): void {
  if (dispositionJson) assertValidJsonString(dispositionJson, "disposition_json");
  db.sql.run(
    `UPDATE issues SET state = ?, disposition_json = ?, blocked_by = ?, updated_at = ?
     WHERE id = ?`,
    state,
    dispositionJson ?? null,
    blockedBy ?? null,
    nowIso(),
    issueId,
  );
}

// ---- Work items ----------------------------------------------------------------

export interface WorkItemRow {
  id: string;
  repo_id: string;
  state: string;
  title: string | null;
  base_branch: string;
  head_branch: string | null;
  lease_token: string | null;
  lease_until: string | null;
  attempts: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface WorkItemInput {
  id: string;
  repo_id: string;
  state: string;
  title?: string | null;
  base_branch: string;
  head_branch?: string | null;
  lease_token?: string | null;
  lease_until?: string | null;
  attempts?: number;
  priority?: number;
}

export function insertWorkItem(db: TissueDb, input: WorkItemInput): WorkItemRow {
  const at = nowIso();
  db.sql.run(
    `INSERT INTO work_items(id, repo_id, state, title, base_branch, head_branch,
       lease_token, lease_until, attempts, priority, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.id,
    input.repo_id,
    input.state,
    input.title ?? null,
    input.base_branch,
    input.head_branch ?? null,
    input.lease_token ?? null,
    input.lease_until ?? null,
    input.attempts ?? 0,
    input.priority ?? 0,
    at,
    at,
  );
  return getWorkItem(db, input.id)!;
}

export function getWorkItem(db: TissueDb, id: string): WorkItemRow | undefined {
  return db.sql.get<WorkItemRow>("SELECT * FROM work_items WHERE id = ?", id);
}

export function listWorkItemsByRepo(db: TissueDb, repoId: string): WorkItemRow[] {
  return db.sql.all<WorkItemRow>("SELECT * FROM work_items WHERE repo_id = ? ORDER BY created_at", repoId);
}

export interface WorkItemStatePatch {
  leaseToken?: string | null;
  leaseUntil?: string | null;
}

export function setWorkItemState(
  db: TissueDb,
  id: string,
  state: string,
  patch: WorkItemStatePatch = {},
): void {
  const fields = ["state = ?"];
  const values: SqlValue[] = [state];
  if (patch.leaseToken !== undefined) {
    fields.push("lease_token = ?");
    values.push(patch.leaseToken);
  }
  if (patch.leaseUntil !== undefined) {
    fields.push("lease_until = ?");
    values.push(patch.leaseUntil);
  }
  fields.push("updated_at = ?");
  values.push(nowIso(), id);
  db.sql.run(`UPDATE work_items SET ${fields.join(", ")} WHERE id = ?`, ...values);
}

export type WorkItemDependencyTarget =
  | { kind: "issue"; id: string }
  | { kind: "work_item"; id: string };

export interface WorkItemDependencyRow {
  id: string;
  dependent_work_item_id: string;
  dependency_issue_id: string | null;
  dependency_work_item_id: string | null;
  state: "ACTIVE" | "SETTLED";
  created_at: string;
  settled_at: string | null;
}

function dependencyWhere(target: WorkItemDependencyTarget): { column: string; id: string } {
  return target.kind === "issue"
    ? { column: "dependency_issue_id", id: target.id }
    : { column: "dependency_work_item_id", id: target.id };
}

function dependencyRow(db: TissueDb, id: string): WorkItemDependencyRow {
  const row = db.sql.get<WorkItemDependencyRow>("SELECT * FROM work_item_dependencies WHERE id = ?", id);
  if (!row) throw new TissueDbError(`dependency '${id}' was not found`);
  return row;
}

export function addWorkItemDependency(
  tx: TissueDb,
  dependentWorkItemId: string,
  dependency: WorkItemDependencyTarget,
): WorkItemDependencyRow {
  if (dependency.kind === "work_item" && dependency.id === dependentWorkItemId) {
    throw new TissueDbError("a WorkItem cannot depend on itself");
  }
  if (!getWorkItem(tx, dependentWorkItemId)) throw new TissueDbError(`dependent WorkItem '${dependentWorkItemId}' was not found`);
  const target = dependency.kind === "issue" ? getIssueById(tx, dependency.id) : getWorkItem(tx, dependency.id);
  if (!target) throw new TissueDbError(`dependency '${dependency.id}' was not found`);

  if (dependency.kind === "work_item") {
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (id === dependentWorkItemId) throw new TissueDbError("WorkItem dependency cycle detected");
      if (seen.has(id)) return;
      seen.add(id);
      const rows = tx.sql.all<{ dependency_work_item_id: string | null }>(
        "SELECT dependency_work_item_id FROM work_item_dependencies WHERE dependent_work_item_id = ? AND state = 'ACTIVE' AND dependency_work_item_id IS NOT NULL",
        id,
      );
      for (const row of rows) if (row.dependency_work_item_id) visit(row.dependency_work_item_id);
    };
    visit(dependency.id);
  }

  const id = `dep-${randomUUID()}`;
  const column = dependency.kind === "issue" ? "dependency_issue_id" : "dependency_work_item_id";
  tx.sql.run(
    `INSERT INTO work_item_dependencies(id, dependent_work_item_id, ${column}, created_at) VALUES(?, ?, ?, ?)`,
    id,
    dependentWorkItemId,
    dependency.id,
    nowIso(),
  );
  return dependencyRow(tx, id);
}

export function listDependentsForCompletedDependency(
  tx: TissueDb,
  dependency: WorkItemDependencyTarget,
): WorkItemDependencyRow[] {
  const { column, id } = dependencyWhere(dependency);
  return tx.sql.all<WorkItemDependencyRow>(
    `SELECT * FROM work_item_dependencies WHERE ${column} = ? AND state = 'ACTIVE' ORDER BY created_at ASC, id ASC`,
    id,
  );
}

export function settleWorkItemDependency(tx: TissueDb, relationId: string): void {
  tx.sql.run(
    "UPDATE work_item_dependencies SET state = 'SETTLED', settled_at = ? WHERE id = ? AND state = 'ACTIVE'",
    nowIso(),
    relationId,
  );
}

// ---- Issue <-> WorkItem relationships (R4) -------------------------------------

/** Attach an issue to a work item as ACTIVE. Enforced: one ACTIVE per issue. */
export function attachIssueToWorkItem(db: TissueDb, issueId: string, workItemId: string): void {
  db.sql.run(
    "INSERT INTO issue_work_items(issue_id, work_item_id, state, attached_at) VALUES(?, ?, 'ACTIVE', ?)",
    issueId,
    workItemId,
    nowIso(),
  );
}

export function detachIssueFromWorkItem(db: TissueDb, issueId: string, workItemId: string): void {
  db.sql.run(
    `UPDATE issue_work_items SET state = 'DETACHED', detached_at = ?
     WHERE issue_id = ? AND work_item_id = ? AND state = 'ACTIVE'`,
    nowIso(),
    issueId,
    workItemId,
  );
}

export function activeIssueLinksForIssue(db: TissueDb, issueId: string): Array<{ work_item_id: string; attached_at: string }> {
  return db.sql.all<{ work_item_id: string; attached_at: string }>(
    "SELECT work_item_id, attached_at FROM issue_work_items WHERE issue_id = ? AND state = 'ACTIVE'",
    issueId,
  );
}

export function activeIssueIdsForWorkItem(db: TissueDb, workItemId: string): string[] {
  return db.sql
    .all<{ issue_id: string }>(
      "SELECT issue_id FROM issue_work_items WHERE work_item_id = ? AND state = 'ACTIVE'",
      workItemId,
    )
    .map((r) => r.issue_id);
}

export interface ResolutionSessionRow {
  id: string;
  work_item_id: string;
  directory: string;
  state: string;
}

/** The single ACTIVE resolution session for a WorkItem (ux_resolution_one_active). */
export function getActiveResolutionSession(db: TissueDb, workItemId: string): ResolutionSessionRow | undefined {
  return db.sql.get<ResolutionSessionRow>(
    `SELECT id, work_item_id, directory, state FROM opencode_sessions
      WHERE work_item_id = ? AND kind = 'resolution' AND state = 'ACTIVE'
      LIMIT 1`,
    workItemId,
  );
}

/** A WorkItem whose controller-generated head branch matches `headRef` (PR linkage). */
export function getWorkItemByHeadBranch(db: TissueDb, headRef: string): WorkItemRow | undefined {
  return db.sql.get<WorkItemRow>("SELECT * FROM work_items WHERE head_branch = ?", headRef);
}

// ---- OpenCode sessions / worktrees / pull requests (R5/R6/R7) -------------------

export interface SessionRow {
  id: string;
  kind: "triage" | "resolution";
  repo_id: string | null;
  work_item_id: string | null;
  directory: string;
  /** Requested agent (controller intent at creation). */
  agent: string | null;
  /** Requested model JSON (controller intent at creation). */
  model_json: string | null;
  requested_agent: string | null;
  requested_model_json: string | null;
  /** Observed agent actually used by the resident runtime (never invented). */
  observed_agent: string | null;
  observed_model_json: string | null;
  observed_at: string | null;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface SessionInput {
  id: string;
  kind: "triage" | "resolution";
  repo_id?: string | null;
  work_item_id?: string | null;
  directory: string;
  agent?: string | null;
  model_json?: string | null;
  state: string;
}

/** Insert a session row. ux_resolution_one_active blocks a second ACTIVE resolution. */
export function insertSession(db: TissueDb, input: SessionInput): void {
  if (input.model_json) assertValidJsonString(input.model_json, "model_json");
  const at = nowIso();
  db.sql.run(
    `INSERT INTO opencode_sessions(id, kind, repo_id, work_item_id, directory, agent,
       model_json, requested_agent, requested_model_json, state, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.id,
    input.kind,
    input.repo_id ?? null,
    input.work_item_id ?? null,
    input.directory,
    input.agent ?? null,
    input.model_json ?? null,
    input.agent ?? null,
    input.model_json ?? null,
    input.state,
    at,
    at,
  );
}

/**
 * Record the agent/model the resident OpenCode actually reported using. Only
 * values returned by the resident runtime are stored (never a guessed/default
 * model), so requested-vs-observed stays explicit and auditable.
 */
export function recordSessionObservation(
  db: TissueDb,
  sessionId: string,
  observation: { agent?: string | null; model_json?: string | null; at?: string },
): boolean {
  if (observation.model_json) assertValidJsonString(observation.model_json, "observed_model_json");
  const existing = db.sql.get<{ id: string }>("SELECT id FROM opencode_sessions WHERE id = ?", sessionId);
  if (!existing) return false;
  db.sql.run(
    `UPDATE opencode_sessions
        SET observed_agent = COALESCE(?, observed_agent),
            observed_model_json = COALESCE(?, observed_model_json),
            observed_at = ?,
            updated_at = ?
      WHERE id = ?`,
    observation.agent ?? null,
    observation.model_json ?? null,
    observation.at ?? nowIso(),
    nowIso(),
    sessionId,
  );
  return true;
}

export function setSessionState(db: TissueDb, sessionId: string, state: string): void {
  db.sql.run(
    "UPDATE opencode_sessions SET state = ?, updated_at = ? WHERE id = ?",
    state,
    nowIso(),
    sessionId,
  );
}

export interface WorktreeInput {
  id: string;
  work_item_id: string;
  path: string;
  branch: string;
  state: string;
}

/** Insert a worktree row. ux_worktree_one_active blocks a second ACTIVE worktree. */
export function insertWorktree(db: TissueDb, input: WorktreeInput): void {
  db.sql.run(
    "INSERT INTO worktrees(id, work_item_id, path, branch, state, created_at) VALUES(?,?,?,?,?,?)",
    input.id,
    input.work_item_id,
    input.path,
    input.branch,
    input.state,
    nowIso(),
  );
}

export function setWorktreeState(db: TissueDb, id: string, state: string, cleanedAt?: string | null): void {
  db.sql.run(
    "UPDATE worktrees SET state = ?, cleaned_at = ? WHERE id = ?",
    state,
    cleanedAt === undefined ? null : cleanedAt,
    id,
  );
}

export interface PullRequestInput {
  id: string;
  work_item_id: string;
  repo_id: string;
  number: number;
  head_ref: string;
  head_sha?: string | null;
  state: string;
  origin?: string;
  envelope?: ProvenanceEnvelope | null;
  quarantine_json?: string | null;
}

export function insertPullRequest(db: TissueDb, input: PullRequestInput): void {
  const at = nowIso();
  assertBodyFreeQuarantine(input.quarantine_json);
  db.sql.run(
    `INSERT INTO pull_requests(id, work_item_id, repo_id, number, head_ref, head_sha,
       state, origin, created_at, updated_at,
       envelope_repository, envelope_source_kind, envelope_object_id, envelope_content_id, envelope_observed_version,
       envelope_content_hash, envelope_authoritative_at, envelope_policy_revision, envelope_actor_present,
       envelope_actor_presence, envelope_actor_raw_login, envelope_actor_normalized_login, envelope_decision,
       envelope_reason, envelope_delivery_class, quarantine_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.id, input.work_item_id, input.repo_id, input.number, input.head_ref,
    input.head_sha ?? null, input.state, input.origin ?? "expected", at, at,
     ...envelopeValues(input.envelope).slice(0, 15), input.quarantine_json ?? null,
  );
}

export function setPullRequestState(db: TissueDb, id: string, state: string): void {
  db.sql.run(
    "UPDATE pull_requests SET state = ?, updated_at = ? WHERE id = ?",
    state,
    nowIso(),
    id,
  );
}

export interface PullRequestRow {
  id: string;
  work_item_id: string;
  repo_id: string;
  number: number;
  head_ref: string;
  head_sha: string | null;
  state: string;
  origin: string;
  snapshot_hash: string | null;
  envelope_repository: string | null;
  envelope_source_kind: string | null;
  envelope_object_id: string | null;
  envelope_content_id: string | null;
  envelope_observed_version: string | null;
  envelope_content_hash: string | null;
  envelope_authoritative_at: string | null;
  envelope_policy_revision: string | null;
  envelope_actor_present: number | null;
  envelope_actor_presence: string | null;
  envelope_actor_raw_login: string | null;
  envelope_actor_normalized_login: string | null;
  envelope_decision: string | null;
  envelope_reason: string | null;
  envelope_delivery_class: string | null;
  quarantine_json: string | null;
  created_at: string;
  updated_at: string;
}

export function getPullRequestByRepoNumber(
  db: TissueDb,
  repoId: string,
  number: number,
): PullRequestRow | undefined {
  return db.sql.get<PullRequestRow>(
    "SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?",
    repoId,
    number,
  );
}

/** Update a WorkItem's PR state by (work_item_id, number); no-op when absent. */
export function markPullRequestState(
  db: TissueDb,
  workItemId: string,
  number: number,
  state: string,
): void {
  db.sql.run(
    "UPDATE pull_requests SET state = ?, updated_at = ? WHERE work_item_id = ? AND number = ?",
    state,
    nowIso(),
    workItemId,
    number,
  );
}

export function upsertPullRequestFromSnapshot(db: TissueDb, input: PullRequestInput & { snapshotHash?: string | null }): PullRequestRow {
  const at = nowIso();
  assertBodyFreeQuarantine(input.quarantine_json);
  const existing = getPullRequestByRepoNumber(db, input.repo_id, input.number);
  if (existing && input.envelope) assertEnvelopeCompatible(envelopeForRow(existing), input.envelope);
  db.sql.run(
    `INSERT INTO pull_requests(id, work_item_id, repo_id, number, head_ref, head_sha,
       state, origin, snapshot_hash, created_at, updated_at,
       envelope_repository, envelope_source_kind, envelope_object_id, envelope_content_id, envelope_observed_version,
       envelope_content_hash, envelope_authoritative_at, envelope_policy_revision, envelope_actor_present,
       envelope_actor_presence, envelope_actor_raw_login, envelope_actor_normalized_login, envelope_decision,
       envelope_reason, envelope_delivery_class, quarantine_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repo_id, number) DO UPDATE SET
       head_sha = excluded.head_sha,
       state = excluded.state,
       snapshot_hash = excluded.snapshot_hash,
       updated_at = excluded.updated_at,
        envelope_repository = COALESCE(excluded.envelope_repository, pull_requests.envelope_repository),
        envelope_source_kind = COALESCE(excluded.envelope_source_kind, pull_requests.envelope_source_kind),
       envelope_object_id = COALESCE(excluded.envelope_object_id, pull_requests.envelope_object_id),
       envelope_content_id = COALESCE(excluded.envelope_content_id, pull_requests.envelope_content_id),
       envelope_observed_version = COALESCE(excluded.envelope_observed_version, pull_requests.envelope_observed_version),
       envelope_content_hash = COALESCE(excluded.envelope_content_hash, pull_requests.envelope_content_hash),
       envelope_authoritative_at = COALESCE(excluded.envelope_authoritative_at, pull_requests.envelope_authoritative_at),
       envelope_policy_revision = COALESCE(excluded.envelope_policy_revision, pull_requests.envelope_policy_revision),
       envelope_actor_present = COALESCE(excluded.envelope_actor_present, pull_requests.envelope_actor_present),
       envelope_actor_presence = COALESCE(excluded.envelope_actor_presence, pull_requests.envelope_actor_presence),
       envelope_actor_raw_login = COALESCE(excluded.envelope_actor_raw_login, pull_requests.envelope_actor_raw_login),
       envelope_actor_normalized_login = COALESCE(excluded.envelope_actor_normalized_login, pull_requests.envelope_actor_normalized_login),
       envelope_decision = COALESCE(excluded.envelope_decision, pull_requests.envelope_decision),
       envelope_reason = COALESCE(excluded.envelope_reason, pull_requests.envelope_reason),
       envelope_delivery_class = COALESCE(excluded.envelope_delivery_class, pull_requests.envelope_delivery_class),
       quarantine_json = COALESCE(excluded.quarantine_json, pull_requests.quarantine_json)`,
    input.id, input.work_item_id, input.repo_id, input.number, input.head_ref,
    input.head_sha ?? null, input.state, input.origin ?? "expected", input.snapshotHash ?? null, at, at,
    ...envelopeValues(input.envelope).slice(0, 15), input.quarantine_json ?? null,
  );
  const row = getPullRequestByRepoNumber(db, input.repo_id, input.number);
  if (!row) throw new TissueDbError(`PR ${input.repo_id}#${input.number} not found after upsert`);
  return row;
}

// ---- Inbox (R10): globally monotonic, ordered, deduplicated ---------------------

export interface InboxRow {
  id: number;
  work_item_id: string | null;
  issue_id: string;
  event_key: string;
  kind: string;
  payload_json: string;
  state: string;
  delivery_nonce: string | null;
  created_at: string;
  delivered_at: string | null;
  terminal_action: string | null;
  terminal_reason: string | null;
  retention_deadline: string | null;
  housekept_at: string | null;
  envelope_repository: string | null;
  envelope_source_kind: string | null;
  envelope_object_id: string | null;
  envelope_content_id: string | null;
  envelope_observed_version: string | null;
  envelope_content_hash: string | null;
  envelope_authoritative_at: string | null;
  envelope_policy_revision: string | null;
  envelope_actor_present: number | null;
  envelope_actor_presence: string | null;
  envelope_actor_raw_login: string | null;
  envelope_actor_normalized_login: string | null;
  envelope_decision: string | null;
  envelope_reason: string | null;
  envelope_delivery_class: string | null;
  quarantine_json: string | null;
}

export interface InboxInput {
  /** null until the issue is attached to a WorkItem; re-parented by Issue id later. */
  work_item_id?: string | null;
  issue_id: string;
  event_key: string;
  kind: string;
  payload_json: string;
  state?: string;
  /** Optional explicit created_at (snapshot time); defaults to now. */
  created_at?: string;
  envelope?: ProvenanceEnvelope | null;
  quarantine_json?: string | null;
}

export function insertInboxEvent(db: TissueDb, input: InboxInput): number {
  assertValidJsonString(input.payload_json, "payload_json");
  assertBodyFreeQuarantine(input.quarantine_json);
  const existing = db.sql.get<InboxRow>("SELECT * FROM inbox WHERE event_key = ?", input.event_key);
  if (existing && input.envelope) assertEnvelopeCompatible(envelopeForRow(existing), input.envelope);
  const res = db.sql.run(
    `INSERT INTO inbox(work_item_id, issue_id, event_key, kind, payload_json, state, created_at,
       envelope_repository, envelope_source_kind, envelope_object_id, envelope_content_id, envelope_observed_version,
       envelope_content_hash, envelope_authoritative_at, envelope_policy_revision, envelope_actor_present,
       envelope_actor_presence, envelope_actor_raw_login, envelope_actor_normalized_login, envelope_decision,
       envelope_reason, envelope_delivery_class, quarantine_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.work_item_id ?? null, input.issue_id, input.event_key, input.kind, input.payload_json,
    input.state ?? "PENDING", input.created_at ?? nowIso(), ...envelopeValues(input.envelope).slice(0, 15), input.quarantine_json ?? null,
  );
  return res.lastInsertRowid;
}

/** Inbox rows for a WorkItem in strict global id order (relay ordering, R10). */
export function listInboxByWorkItem(db: TissueDb, workItemId: string): InboxRow[] {
  return db.sql.all<InboxRow>(
    "SELECT * FROM inbox WHERE work_item_id = ? ORDER BY id",
    workItemId,
  );
}

/** Unattached (NULL-WorkItem) inbox rows for an issue, in global order. */
export function listNullWorkItemInboxByIssue(db: TissueDb, issueId: string): InboxRow[] {
  return db.sql.all<InboxRow>(
    "SELECT * FROM inbox WHERE issue_id = ? AND work_item_id IS NULL ORDER BY id",
    issueId,
  );
}

/**
 * Re-parent every NULL-WorkItem inbox row of an issue onto a WorkItem (events
 * can predate attachment; re-parent by Issue id in the attachment transaction).
 *
 * L1 terminal-action guard: rows already terminal-marked by terminal-unattached
 * housekeeping (terminal_action IS NOT NULL) are NEVER re-attached. R14 enqueue
 * can admit a BASELINE_EXCLUDED issue and later attach it, but a pre-existing
 * terminal-marked row has no future delivery path and must stay terminal —
 * re-attaching it would strand a TERMINAL row on a live WorkItem. This guard
 * preserves R22 (terminal history is not relabeled) while keeping R14 intact
 * (enqueue still admits the issue and any non-terminal NULL-WorkItem events).
 */
export function reparentInboxByIssue(db: TissueDb, issueId: string, workItemId: string): number {
  const res = db.sql.run(
    `UPDATE inbox SET work_item_id = ?
      WHERE issue_id = ? AND work_item_id IS NULL AND terminal_action IS NULL`,
    workItemId,
    issueId,
  );
  return res.changes;
}

export function countInboxByState(db: TissueDb): Record<string, number> {
  const rows = db.sql.all<{ state: string; c: number }>(
    "SELECT state, COUNT(*) AS c FROM inbox GROUP BY state",
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = r.c;
  return out;
}

export function getInboxById(db: TissueDb, id: number): InboxRow | undefined {
  return db.sql.get<InboxRow>("SELECT * FROM inbox WHERE id = ?", id);
}

/** PENDING inbox rows for a WorkItem in strict global id order (relay input). */
export function listPendingInboxByWorkItem(db: TissueDb, workItemId: string): InboxRow[] {
  return db.sql.all<InboxRow>(
    "SELECT * FROM inbox WHERE work_item_id = ? AND state = 'PENDING' ORDER BY id",
    workItemId,
  );
}

/** The durable single-flight guard: DELIVERING rows for a WorkItem, in id order. */
export function listDeliveringInboxByWorkItem(db: TissueDb, workItemId: string): InboxRow[] {
  return db.sql.all<InboxRow>(
    "SELECT * FROM inbox WHERE work_item_id = ? AND state = 'DELIVERING' ORDER BY id",
    workItemId,
  );
}

/**
 * Mark a bundle of PENDING rows DELIVERING with one shared delivery nonce. The
 * nonce is recorded BEFORE the external prompt (durable single-flight, RG-4).
 */
export function markInboxDelivering(db: TissueDb, ids: readonly number[], nonce: string): number {
  let changed = 0;
  for (const id of ids) {
    const res = db.sql.run(
      `UPDATE inbox SET state = 'DELIVERING', delivery_nonce = ?
        WHERE id = ? AND state = 'PENDING'`,
      nonce,
      id,
    );
    changed += res.changes;
  }
  return changed;
}

/** Mark a bundle DELIVERED (nonce parent-linked qualifying turn observed). */
export function markInboxDelivered(db: TissueDb, ids: readonly number[], at: string): number {
  let changed = 0;
  for (const id of ids) {
    const res = db.sql.run(
      `UPDATE inbox SET state = 'DELIVERED', delivered_at = ?
        WHERE id = ? AND state = 'DELIVERING'`,
      at,
      id,
    );
    changed += res.changes;
  }
  return changed;
}

/** Recycle DELIVERING rows back to PENDING and clear the nonce (bounded noReply). */
export function recycleInboxToPending(db: TissueDb, ids: readonly number[]): number {
  let changed = 0;
  for (const id of ids) {
    const res = db.sql.run(
      `UPDATE inbox SET state = 'PENDING', delivery_nonce = NULL
        WHERE id = ? AND state = 'DELIVERING'`,
      id,
    );
    changed += res.changes;
  }
  return changed;
}

/** Insert an inbox event idempotently by event_key; returns the existing id on dup. */
export function insertInboxEventIfAbsent(
  db: TissueDb,
  input: InboxInput,
): { id: number; inserted: boolean } {
  if (input.payload_json) assertValidJsonString(input.payload_json, "payload_json");
  assertBodyFreeQuarantine(input.quarantine_json);
  const existing = db.sql.get<InboxRow>("SELECT * FROM inbox WHERE event_key = ?", input.event_key);
  if (existing && input.envelope) assertEnvelopeCompatible(envelopeForRow(existing), input.envelope);
  const res = db.sql.run(
    `INSERT OR IGNORE INTO inbox(work_item_id, issue_id, event_key, kind, payload_json, state, created_at,
       envelope_repository, envelope_source_kind, envelope_object_id, envelope_content_id, envelope_observed_version,
       envelope_content_hash, envelope_authoritative_at, envelope_policy_revision, envelope_actor_present,
       envelope_actor_presence, envelope_actor_raw_login, envelope_actor_normalized_login, envelope_decision,
       envelope_reason, envelope_delivery_class, quarantine_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.work_item_id ?? null,
    input.issue_id,
    input.event_key,
    input.kind,
    input.payload_json ?? "{}",
    "PENDING",
    input.created_at ?? nowIso(),
    ...envelopeValues(input.envelope).slice(0, 15),
    input.quarantine_json ?? null,
  );
  if (res.changes > 0) return { id: Number(res.lastInsertRowid), inserted: true };
  const duplicate = db.sql.get<{ id: number }>("SELECT id FROM inbox WHERE event_key = ?", input.event_key);
  return { id: duplicate?.id ?? -1, inserted: false };
}

// ---- Side effects (transactional outbox) -----------------------------------------

export interface SideEffectInput {
  id: string;
  kind: string;
  effect_key: string;
  state: string;
  payload_json: string;
}

export function insertSideEffect(db: TissueDb, input: SideEffectInput): void {
  assertValidJsonString(input.payload_json, "payload_json");
  db.sql.run(
    `INSERT INTO side_effects(id, kind, effect_key, state, payload_json, created_at)
     VALUES(?,?,?,?,?,?)`,
    input.id,
    input.kind,
    input.effect_key,
    input.state,
    input.payload_json,
    nowIso(),
  );
}

/**
 * Insert an outbox intent idempotently by effect_key. Returns `inserted:false`
 * when an identical intent already exists (committed-before-execution outbox is
 * replay-safe across crashes/re-polls).
 */
export function insertSideEffectIfAbsent(
  db: TissueDb,
  input: SideEffectInput,
): { inserted: boolean } {
  assertValidJsonString(input.payload_json, "payload_json");
  const res = db.sql.run(
    `INSERT OR IGNORE INTO side_effects(id, kind, effect_key, state, payload_json, created_at)
     VALUES(?,?,?,?,?,?)`,
    input.id,
    input.kind,
    input.effect_key,
    input.state,
    input.payload_json,
    nowIso(),
  );
  return { inserted: res.changes > 0 };
}

export function getSideEffect(db: TissueDb, id: string): { state: string; attempt: number } | undefined {
  return db.sql.get<{ state: string; attempt: number }>(
    "SELECT state, attempt FROM side_effects WHERE id = ?",
    id,
  );
}

export function setSideEffectState(
  db: TissueDb,
  id: string,
  state: string,
  patch: { nextAttemptAt?: string | null; lastError?: string | null } = {},
): void {
  db.sql.run(
    `UPDATE side_effects SET state = ?, attempt = attempt + 1, next_attempt_at = ?,
       last_error = ?, completed_at = CASE WHEN ? = 'DONE' THEN ? ELSE completed_at END
     WHERE id = ?`,
    state,
    patch.nextAttemptAt ?? null,
    patch.lastError ?? null,
    state,
    state === "DONE" ? nowIso() : null,
    id,
  );
}

export interface SideEffectRow {
  id: string;
  kind: string;
  effect_key: string;
  state: string;
  payload_json: string;
  attempt: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

export function getSideEffectFull(db: TissueDb, id: string): SideEffectRow | undefined {
  return db.sql.get<SideEffectRow>("SELECT * FROM side_effects WHERE id = ?", id);
}

/** Due effects (PENDING/FAILED whose next_attempt_at is null or past), oldest first. */
export function listDueSideEffects(db: TissueDb, now: Date, limit = 50): SideEffectRow[] {
  return db.sql.all<SideEffectRow>(
    `SELECT * FROM side_effects
      WHERE state IN ('PENDING','FAILED')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at, id LIMIT ?`,
    now.toISOString(),
    limit,
  );
}

/**
 * Return an effect to PENDING WITHOUT incrementing attempt — used when a merge is
 * held for human approval / pending checks (the effect is not a failure, it is
 * simply waiting for the external precondition to clear).
 */
export function requeueSideEffect(
  db: TissueDb,
  id: string,
  patch: { nextAttemptAt?: string | null; lastError?: string | null } = {},
): void {
  db.sql.run(
    "UPDATE side_effects SET state = 'PENDING', next_attempt_at = ?, last_error = ? WHERE id = ?",
    patch.nextAttemptAt ?? null,
    patch.lastError ?? null,
    id,
  );
}

// ---- State transitions (audit history) -------------------------------------------

export interface TransitionRecord {
  entity_type: string;
  entity_id: string;
  from_state: string | null;
  to_state: string;
  event: string;
  reason_json: string | null;
  actor: string;
  at: string;
}

/** Append exactly one audit row for a transition. */
export function appendTransition(
  db: TissueDb,
  rec: {
    entity_type: string;
    entity_id: string;
    from_state?: string | null;
    to_state: string;
    event: string;
    reason_json?: string | null;
    actor: string;
    /** Optional deterministic timestamp for controller tests; production defaults to now. */
    at?: string;
  },
): void {
  if (rec.reason_json) assertValidJsonString(rec.reason_json, "reason_json");
  db.sql.run(
    `INSERT INTO state_transitions(entity_type, entity_id, from_state, to_state, event,
       reason_json, actor, at)
     VALUES(?,?,?,?,?,?,?,?)`,
    rec.entity_type,
    rec.entity_id,
    rec.from_state ?? null,
    rec.to_state,
    rec.event,
    rec.reason_json ?? null,
     rec.actor,
     rec.at ?? nowIso(),
   );
}

export function listTransitions(db: TissueDb, entityType: string, entityId: string): TransitionRecord[] {
  return db.sql.all<TransitionRecord>(
    "SELECT * FROM state_transitions WHERE entity_type = ? AND entity_id = ? ORDER BY id",
    entityType,
    entityId,
  );
}

/**
 * Timestamp of the most recent transition for an entity, optionally for a given
 * event. Used by the relay to age a DELIVERING attempt (the DELIVERING start is
 * the `delivery_started` transition) without adding a schema column beyond the
 * DD-frozen tables.
 */
export function latestTransitionAt(
  db: TissueDb,
  entityType: string,
  entityId: string,
  event?: string,
): string | undefined {
  if (event === undefined) {
    return db.sql.get<{ at: string }>(
      "SELECT at FROM state_transitions WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1",
      entityType,
      entityId,
    )?.at;
  }
  return db.sql.get<{ at: string }>(
    "SELECT at FROM state_transitions WHERE entity_type = ? AND entity_id = ? AND event = ? ORDER BY id DESC LIMIT 1",
    entityType,
    entityId,
    event,
  )?.at;
}

export function listRecentTransitions(db: TissueDb, limit: number): TransitionRecord[] {
  return db.sql.all<TransitionRecord>(
    "SELECT * FROM state_transitions ORDER BY id DESC LIMIT ?",
    limit,
  );
}

// ---- Controller leases (R7): durable, conditional, expiry-based -------------------

export interface LeaseResult {
  acquired: boolean;
  ownerToken?: string;
  leaseUntil?: string;
  reason?: "held" | "acquired";
}

/**
 * Durable conditional lease on `resource_key` with owner token and TTL. A
 * resource is free if it has no row or its lease has expired. SQLITE_BUSY is
 * classified transient (see isBusyError) and re-tried by the caller, never
 * treated as correctness-by-mutex.
 */
export function acquireLease(
  db: TissueDb,
  resourceKey: string,
  ownerToken: string,
  now: Date,
  ttlMs: number,
): LeaseResult {
  const until = new Date(now.getTime() + ttlMs).toISOString();
  const acquiredAt = now.toISOString();
  const held = runWrite(db, (tx) => {
    const existing = tx.sql.get<{ owner_token: string; lease_until: string }>(
      "SELECT owner_token, lease_until FROM controller_leases WHERE resource_key = ?",
      resourceKey,
    );
    if (existing && existing.lease_until > acquiredAt) {
      return { owner: existing.owner_token, until: existing.lease_until } as const;
    }
    // Free or expired: conditionally claim (insert, or update past lease).
    if (existing) {
      tx.sql.run(
        "UPDATE controller_leases SET owner_token = ?, acquired_at = ?, lease_until = ? WHERE resource_key = ? AND lease_until <= ?",
        ownerToken,
        acquiredAt,
        until,
        resourceKey,
        acquiredAt,
      );
    } else {
      try {
        tx.sql.run(
          "INSERT INTO controller_leases(resource_key, owner_token, acquired_at, lease_until) VALUES(?,?,?,?)",
          resourceKey,
          ownerToken,
          acquiredAt,
          until,
        );
      } catch {
        // Concurrent insert of the same key lost the race; treat as held.
        return { owner: "", until } as const;
      }
    }
    return null;
  });

  if (held) {
    return { acquired: false, reason: "held" };
  }
  return { acquired: true, ownerToken, leaseUntil: until, reason: "acquired" };
}

/** Release a lease only when the caller still owns it (owner token must match). */
export function releaseLease(db: TissueDb, resourceKey: string, ownerToken: string): boolean {
  const res = db.sql.run(
    "DELETE FROM controller_leases WHERE resource_key = ? AND owner_token = ?",
    resourceKey,
    ownerToken,
  );
  return res.changes > 0;
}

/** Delete all leases expired at `now`; returns how many were removed. */
export function expireLeases(db: TissueDb, now: Date): number {
  const res = db.sql.run(
    "DELETE FROM controller_leases WHERE lease_until <= ?",
    now.toISOString(),
  );
  return res.changes;
}

export function getLease(db: TissueDb, resourceKey: string): { owner_token: string; lease_until: string } | undefined {
  return db.sql.get<{ owner_token: string; lease_until: string }>(
    "SELECT owner_token, lease_until FROM controller_leases WHERE resource_key = ?",
    resourceKey,
  );
}

// ---- Terminal-unattached inbox housekeeping (R10/R22) -------------------------------
// Idempotent BEGIN IMMEDIATE transaction: every inbox row with work_item_id IS NULL
// whose Issue is terminal REJECTED/DUPLICATE/BASELINE_EXCLUDED (no future attachment
// path) is terminal-marked, recording the issue/event identity, action, reason, and a
// retention deadline, with one audit state_transitions row per event. Payload rows are
// retained (their physical pruning is a later explicit retention migration that keeps
// the audit/JSONL evidence). Repeated housekeeping is a no-op.

export function housekeepTerminalUnattachedInbox(db: TissueDb, now: Date): HousekeepingResult {
  const at = now.toISOString();
  const retentionDeadline = addDaysIso(at, db.retentionDays);
  const placeholders = [...TERMINAL_UNATTACHED_ISSUE_STATES].map(() => "?").join(", ");

  return runWrite(db, (tx) => {
    const stateParams: SqlValue[] = [...TERMINAL_UNATTACHED_ISSUE_STATES];
    const candidates = tx.sql.all<{ id: number; issue_id: string }>(
      `SELECT ib.id, ib.issue_id FROM inbox ib
       JOIN issues i ON i.id = ib.issue_id
       WHERE ib.work_item_id IS NULL
         AND ib.terminal_action IS NULL
         AND i.state IN (${placeholders})`,
      ...stateParams,
    );

    const issueIds = new Set<string>();
    let marked = 0;
    for (const c of candidates) {
      const issue = tx.sql.get<{ state: string }>("SELECT state FROM issues WHERE id = ?", c.issue_id);
      const reason = issue
        ? `issue terminal (${issue.state}), no future attachment path`
        : "issue terminal, no future attachment path";
      tx.sql.run(
        `UPDATE inbox SET state = 'TERMINAL', terminal_action = 'terminal_marked',
           terminal_reason = ?, retention_deadline = ?, housekept_at = ?
         WHERE id = ? AND terminal_action IS NULL`,
        reason,
        retentionDeadline,
        at,
        c.id,
      );
      appendTransition(tx, {
        entity_type: "inbox",
        entity_id: String(c.id),
        from_state: "PENDING",
        to_state: "TERMINAL",
        event: "terminal_unattached_housekeeping",
        reason_json: JSON.stringify({
          issue_id: c.issue_id,
          action: "terminal_marked",
          retention_deadline: retentionDeadline,
        }),
        actor: "controller.housekeeping",
      });
      issueIds.add(c.issue_id);
      marked += 1;
    }

    return {
      checked: candidates.length,
      terminalMarked: marked,
      pruned: 0,
      issueIds: [...issueIds],
      at,
    };
  });
}

/** Aggregated housekeeping observability counters for status/history (R16/R22). */
export function housekeepingCounters(db: TissueDb): {
  terminalMarked: number;
  pruned: number;
  lastAt: string | null;
} {
  const marked = db.sql.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM inbox WHERE terminal_action = 'terminal_marked'",
  )?.c ?? 0;
  const pruned = db.sql.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM inbox WHERE terminal_action = 'pruned'",
  )?.c ?? 0;
  const last = db.sql.get<{ at: SqlValue }>(
    "SELECT MAX(at) AS at FROM state_transitions WHERE event = 'terminal_unattached_housekeeping'",
  )?.at;
  return {
    terminalMarked: Number(marked),
    pruned: Number(pruned),
    lastAt: last == null ? null : String(last),
  };
}

// ---- Status / history summarizers ---------------------------------------------------

export interface StatusSummary {
  repositories: number;
  issues: number;
  workItems: Record<string, number>;
  inbox: Record<string, number>;
  sideEffectsPending: number;
  activeLeases: number;
  housekeeping: { terminalMarked: number; pruned: number; lastAt: string | null };
}

/** Aggregate counts surfaced by `tissue status` / inspect (R16). */
export function statusSummary(db: TissueDb): StatusSummary {
  const repos = db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM repositories")?.c ?? 0;
  const issues = db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM issues")?.c ?? 0;
  const wiRows = db.sql.all<{ state: string; c: number }>(
    "SELECT state, COUNT(*) AS c FROM work_items GROUP BY state",
  );
  const workItems: Record<string, number> = {};
  for (const r of wiRows) workItems[r.state] = r.c;
  const effects = db.sql.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM side_effects WHERE state <> 'DONE'",
  )?.c ?? 0;
  const leases = db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM controller_leases")?.c ?? 0;
  return {
    repositories: Number(repos),
    issues: Number(issues),
    workItems,
    inbox: countInboxByState(db),
    sideEffectsPending: Number(effects),
    activeLeases: Number(leases),
    housekeeping: housekeepingCounters(db),
  };
}

// ---- Delivery / reconciliation accessors (P3) -------------------------------------
// Typed read/extend surface used by drift adoption, terminal-leftover cleanup,
// session census, and reconcile status/history. Business rules stay in the
// controller modules; these are pure accessors.

export interface WorktreeRow {
  id: string;
  work_item_id: string;
  path: string;
  branch: string;
  state: string;
  created_at: string;
  cleaned_at: string | null;
}

export function listWorktreesByWorkItem(db: TissueDb, workItemId: string): WorktreeRow[] {
  return db.sql.all<WorktreeRow>(
    "SELECT * FROM worktrees WHERE work_item_id = ? ORDER BY created_at, id",
    workItemId,
  );
}

export function listActiveWorktrees(db: TissueDb): WorktreeRow[] {
  return db.sql.all<WorktreeRow>(
    "SELECT * FROM worktrees WHERE state = 'ACTIVE' ORDER BY created_at, id",
  );
}

/** INSERT OR IGNORE a worktree row; false when a conflicting row already exists. */
export function insertWorktreeIfAbsent(db: TissueDb, input: WorktreeInput): boolean {
  const res = db.sql.run(
    "INSERT OR IGNORE INTO worktrees(id, work_item_id, path, branch, state, created_at) VALUES(?,?,?,?,?,?)",
    input.id,
    input.work_item_id,
    input.path,
    input.branch,
    input.state,
    nowIso(),
  );
  return res.changes > 0;
}

/** Adopt an observed controller branch onto its WorkItem identity (drift only). */
export function setWorkItemHeadBranch(db: TissueDb, id: string, headBranch: string): void {
  db.sql.run("UPDATE work_items SET head_branch = ?, updated_at = ? WHERE id = ?", headBranch, nowIso(), id);
}

export function listPullRequestsByWorkItem(db: TissueDb, workItemId: string): PullRequestRow[] {
  return db.sql.all<PullRequestRow>(
    "SELECT * FROM pull_requests WHERE work_item_id = ? ORDER BY created_at, id",
    workItemId,
  );
}

export function listActivePullRequests(db: TissueDb): PullRequestRow[] {
  return db.sql.all<PullRequestRow>(
    "SELECT * FROM pull_requests WHERE state = 'ACTIVE' ORDER BY created_at, id",
  );
}

export function insertPullRequestIfAbsent(db: TissueDb, input: PullRequestInput): boolean {
  const at = nowIso();
  assertBodyFreeQuarantine(input.quarantine_json);
  const existing = getPullRequestByRepoNumber(db, input.repo_id, input.number);
  if (existing && input.envelope) assertEnvelopeCompatible(envelopeForRow(existing), input.envelope);
  const res = db.sql.run(
    `INSERT OR IGNORE INTO pull_requests(id, work_item_id, repo_id, number, head_ref, head_sha,
       state, origin, created_at, updated_at,
       envelope_repository, envelope_source_kind, envelope_object_id, envelope_content_id, envelope_observed_version,
       envelope_content_hash, envelope_authoritative_at, envelope_policy_revision, envelope_actor_present,
       envelope_actor_presence, envelope_actor_raw_login, envelope_actor_normalized_login, envelope_decision,
       envelope_reason, envelope_delivery_class, quarantine_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.id, input.work_item_id, input.repo_id, input.number, input.head_ref,
    input.head_sha ?? null, input.state, input.origin ?? "expected", at, at,
     ...envelopeValues(input.envelope).slice(0, 15), input.quarantine_json ?? null,
   );
   return res.changes > 0;
}

export function listSessions(db: TissueDb): SessionRow[] {
  return db.sql.all<SessionRow>("SELECT * FROM opencode_sessions ORDER BY created_at, id");
}

export function listWorkItemsByStates(db: TissueDb, states: readonly string[]): WorkItemRow[] {
  if (states.length === 0) return [];
  const placeholders = states.map(() => "?").join(", ");
  return db.sql.all<WorkItemRow>(
    `SELECT * FROM work_items WHERE state IN (${placeholders}) ORDER BY created_at, id`,
    ...(states as SqlValue[]),
  );
}

export interface HousekeepingAction {
  at: string;
  entity_id: string;
  issue_id: string | null;
  action: string | null;
  retention_deadline: string | null;
}

/** Recent terminal-unattached housekeeping audit actions (newest first) for `history`. */
export function listHousekeepingActions(db: TissueDb, limit = 20): HousekeepingAction[] {
  const rows = db.sql.all<{ at: string; entity_id: string; reason_json: string | null }>(
    "SELECT at, entity_id, reason_json FROM state_transitions WHERE event = 'terminal_unattached_housekeeping' ORDER BY id DESC LIMIT ?",
    limit,
  );
  return rows.map((r) => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = r.reason_json ? (JSON.parse(r.reason_json) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    return {
      at: r.at,
      entity_id: r.entity_id,
      issue_id: typeof parsed.issue_id === "string" ? parsed.issue_id : null,
      action: typeof parsed.action === "string" ? parsed.action : null,
      retention_deadline: typeof parsed.retention_deadline === "string" ? parsed.retention_deadline : null,
    };
  });
}
