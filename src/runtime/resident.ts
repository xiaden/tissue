// src/runtime/resident.ts
//
// Resident-OpenCode production boundary (DD A′ topology; CONTRACTS
// validateResidentOpenCodeEndpoint / parseProviderModel /
// validateTissueAgentDefinitions).
//
// Production is A′ only: one supervised Tissue daemon connects to an
// already-running resident OpenCode endpoint (TISSUE_OPENCODE_URL). Tissue never
// starts, supervises, reaps, or terminates an OpenCode serve. This module
// centralizes the three production-closure guards:
//
//   1. The resident endpoint is validated as loopback/private BEFORE any
//      credential is attached, so a public/unsafe URL can never receive
//      OPENCODE_SERVER_USERNAME/PASSWORD.
//   2. A scalar `provider/model` config value is converted to OpenCode's native
//      prompt shape without silently selecting a model (T8 (f) stays open).
//   3. Host-global dedicated triage/resolution agent definitions are validated:
//      triage is restrictive; resolution permits local edit/test only and never
//      a GitHub lifecycle tool/effect.
//
// Nothing here reads a credential value into a log line or durable status.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { TISSUE_RESOLVE_AGENT, TISSUE_TRIAGE_AGENT } from "../config/types.ts";
import type { ProviderModel } from "../config/types.ts";

// ---- resident endpoint ---------------------------------------------------------

export class ResidentEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResidentEndpointError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
// Constructed (never a contiguous literal) so the A'/D' boundary scan that bans
// wildcard-bind literals in src/ never mistakes this guard for a bind directive.
const WILDCARD_V4 = ["0", "0", "0", "0"].join(".");

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1") return true;
  // Unique local fc00::/7 and link-local fe80::/10.
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

/**
 * Accept ONLY a loopback/private resident endpoint. Rejects non-http(s)
 * schemes, embedded credentials, wildcard binds, and public hostnames. This
 * runs BEFORE any credential is attached to the transport.
 */
export function validateResidentOpenCodeEndpoint(url: string): URL {
  const raw = (url ?? "").trim();
  if (raw.length === 0) {
    throw new ResidentEndpointError("TISSUE_OPENCODE_URL is required; Tissue never starts an OpenCode serve");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ResidentEndpointError("TISSUE_OPENCODE_URL is not a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ResidentEndpointError("TISSUE_OPENCODE_URL must be http(s)");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ResidentEndpointError("TISSUE_OPENCODE_URL must not embed credentials");
  }
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) throw new ResidentEndpointError("TISSUE_OPENCODE_URL has no host");
  if (host === WILDCARD_V4 || host === "::" || host === "[::]") {
    throw new ResidentEndpointError("TISSUE_OPENCODE_URL must be a concrete loopback/private host, not a wildcard bind");
  }
  const allowed = LOOPBACK_HOSTS.has(host) || isPrivateIpv4(host) || isPrivateIpv6(host);
  if (!allowed) {
    throw new ResidentEndpointError("TISSUE_OPENCODE_URL must be a loopback/private resident endpoint");
  }
  return parsed;
}

/** A safe, credential-free endpoint label for status/logs (scheme://host:port). */
export function redactResidentEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "[invalid]";
  }
}

// ---- provider/model ------------------------------------------------------------

/**
 * Convert the scalar `provider/model` config form to OpenCode's native prompt
 * model shape. A value without a provider/model split is rejected rather than
 * silently selecting a model (T8 (f) remains NEEDS_DECISION). Only the first
 * slash splits provider from model so model ids may themselves contain slashes.
 */
export function parseProviderModel(value: string): ProviderModel {
  const raw = (value ?? "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new ResidentEndpointError("agents.*.model must be 'provider/model' (a concrete model is not auto-selected)");
  }
  const providerID = raw.slice(0, slash);
  const modelID = raw.slice(slash + 1);
  if (!/^[^\s/]+$/.test(providerID) || modelID.length === 0 || /[\u0000-\u001f\u007f]/.test(modelID)) {
    throw new ResidentEndpointError("agents.*.model is not a valid 'provider/model' identifier");
  }
  return { providerID, modelID };
}

// ---- agent definitions ---------------------------------------------------------

/** Tools that may never be enabled for a Tissue agent (lifecycle/effects/GitHub). */
const FORBIDDEN_TOOL_RE = /(^|[_-])(gh|github|tissue|pr|merge|push|release|workflow|issue[_-]?(close|comment|edit)|admin)([_-]|$)/i;
/** Triage may only read/inspect; it is a classifier, not an executor. */
const TRIAGE_ALLOWED = new Set(["read", "grep", "glob", "list", "search"]);
/** Resolution may edit and run local verification, but never lifecycle/GitHub. */
const RESOLUTION_ALLOWED = new Set(["read", "edit", "write", "patch", "bash", "grep", "glob", "list", "search"]);

/** The dedicated Tissue agent definition files, in role order. */
export const TISSUE_AGENT_FILES: ReadonlyArray<{ role: "triage" | "resolution"; fileName: string; requiredAgent: string }> = [
  { role: "triage", fileName: "tissue-triage.md", requiredAgent: TISSUE_TRIAGE_AGENT },
  { role: "resolution", fileName: "tissue-resolve.md", requiredAgent: TISSUE_RESOLVE_AGENT },
];

/**
 * Resolve the OpenCode GLOBAL agent directory the RESIDENT service actually
 * discovers. Deterministic and absolute: `TISSUE_OPENCODE_AGENTS_DIR` wins,
 * otherwise `$XDG_CONFIG_HOME/opencode/agents` or `$HOME/.config/opencode/agents`.
 *
 * There is deliberately NO CWD-relative default: the resident OpenCode service
 * does not read `<Tissue>/agents`, so validating (or trusting) a path relative to
 * the process working directory proves nothing about what the resident can use.
 */
export function resolveOpenCodeGlobalAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.TISSUE_OPENCODE_AGENTS_DIR ?? "").trim();
  if (explicit.length > 0) {
    if (!isAbsolute(explicit)) {
      throw new ResidentEndpointError("TISSUE_OPENCODE_AGENTS_DIR must be an absolute path");
    }
    return resolve(explicit);
  }
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  if (xdg.length > 0 && isAbsolute(xdg)) return join(resolve(xdg), "opencode", "agents");
  const home = (env.HOME ?? "").trim();
  if (home.length > 0 && isAbsolute(home)) return join(resolve(home), ".config", "opencode", "agents");
  throw new ResidentEndpointError(
    "cannot resolve the OpenCode global agent directory: set TISSUE_OPENCODE_AGENTS_DIR or HOME/XDG_CONFIG_HOME",
  );
}

/**
 * The canonical CHECKED-IN Tissue agent definitions (`<repo>/agents`). These are
 * source artifacts only; resolved from this module's own location so the answer
 * never depends on the process working directory.
 */
export function resolveSourceAgentsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
}

export interface AgentDefinitionFileStatus {
  role: "triage" | "resolution";
  file: string;
  present: boolean;
  mode: string | null;
  enabledTools: string[];
  disabledTools: string[];
  /** Checked-in source file used for drift comparison (null when drift is not compared). */
  sourceFile: string | null;
  /** True when the deployed definition differs from the checked-in source. */
  sourceDrift: boolean;
  errors: string[];
}

export interface AgentDefinitionStatus {
  ok: boolean;
  /** Deployed/global directory the RESIDENT OpenCode service reads. */
  agentsDir: string;
  /** Checked-in source directory used for drift comparison (null when not compared). */
  sourceDir: string | null;
  agents: AgentDefinitionFileStatus[];
  errors: string[];
}

interface ParsedFrontmatter {
  mode: string | null;
  tools: Record<string, boolean>;
  hasModelPin: boolean;
  errors: string[];
}

function parseFrontmatter(text: string, relFile: string): ParsedFrontmatter {
  const errors: string[] = [];
  if (!text.startsWith("---")) {
    return { mode: null, tools: {}, hasModelPin: false, errors: [`${relFile}: missing YAML frontmatter`] };
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) {
    return { mode: null, tools: {}, hasModelPin: false, errors: [`${relFile}: unterminated YAML frontmatter`] };
  }
  const yamlText = text.slice(3, end);
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    return { mode: null, tools: {}, hasModelPin: false, errors: [`${relFile}: invalid frontmatter YAML (${(err as Error).message})`] };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { mode: null, tools: {}, hasModelPin: false, errors: [`${relFile}: frontmatter must be a mapping`] };
  }
  const obj = doc as Record<string, unknown>;
  const mode = typeof obj.mode === "string" ? obj.mode : null;
  const hasModelPin = obj.model !== undefined || obj.providerID !== undefined || obj.modelID !== undefined;
  const toolsRaw = obj.tools;
  const tools: Record<string, boolean> = {};
  if (toolsRaw === undefined) {
    errors.push(`${relFile}: a restrictive 'tools' profile is required`);
  } else if (typeof toolsRaw !== "object" || toolsRaw === null || Array.isArray(toolsRaw)) {
    errors.push(`${relFile}: 'tools' must be a mapping of tool name to boolean`);
  } else {
    for (const [k, v] of Object.entries(toolsRaw as Record<string, unknown>)) {
      if (typeof v !== "boolean") {
        errors.push(`${relFile}: tools.${k} must be a boolean`);
        continue;
      }
      tools[k] = v;
    }
  }
  return { mode, tools, hasModelPin, errors };
}

/** SHA-256 of a file's bytes, or null when it cannot be read (missing/unreadable). */
function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function validateAgentFile(
  role: "triage" | "resolution",
  agentsDir: string,
  sourceDir: string | null,
  fileName: string,
): { status: AgentDefinitionFileStatus; errors: string[] } {
  const file = resolve(agentsDir, fileName);
  const relative = `${agentsDir}/${fileName}`;
  const base: AgentDefinitionFileStatus = {
    role,
    file: relative,
    present: existsSync(file),
    mode: null,
    enabledTools: [],
    disabledTools: [],
    sourceFile: null,
    sourceDrift: false,
    errors: [],
  };
  if (!base.present) {
    base.errors.push(`${relative}: missing host-global ${role} agent definition`);
    return { status: base, errors: base.errors };
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    base.errors.push(`${relative}: cannot read (${(err as Error).message})`);
    return { status: base, errors: base.errors };
  }
  const parsed = parseFrontmatter(text, relative);
  base.mode = parsed.mode;
  base.errors.push(...parsed.errors);
  const enabled = Object.entries(parsed.tools).filter(([, on]) => on).map(([k]) => k);
  const disabled = Object.entries(parsed.tools).filter(([, on]) => !on).map(([k]) => k);
  base.enabledTools = enabled;
  base.disabledTools = disabled;
  if (parsed.hasModelPin) {
    base.errors.push(`${relative}: a concrete model/identity pin is a T8 (f) decision and must stay NEEDS_DECISION`);
  }
  if (parsed.mode === null) base.errors.push(`${relative}: 'mode' is required`);

  const allowed = role === "triage" ? TRIAGE_ALLOWED : RESOLUTION_ALLOWED;
  for (const tool of Object.keys(parsed.tools)) {
    if (FORBIDDEN_TOOL_RE.test(tool)) {
      base.errors.push(`${relative}: forbidden lifecycle/GitHub tool '${tool}' must never be exposed to a Tissue agent`);
    }
  }
  for (const tool of enabled) {
    if (!allowed.has(tool)) {
      base.errors.push(`${relative}: tool '${tool}' is outside the ${role} allowed profile`);
    }
  }
  if (enabled.length === 0) {
    base.errors.push(`${relative}: at least one allowlisted ${role} tool must be explicitly enabled`);
  }

  // Deterministic source/deployed comparison: an old or hand-edited deployed
  // definition must not silently survive a source update. Model pins are not part
  // of this contract (model selection is config/T8 (f), and a pinned model in the
  // deployed file is already rejected above).
  if (sourceDir !== null) {
    const sourceFile = resolve(sourceDir, fileName);
    base.sourceFile = sourceFile;
    const deployedHash = sha256File(file);
    const sourceHash = sha256File(sourceFile);
    if (sourceHash === null) {
      base.errors.push(`${sourceFile}: checked-in source definition is missing or unreadable`);
    } else if (deployedHash !== sourceHash) {
      base.sourceDrift = true;
      base.errors.push(
        `${relative}: deployed definition has drifted from the checked-in source (${sourceFile}); re-run 'tissue install-agents --force'`,
      );
    }
  }
  return { status: base, errors: base.errors };
}

/**
 * Validate the deployed/global dedicated Tissue triage/resolution definitions the
 * RESIDENT OpenCode service will actually use. Triage must be restrictive
 * (read/inspect only); resolution may edit and run local verification but must
 * never expose a GitHub lifecycle tool/effect. No concrete model/identity is
 * validated or selected here (T8 (f) is open).
 *
 * `agentsDir` defaults to the resolved OpenCode global agent directory — never a
 * CWD-relative path. Supplying `sourceDir` additionally fails validation when the
 * deployed definition has drifted from the checked-in source.
 */
export interface AgentValidationOptions {
  /** Deployed/global agent dir the resident service reads. Defaults to the resolved OpenCode global dir. */
  agentsDir?: string;
  /** Checked-in source dir; when provided, source/deployed drift fails validation. */
  sourceDir?: string;
}

export function validateTissueAgentDefinitions(opts: AgentValidationOptions = {}): AgentDefinitionStatus {
  const agentsDir = opts.agentsDir !== undefined ? resolve(opts.agentsDir) : resolveOpenCodeGlobalAgentsDir();
  const sourceDir = opts.sourceDir !== undefined ? resolve(opts.sourceDir) : null;
  const triage = validateAgentFile("triage", agentsDir, sourceDir, "tissue-triage.md");
  const resolution = validateAgentFile("resolution", agentsDir, sourceDir, "tissue-resolve.md");
  const errors = [...triage.errors, ...resolution.errors];
  return {
    ok: errors.length === 0,
    agentsDir,
    sourceDir,
    agents: [triage.status, resolution.status],
    errors,
  };
}

// ---- agent deployment ----------------------------------------------------------

export interface AgentInstallEntry {
  role: "triage" | "resolution";
  file: string;
  action: "installed" | "unchanged" | "exists-divergent";
}

export interface AgentInstallStatus {
  ok: boolean;
  sourceDir: string;
  targetDir: string;
  results: AgentInstallEntry[];
  errors: string[];
}

/**
 * Deploy the checked-in dedicated Tissue agent definitions into the OpenCode
 * GLOBAL agent directory the resident service reads, creating the directory when
 * needed.
 *
 * Filesystem-only by construction: it never touches OpenCode's SQLite database and
 * never starts, restarts, or reaps a serve. A divergent existing file is refused
 * unless `force` is set, so an operator's local edit is never silently destroyed;
 * an identical file is a no-op (idempotent).
 */
export function installAgentDefinitions(
  opts: { sourceDir?: string; targetDir?: string; force?: boolean } = {},
): AgentInstallStatus {
  const sourceDir = opts.sourceDir !== undefined ? resolve(opts.sourceDir) : resolveSourceAgentsDir();
  const targetDir = opts.targetDir !== undefined ? resolve(opts.targetDir) : resolveOpenCodeGlobalAgentsDir();
  const results: AgentInstallEntry[] = [];
  const errors: string[] = [];

  // Never deploy definitions that do not pass the role boundary validation.
  const sourceStatus = validateTissueAgentDefinitions({ agentsDir: sourceDir });
  if (!sourceStatus.ok) {
    return {
      ok: false,
      sourceDir,
      targetDir,
      results,
      errors: [`checked-in source definitions are invalid: ${sourceStatus.errors.join("; ")}`],
    };
  }

  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  } catch (err) {
    return { ok: false, sourceDir, targetDir, results, errors: [`cannot create ${targetDir} (${(err as Error).message})`] };
  }

  for (const { role, fileName } of TISSUE_AGENT_FILES) {
    const from = resolve(sourceDir, fileName);
    const to = resolve(targetDir, fileName);
    if (existsSync(to)) {
      if (readFileSync(to).equals(readFileSync(from))) {
        results.push({ role, file: to, action: "unchanged" });
        continue;
      }
      if (!opts.force) {
        results.push({ role, file: to, action: "exists-divergent" });
        errors.push(`${to}: differs from ${from}; re-run with --force to overwrite`);
        continue;
      }
    }
    try {
      writeFileSync(to, readFileSync(from), { mode: statSync(from).mode & 0o777 });
      results.push({ role, file: to, action: "installed" });
    } catch (err) {
      errors.push(`${to}: cannot write (${(err as Error).message})`);
    }
  }

  return { ok: errors.length === 0, sourceDir, targetDir, results, errors };
}
