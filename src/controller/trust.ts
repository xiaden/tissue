import { createHash } from "node:crypto";

import type { TissueConfig } from "../config/types.ts";
import { loadConfig } from "../config/load.ts";

export type ActorPresence = "PRESENT" | "MISSING" | "UNKNOWN" | "MALFORMED";
export type TrustDecision =
  | "TRUSTED"
  | "UNTRUSTED"
  | "MISSING_ACTOR"
  | "UNKNOWN_ACTOR"
  | "MALFORMED_ACTOR"
  | "CONFIG_UNUSABLE";
export type DeliveryClass = "OBJECTIVE" | "TRUSTED_PROSE" | "DENIED_PROSE";
export type GithubProseDecision = "TRUSTED" | "DENIED";

/** Legacy immutable allowlist representation used by ingestion-time provenance helpers.
 *
 * This policy and its revision are not authoritative for later agent-visible prose;
 * retrieval boundaries use `decideCurrentGithubProse` instead.
 */
export interface TrustedGithubPolicy {
  /** ASCII-lowercased GitHub logins accepted by the policy. */
  readonly normalizedUsers: ReadonlySet<string>;
  /** `sha256:` revision derived from the sorted normalized allowlist. */
  readonly revision: string;
  /** False when configuration is absent, empty, or contains an invalid login. */
  readonly usable: boolean;
}

/** The actor fields observed at ingestion time; missing or malformed data is retained explicitly. */
export interface ActorObservation {
  readonly present: boolean;
  readonly rawLogin: string | null;
  readonly normalizedLogin: string | null;
  readonly presence: ActorPresence;
}

/** Legacy version-bound actor/provenance data retained with a source record.
 *
 * Its decision and policy revision are historical metadata, not authorization for
 * later prose delivery; final retrieval uses the current configuration.
 */
export interface ProvenanceEnvelope {
  readonly repository: string;
  readonly sourceKind: string;
  readonly objectId: string;
  readonly contentId: string | null;
  readonly observedVersion: string;
  readonly contentHash: string | null;
  readonly authoritativeAt: string;
  /** Policy revision used for this decision; decisions are not recomputed later. */
  readonly policyRevision: string;
  readonly actor: ActorObservation;
  readonly decision: TrustDecision;
  readonly reason: string;
  readonly deliveryClass: DeliveryClass;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007f]/;

/** Normalize only a current, textual GitHub login; invalid values return null. */
export function normalizeGithubLogin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 39) return null;
  if (CONTROL_OR_SPACE_RE.test(raw) || !LOGIN_RE.test(raw)) return null;
  return raw.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function immutableSet(values: readonly string[]): ReadonlySet<string> {
  const set = new Set(values);
  return new Proxy(set, {
    get(target, property, receiver) {
      if (property === "add" || property === "delete" || property === "clear") {
        return () => { throw new TypeError("trusted policy membership is immutable"); };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function revisionMaterial(users: readonly string[]): string {
  return JSON.stringify({ trustedGithubUsers: [...users].sort() });
}

/** Return a stable, content-addressed revision for a normalized policy. */
export function policyRevision(policy: TrustedGithubPolicy): string {
  return policy.revision;
}

/**
 * Build an immutable policy from the optional security configuration.
 *
 * Invalid or empty input produces an unusable policy rather than a trust-all
 * fallback. Valid logins are ASCII-normalized, deduplicated, sorted, and
 * assigned a stable SHA-256 revision.
 *
 * @param config Configuration containing the optional GitHub trust allowlist.
 * @returns The normalized policy, revision, and usability state.
 */
export function createTrustedGithubPolicy(config: Pick<TissueConfig, "security"> | null | undefined): TrustedGithubPolicy {
  const rawUsers = config?.security?.trustedGithubUsers;
  if (!rawUsers || rawUsers.length === 0) {
    return { normalizedUsers: immutableSet([]), revision: revisionForUsers([]), usable: false };
  }
  const normalized = rawUsers.map((login) => normalizeGithubLogin(login));
  if (normalized.some((login): login is null => login === null)) {
    return { normalizedUsers: immutableSet([]), revision: revisionForUsers([]), usable: false };
  }
  const users = [...new Set(normalized as string[])].sort();
  return { normalizedUsers: immutableSet(users), revision: revisionForUsers(users), usable: users.length > 0 };
}

function revisionForUsers(users: readonly string[]): string {
  return `sha256:${createHash("sha256").update(revisionMaterial(users), "utf8").digest("hex")}`;
}

function result(decision: TrustDecision, reason: string): { decision: TrustDecision; reason: string; deliveryClass: DeliveryClass } {
  return { decision, reason, deliveryClass: decision === "TRUSTED" ? "TRUSTED_PROSE" : "DENIED_PROSE" };
}

/**
 * Classify an observed GitHub actor against a policy without fail-open behavior.
 *
 * Unusable policies and missing, unknown, or malformed actors receive explicit
 * denied decision classes. Only an allowlisted normalized login is `TRUSTED`;
 * that result is delivered as `TRUSTED_PROSE`, while all other results are
 * delivered as `DENIED_PROSE`.
 *
 * @param policy The immutable policy, or null when no policy is available.
 * @param actor Actor observation captured for the source object.
 * @returns The legacy decision, reason code, and delivery class recorded for the observed policy evaluation. This result is not the authority for later prose delivery.
 */
export function decideGithubActor(
  policy: TrustedGithubPolicy | null,
  actor: ActorObservation,
): { decision: TrustDecision; reason: string; deliveryClass: DeliveryClass } {
  if (policy === null || !policy.usable) return result("CONFIG_UNUSABLE", "CONFIG_UNUSABLE");
  if (actor.presence === "MISSING" || !actor.present) return result("MISSING_ACTOR", "MISSING_ACTOR");
  if (actor.presence === "UNKNOWN") return result("UNKNOWN_ACTOR", "UNKNOWN_ACTOR");
  if (actor.presence === "MALFORMED" || actor.normalizedLogin === null) {
    return result("MALFORMED_ACTOR", "MALFORMED_ACTOR");
  }
  return policy.normalizedUsers.has(actor.normalizedLogin)
    ? result("TRUSTED", "TRUSTED")
    : result("UNTRUSTED", "UNTRUSTED");
}

/**
 * Decide prose access from the configuration file as it exists now.
 *
 * This deliberately returns only an operation-scoped boolean decision. Callers
 * must not retain a policy, revision, or prior result for a later delivery.
 * Loader failures and unusable configuration fail closed.
 */
export function decideCurrentGithubProse(rawLogin: unknown, configPath: string): GithubProseDecision {
  const normalizedLogin = normalizeGithubLogin(rawLogin);
  if (normalizedLogin === null) return "DENIED";
  try {
    const currentConfig = loadConfig(configPath);
    const policy = createTrustedGithubPolicy(currentConfig);
    return policy.usable && policy.normalizedUsers.has(normalizedLogin) ? "TRUSTED" : "DENIED";
  } catch {
    return "DENIED";
  }
}
