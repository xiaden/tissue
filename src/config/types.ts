// src/config/types.ts
//
// Types for Tissue's small YAML configuration boundary (R14/R15). Field
// names here are camelCase; the strict loader maps the human YAML onto these.
// These are SCALAR policy fields only — no policy DSL, no secret material.

export const DEFAULT_MAX_CONCURRENT_GLOBAL = 3;
export const DEFAULT_MAX_CONCURRENT_PER_REPO = 1;
export const DEFAULT_POLL_INTERVAL_SECONDS = 300;
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_BASE_BRANCH = "main";

/**
 * Dedicated host-global Tissue agent identities (R11/R12). Enabled production
 * work always addresses these EXACT agents: omitting `agents.*.agent` defaults
 * to them, and a divergent explicit value is rejected. Omission therefore never
 * means "use whatever agent the resident OpenCode default happens to be".
 * Model/provider selection stays T8 (f) NEEDS_DECISION and remains optional.
 */
export const TISSUE_TRIAGE_AGENT = "tissue-triage";
export const TISSUE_RESOLVE_AGENT = "tissue-resolve";

/** OpenCode's native prompt-addressable model identity (`provider/model`). */
export interface ProviderModel {
  providerID: string;
  modelID: string;
}

/**
 * An agent/model setting for one role. The agent identity is FIXED per role
 * (tissue-triage / tissue-resolve); only the model split is T8 (f) NEEDS_DECISION.
 */
export interface ModelSetting {
  /** Dedicated Tissue agent identity; defaults to the role's required agent. */
  agent?: string;
  /** Provider/model id, usually `provider/model`; transmitted only when configured. */
  model?: string;
}

/** Per-repository configuration (maps to the DD `repositories` row). */
export interface RepositoryConfig {
  /** GitHub owner (e.g. the human-monitored owner — T8 (e), never silently canonicalized). */
  owner: string;
  name: string;
  /** Optional clone URL for the writable checkout; must not embed credentials. */
  remote?: string;
  /** Optional target repository for PRs; defaults to owner/name. */
  targetOwner?: string;
  targetName?: string;
  /** Writable push destination; defaults to target owner/name and checkout origin. */
  pushOwner?: string;
  pushName?: string;
  pushRemote?: string;
  /** Absolute path to the repository's main checkout. */
  localDir: string;
  enabled: boolean;
  pollIntervalSeconds: number;
  maxConcurrentPerRepo: number;
  baseBranch: string;
  labels: string[];
  autoMerge: boolean;
  priority: number;
  /** ISO-8601 activation baseline; pre-baseline issues are BASELINE_EXCLUDED (R14). */
  baselineBefore?: string;
}

/** Validated GitHub authors permitted to receive trusted human-prose treatment. */
export interface TrustedGithubSecurityConfig {
  /** ASCII GitHub logins; the strict loader rejects malformed entries. */
  trustedGithubUsers: string[];
}

/** Fully validated Tissue YAML configuration, including optional trust policy. */
export interface TissueConfig {
  security?: TrustedGithubSecurityConfig;
  pollIntervalSeconds: number;
  maxConcurrentGlobal: number;
  /** History/audit retention window in days (R22). */
  retentionDays: number;
  agents: {
    triage?: ModelSetting;
    resolution?: ModelSetting;
  };
  repos: RepositoryConfig[];
}
