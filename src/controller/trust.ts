import type { TissueConfig } from "../config/types.ts";
import { loadConfig } from "../config/load.ts";

export type GithubProseDecision = "TRUSTED" | "DENIED";

/** Immutable allowlist representation built from the current configuration. */
export interface TrustedGithubPolicy {
  /** ASCII-lowercased GitHub logins accepted by the policy. */
  readonly normalizedUsers: ReadonlySet<string>;
  /** False when configuration is absent, empty, or contains an invalid login. */
  readonly usable: boolean;
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
    get(target, property) {
      if (property === "add" || property === "delete" || property === "clear") {
        return () => { throw new TypeError("trusted policy membership is immutable"); };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Build an immutable policy from the optional security configuration.
 *
 * Invalid or empty input produces an unusable policy rather than a trust-all
 * fallback. Valid logins are ASCII-normalized, deduplicated, and sorted.
 *
 * @param config Configuration containing the optional GitHub trust allowlist.
 * @returns The normalized policy and its usability state.
 */
export function createTrustedGithubPolicy(config: Pick<TissueConfig, "security"> | null | undefined): TrustedGithubPolicy {
  const rawUsers = config?.security?.trustedGithubUsers;
  if (!rawUsers || rawUsers.length === 0) {
    return { normalizedUsers: immutableSet([]), usable: false };
  }
  const normalized = rawUsers.map((login) => normalizeGithubLogin(login));
  if (normalized.some((login): login is null => login === null)) {
    return { normalizedUsers: immutableSet([]), usable: false };
  }
  const users = [...new Set(normalized as string[])].sort();
  return { normalizedUsers: immutableSet(users), usable: users.length > 0 };
}

/**
 * Decide prose access from the configuration file as it exists now.
 *
 * This deliberately returns only an operation-scoped boolean decision. Callers
 * must not retain a policy or prior result for a later delivery. Loader
 * failures and unusable configuration fail closed.
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
