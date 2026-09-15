// src/controller/session-driver.ts
//
// M4 abstract OpenCode session driver boundary (R3/R5, CONTRACTS OpenCode/runtime
// contracts). Triage orchestration talks ONLY to this interface — it never talks
// to the OpenCode runtime, HTTP, or filesystem directly. The REAL OpenCode driver
// (createRealSession/getSessionStatus/prompt against an OpenCode-created `ses_...`
// identity) is implemented at src/integrations/opencode-driver.ts and adapts to
// this port. This module ships the boundary plus the controller orchestration
// that consumes it, so triage logic remains fully testable through a test double;
// the real adapter plugs in below this interface with no controller change.
//
// No production implementation in this module performs a real OpenCode session
// call. The controller never creates a real session, writes OpenCode shared state
// (~/.local/share/opencode, ~/.config/opencode), or starts a serve process in this
// phase (STRICT GUARDRAIL). Only the durable, abstract `ses_...` identity is used.

import type { IssueTriageDisposition } from "../domain/state-machine.ts";
import type { ResolutionEnvelope } from "../domain/envelopes.ts";
import type { ProviderModel } from "../config/types.ts";

/** Session kind — triage (one per enabled repo) or resolution (one per active WI). */
export type SessionKind = "triage" | "resolution";

/** Durable OpenCode session lifecycle status; busy/retry are non-idle (R10). */
export type SessionStatus = "idle" | "busy" | "retry" | "missing";

/** Controller-side metadata used to create/relocate a durable session. */
export interface SessionMetadata {
  repoId: string;
  /** Repository/worktree directory in which the real session is created. */
  directory: string;
  kind: SessionKind;
  workItemId?: string;
  agent?: string;
  /** Native OpenCode provider/model identity; never a silently chosen model. */
  model?: ProviderModel;
}

/** An OpenCode-created durable session identity (ses_...). Never emulated. */
export interface RealSessionRef {
  sessionId: string;
  directory: string;
}

/**
 * Bounded per-issue triage digest. Only identifier-safe, bounded content is
 * presented to the agent — no full untrusted body dumps (R15/R17). Body/title
 * previews are truncated to the configured caps before building the digest.
 */
export interface IssueTriageDigest {
  issueId: string;
  repoOwner: string;
  repoName: string;
  repoId: string;
  issueNumber: number;
  titlePreview: string;
  bodyPreview: string;
  createdAt: string;
  /** Total candidate (TRIAGE_PENDING) issues currently awaiting triage in the repo. */
  pendingCount: number;
  /** Light repo context: open issues / queued / running work counts. */
  repoCounts: { open: number; queued: number; running: number };
}

/** A bounded, structured triage recommendation produced by the agent session. */
export interface TriageSuggestion {
  issueId: string;
  disposition: IssueTriageDisposition;
  /** Canonical WorkItem reference when grouping (DUPLICATE/MERGED/READY-to-existing). */
  canonicalWorkItemId?: string;
  /** Dependency identifier when disposition is BLOCKED. */
  blockedBy?: string;
  /** Bounded rationale (validated/length-capped by the controller). */
  reason?: string;
}

/** An OpenCode session driver error (session missing/unreachable, driver fault). */
export class SessionDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionDriverError";
  }
}

/**
 * The OpenCode session driver surface consumed by triage orchestration. A test
 * double implements this for tests; the real OpenCode implementation (Plan B)
 * implements the same methods.
 */
export interface SessionDriver {
  /**
   * Ensure a durable real session exists for the given repo/task, returning its
   * OpenCode-created `ses_...` identity. The controller persists the returned id.
   */
  ensureSession(metadata: SessionMetadata): Promise<RealSessionRef>;
  /** Observe the durable session's status; busy/retry are non-idle. */
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  /**
   * Prompt the durable session with a bounded per-issue digest and return the
   * agent's structured disposition recommendation. The controller validates the
   * suggestion (disposition enum, identifiers) before applying anything.
   */
  promptTriage(sessionId: string, digest: IssueTriageDigest): Promise<TriageSuggestion>;
}

/** Real resolution-session result returned by the semantic adapter. */
export interface ResolutionResult {
  envelope: ResolutionEnvelope;
  assistantId?: string;
}

/** Optional capability implemented by the resident OpenCode resolution adapter. */
export interface ResolutionDriver {
  createRealSession(kind: "resolution", directory: string, metadata: SessionMetadata): Promise<RealSessionRef>;
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  promptAsync(sessionId: string, prompt: { text: string; nonce?: string; agent?: string; model?: { providerID: string; modelID: string } }): Promise<unknown>;
  observeCompletion(sessionId: string, nonce: string): Promise<{ matched: boolean; assistantId?: string }>;
  readResolutionResult(sessionId: string, workItemId: string, nonce: string): Promise<ResolutionResult | null>;
}
