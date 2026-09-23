// src/controller/triage.ts
//
// M4 durable per-repository triage orchestration (R2/R3/R4/R9). One flight per
// enabled repository at a time drives its durable triage pump (repository-row
// columns) through IDLE → PROMPTING → IDLE / BACKOFF / PAUSED_TRIAGE. Each flight
// takes the oldest TRIAGE_PENDING issue, prompts the repo's durable OpenCode
// session through the abstract driver boundary with a BOUNDED digest (no full
// untrusted body dumps), validates the returned disposition against the six legal
// yields, and applies it via the typed envelope + Issue↔WorkItem relationship.
//
// Guardrails (STRICT for this phase, per DD sequencing):
//   - No real OpenCode session/serve is created here. Triage talks ONLY to the
//     injected `SessionDriver` abstraction (see session-driver.ts); the real
//     OpenCode driver and topology probes are Plan B. Nothing in src touches
//     ~/.local/share/opencode or ~/.config/opencode.
//   - No resolution WorkItem is ever created/queued before its Issue is READY
//     (no-resolution-before-READY). A WorkItem is created only in the same
//     transaction that applies the READY disposition.
//   - Duplicate discovery never creates a second WorkItem: it groups the issue
//     onto an existing canonical WorkItem (ux_issue_one_active semantics).
//   - Dispositions are validated to ISSUE_TRIAGE_DISPOSITIONS; anything else is a
//     flight failure (backoff), never applied.
//
// Backoff ladder 1m / 5m / 30m with jitter (capped 4h); three consecutive
// failures escalate the pump to PAUSED_TRIAGE; an explicit unpause resets it.

import { randomUUID } from "node:crypto";
import type { ProviderModel } from "../config/types.ts";
import { decideCurrentGithubProse } from "./trust.ts";
import type { TissueDb } from "../db/open.ts";
import { runWrite } from "../db/open.ts";
import {
  getRepositoryById,
  getIssueById,
  getWorkItem,
  insertWorkItem,
  attachIssueToWorkItem,
  reparentInboxByIssue,
  activeIssueLinksForIssue,
  updateTriageState,
  updateIssueSnapshot,
  type RepositoryRow,
  type IssueRow,
  type WorkItemRow,
} from "../db/repositories.ts";
import { recordTransition } from "../domain/transitions.ts";
import { applyTriageEnvelope, type TriageEnvelope } from "../domain/envelopes.ts";
import { ISSUE_TRIAGE_DISPOSITIONS, type IssueTriageDisposition } from "../domain/state-machine.ts";
import type {
  SessionDriver,
  IssueTriageDigest,
  TriageSuggestion,
} from "./session-driver.ts";

/** Backoff ladder delays in ms: 1 minute, 5 minutes, 30 minutes (R2 backoff). */
export const TRIAGE_BACKOFF_LADDER_MS = [60_000, 300_000, 1_800_000] as const;
/** Hard cap on any single triage backoff (ms). */
export const TRIAGE_BACKOFF_CAP_MS = 4 * 3_600_000;
/** Consecutive failures before the pump escalates to PAUSED_TRIAGE. */
export const TRIAGE_ESCALATION_LIMIT = 3;
/** Title preview cap for the bounded digest (no full untrusted bodies). */
export const TITLE_PREVIEW_MAX = 200;
/** Body preview cap for the bounded digest. */
export const BODY_PREVIEW_MAX = 400;

export interface TriageRunSummary {
  repoId: string;
  /** True when a real flight (issue prompt/apply or a failure disposition) ran. */
  ran: boolean;
  reason?: "paused" | "backoff" | "no_due" | "stale_prompting";
  issueId?: string;
  disposition?: IssueTriageDisposition;
  outcome?: "disposition_applied" | "failure" | "noop";
  createdWorkItemId?: string;
  failures: number;
  triageState: string;
  error?: string;
}

/**
 * Pick the jittered backoff delay for `failureCount` (1-based). Applies the
 * 1m/5m/30m ladder, jitters within ±20%, and caps at TRIAGE_BACKOFF_CAP_MS.
 */
export function triageBackoffDelayMs(failureCount: number, random: () => number = Math.random): number {
  const idx = Math.min(Math.max(failureCount - 1, 0), TRIAGE_BACKOFF_LADDER_MS.length - 1);
  const base = TRIAGE_BACKOFF_LADDER_MS[idx]!;
  const jittered = Math.floor(base * (0.8 + random() * 0.4));
  return Math.min(jittered, TRIAGE_BACKOFF_CAP_MS);
}

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const bounded = text.length <= max ? text : `${text.slice(0, max)}…`;
  return bounded.replace(/[\u0000-\u001f\u007f]/g, "�");
}

/** Count issues in a repo currently awaiting triage. */
function pendingCount(db: TissueDb, repoId: string): number {
  return db.sql.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM issues WHERE repo_id = ? AND state = 'TRIAGE_PENDING'",
    repoId,
  )?.c ?? 0;
}

/** A bounded per-issue triage digest (identifiers + truncated previews only). */
export function buildTriageDigest(
  db: TissueDb,
  repo: RepositoryRow,
  issue: IssueRow,
  configPath: string = process.env.TISSUE_CONFIG ?? "./tissue.yml",
): IssueTriageDigest {
  const proseTrusted = decideCurrentGithubProse(issue.envelope_actor_raw_login, configPath) === "TRUSTED";
  let body = "";
  if (issue.body_json) {
    try {
      const parsed = JSON.parse(issue.body_json) as unknown;
      if (typeof parsed === "string") body = parsed;
    } catch {
      body = "";
    }
  }
  const queued = db.sql.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM work_items WHERE repo_id = ? AND state IN ('QUEUED','READY')",
    repo.id,
  )?.c ?? 0;
  const running = db.sql.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM work_items WHERE repo_id = ? AND state IN ('RUNNING','WAITING','AWAITING_DECISION')",
    repo.id,
  )?.c ?? 0;
  const open = db.sql.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM issues WHERE repo_id = ? AND state NOT IN ('DUPLICATE','MERGED','REJECTED','BASELINE_EXCLUDED')",
    repo.id,
  )?.c ?? 0;
  return {
    issueId: issue.id,
    repoOwner: repo.owner,
    repoName: repo.name,
    repoId: repo.id,
    issueNumber: issue.number,
    titlePreview: proseTrusted ? truncate(issue.title, TITLE_PREVIEW_MAX) : "",
    bodyPreview: proseTrusted ? truncate(body, BODY_PREVIEW_MAX) : "",
    createdAt: issue.first_seen_at,
    pendingCount: pendingCount(db, repo.id),
    repoCounts: { open, queued, running },
  };
}

/** The next due (oldest TRIAGE_PENDING) issue for a repo, or undefined. */
function nextDueIssue(db: TissueDb, repoId: string): IssueRow | undefined {
  return db.sql.get<IssueRow>(
    "SELECT * FROM issues WHERE repo_id = ? AND state = 'TRIAGE_PENDING' ORDER BY first_seen_at, number LIMIT 1",
    repoId,
  );
}

/** Move the pump to PROMPTING from IDLE (after any expired BACKOFF → IDLE). */
function beginFlight(db: TissueDb, repoId: string, fromState: string, issueId: string): void {
  runWrite(db, (tx) => {
    if (fromState === "BACKOFF") {
      recordTransition(
        tx,
        { type: "triage", id: repoId },
        "BACKOFF",
        "IDLE",
        "backoff_complete",
        { issue_id: issueId },
        "controller.triage",
      );
      updateTriageState(tx, repoId, { state: "IDLE" });
    }
    recordTransition(
      tx,
      { type: "triage", id: repoId },
      "IDLE",
      "PROMPTING",
      "triage_start",
      { issue_id: issueId },
      "controller.triage",
    );
    updateTriageState(tx, repoId, { state: "PROMPTING" });
  });
}

/** Record a failed flight: BACKOFF (with jittered retry) or escalate to PAUSED. */
function failFlight(
  db: TissueDb,
  repoId: string,
  fromState: string,
  currentFailures: number,
  now: Date,
  errorMessage: string,
  random: () => number = Math.random,
): void {
  const failures = currentFailures + 1;
  runWrite(db, (tx) => {
    if (failures >= TRIAGE_ESCALATION_LIMIT) {
      recordTransition(
        tx,
        { type: "triage", id: repoId },
        fromState,
        "PAUSED_TRIAGE",
        "escalate",
        { consecutive_failures: failures, error: errorMessage },
        "controller.triage",
      );
      updateTriageState(tx, repoId, {
        state: "PAUSED_TRIAGE",
        failures,
        nextAttemptAt: null,
      });
    } else {
      const delayMs = triageBackoffDelayMs(failures, random);
      const nextAt = new Date(now.getTime() + delayMs).toISOString();
      recordTransition(
        tx,
        { type: "triage", id: repoId },
        fromState,
        "BACKOFF",
        "triage_backoff",
        { consecutive_failures: failures, retry_after_ms: delayMs, error: errorMessage },
        "controller.triage",
      );
      updateTriageState(tx, repoId, { state: "BACKOFF", failures, nextAttemptAt: nextAt });
    }
  });
}

/** Deterministic controller-generated WorkItem id for an issue's resolution work. */
function workItemIdFor(repo: RepositoryRow, issue: IssueRow): string {
  return `wi-${repo.owner}-${repo.name}-${issue.number}`;
}

/**
 * Create a canonical READY resolution WorkItem for a READY issue and attach it,
 * re-parenting any earlier NULL-WorkItem inbox events by Issue id. No-resolution-
 * before-READY holds by construction: callers invoke this only after the READY
 * disposition is applied in the same transaction.
 */
function ensureResolutionReady(
  tx: TissueDb,
  repo: RepositoryRow,
  issue: IssueRow,
): { workItemId: string; created: boolean } {
  const existing = activeIssueLinksForIssue(tx, issue.id);
  if (existing.length > 0) {
    // Already attached to an active WorkItem — ux_issue_one_active; do not create.
    return { workItemId: existing[0]!.work_item_id, created: false };
  }
  const id = workItemIdFor(repo, issue);
  const existingWi = getWorkItem(tx, id);
  if (!existingWi) {
    insertWorkItem(tx, {
      id,
      repo_id: repo.id,
      state: "READY",
      title: issue.title,
      base_branch: repo.base_branch ?? "main",
    });
  }
  attachIssueToWorkItem(tx, issue.id, id);
  reparentInboxByIssue(tx, issue.id, id);
  return { workItemId: id, created: true };
}

/** Group a DUPLICATE/MERGED issue onto an existing canonical WorkItem (no new work). */
function ensureGrouped(tx: TissueDb, repo: RepositoryRow, issue: IssueRow, canonical: WorkItemRow): string {
  attachIssueToWorkItem(tx, issue.id, canonical.id);
  reparentInboxByIssue(tx, issue.id, canonical.id);
  return canonical.id;
}

export interface TriageRunOptions {
  /** Inject a randomness source for backoff jitter (tests). */
  random?: () => number;
  /**
   * Bounded issue-body retrieval, injected so the controller owns the typed gh
   * argv (P2-S4). Called once before the digest is built; the returned text is
   * already bounded/control-safe. A null result leaves any existing body as-is.
   */
  fetchIssueBody?: (issue: IssueRow) => Promise<string | null>;
  /** Configured triage agent name (host-global definition); preserved on session create. */
  agent?: string;
  /** Configured triage provider/model identity; a concrete model is never auto-selected. */
  model?: ProviderModel;
  /** Current configuration path; loaded afresh at digest serialization. */
  configPath?: string;
}

/**
 * Run ONE triage flight for `repoId` (no-op when the repo is paused, in backoff,
 * has no due issue, or holds a stale PROMPTING flight). Returns a summary.
 */
export function runTriageRepo(
  db: TissueDb,
  repoId: string,
  driver: SessionDriver,
  now: Date = new Date(),
  opts: TriageRunOptions = {},
): Promise<TriageRunSummary> {
  const repo = getRepositoryById(db, repoId);
  if (!repo) throw new Error(`triage: unknown repository '${repoId}'`);
  const atIso = now.toISOString();
  const base = { repoId, failures: repo.triage_failures, triageState: repo.triage_state };
  const random = opts.random;

  if (repo.triage_state === "PAUSED_TRIAGE") {
    return Promise.resolve({ ...base, ran: false, reason: "paused" });
  }
  if (repo.triage_next_attempt_at && repo.triage_next_attempt_at > atIso) {
    return Promise.resolve({ ...base, ran: false, reason: "backoff" });
  }
  if (repo.triage_state === "PROMPTING") {
    // A prior flight was interrupted mid-prompt (crash). We cannot prompt again
    // (one flight per repo); record it as a failed flight so the pump backs off.
    const error = "stale PROMPTING flight from an interrupted prior pass";
    failFlight(db, repoId, "PROMPTING", repo.triage_failures, now, error, random);
    const after = getRepositoryById(db, repoId)!;
    return Promise.resolve({
      repoId,
      ran: false,
      reason: "stale_prompting",
      error,
      failures: after.triage_failures,
      triageState: after.triage_state,
    });
  }

  const issue = nextDueIssue(db, repoId);
  if (!issue) {
    // Park an expired BACKOFF pump back to IDLE so a later issue can be triaged.
    if (repo.triage_state === "BACKOFF") {
      runWrite(db, (tx) => {
        recordTransition(
          tx,
          { type: "triage", id: repoId },
          "BACKOFF",
          "IDLE",
          "backoff_complete",
          { issue_id: null },
          "controller.triage",
        );
        updateTriageState(tx, repoId, { state: "IDLE" });
      });
    }
    return Promise.resolve({ ...base, ran: false, reason: "no_due" });
  }

  // Begin the flight (IDLE → PROMPTING), possibly after an expired BACKOFF → IDLE.
  beginFlight(db, repoId, repo.triage_state, issue.id);

  // The driver calls (session ensure + prompt) happen OUTSIDE any DB transaction —
  // they are the abstract, side-effecting boundary this controller does not own in
  // this phase. On any failure the pump backs off/escalates durably.
  return (async (): Promise<TriageRunSummary> => {
    try {
      let sessionId = repo.triage_session_id;
      if (!sessionId) {
        const ref = await driver.ensureSession({
          repoId: repo.id,
          directory: repo.local_dir,
          kind: "triage",
          ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
        });
        runWrite(db, (tx) => updateTriageState(tx, repo.id, { sessionId: ref.sessionId }));
        sessionId = ref.sessionId;
      }

      if (opts.fetchIssueBody) {
        // Bounded body fetch BEFORE triage so the untrusted body is stored once in
        // the separate Tissue SQLite; failure fails the flight (fail closed) rather
        // than triaging on a body the controller could not bound.
        const body = await opts.fetchIssueBody(issue);
        if (body !== null && issue.body_json === null) {
          runWrite(db, (tx) =>
            updateIssueSnapshot(tx, issue.id, { bodyJson: JSON.stringify(body) }),
          );
        }
      }
      const freshIssue = getIssueById(db, issue.id) ?? issue;
      const digest = buildTriageDigest(db, repo, freshIssue, opts.configPath);
      const suggestion = await driver.promptTriage(sessionId, digest);
      return applySuggestion(db, repo, issue, suggestion);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failFlight(db, repo.id, "PROMPTING", repo.triage_failures, now, message, random);
      const after = getRepositoryById(db, repo.id)!;
      return {
        repoId: repo.id,
        ran: true,
        issueId: issue.id,
        outcome: "failure",
        failures: after.triage_failures,
        triageState: after.triage_state,
        error: message,
      };
    }
  })();
}

/** Validate a suggestion and apply it (envelope + relationships) atomically. */
function applySuggestion(
  db: TissueDb,
  repo: RepositoryRow,
  issue: IssueRow,
  suggestion: TriageSuggestion,
): TriageRunSummary {
  // ---- Bounded validation of the agent suggestion (reject untrusted data) ----
  if (suggestion.issueId !== issue.id) {
    throw new Error(`triage: suggestion references '${suggestion.issueId}', expected '${issue.id}'`);
  }
  if (!ISSUE_TRIAGE_DISPOSITIONS.includes(suggestion.disposition)) {
    throw new Error(`triage: disposition '${String(suggestion.disposition)}' is not a legal triage disposition`);
  }
  if (suggestion.reason !== undefined && suggestion.reason.length > 2000) {
    throw new Error("triage: suggestion reason exceeds 2000 characters");
  }

  let canonical: WorkItemRow | undefined;
  if (suggestion.canonicalWorkItemId !== undefined) {
    canonical = getWorkItem(db, suggestion.canonicalWorkItemId);
    if (!canonical) {
      throw new Error(`triage: canonical work item '${suggestion.canonicalWorkItemId}' does not exist`);
    }
  }

  const envelopeId = `env-${randomUUID()}`;

  const applied = runWrite(db, (tx) => {
    const envelope: TriageEnvelope = {
      kind: "triage",
      envelope_id: envelopeId,
      issue_id: issue.id,
      disposition: suggestion.disposition,
      ...(suggestion.canonicalWorkItemId !== undefined
        ? { canonical_work_item_id: suggestion.canonicalWorkItemId }
        : {}),
      ...(suggestion.blockedBy !== undefined ? { blocked_by: suggestion.blockedBy } : {}),
      ...(suggestion.reason !== undefined ? { reason: suggestion.reason } : {}),
    };
    const result = applyTriageEnvelope(tx, envelope);

    let createdWorkItemId: string | undefined;
    if (result.status !== "noop_duplicate") {
      if (suggestion.disposition === "READY") {
        const created = ensureResolutionReady(tx, repo, issue);
        createdWorkItemId = created.workItemId;
      } else if (canonical) {
        ensureGrouped(tx, repo, issue, canonical);
      }
    }

    // Atomically reset the pump (PROMPTING → IDLE) with the disposition outcome.
    recordTransition(
      tx,
      { type: "triage", id: repo.id },
      "PROMPTING",
      "IDLE",
      "triage_done",
      {
        issue_id: issue.id,
        disposition: suggestion.disposition,
        envelope_id: envelopeId,
        backoff_ms: 0,
        disposition_applied_at: new Date().toISOString(),
      },
      "controller.triage",
    );
    updateTriageState(tx, repo.id, { state: "IDLE", failures: 0, nextAttemptAt: null });

    return { status: result.status, createdWorkItemId };
  });

  const after = getRepositoryById(db, repo.id)!;
  return {
    repoId: repo.id,
    ran: true,
    issueId: issue.id,
    disposition: suggestion.disposition,
    outcome: applied.status === "noop_duplicate" ? "noop" : "disposition_applied",
    ...(applied.createdWorkItemId ? { createdWorkItemId: applied.createdWorkItemId } : {}),
    failures: after.triage_failures,
    triageState: after.triage_state,
  };
}

/** Run one triage flight per enabled repository (used by reconcile / tests). */
export async function runTriagePass(
  db: TissueDb,
  repos: RepositoryRow[],
  driver: SessionDriver,
  now: Date = new Date(),
  opts: TriageRunOptions = {},
): Promise<TriageRunSummary[]> {
  const summaries: TriageRunSummary[] = [];
  for (const repo of repos) {
    if (repo.enabled === 0) continue;
    summaries.push(await runTriageRepo(db, repo.id, driver, now, opts));
  }
  return summaries;
}

/** Explicitly unpause a repository's triage pump, resetting its failure counters. */
export function unpauseTriage(db: TissueDb, repoId: string, now: Date = new Date()): boolean {
  const repo = getRepositoryById(db, repoId);
  if (!repo) throw new Error(`triage: unknown repository '${repoId}'`);
  let changed = false;
  runWrite(db, (tx) => {
    if (repo.triage_state === "PAUSED_TRIAGE") {
      recordTransition(
        tx,
        { type: "triage", id: repo.id },
        "PAUSED_TRIAGE",
        "IDLE",
        "unpause",
        { explicit: true },
        "controller.triage",
      );
      changed = true;
    }
    // Reset counters/window regardless of current state (explicit unpause resets).
    updateTriageState(tx, repo.id, { state: "IDLE", failures: 0, nextAttemptAt: null });
  });
  return changed;
}
