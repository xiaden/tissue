// src/config/load.ts
//
// Strict loader for Tissue's small YAML configuration boundary.
//
// Contract: `loadConfig(path: string) -> TissueConfig` validates small YAML
// scalar policy fields, repository identity/local paths, limits, intervals, and
// agent/model settings; it REJECTS policy DSLs and secret material (R17/R15).
//
// Design rules enforced here:
//   - Allowlisted scalar fields only. Unknown keys (which is how a policy DSL or
//     arbitrary rules block would be smuggled in) are rejected.
//   - Secret-like keys and credential-bearing strings (remotes embedding
//     user:pass@, GitHub token shapes) are rejected outright.
//   - Repository identity is identifier-safe: owner/name may contain only
//     [A-Za-z0-9._-] (no whitespace/shell metacharacters, no path separators).
//   - Local paths must be absolute and free of NUL/control characters.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import type {
  ModelSetting,
  RepositoryConfig,
  TissueConfig,
} from "./types.ts";
import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_MAX_CONCURRENT_GLOBAL,
  DEFAULT_MAX_CONCURRENT_PER_REPO,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_RETENTION_DAYS,
  TISSUE_RESOLVE_AGENT,
  TISSUE_TRIAGE_AGENT,
} from "./types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(`config: ${message}`);
    this.name = "ConfigError";
  }
}

const SECRET_KEY_RE = /(secret|token|password|credential|authorization|bearer|apikey|api[-_]?key|oauth)/i;
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_PATH_RE = /^\//;
const GITHUB_TOKEN_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/,
];
const REMOTE_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i;

type Obj = Record<string, unknown>;

function isRecord(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPlainString(v: unknown): v is string {
  return typeof v === "string";
}

function walkRejectSecrets(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) walkRejectSecrets(node[i], `${path}[${i}]`);
    return;
  }
  if (!isRecord(node)) return;
  for (const key of Object.keys(node)) {
    if (SECRET_KEY_RE.test(key)) {
      throw new ConfigError(`${path}.${key}: secret-like key is forbidden in configuration`);
    }
    walkRejectSecrets(node[key], `${path}.${key}`);
  }
}

function assertKnownKeys(node: Obj, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`${path}.${key}: unknown key (policy DSL / arbitrary config rejected)`);
    }
  }
}

function expectObject(node: unknown, path: string): Obj {
  if (!isRecord(node)) throw new ConfigError(`${path}: expected a mapping`);
  return node;
}

function expectString(node: unknown, path: string): string {
  if (!isPlainString(node)) throw new ConfigError(`${path}: expected a string`);
  return node;
}

function expectBoolean(node: unknown, path: string): boolean {
  if (typeof node !== "boolean") throw new ConfigError(`${path}: expected a boolean`);
  return node;
}

function expectInteger(node: unknown, path: string): number {
  if (typeof node !== "number" || !Number.isInteger(node)) {
    throw new ConfigError(`${path}: expected an integer`);
  }
  return node;
}

function expectStringArray(node: unknown, path: string): string[] {
  if (!Array.isArray(node) || !node.every(isPlainString)) {
    throw new ConfigError(`${path}: expected an array of strings`);
  }
  return node as string[];
}

function rejectTokenValues(value: string, path: string): void {
  for (const re of GITHUB_TOKEN_SHAPES) {
    if (re.test(value)) throw new ConfigError(`${path}: credential-shaped value is forbidden`);
  }
}

function validateRepoIdentity(owner: string, name: string, path: string): void {
  if (!REPO_ID_RE.test(owner)) {
    throw new ConfigError(`${path}.owner: unsafe owner (must match [A-Za-z0-9._-], no shell metacharacters)`);
  }
  if (!REPO_ID_RE.test(name)) {
    throw new ConfigError(`${path}.name: unsafe repo name (must match [A-Za-z0-9._-])`);
  }
}

function validateAbsolutePath(value: string, path: string): string {
  if (CONTROL_RE.test(value) || !ABSOLUTE_PATH_RE.test(value)) {
    throw new ConfigError(`${path}: must be an absolute path with no control characters`);
  }
  return value;
}

function validateRemote(value: string, path: string): string {
  rejectTokenValues(value, path);
  if (REMOTE_WITH_CREDENTIALS.test(value)) {
    throw new ConfigError(`${path}: remote must not embed credentials`);
  }
  return value;
}

function validateBaseline(value: string, path: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw new ConfigError(`${path}: baselineBefore must be an ISO-8601 date/time`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new ConfigError(`${path}: baselineBefore is not a valid date`);
  }
  return value;
}

/**
 * Parse one role's agent/model setting. The agent identity is mandatory and
 * dedicated: an omitted `agent` defaults to `requiredAgent`, and an explicit
 * value that differs is rejected so enabled production work can never silently
 * fall back to the resident OpenCode default agent. `model` stays optional (T8 (f)).
 */
function parseModelSetting(node: unknown, path: string, requiredAgent: string): ModelSetting {
  if (node === undefined || node === null) return { agent: requiredAgent };
  const obj = expectObject(node, path);
  assertKnownKeys(obj, new Set(["agent", "model"]), path);
  const out: ModelSetting = { agent: requiredAgent };
  if (obj.agent !== undefined) {
    const agent = expectString(obj.agent, `${path}.agent`);
    if (agent !== requiredAgent) {
      throw new ConfigError(
        `${path}.agent: must be '${requiredAgent}' — enabled production work never falls back to a resident default agent`,
      );
    }
    out.agent = agent;
  }
  if (obj.model !== undefined) out.model = expectString(obj.model, `${path}.model`);
  return out;
}

function parseRepository(node: unknown, index: number): RepositoryConfig {
  const base = `repos[${index}]`;
  const obj = expectObject(node, base);
  assertKnownKeys(
    obj,
    new Set([
      "owner", "name", "remote", "targetOwner", "targetName", "pushOwner", "pushName", "pushRemote", "localDir", "enabled",
       "pollIntervalSeconds", "maxConcurrentPerRepo", "baseBranch", "labels",
       "autoMerge", "priority", "baselineBefore",
    ]),
    base,
  );

  const owner = expectString(obj.owner, `${base}.owner`);
  const name = expectString(obj.name, `${base}.name`);
  validateRepoIdentity(owner, name, base);

  const localDir = validateAbsolutePath(expectString(obj.localDir, `${base}.localDir`), `${base}.localDir`);

  let remote: string | undefined;
  if (obj.remote !== undefined) remote = validateRemote(expectString(obj.remote, `${base}.remote`), `${base}.remote`);
  const targetOwner = obj.targetOwner === undefined ? owner : expectString(obj.targetOwner, `${base}.targetOwner`);
  const targetName = obj.targetName === undefined ? name : expectString(obj.targetName, `${base}.targetName`);
  validateRepoIdentity(targetOwner, targetName, `${base}.target`);
  const pushOwner = obj.pushOwner === undefined ? targetOwner : expectString(obj.pushOwner, `${base}.pushOwner`);
  const pushName = obj.pushName === undefined ? targetName : expectString(obj.pushName, `${base}.pushName`);
  validateRepoIdentity(pushOwner, pushName, `${base}.push`);
  const pushRemote = obj.pushRemote === undefined ? undefined : expectString(obj.pushRemote, `${base}.pushRemote`);

  const enabled = obj.enabled === undefined ? true : expectBoolean(obj.enabled, `${base}.enabled`);

  let pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS;
  if (obj.pollIntervalSeconds !== undefined) {
    pollIntervalSeconds = expectInteger(obj.pollIntervalSeconds, `${base}.pollIntervalSeconds`);
  }
  if (pollIntervalSeconds < 10) {
    throw new ConfigError(`${base}.pollIntervalSeconds: must be >= 10 seconds`);
  }

  const maxConcurrentPerRepo =
    obj.maxConcurrentPerRepo === undefined
      ? DEFAULT_MAX_CONCURRENT_PER_REPO
      : expectInteger(obj.maxConcurrentPerRepo, `${base}.maxConcurrentPerRepo`);
  if (maxConcurrentPerRepo < 1) {
    throw new ConfigError(`${base}.maxConcurrentPerRepo: must be >= 1`);
  }

  const baseBranch =
    obj.baseBranch === undefined ? DEFAULT_BASE_BRANCH : expectString(obj.baseBranch, `${base}.baseBranch`);

  const labels = obj.labels === undefined ? [] : expectStringArray(obj.labels, `${base}.labels`);
  for (const l of labels) {
    if (l.length === 0 || CONTROL_RE.test(l)) {
      throw new ConfigError(`${base}.labels: label must be non-empty with no control characters`);
    }
  }

  const autoMerge = obj.autoMerge === undefined ? false : expectBoolean(obj.autoMerge, `${base}.autoMerge`);
  const priority = obj.priority === undefined ? 0 : expectInteger(obj.priority, `${base}.priority`);

  let baselineBefore: string | undefined;
  if (obj.baselineBefore !== undefined) {
    baselineBefore = validateBaseline(expectString(obj.baselineBefore, `${base}.baselineBefore`), `${base}.baselineBefore`);
  }

  return {
    owner,
    name,
    ...(remote ? { remote } : {}),
    targetOwner,
    targetName,
    pushOwner,
    pushName,
    ...(pushRemote ? { pushRemote } : {}),
    localDir,
    enabled,
    pollIntervalSeconds,
    maxConcurrentPerRepo,
    baseBranch,
    labels,
    autoMerge,
    priority,
    ...(baselineBefore ? { baselineBefore } : {}),
  };
}

/** Parse and validate YAML configuration text into a TissueConfig. */
export function parseConfig(yamlText: string, source = "<yaml>"): TissueConfig {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML (${(err as Error).message})`);
  }
  const root = expectObject(doc, source);
  assertKnownKeys(
    root,
    new Set(["pollIntervalSeconds", "maxConcurrentGlobal", "retentionDays", "agents", "repos"]),
    source,
  );
  walkRejectSecrets(root, source);

  let pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS;
  if (root.pollIntervalSeconds !== undefined) {
    pollIntervalSeconds = expectInteger(root.pollIntervalSeconds, `${source}.pollIntervalSeconds`);
  }
  if (pollIntervalSeconds < 10) {
    throw new ConfigError(`${source}.pollIntervalSeconds: must be >= 10 seconds`);
  }

  const maxConcurrentGlobal =
    root.maxConcurrentGlobal === undefined
      ? DEFAULT_MAX_CONCURRENT_GLOBAL
      : expectInteger(root.maxConcurrentGlobal, `${source}.maxConcurrentGlobal`);
  if (maxConcurrentGlobal < 1) {
    throw new ConfigError(`${source}.maxConcurrentGlobal: must be >= 1`);
  }

  let retentionDays = DEFAULT_RETENTION_DAYS;
  if (root.retentionDays !== undefined) {
    retentionDays = expectInteger(root.retentionDays, `${source}.retentionDays`);
  }
  if (retentionDays < 1) {
    throw new ConfigError(`${source}.retentionDays: must be >= 1`);
  }

  const agentsNode = root.agents === undefined ? {} : expectObject(root.agents, `${source}.agents`);
  if (root.agents !== undefined) {
    assertKnownKeys(agentsNode, new Set(["triage", "resolution"]), `${source}.agents`);
  }
  const triage = parseModelSetting(agentsNode.triage, `${source}.agents.triage`, TISSUE_TRIAGE_AGENT);
  const resolution = parseModelSetting(agentsNode.resolution, `${source}.agents.resolution`, TISSUE_RESOLVE_AGENT);

  const reposRaw = root.repos === undefined ? [] : root.repos;
  if (!Array.isArray(reposRaw)) throw new ConfigError(`${source}.repos: expected a list`);
  const repos = reposRaw.map((r, i) => parseRepository(r, i));

  return {
    pollIntervalSeconds,
    maxConcurrentGlobal,
    retentionDays,
    agents: { triage, resolution },
    repos,
  };
}

/** Load and validate a Tissue YAML config file from disk. */
export function loadConfig(path: string): TissueConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`${path}: cannot read config file (${(err as NodeJS.ErrnoException).message})`);
  }
  return parseConfig(text, path);
}
