import { readFileSync } from "node:fs";
import { join } from "node:path";

export const GATES = ["RG-1", "RG-2", "RG-3", "RG-4", "RG-5", "RG-6"] as const;
export type GateId = (typeof GATES)[number];
export type GateStatus = "PASS" | "BLOCKED" | "DETERMINISTIC_ONLY" | "INSUFFICIENT";

export interface GateEvidence {
  gate: GateId;
  status: GateStatus;
  owner: string;
  collectedAt: string;
  server: { binary: string; version: string; sdk: string | null; gh: string };
  topology: {
    tissueDb: string;
    openCodeDb: string;
    residentS6: boolean;
    ambientWriters: string[];
    lowActivityWindow: boolean;
  };
  thresholds: Record<string, number | string | boolean>;
  lockWaits: { count: number; maxMs: number; samples: number };
  logs: string[];
  artifacts: string[];
  redaction: { secretsExcluded: boolean; sessionIdsRedacted: boolean; rawCapturePath: string | null };
  reason: string;
  action: string;
}

export interface EvidenceBundle {
  schema: "tissue.release-gates.v1";
  generatedAt: string;
  plan: "TASK-tissue-E-release-docs";
  releasePromotable: false;
  gates: Record<GateId, GateEvidence>;
}

const SECRET = /(password|token|secret|api[_-]?key|authorization|BEGIN [A-Z ]+PRIVATE KEY)/i;
const SESSION = /ses_[A-Za-z0-9]{8,}/g;

function isGate(value: unknown): value is GateId {
  return typeof value === "string" && (GATES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be non-empty text`);
}

function assertSafeText(value: unknown, field: string): asserts value is string {
  assertText(value, field);
  if (SECRET.test(value)) throw new Error(`${field} contains secret-shaped text`);
}

export function validateGateEvidence(value: unknown): GateEvidence {
  if (!isRecord(value) || !isGate(value.gate)) throw new Error("invalid gate evidence identity");
  for (const field of ["owner", "collectedAt", "reason", "action"] as const) assertSafeText(value[field], field);
  if (!["PASS", "BLOCKED", "DETERMINISTIC_ONLY", "INSUFFICIENT"].includes(String(value.status))) {
    throw new Error(`${value.gate}: invalid status`);
  }
  const server = value.server;
  if (!isRecord(server)) throw new Error(`${value.gate}: server metadata is required`);
  for (const field of ["binary", "version", "gh"] as const) assertSafeText(server[field], `server.${field}`);
  if (server.sdk !== null && server.sdk !== undefined) assertSafeText(server.sdk, "server.sdk");
  const topology = value.topology;
  if (!isRecord(topology) || typeof topology.tissueDb !== "string" || typeof topology.openCodeDb !== "string") {
    throw new Error(`${value.gate}: topology/database separation is required`);
  }
  if (!Array.isArray(topology.ambientWriters) || topology.ambientWriters.some((x) => typeof x !== "string")) {
    throw new Error(`${value.gate}: ambientWriters must be a string array`);
  }
  if (typeof topology.residentS6 !== "boolean" || typeof topology.lowActivityWindow !== "boolean") {
    throw new Error(`${value.gate}: topology booleans are required`);
  }
  if (!isRecord(value.thresholds)) throw new Error(`${value.gate}: thresholds are required`);
  if (!isRecord(value.lockWaits) || typeof value.lockWaits.count !== "number" || typeof value.lockWaits.maxMs !== "number" || typeof value.lockWaits.samples !== "number") {
    throw new Error(`${value.gate}: lock wait measurements are required`);
  }
  for (const field of ["logs", "artifacts"] as const) {
    if (!Array.isArray(value[field]) || value[field].some((x) => typeof x !== "string" || SECRET.test(x))) throw new Error(`${value.gate}: ${field} are invalid`);
  }
  const redaction = value.redaction;
  if (!isRecord(redaction) || redaction.secretsExcluded !== true || redaction.sessionIdsRedacted !== true || (redaction.rawCapturePath !== null && typeof redaction.rawCapturePath !== "string")) {
    throw new Error(`${value.gate}: redaction contract is not satisfied`);
  }
  return value as unknown as GateEvidence;
}

export function validateEvidenceBundle(value: unknown): EvidenceBundle {
  if (!isRecord(value) || value.schema !== "tissue.release-gates.v1" || value.plan !== "TASK-tissue-E-release-docs") {
    throw new Error("invalid Tissue release-gate evidence bundle header");
  }
  if (value.releasePromotable !== false) throw new Error("releasePromotable must remain false until gates are accepted");
  if (!isRecord(value.gates)) throw new Error("gates are required");
  const gates = {} as Record<GateId, GateEvidence>;
  for (const gate of GATES) gates[gate] = validateGateEvidence(value.gates[gate]);
  return { ...value, gates } as unknown as EvidenceBundle;
}

export function redactSessionIds(text: string): string {
  return text.replace(SESSION, "ses_[REDACTED]");
}

export function inheritedEvidenceClassification(markdown: string): "HISTORICAL_NON_CURRENT" | "MISSING_CLASSIFICATION" {
  return /historical\/non-current/i.test(markdown) && /insufficient for .*release/i.test(markdown)
    ? "HISTORICAL_NON_CURRENT"
    : "MISSING_CLASSIFICATION";
}

export function validateInheritedEvidence(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const gate of ["rg2", "rg3", "rg4", "rg6"] as const) {
    const file = join(root, "artifacts", "designs", "process", `tissue-${gate}-evidence.md`);
    result[gate.toUpperCase()] = inheritedEvidenceClassification(readFileSync(file, "utf8"));
  }
  return result;
}
