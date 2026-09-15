// tests/helpers/session-driver.ts
//
// Scripted test double for the abstract SessionDriver boundary (src/controller/
// session-driver.ts). It records calls, captures digests for boundedness
// assertions, and plays a scripted queue of suggestions/errors so triage
// orchestration is fully testable WITHOUT any real OpenCode session/serve.

import type {
  SessionDriver,
  SessionMetadata,
  RealSessionRef,
  SessionStatus,
  IssueTriageDigest,
  TriageSuggestion,
} from "../../src/controller/session-driver.ts";

let sessionSeq = 0;

/**
 * A deterministic SessionDriver for tests. `outcomes` is consumed in order by
 * promptTriage; after it is exhausted the last good suggestion (if any) is
 * repeated. An `Error` outcome makes promptTriage throw (simulating a driver /
 * session failure).
 */
export class ScriptedTriageDriver implements SessionDriver {
  readonly sessionId: string;
  readonly ensureCalls: number[] = [];
  readonly statusCalls: string[] = [];
  readonly promptCalls: Array<{ sessionId: string; digest: IssueTriageDigest }> = [];
  readonly digests: IssueTriageDigest[] = [];
  private readonly outcomes: Array<TriageSuggestion | Error>;
  private lastGood: TriageSuggestion | null = null;

  constructor(outcomes: Array<TriageSuggestion | Error> = [], sessionId?: string) {
    sessionSeq += 1;
    this.sessionId = sessionId ?? `ses_test_${sessionSeq}`;
    this.outcomes = [...outcomes];
  }

  async ensureSession(metadata: SessionMetadata): Promise<RealSessionRef> {
    this.ensureCalls.push(this.ensureCalls.length);
    return { sessionId: this.sessionId, directory: metadata.directory };
  }

  async getSessionStatus(_sessionId: string): Promise<SessionStatus> {
    this.statusCalls.push("idle");
    return "idle";
  }

  async promptTriage(sessionId: string, digest: IssueTriageDigest): Promise<TriageSuggestion> {
    this.promptCalls.push({ sessionId, digest });
    this.digests.push(digest);
    const next = this.outcomes.shift();
    if (next instanceof Error) throw next;
    if (next) {
      this.lastGood = next;
      return next;
    }
    if (this.lastGood) return this.lastGood;
    throw new Error("scripted driver has no suggestion to return");
  }
}

/** Build a canned READY suggestion for an issue. */
export function readySuggestion(issueId: string): TriageSuggestion {
  return { issueId, disposition: "READY" };
}

/** Build a canned DUPLICATE suggestion grouping onto a canonical work item. */
export function duplicateSuggestion(issueId: string, canonicalWorkItemId: string): TriageSuggestion {
  return { issueId, disposition: "DUPLICATE", canonicalWorkItemId };
}
