// src/runtime/entrypoint.ts
//
// A' supervised runtime entrypoint. The exported startup probe remains pure for
// diagnostics; the production main path consumes `daemon` and stays resident.
//
// The resident endpoint guard is owned by the single transport factory, which
// validates it as loopback/private — or, when `TISSUE_OPENCODE_ALLOWED_ORIGINS`
// is set, as an exact-origin allowlist entry that resolve-and-pins entirely to
// private addresses — BEFORE credentials attach. The runtime contains NO
// D'-style child-process or per-turn `opencode run` machinery and no
// `turn_in_flight` ledger. D' is documented only and must not be co-built.
//
// Production-closure wiring (P3-S1..S3):
//   - The resident endpoint is validated by the single factory as loopback/
//     private, or as an exact-origin `TISSUE_OPENCODE_ALLOWED_ORIGINS` entry that
//     resolve-and-pins entirely to private addresses, BEFORE
//     OPENCODE_SERVER_USERNAME/PASSWORD are attached.
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
import { OpenCodeDriver, type ManagedGateVerdict } from "../integrations/opencode-driver.ts";
import {
  defaultNormalLoopIo,
  runDaemon,
  SseWakeHint,
  type DaemonContext,
  type DaemonRunReport,
  type NormalLoopIo,
} from "./daemon.ts";
import { runReconcilePass, type ReconcileReport } from "../controller/reconcile.ts";
import {
  runStartupRegistryReconciliation,
  type RegistryStartupReport,
} from "../controller/session-registry.ts";
import {
  createResidentTransport,
  parseProviderModel,
  validateModerationPlugin,
  verifyModerationPluginLoaded,
  resolveSourceAgentsDir,
  validateTissueAgentDefinitions,
  type AgentDefinitionStatus,
} from "./resident.ts";
import { TISSUE_TRIAGE_AGENT } from "../config/types.ts";
import type { TissueConfig, ProviderModel } from "../config/types.ts";
import type { TissueDb } from "../db/open.ts";
import { startHealthServer, type HealthServer } from "./health-server.ts";

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
  /**
   * Raw TISSUE_OPENCODE_URL; validated as loopback/private — or, when
   * `TISSUE_OPENCODE_ALLOWED_ORIGINS` is set, as an exact allowlist origin that
   * resolve-and-pins entirely to private addresses — before credentials attach.
   */
  endpoint: string;
  /** Current configuration file used for retrieval-time prose decisions. */
  configPath?: string;
  /** Resident basic-auth credentials (TISSUE_OPENCODE_URL validation precedes attach). */
  credentials?: ResidentCredentials;
  /** Directory holding host-global tissue-triage.md / tissue-resolve.md. */
  agentsDir?: string;
  /** Test-only deployed moderation plugin directory. */
  pluginsDir?: string;
  /** Test-only external-boundary injection; production uses the authenticated absolute gh binary. */
  gh?: GhClient;
  /** Test-only clock injection; production uses wall-clock time. */
  now?: () => Date;
  /**
   * Managed-session registry dir (plan I). When omitted the driver resolves it
   * from `TISSUE_SESSION_REGISTRY_DIR` / the host default.
   */
  registryDir?: string;
  /**
   * Managed-session gate predicate. Production assembly MUST always supply it
   * (plan M wires the beacon-backed default); when omitted the loaded half of
   * the gate is skipped and only the marker invariant applies (plan J seam).
   */
  managedGate?: () => ManagedGateVerdict;
}

/**
 * Optional seams for `runProductionDaemon`/`runProductionDaemonEntrypoint`.
 * Every field defaults to the production behaviour, so the zero-argument
 * `runProductionDaemon()` entry path (`npm start`) is unchanged; the seams exist
 * so the ordered startup pre-step can be tested without a real container mount.
 */
export interface ProductionDaemonSeams {
  /** Registry environment view for the startup mount assertion; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Mount-table path for the startup mount assertion; defaults to `/proc/self/mountinfo`. */
  mountInfoPath?: string;
  /** Structured logger; defaults to the stdout JSONL `daemon` logger. */
  logger?: JsonLogger;
  /** Assembly constructor; defaults to `createProductionAssembly`. */
  createAssembly?: (opts: ProductionAssemblyOptions) => Promise<ProductionAssembly>;
  /** Resident daemon loop; defaults to `runDaemon`. */
  runDaemonLoop?: (ctx: DaemonContext) => Promise<DaemonRunReport>;
}

/** Resolve configured agent/model settings, failing closed on a malformed model. */
function resolveRoleModel(setting: { model?: string } | undefined): ProviderModel | undefined {
  return setting?.model !== undefined ? parseProviderModel(setting.model) : undefined;
}

/** Assemble exactly the runtime used by `tissue daemon`; only external transports are injectable. */
/** Test seam for the fail-closed managed gate contract; production uses createProductionAssembly. */
export async function createProductionAssemblyForTest(opts: { beaconFailure: boolean }): Promise<{ managedGate: () => ManagedGateVerdict }> {
  return { managedGate: () => ({ loaded: !opts.beaconFailure, reason: opts.beaconFailure ? "test beacon failure" : "test beacon loaded" }) };
}

export async function createProductionAssembly(opts: ProductionAssemblyOptions): Promise<ProductionAssembly> {
  // Order matters: the single factory validates the resident endpoint (loopback/
  // private or an exact allowlist origin), applies the exact-origin allowlist, and
  // pins it to a literal private address BEFORE any credential is attached.
  // `TISSUE_OPENCODE_URL` is taken from the option (the daemon/CLI pass the
  // environment value) and `TISSUE_OPENCODE_ALLOWED_ORIGINS` from the environment.
  const credentials = opts.credentials ?? {};
  const transport = await createResidentTransport(
    { ...process.env, TISSUE_OPENCODE_URL: opts.endpoint },
    credentials,
  );
   const agentDefinitions = validateTissueAgentDefinitions({
    // Always compare against the checked-in source so a stale deployed definition
    // cannot silently survive a source update.
    sourceDir: resolveSourceAgentsDir(),
    ...(opts.agentsDir ? { agentsDir: opts.agentsDir } : {}),
  });
   if (!agentDefinitions.ok) {
     throw new Error(`invalid host-global Tissue agent definitions: ${agentDefinitions.errors.join("; ")}`);
   }
   const plugin = validateModerationPlugin(opts.pluginsDir !== undefined ? { pluginsDir: opts.pluginsDir } : {});
   if (!plugin.ok && opts.pluginsDir !== undefined) throw new Error(`invalid host-global Tissue moderation plugin: ${plugin.errors.join("; ")}`);
   const moderationDir = process.env.TISSUE_MODERATION_DIR ?? "/tissue-moderation";
   const expectedSha256 = plugin.expectedSha256 ?? "";
   const managedGate = opts.managedGate ?? (() => verifyModerationPluginLoaded({ moderationDir, pluginsDir: plugin.pluginsDir, expectedSha256 }));
   const gate = managedGate();
    if (!gate.loaded) opts.logger.warn("moderation.plugin_not_verified", { reason: gate.reason, deployedSha256: plugin.sha256 });
    // Preserve the main-branch issue fix: assembly startup performs one authenticated
    // resident-health request before exposing the production driver.
    await transport.http.sessionStatus();

    const http = transport.http;
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
    logger: opts.logger,
    ...(opts.registryDir !== undefined ? { registryDir: opts.registryDir } : {}),
     managedGate,
  });

  return {
    driver,
    transport: http,
    endpoint: transport.endpointLabel,
    agentDefinitions,
     normalLoop: defaultNormalLoopIo(opts.config, opts.logger, {
       gh,
       triageDriver: driver,
       resolutionDriver: driver,
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
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

export async function runProductionDaemon(seams: ProductionDaemonSeams = {}): Promise<void> {
  const stateDir = process.env.TISSUE_STATE_DIR ?? ".tissue";
  const configPath = process.env.TISSUE_CONFIG ?? "./tissue.yml";
  const config = loadConfig(configPath);
  const logger = seams.logger ?? new JsonLogger(stdout, "info").op("daemon");
  const env = seams.env ?? process.env;
  const db = openTissueDb(join(stateDir, "tissue.db"), { retentionDays: config.retentionDays });
  let health: HealthServer | undefined;
  try {
    // Ordered startup pre-step (L13 / DD §8.3), run STRICTLY before the assembly
    // and the daemon loop: assert the registry mount -> prune markers with no DB
    // row -> continue. A mount-assertion failure is a loud structured event and a
    // non-zero exit; createProductionAssembly/runDaemon are never reached.
    let startup: RegistryStartupReport;
    try {
      startup = await runStartupRegistryReconciliation(
        db,
        env,
        logger,
        seams.mountInfoPath !== undefined ? { mountInfoPath: seams.mountInfoPath } : {},
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error("registry.mount_assertion_failed", { reason });
      throw error;
    }
    logger.info("registry.startup", {
      dir: startup.dir,
      mountAsserted: startup.mountAsserted,
      pruned: startup.pruned,
      markerCount: startup.markerCount,
      at: startup.at,
    });

    const createAssembly = seams.createAssembly ?? createProductionAssembly;
    const assembly = await createAssembly({
       config,
       logger,
       db,
       stateDir,
       configPath,
       endpoint: process.env.TISSUE_OPENCODE_URL ?? "",
      credentials: {
        ...(process.env.OPENCODE_SERVER_USERNAME !== undefined ? { username: process.env.OPENCODE_SERVER_USERNAME } : {}),
        ...(process.env.OPENCODE_SERVER_PASSWORD !== undefined ? { password: process.env.OPENCODE_SERVER_PASSWORD } : {}),
      },
    });
    const runDaemonLoop = seams.runDaemonLoop ?? runDaemon;
    try {
      health = await startHealthServer({
        port: Number(process.env.TISSUE_HTTP_PORT ?? 8787),
        db,
        registryDir: startup.dir,
        residentReachable: async () => {
          try {
            await assembly.transport.sessionStatus();
            return true;
          } catch {
            return false;
          }
        },
      });
      logger.info("health.started", { url: health.url });
    } catch (error) {
      logger.error("health.start_failed", { reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const wakeHint = new SseWakeHint({
      source: { openStream: () => assembly.transport.eventStream() },
      logger,
      sleep: defaultSleep,
    });
    await runDaemonLoop({
      config,
      logger,
      db,
      reconcile: assembly.reconcile,
      checkResidentHealth: assembly.checkResidentHealth,
      normalLoop: assembly.normalLoop,
      wakeHint,
      sleep: defaultSleep,
    });
  } finally {
    // Health is intentionally best-effort during shutdown and never changes the
    // daemon's failure result.
    try {
      await health?.close();
    } catch {
      /* listener may already be closed */
    }
    closeDb(db);
  }
}

/**
 * Production entrypoint wrapper: run the daemon and return the process exit
 * code. A startup failure (for example the registry mount assertion) has already
 * been logged loudly by `runProductionDaemon`; it is converted here into a
 * non-zero code and never reaches the daemon loop.
 */
export async function runProductionDaemonEntrypoint(seams: ProductionDaemonSeams = {}): Promise<number> {
  try {
    await runProductionDaemon(seams);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tissue daemon failed: ${message}\n`);
    return 1;
  }
}

if (isMain()) {
  const mode = process.argv[2] ?? "daemon";
  if (mode === "daemon") {
    runProductionDaemonEntrypoint().then((code) => {
      if (code !== 0) process.exitCode = code;
    });
  } else {
    process.stdout.write(JSON.stringify(emptySafeStartup(process.env.TISSUE_STATE_DIR ?? ".tissue")) + "\n");
  }
}
