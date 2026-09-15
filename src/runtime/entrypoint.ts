// src/runtime/entrypoint.ts
//
// A' supervised runtime entrypoint. The exported startup probe remains pure for
// diagnostics; the production main path consumes `daemon` and stays resident.
//
// It is loopback/private-only by construction and contains NO D'-style
// child-process or per-turn `opencode run` machinery and no `turn_in_flight`
// ledger. D' is documented only and must not be co-built.
//
// Production-closure wiring (P3-S1..S3):
//   - TISSUE_OPENCODE_URL is validated as a loopback/private resident endpoint
//     BEFORE OPENCODE_SERVER_USERNAME/PASSWORD are attached.
//   - Configured triage/resolution agent+model are preserved as native
//     {providerID, modelID} on session creation and every prompt; a concrete
//     model is never silently selected.
//   - Host-global Tissue triage/resolution agent definitions are validated at
//     startup (and in doctor).
//   - The SSE wake hint is wired into the real daemon loop as a WAKE-ONLY hint
//     with the polling/durable-state backstop (it carries no controller truth).

import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { stdout } from "node:process";
import { loadConfig } from "../config/load.ts";
import { JsonLogger } from "../logging/jsonl.ts";
import { openTissueDb, closeDb } from "../db/open.ts";
import { GhClient } from "../integrations/gh-client.ts";
import { OpenCodeHttp } from "../integrations/opencode-http.ts";
import { OpenCodeDriver } from "../integrations/opencode-driver.ts";
import {
  defaultNormalLoopIo,
  runDaemon,
  SseWakeHint,
  type NormalLoopIo,
} from "./daemon.ts";
import { runReconcilePass, type ReconcileReport } from "../controller/reconcile.ts";
import {
  parseProviderModel,
  redactResidentEndpoint,
  resolveSourceAgentsDir,
  validateResidentOpenCodeEndpoint,
  validateTissueAgentDefinitions,
  type AgentDefinitionStatus,
} from "./resident.ts";
import { TISSUE_TRIAGE_AGENT } from "../config/types.ts";
import type { TissueConfig, ProviderModel } from "../config/types.ts";
import type { TissueDb } from "../db/open.ts";

/** Result of the dependency-only startup capability probe (not production daemon startup). */
export interface StartupReport {
  nodeVersion: string;
  /** Native TypeScript type-stripping availability (process.features.typescript). */
  tsTypeStrip: boolean;
  /** node:sqlite builtin availability (DatabaseSync) — verified via getBuiltinModule. */
  sqliteAvailable: boolean;
  /** Runtime state directory used by the supervised daemon. */
  stateDir: string;
}

function readFeatures(): { typescript?: string | boolean } | undefined {
  const p = process as unknown as { features?: { typescript?: string | boolean } };
  return p.features;
}

function sqliteAvailable(): boolean {
  const p = process as unknown as { getBuiltinModule?: (id: string) => unknown };
  try {
    return typeof p.getBuiltinModule === "function" && !!p.getBuiltinModule("node:sqlite");
  } catch {
    return false;
  }
}

/** Probe runtime prerequisites without opening durable state; production uses runProductionDaemon. */
export function emptySafeStartup(stateDir: string): StartupReport {
  const tsStrip = readFeatures()?.typescript === "strip";
  return {
    nodeVersion: process.versions.node,
    tsTypeStrip: tsStrip,
    sqliteAvailable: sqliteAvailable(),
    stateDir,
  };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

/** Credentials for the resident OpenCode transport. Never logged or persisted. */
export interface ResidentCredentials {
  username?: string;
  password?: string;
}

export interface ProductionAssembly {
  driver: OpenCodeDriver;
  /** Authenticated resident transport (used to open the SSE wake-only stream). */
  transport: OpenCodeHttp;
  normalLoop: NormalLoopIo;
  reconcile: () => Promise<ReconcileReport>;
  /**
   * Fail-closed resident-dependency probe over the same authenticated transport
   * the daemon already uses. Returns false (never throws) when the resident
   * service is unreachable; credentials are never logged.
   */
  checkResidentHealth(): Promise<boolean>;
  /** Credential-free endpoint label (scheme://host:port) for status/logs. */
  endpoint: string;
  agentDefinitions: AgentDefinitionStatus;
}

export interface ProductionAssemblyOptions {
  config: TissueConfig;
  logger: JsonLogger;
  db: TissueDb;
  stateDir: string;
  /** Raw TISSUE_OPENCODE_URL; validated loopback/private before credentials attach. */
  endpoint: string;
  /** Resident basic-auth credentials (TISSUE_OPENCODE_URL validation precedes attach). */
  credentials?: ResidentCredentials;
  /** Directory holding host-global tissue-triage.md / tissue-resolve.md. */
  agentsDir?: string;
  /** Test-only external-boundary injection; production uses the authenticated absolute gh binary. */
  gh?: GhClient;
  /** Test-only clock injection; production uses wall-clock time. */
  now?: () => Date;
}

/** Resolve configured agent/model settings, failing closed on a malformed model. */
function resolveRoleModel(setting: { model?: string } | undefined): ProviderModel | undefined {
  return setting?.model !== undefined ? parseProviderModel(setting.model) : undefined;
}

/** Assemble exactly the runtime used by `tissue daemon`; only external transports are injectable. */
export async function createProductionAssembly(opts: ProductionAssemblyOptions): Promise<ProductionAssembly> {
  // Order matters: validate the resident endpoint BEFORE any credential exists.
  const endpoint = validateResidentOpenCodeEndpoint(opts.endpoint);
  const agentDefinitions = validateTissueAgentDefinitions({
    // Always compare against the checked-in source so a stale deployed definition
    // cannot silently survive a source update.
    sourceDir: resolveSourceAgentsDir(),
    ...(opts.agentsDir ? { agentsDir: opts.agentsDir } : {}),
  });
  if (!agentDefinitions.ok) {
    throw new Error(`invalid host-global Tissue agent definitions: ${agentDefinitions.errors.join("; ")}`);
  }

  const credentials = opts.credentials ?? {};
  const http = new OpenCodeHttp({
    baseUrl: endpoint.toString(),
    ...(credentials.username !== undefined ? { username: credentials.username } : {}),
    ...(credentials.password !== undefined ? { password: credentials.password } : {}),
  });
  await http.sessionStatus();
  const gh = opts.gh ?? new GhClient();

  const triage = opts.config.agents.triage;
  // The dedicated identity is mandatory: an omitted config agent resolves to the
  // Tissue triage agent, never the resident OpenCode default agent.
  const triageAgent = triage?.agent ?? TISSUE_TRIAGE_AGENT;
  const triageModel = resolveRoleModel(triage);
  const driver = new OpenCodeDriver({
    http,
    db: opts.db,
    triageAgent,
    ...(triageModel !== undefined ? { triageModel } : {}),
  });

  return {
    driver,
    transport: http,
    endpoint: redactResidentEndpoint(opts.endpoint),
    agentDefinitions,
    normalLoop: defaultNormalLoopIo(opts.config, opts.logger, {
      gh,
      triageDriver: driver,
      resolutionDriver: driver,
      ...(opts.now ? { now: opts.now } : {}),
    }),
    reconcile: () => runReconcilePass({
      config: opts.config,
      logger: opts.logger.op("reconcile"),
      db: opts.db,
      stateDir: opts.stateDir,
      driver,
      gh,
    }),
    checkResidentHealth: async () => {
      try {
        await http.sessionStatus();
        return true;
      } catch {
        // Unreachable resident service is unhealthy; never surface credentials.
        return false;
      }
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function runProductionDaemon(): Promise<void> {
  const stateDir = process.env.TISSUE_STATE_DIR ?? ".tissue";
  const configPath = process.env.TISSUE_CONFIG ?? "./tissue.yml";
  const config = loadConfig(configPath);
  const logger = new JsonLogger(stdout, "info").op("daemon");
  const db = openTissueDb(join(stateDir, "tissue.db"), { retentionDays: config.retentionDays });
  try {
    const assembly = await createProductionAssembly({
      config,
      logger,
      db,
      stateDir,
      endpoint: process.env.TISSUE_OPENCODE_URL ?? "",
      credentials: {
        ...(process.env.OPENCODE_SERVER_USERNAME !== undefined ? { username: process.env.OPENCODE_SERVER_USERNAME } : {}),
        ...(process.env.OPENCODE_SERVER_PASSWORD !== undefined ? { password: process.env.OPENCODE_SERVER_PASSWORD } : {}),
      },
    });
    const wakeHint = new SseWakeHint({
      source: { openStream: () => assembly.transport.eventStream() },
      logger,
      sleep: defaultSleep,
    });
    await runDaemon({
      config,
      logger,
      db,
      reconcile: assembly.reconcile,
      checkResidentHealth: assembly.checkResidentHealth,
      normalLoop: assembly.normalLoop,
      wakeHint,
      sleep: defaultSleep,
    });
  } finally { closeDb(db); }
}

if (isMain()) {
  const mode = process.argv[2] ?? "daemon";
  if (mode === "daemon") {
    runProductionDaemon().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tissue daemon failed: ${message}\n`);
      process.exitCode = 1;
    });
  } else {
    process.stdout.write(JSON.stringify(emptySafeStartup(process.env.TISSUE_STATE_DIR ?? ".tissue")) + "\n");
  }
}
