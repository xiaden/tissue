// src/controller/intake.ts
//
// P2 intake policy: label admission, bounded numeric-ID issue body retrieval,
// and the bounded untrusted-content sanitizer shared by triage/ingest.
//
// This module is intentionally pure/read-only apart from the injected gh reader:
//   - admitIssue is a deterministic decision function over already-parsed labels;
//   - fetchBoundedIssueBody reads ONE issue body by NUMERIC id through the
//     identifier-safe GhClient (typed argv, fixed --json field set) and returns a
//     BOUNDED, control-safe string. Untrusted body text is never placed in argv,
//     never shell-interpreted, and never stored unbounded.
//
// Precedence: TISSUE-REQUEST > DD > CONTRACTS > plan > implementation. Empty
// configured labels admit every eligible issue; a non-empty label set admits any
// issue carrying at least one matching label; an explicit enqueue is the sole
// historical override and is the only path that admits a baseline-excluded issue.

import type { GhClient } from "../integrations/gh-client.ts";
import { argvIssueBody } from "../integrations/gh-client.ts";

/** Default cap on a bounded issue body (characters, after control stripping). */
export const BODY_LIMIT_DEFAULT = 8_000;

/**
 * Normalize line endings to LF: CRLF and lone CR both become a single LF, so line
 * structure survives as newlines rather than replacement markers. Remaining C0/C1
 * control characters (except tab/newline) are then replaced with a marker.
 */
export function sanitizeUntrustedText(text: string, limit: number): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n?/g, "\n");
  const stripped = normalized.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "\ufffd");
  if (stripped.length <= limit) return { text: stripped, truncated: false };
  return { text: stripped.slice(0, limit), truncated: true };
}

export interface BoundedIssueBody {
  owner: string;
  name: string;
  issueNumber: number;
  /** Control-safe, length-bounded body text (never full unbounded untrusted text). */
  body: string;
  truncated: boolean;
  /** Length of the sanitized (pre-truncation) text. */
  length: number;
}

/**
 * Read one issue body by NUMERIC id through the validated gh binary and return a
 * bounded, control-safe value. The issue number is validated as an integer by the
 * argv builder, so no untrusted identifier ever reaches the command line.
 */
export async function fetchBoundedIssueBody(
  gh: GhClient,
  owner: string,
  name: string,
  issueNumber: number,
  limit: number = BODY_LIMIT_DEFAULT,
): Promise<BoundedIssueBody> {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const raw = (await gh.runJson(argvIssueBody(owner, name, issueNumber))) as { body?: unknown };
  const body = typeof raw.body === "string" ? raw.body : "";
  const { text, truncated } = sanitizeUntrustedText(body, boundedLimit);
  return { owner, name, issueNumber, body: text, truncated, length: body.length };
}

export type AdmissionReason = "baseline" | "label_mismatch" | "admitted" | "explicit_enqueue";

export interface AdmissionDecision {
  admitted: boolean;
  reason: AdmissionReason;
}

/** Parse a repository `labels_json` column into a bounded string list. */
export function parseConfiguredLabels(labelsJson: string | null | undefined): string[] {
  if (!labelsJson) return [];
  try {
    const parsed = JSON.parse(labelsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Deterministic label/baseline admission policy:
 *   - an explicit enqueue always admits (the sole historical override, R14);
 *   - a baseline-excluded issue is otherwise never admitted by discovery;
 *   - empty configured labels admit ALL eligible issues;
 *   - non-empty configured labels admit an issue carrying ANY matching label.
 */
export function admitIssue(
  labels: readonly string[],
  configuredLabels: readonly string[],
  explicitEnqueue: boolean,
  baselineExcluded: boolean,
): AdmissionDecision {
  if (explicitEnqueue) return { admitted: true, reason: "explicit_enqueue" };
  if (baselineExcluded) return { admitted: false, reason: "baseline" };
  if (configuredLabels.length === 0) return { admitted: true, reason: "admitted" };
  const match = labels.some((label) => configuredLabels.includes(label));
  return match ? { admitted: true, reason: "admitted" } : { admitted: false, reason: "label_mismatch" };
}
