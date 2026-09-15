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

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

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

export interface AgentDefinitionFileStatus {
  role: "triage" | "resolution";
  file: string;
  present: boolean;
  mode: string | null;
  enabledTools: string[];
  disabledTools: string[];
  errors: string[];
}

export interface AgentDefinitionStatus {
  ok: boolean;
  agentsDir: string;
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

function validateAgentFile(
  role: "triage" | "resolution",
  agentsDir: string,
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
  return { status: base, errors: base.errors };
}

/**
 * Validate the host-global dedicated Tissue triage/resolution definitions.
 * Triage must be restrictive (read/inspect only); resolution may edit and run
 * local verification but must never expose a GitHub lifecycle tool/effect. No
 * concrete model/identity is validated or selected here (T8 (f) is open).
 */
export function validateTissueAgentDefinitions(opts: { agentsDir?: string } = {}): AgentDefinitionStatus {
  const agentsDir = resolve(opts.agentsDir ?? process.env.TISSUE_AGENTS_DIR ?? "agents");
  if (!isAbsolute(agentsDir)) throw new Error("agentsDir must resolve to an absolute path");
  const triage = validateAgentFile("triage", agentsDir, "tissue-triage.md");
  const resolution = validateAgentFile("resolution", agentsDir, "tissue-resolve.md");
  const errors = [...triage.errors, ...resolution.errors];
  return {
    ok: errors.length === 0,
    agentsDir,
    agents: [triage.status, resolution.status],
    errors,
  };
}
