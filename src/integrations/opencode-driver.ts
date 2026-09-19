// src/integrations/opencode-driver.ts
//
// M6 REAL OpenCode session driver (R3/R5/R10, CONTRACTS OpenCode runtime
// contracts). This is the production driver for durable OpenCode-created
// `ses_...` sessions. It implements the CONTRACTS real-session op surface:
//
//   createRealSession(kind, directory, metadata) -> RealSessionRef
//   getSessionStatus(sessionId)                   -> 'idle'|'busy'|'retry'|'missing'
//   listSessions(directory?) / getSession(id)
//   promptSession(sessionId, envelope)            -> PromptObservation  (sync turn)
//   promptAsync(sessionId, envelope)              -> AcceptedObservation (204 != completion)
//   abortSession(sessionId)
//   readHistory(sessionId)                        -> raw ordered history
//   observeCompletion(sessionId, deliveryNonce, obs) -> CompletionMatch
//
// It REUSES the controller boundary types (SessionStatus/SessionMetadata/
// RealSessionRef/SessionDriverError) so a controller-side `SessionDriver`
// implementation can be wired over it later, but it is deliberately NOT bound
// to the triage trio's `ensureSession`/`promptTriage` orchestration contract
// (that path needs TriageSuggestion transcript parsing — an RG-3/RG-4 release
// concern for the integration checkpoint in a later phase).
//
// Real-session-only: this module never creates an emulated/fake session and
// never reaches an OpenCode shared-state path (opencode.db is never opened
// directly, R1 hygiene). The durable mapping lives ONLY in the Tissue DB
// (`opencode_sessions`) when a db handle is wired; nowhere else.
//
// Completion semantics (RG-4): HTTP acceptance (204) is NOT completion, and a
// `noReply` user injection is not completion. Completion is established only by
// `observeCompletion`, which reads the transcript and matches a nonce-bearing
// USER message followed by a parent-linked ASSISTANT turn, excluding
// summary=true and mode=compaction. This module reads the transcript via the
// tested RAW HTTP fallback (opencode-http.listMessages) — DD RG-6's sanctioned
// alternative to pinning the 1.17.18 SDK `session.messages`.

import {
  SessionDriverError,
  type IssueTriageDigest,
  type TriageSuggestion,
  type ResolutionResult,
} from "../controller/session-driver.ts";
import { TISSUE_TRIAGE_AGENT } from "../config/types.ts";
import { validateEnvelope, type TriageEnvelope } from "../domain/envelopes.ts";
import type {
  RealSessionRef,
  SessionKind,
  SessionMetadata,
  SessionStatus,
} from "../controller/session-driver.ts";
import type { TissueDb } from "../db/open.ts";
import { insertSession, recordSessionObservation } from "../db/repositories.ts";
import {
  type OcHistoryEntry,
  type OcMessage,
  type OcSession,
  OpenCodeHttp,
  OpenCodeHttpError,
} from "./opencode-http.ts";
import {
  classifySessionMarker,
  createSessionMarker,
  ensureSessionMarkerBeforeResume,
  resolveSessionRegistryDir,
} from "../controller/session-registry.ts";
import type { JsonLogger } from "../logging/jsonl.ts";

// Re-exported so callers do not need the raw-client types.
export type { RealSessionRef, SessionKind, SessionMetadata, SessionStatus };
export { OpenCodeHttp, OpenCodeHttpError };

/** Bounded, controller-constructed prompt content pushed to a durable session. */
export interface PromptEnvelope {
  /** Prompt body. The delivery nonce is embedded here when present. */
  text: string;
  /** Optional explicit delivery nonce recorded before prompting (RG-4). */
  nonce?: string;
  agent?: string;
  /** Provider/model id, passed through to the resident OpenCode API. */
  model?: { providerID: string; modelID: string };
  noReply?: boolean;
  system?: string;
}

/** Outcome of a synchronous prompt: the server returned an assistant turn. */
export interface PromptObservation {
  kind: "turn";
  assistantId: string;
  parentId: string | undefined;
  mode: string;
  summary: boolean;
}

/** Outcome of an async prompt: HTTP 204 acceptance — NOT completion (RG-4). */
export interface AcceptedObservation {
  kind: "accepted";
}

export type Observation = PromptObservation | AcceptedObservation;

/** Result of transcript matching for a delivery nonce (RG-4 completion). */
export type CompletionMatch =
  | {
      matched: true;
      nonceUserMessageId: string;
      assistantId: string;
      mode: string;
    }
  | {
      matched: false;
      reason: "nonce_not_found" | "no_turn" | "only_summary_or_compaction" | "session_missing";
    };

export interface OpenCodeDriverOptions {
  /** Raw loopback HTTP transport (binds 127.0.0.1; never public). */
  http: OpenCodeHttp;
  /** When set, createRealSession persists the durable mapping here (Tissue DB). */
  db?: TissueDb;
  triageAgent?: string;
  triageModel?: { providerID: string; modelID: string };
  /**
   * Managed-session registry directory (plan I). Resolved from
   * `resolveSessionRegistryDir(process.env)` when omitted, so production callers
   * pass the same value the startup mount assertion checked.
   */
  registryDir?: string;
  /**
   * Optional managed-session gate predicate. PRODUCTION ASSEMBLY MUST ALWAYS
   * SUPPLY IT (plan M wires the beacon-backed default) so the managed path is
   * fail-closed. When omitted — tests and non-production assembly — only the
   * loaded half of the gate is skipped; the marker-existence invariant still
   * applies unconditionally. A predicate reporting `loaded: false` refuses
   * creation and prompting of a managed session with a typed, logged error.
   */
  managedGate?: () => ManagedGateVerdict;
  /** Structured logger for gate refusals; omitted means no refusal logging. */
  logger?: JsonLogger;
}

/** Verdict of an injected managed-session gate predicate (fail-closed). */
export interface ManagedGateVerdict {
  loaded: boolean;
  reason: string;
}

/**
 * Typed refusal thrown when the managed-session gate is closed: the marker is
 * absent on the creation path, or the moderation-plugin predicate reports not
 * loaded. Carries a machine-readable `reason`; `name === "ManagedSessionGateError"`.
 */
export class ManagedSessionGateError extends Error {
  readonly reason: string;
  readonly action: string;
  readonly sessionId?: string;
  constructor(reason: string, action: string, sessionId?: string) {
    super(`managed-session gate refused (${action}): ${reason}`);
    this.name = "ManagedSessionGateError";
    this.reason = reason;
    this.action = action;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }
}

/** What a gate call must assert about the marker before it may prompt. */
type ManagedGateRequest =
  | { marker: "creation"; registryDir: string; sessionId: string; action: string }
  | { marker: "resume"; registryDir: string; sessionId: string; action: string }
  | { marker: "none"; action: string };

/**
 * The single managed-session gate helper (plan J P2-S3), shared by
 * `createRealSession`, `promptTriage`, `promptSession` and `promptAsync`. It
 * enforces the single invariant — "Tissue MUST NOT prompt or resume an OpenCode
 * session unless that session's marker currently exists" — and, when the
 * optional predicate is wired, that the moderation plugin is loaded:
 *
 *   - `creation`: the marker must ALREADY classify MANAGED (never recreated).
 *   - `resume`:   the marker is (re)created by the idempotent plan-I helper
 *                 immediately before the prompt.
 *   - `none`:     no session id exists yet (the OpenCode session is created
 *                 after the gate); only the loaded predicate is consulted.
 *
 * A refusal throws exactly one `ManagedSessionGateError` and emits exactly one
 * structured `managed_session.gate_refused` record. It never touches unrelated
 * tools (`edit`/`bash`/`read`) and never makes OpenCode unavailable.
 */
function enforceManagedSessionGate(
  request: ManagedGateRequest,
  gate: (() => ManagedGateVerdict) | undefined,
  logger: JsonLogger | undefined,
): void {
  const refuse = (reason: string, sessionId?: string): never => {
    logger?.warn("managed_session.gate_refused", {
      action: request.action,
      reason,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    throw new ManagedSessionGateError(reason, request.action, sessionId);
  };

  if (request.marker === "creation") {
    // Creation path: the marker must currently exist; never recreate it here.
    if (classifySessionMarker(request.registryDir, request.sessionId) !== "MANAGED") {
      refuse("marker-absent", request.sessionId);
    }
  } else if (request.marker === "resume") {
    // Resume path: recreate the marker immediately before the prompt if needed.
    // One statSync when present; one atomic create otherwise (no cache, no HTTP).
    ensureSessionMarkerBeforeResume(request.registryDir, request.sessionId);
  }

  if (gate) {
    const verdict = gate();
    if (!verdict.loaded) {
      refuse(verdict.reason, request.marker === "none" ? undefined : request.sessionId);
    }
  }
}

function isUserMessage(m: OcMessage): m is Extract<OcMessage, { role: "user" }> {
  return m.role === "user";
}

function messageText(m: OcMessage, parts: OcHistoryEntry["parts"]): string {
  // Concatenate text-part text. Guards against the OQ3-late/missing history by
  // tolerating empty part arrays (returns "").
  let out = "";
  for (const p of parts) {
    if (p.type === "text" && typeof p.text === "string") out += p.text;
  }
  return out;
}

function isSummaryOrCompaction(m: OcMessage): boolean {
  if (m.role !== "assistant") return false;
  if (m.summary === true) return true;
  // mode === 'compaction' is the durable compaction marker on assistant turns.
  if (m.mode === "compaction") return true;
  return false;
}

/**
 * Record the resident-observed agent/model for a session from its transcript.
 * Only values the resident runtime actually reported are persisted; a session
 * with no observed metadata is left untouched (never a guessed model). Kept as a
 * module-level function so the driver's public/prototype method surface stays
 * the closed session-op set.
 */
async function captureObservedMetadata(http: OpenCodeHttp, db: TissueDb | undefined, sessionId: string): Promise<void> {
  if (!db) return;
  let history: OcHistoryEntry[];
  try {
    history = await http.listMessages(sessionId);
  } catch {
    return;
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const info = history[i]!.info;
    if (info.role !== "user") continue;
    const agent = typeof info.agent === "string" && info.agent.length > 0 ? info.agent : null;
    const model = info.model ? JSON.stringify(info.model) : null;
    if (agent === null && model === null) return;
    recordSessionObservation(db, sessionId, { agent, model_json: model });
    return;
  }
}

/**
 * Real OpenCode session driver. All transport is via OpenCodeHttp (raw HTTP
 * fallback over fetch). Production behavior is real-session-only; no emulation.
 *
 * Registration ordering (plan J / L12): create the real session -> write the
 * `ses_*` registry marker -> persist the durable Tissue mapping -> prompt. The
 * managed prompt/resume funnels additionally enforce the single invariant that
 * no session is prompted or resumed unless its marker currently exists, and —
 * when a gate predicate is wired — that the moderation plugin is loaded. The
 * production assembly MUST always wire the predicate (plan M); without it the
 * loaded half of the gate is skipped, never the marker invariant.
 */
export class OpenCodeDriver {
  private readonly http: OpenCodeHttp;
  private readonly db?: TissueDb;
  private readonly triageAgent: string;
  private readonly triageModel?: { providerID: string; modelID: string };
  /** Managed-session registry dir (plan I); resolved from env when omitted. */
  private readonly registryDir: string;
  /** Fail-closed moderation-plugin predicate; production must supply one. */
  private readonly managedGate?: () => ManagedGateVerdict;
  /** Structured logger for gate refusals (optional). */
  private readonly logger?: JsonLogger;
  /** Defensive guard: refuse overlapping synchronous prompt issues. */
  private syncPromptInFlight = false;

  constructor(opts: OpenCodeDriverOptions) {
    this.http = opts.http;
    this.db = opts.db;
    this.triageAgent = opts.triageAgent ?? TISSUE_TRIAGE_AGENT;
    this.triageModel = opts.triageModel;
    this.registryDir = opts.registryDir ?? resolveSessionRegistryDir(process.env);
    this.managedGate = opts.managedGate;
    this.logger = opts.logger;
  }

  /**
   * Create a real OpenCode session bound to `directory`, verify the server
   * returned an OpenCode-created `ses_...` identity, and (when a db is wired)
   * persist the mapping ONLY in the Tissue `opencode_sessions` table.
   */
  async createRealSession(kind: SessionKind, directory: string, metadata: SessionMetadata): Promise<RealSessionRef> {
    // The gate is consulted BEFORE the OpenCode session exists: a closed managed
    // gate must refuse creation without producing a server-side session.
    enforceManagedSessionGate({ marker: "none", action: "create" }, this.managedGate, this.logger);
    const created = await this.http.createSession(directory, { title: undefined });
    const id = created.id;
    if (!/^ses_[A-Za-z0-9]+$/.test(id)) {
      // Real-session identity is only real: never trust a non-ses_ identity.
      throw new OpenCodeHttpError(
        `createRealSession: server returned non-ses_ identity '${id}' (refusing real-session guarantee)`,
        0,
      );
    }
    // Order (L12): marker BEFORE the durable mapping. A marker-write failure is
    // FATAL and joins the non-ses_ fail-closed set: no RealSessionRef is ever
    // handed to a caller that prompts, and no durable row is persisted.
    try {
      createSessionMarker(this.registryDir, id);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `createRealSession: managed-session marker write failed for '${id}' ` +
          `(no real-session guarantee is issued without a marker): ${detail}`,
      );
    }
    const ref: RealSessionRef = { sessionId: id, directory };
    if (this.db) {
      insertSession(this.db, {
        id,
        kind,
        repo_id: metadata.repoId,
        work_item_id: metadata.workItemId ?? null,
        directory,
        agent: metadata.agent ?? null,
        model_json: metadata.model ? JSON.stringify(metadata.model) : null,
        state: "ACTIVE",
      });
    }
    return ref;
  }

  /** SessionDriver triage adapter: create one real durable session. */
  async ensureSession(metadata: SessionMetadata): Promise<RealSessionRef> {
    return this.createRealSession(metadata.kind, metadata.directory, metadata);
  }

  /** Prompt the triage role and parse exactly one bounded typed envelope. */
  async promptTriage(sessionId: string, digest: IssueTriageDigest): Promise<TriageSuggestion> {
    // Creation path: the marker must ALREADY exist; never recreate it here.
    enforceManagedSessionGate(
      { marker: "creation", registryDir: this.registryDir, sessionId, action: "prompt_triage" },
      this.managedGate,
      this.logger,
    );
    const result = await this.promptSession(sessionId, {
      agent: this.triageAgent,
      ...(this.triageModel ? { model: this.triageModel } : {}),
      text: [
        "Return exactly one JSON triage envelope and no markdown.",
        `issue_id=${digest.issueId} repository=${digest.repoOwner}/${digest.repoName} number=${digest.issueNumber}`,
        `title=${digest.titlePreview}`,
        `body=${digest.bodyPreview}`,
        `created_at=${digest.createdAt} pending=${digest.pendingCount} open=${digest.repoCounts.open} queued=${digest.repoCounts.queued} running=${digest.repoCounts.running}`,
        "Allowed dispositions: READY, DUPLICATE, MERGED, BLOCKED, REJECTED, PAUSED_TRIAGE.",
      ].join("\n"),
    });
    const history = await this.readHistory(sessionId);
    const entry = history.find((item) => item.info.id === result.assistantId);
    if (!entry) throw new SessionDriverError("triage assistant turn disappeared from history");
    const text = entry.parts.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
    if (text.length === 0 || text.length > 8_000) throw new SessionDriverError("triage output is empty or oversized");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new SessionDriverError("triage output is not JSON"); }
    if (!raw || typeof raw !== "object") throw new SessionDriverError("triage output is not an object");
    const envelope = raw as TriageEnvelope;
    validateEnvelope(envelope);
    if (envelope.kind !== "triage" || envelope.issue_id !== digest.issueId) throw new SessionDriverError("triage envelope identity mismatch");
    return {
      issueId: envelope.issue_id,
      disposition: envelope.disposition,
      ...(envelope.canonical_work_item_id ? { canonicalWorkItemId: envelope.canonical_work_item_id } : {}),
      ...(envelope.blocked_by ? { blockedBy: envelope.blocked_by } : {}),
      ...(envelope.reason ? { reason: envelope.reason } : {}),
    };
  }

  /** List durable sessions, optionally exact-directory-scoped. */
  async listSessions(directory?: string): Promise<OcSession[]> {
    return this.http.listSessions(directory);
  }

  /** Get one durable session by its ses_ id (throws when missing). */
  async getSession(sessionId: string): Promise<OcSession> {
    return this.http.getSession(sessionId);
  }

  /**
   * Map the server's observed status for a session onto the controller's
   * SessionStatus. busy/retry are NON-idle (R10).
   *
   * The status map only reports non-idle sessions (an idle map is `{}`), so an
   * absent entry does NOT mean the session is gone: fall back to GET /session/
   * {id} to distinguish an existing-but-idle session from a genuinely missing
   * (deleted) one (OQ3/U-2 evidence).
   *
   * A 404 from the GLOBAL GET /session/status request is a dependency/route
   * failure, never evidence about one session: it is rethrown so the caller treats
   * it as resident unavailability. Only a confirmed 404 from the individual
   * GET /session/{id} lookup below maps to `missing`.
   */
  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    // Deliberately NOT caught: a failing service-level status read (including 404)
    // is a transport/dependency failure, not a per-session classification.
    const statuses: Record<string, { type: string }> = await this.http.sessionStatus();
    const raw = statuses[sessionId];
    if (raw) {
      if (raw.type === "busy") return "busy";
      if (raw.type === "retry") return "retry";
      if (raw.type === "idle") return "idle";
    }
    // Absent from the (non-idle-only) status map: confirm the session exists.
    try {
      await this.http.getSession(sessionId);
      return "idle";
    } catch (err) {
      if (err instanceof OpenCodeHttpError && err.status === 404) return "missing";
      throw err;
    }
  }

  /**
   * Sync prompt (turn barrier): POST /session/{id}/message. Never issues
   * controller prompts concurrently (defensive guard + caller gates on idle).
   * HTTP acceptance is NOT completion — the returned turn is the assistant turn.
   */
  async promptSession(sessionId: string, prompt: PromptEnvelope): Promise<PromptObservation> {
    // Resume path: recreate a missing marker immediately before the prompt.
    enforceManagedSessionGate(
      { marker: "resume", registryDir: this.registryDir, sessionId, action: "prompt" },
      this.managedGate,
      this.logger,
    );
    if (this.syncPromptInFlight) {
      throw new SessionDriverError("concurrent prompt refused: a sync prompt is already in flight");
    }
    this.syncPromptInFlight = true;
    try {
      const body = this.buildPromptBody(prompt);
      const res = await this.http.sendMessage(sessionId, body);
      const info = res.info;
      if (info.role !== "assistant") {
        throw new SessionDriverError(`prompt ${sessionId}: expected an assistant turn, got role '${info.role}'`);
      }
      await captureObservedMetadata(this.http, this.db, sessionId);
      return {
        kind: "turn",
        assistantId: info.id,
        parentId: info.parentID,
        mode: info.mode,
        summary: info.summary === true,
      };
    } finally {
      this.syncPromptInFlight = false;
    }
  }

  /**
   * Async prompt: POST /session/{id}/prompt_async. A 204 response means the
   * prompt was ACCEPTED, never that it completed (RG-4). Callers gate on
   * observed-idle then drive completion via observeCompletion.
   */
  async promptAsync(sessionId: string, prompt: PromptEnvelope): Promise<AcceptedObservation> {
    // Resume path: recreate a missing marker immediately before the prompt.
    enforceManagedSessionGate(
      { marker: "resume", registryDir: this.registryDir, sessionId, action: "prompt_async" },
      this.managedGate,
      this.logger,
    );
    if (this.syncPromptInFlight) {
      throw new SessionDriverError("concurrent prompt refused: a sync prompt is already in flight");
    }
    const body = this.buildPromptBody(prompt);
    await this.http.sendPromptAsync(sessionId, body);
    return { kind: "accepted" };
  }

  /** Abort the in-flight turn of a session (no completion is produced). */
  async abortSession(sessionId: string): Promise<void> {
    await this.http.abortSession(sessionId);
  }

  /** Read the ordered transcript for a session ({info, parts} entries). */
  async readHistory(sessionId: string): Promise<OcHistoryEntry[]> {
    return this.http.listMessages(sessionId);
  }

  /**
   * Establish completion by matching the durable transcript: a nonce-bearing
   * USER message whose text contains `deliveryNonce`, followed by a subsequent
   * ASSISTANT turn whose parentID === that user message id. Summary (summary=
   * true) and compaction (mode=compaction) assistant messages are EXCLUDED
   * (RG-4). This is the raw-HTTP-fallback path (DD RG-6).
   */
  async observeCompletion(sessionId: string, deliveryNonce: string, _observation?: Observation): Promise<CompletionMatch> {
    let history: OcHistoryEntry[];
    try {
      history = await this.readHistory(sessionId);
    } catch (err) {
      if (err instanceof OpenCodeHttpError && err.status === 404) {
        return { matched: false, reason: "session_missing" };
      }
      throw err;
    }

    let nonceUserMessageId: string | undefined;
    let nonceIndex = -1;
    for (let i = 0; i < history.length; i++) {
      const { info, parts } = history[i]!;
      if (!isUserMessage(info)) continue;
      const text = messageText(info, parts);
      if (text.includes(deliveryNonce) || (info.id === deliveryNonce)) {
        nonceUserMessageId = info.id;
        nonceIndex = i;
        break;
      }
    }
    if (nonceUserMessageId === undefined) {
      return { matched: false, reason: "nonce_not_found" };
    }

    // Scan forward for a parent-linked, non-summary, non-compaction assistant turn.
    let sawSummaryOrCompaction = false;
    for (let j = nonceIndex + 1; j < history.length; j++) {
      const { info } = history[j]!;
      if (info.role !== "assistant") continue;
      if (info.parentID !== nonceUserMessageId) continue;
      if (isSummaryOrCompaction(info)) {
        sawSummaryOrCompaction = true;
        continue;
      }
      await captureObservedMetadata(this.http, this.db, sessionId);
      return {
        matched: true,
        nonceUserMessageId,
        assistantId: info.id,
        mode: info.mode,
      };
    }
    return { matched: false, reason: sawSummaryOrCompaction ? "only_summary_or_compaction" : "no_turn" };
  }

  /** Parse the latest parent-linked assistant text as a bounded resolution envelope. */
  async readResolutionResult(sessionId: string, workItemId: string, deliveryNonce: string): Promise<ResolutionResult | null> {
    const history = await this.readHistory(sessionId);
    const completion = await this.observeCompletion(sessionId, deliveryNonce);
    if (!completion.matched) return null;
    const entry = history.find((item) => item.info.role === "assistant" && item.info.id === completion.assistantId);
    if (!entry) return null;
    const text = entry.parts.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
    if (text.length === 0 || text.length > 16_000) throw new SessionDriverError("resolution assistant output is empty or oversized");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new SessionDriverError("resolution assistant output is not JSON"); }
    if (!raw || typeof raw !== "object") throw new SessionDriverError("resolution assistant output is not an object");
    const envelope = raw as import("../domain/envelopes.ts").ResolutionEnvelope;
    if (envelope.kind !== "resolution" || envelope.work_item_id !== workItemId) throw new SessionDriverError("resolution envelope identity mismatch");
    const { validateEnvelope } = await import("../domain/envelopes.ts");
    validateEnvelope(envelope);
    return { envelope, assistantId: completion.assistantId };
  }

  private buildPromptBody(prompt: PromptEnvelope): {
    agent?: string;
    model?: { providerID: string; modelID: string };
    noReply?: boolean;
    system?: string;
    parts: { type: "text"; text: string }[];
  } {
    // Only identifier-bounded, non-lifecycle content reaches the session (no
    // tools map is ever attached, so no lifecycle-mutating Tissue tool is ever
    // reachable by a session). The delivery nonce travels inside `text`.
    return {
      ...(prompt.agent !== undefined ? { agent: prompt.agent } : {}),
      ...(prompt.model !== undefined ? { model: prompt.model } : {}),
      ...(prompt.noReply !== undefined ? { noReply: prompt.noReply } : {}),
      ...(prompt.system !== undefined ? { system: prompt.system } : {}),
      parts: [{ type: "text", text: prompt.text }],
    };
  }
}
