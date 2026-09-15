// src/cli.ts
//
// Thin CLI dispatch (R16/R20). This file only routes commands to shared domain
// handlers. `tick` and `reconcile` run one pass; `daemon` enters the resident
// `runDaemon` loop. Structured logging is masked JSONL.

import { stdout } from "node:process";

import { loadConfig, ConfigError } from "./config/load.ts";
import type { TissueConfig } from "./config/types.ts";
import { JsonLogger } from "./logging/jsonl.ts";
import { runReconcilePass, type ReconcileReport } from "./controller/reconcile.ts";
import { openTissueDb, closeDb } from "./db/open.ts";
import { GhClient } from "./integrations/gh-client.ts";
import { createProductionAssembly } from "./runtime/entrypoint.ts";
import { runDaemon, SseWakeHint } from "./runtime/daemon.ts";
import { installAgentDefinitions } from "./runtime/resident.ts";
import {
  OperationError,
  statusOperation,
  inspectOperation,
  historyOperation,
  enqueueOperation,
  pauseOperation,
  resumeOperation,
  unpauseOperation,
  cleanupOperation,
  doctorOperation,
  smokeOperation,
} from "./controller/ops.ts";

// Re-export so type-only consumers can rely on cli as the single command surface.
export type { TissueConfig };

export const COMMANDS = [
  "daemon",
  "tick",
  "reconcile",
  "status",
  "inspect",
  "history",
  "enqueue",
  "pause",
  "resume",
  "unpause",
  "cleanup",
  "install-agents",
  "doctor",
  "smoke",
] as const;

export type CommandName = (typeof COMMANDS)[number];

export interface CliContext {
  configPath: string;
  logger: JsonLogger;
  /** Load config from configPath (throws ConfigError). */
  load(): TissueConfig;
  out: (text: string) => void;
}

type Handler = (ctx: CliContext, args: string[]) => Promise<number>;

export interface CommandEntry {
  name: CommandName;
  usage: string;
  summary: string;
  run: Handler;
}

function writeOut(text: string): void {
  stdout.write(text + "\n");
}

function makeContext(configPath: string, logger: JsonLogger): CliContext {
  return {
    configPath,
    logger,
    load: () => loadConfig(configPath),
    out: writeOut,
  };
}

// ---- handlers -------------------------------------------------------------

function opsContext(ctx: CliContext): { config: TissueConfig; stateDir: string; logger: JsonLogger } {
  return { config: ctx.load(), stateDir: process.env.TISSUE_STATE_DIR ?? ".tissue", logger: ctx.logger };
}

function printJson(ctx: CliContext, value: unknown): void { ctx.out(JSON.stringify(value)); }

const hStatus: Handler = async (ctx, _args) => { printJson(ctx, statusOperation(opsContext(ctx))); return 0; };
const hInspect: Handler = async (ctx, args) => { printJson(ctx, inspectOperation(opsContext(ctx), args[0])); return 0; };
const hHistory: Handler = async (ctx, args) => { printJson(ctx, historyOperation(opsContext(ctx), args[0])); return 0; };
const hPause: Handler = async (ctx, args) => { if (!args[0]) throw new OperationError("INVALID_ARGUMENT", "pause expects a target", 2); printJson(ctx, pauseOperation(opsContext(ctx), args[0])); return 0; };
const hResume: Handler = async (ctx, args) => { if (!args[0]) throw new OperationError("INVALID_ARGUMENT", "resume expects a target", 2); printJson(ctx, resumeOperation(opsContext(ctx), args[0])); return 0; };
const hUnpause: Handler = async (ctx, args) => { if (!args[0]) throw new OperationError("INVALID_ARGUMENT", "unpause expects a target", 2); printJson(ctx, unpauseOperation(opsContext(ctx), args[0])); return 0; };
const hCleanup: Handler = async (ctx, args) => { if (!args[0]) throw new OperationError("INVALID_ARGUMENT", "cleanup expects a work item id", 2); printJson(ctx, await cleanupOperation(opsContext(ctx), args[0])); return 0; };

const hDoctor: Handler = async (ctx, _args) => {
  const report = doctorOperation(opsContext(ctx));
  printJson(ctx, report);
  // Fail closed: an invalid/missing/drifted deployed agent definition is a
  // doctor failure, not an advisory note.
  return report.ok === true ? 0 : 1;
};

/**
 * Deploy the checked-in dedicated Tissue agent definitions into the OpenCode
 * global agent directory the resident service reads. Idempotent; refuses to
 * overwrite a divergent file without --force. Never touches the OpenCode database
 * and never restarts the resident service.
 */
const hInstallAgents: Handler = async (ctx, args) => {
  const result = installAgentDefinitions({ force: args.includes("--force") });
  printJson(ctx, result);
  return result.ok ? 0 : 1;
};
const hSmoke: Handler = async (ctx, _args) => { printJson(ctx, smokeOperation(opsContext(ctx))); return 0; };

/** One-line, human/ops-readable reconcile summary: `reconcile P0:ok P1:fail ...`. */
export function renderReconcileReport(report: ReconcileReport): string {
  const parts = report.phases.map((p) => `${p.phase}:${p.ok ? "ok" : p.skipped ? "skip" : "fail"}`);
  const failures = report.phases.filter((p) => !p.ok && !p.skipped).length;
  return `reconcile ${parts.join(" ")}${failures > 0 ? ` failures=${failures}` : ""}`;
}

async function runReconcileHandler(ctx: CliContext, op: string): Promise<number> {
  const report = await runReconcilePass({ config: ctx.load(), logger: ctx.logger.op(op) });
  ctx.out(renderReconcileReport(report));
  return report.phases.some((p) => !p.ok && !p.skipped) ? 1 : 0;
}

const hReconcile: Handler = (ctx) => runReconcileHandler(ctx, "reconcile");
const hTick: Handler = (ctx) => runReconcileHandler(ctx, "tick");
const hDaemon: Handler = async (ctx) => {
  const config = ctx.load();
  const stateDir = process.env.TISSUE_STATE_DIR ?? ".tissue";
  const db = openTissueDb(`${stateDir}/tissue.db`, { retentionDays: config.retentionDays });
  try {
    const endpoint = process.env.TISSUE_OPENCODE_URL ?? "";
    const logger = ctx.logger.op("daemon");
    const assembly = await createProductionAssembly({
      config,
      logger,
      db,
      stateDir,
      endpoint,
      credentials: {
        ...(process.env.OPENCODE_SERVER_USERNAME !== undefined ? { username: process.env.OPENCODE_SERVER_USERNAME } : {}),
        ...(process.env.OPENCODE_SERVER_PASSWORD !== undefined ? { password: process.env.OPENCODE_SERVER_PASSWORD } : {}),
      },
    });
    const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 1000)));
    const wakeHint = new SseWakeHint({
      source: { openStream: () => assembly.transport.eventStream() },
      logger,
      sleep,
    });
    const report = await runDaemon({
      config,
      logger,
      db,
      reconcile: assembly.reconcile,
      normalLoop: assembly.normalLoop,
      wakeHint,
      sleep,
      ...(process.env.TISSUE_MAX_ITERATIONS ? { maxIterations: Number(process.env.TISSUE_MAX_ITERATIONS) } : {}),
    });
    ctx.out(JSON.stringify(report));
    return 0;
  } finally {
    closeDb(db);
  }
};

const ENQUEUE_ARG_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)#(\d{1,10})$/;

const hEnqueue: Handler = async (ctx, args) => {
  const arg = args[0];
  if (!arg || !ENQUEUE_ARG_RE.test(arg)) {
    throw new Error(`enqueue expects owner/repo#number, got '${arg ?? ""}'`);
  }
  const [, owner, name, issue] = arg.match(ENQUEUE_ARG_RE)!;
  printJson(ctx, enqueueOperation(opsContext(ctx), owner!, name!, Number(issue)));
  return 0;
};

// ---- command table ---------------------------------------------------------
// One registry row per command; tick/reconcile share runReconcilePass, while
// daemon is the resident wrapper around that pass and the normal-loop path.
const TABLE: CommandEntry[] = [
  { name: "daemon", usage: "daemon", summary: "run the supervised reconcile loop", run: hDaemon },
  { name: "tick", usage: "tick", summary: "run one reconcile pass (manual)", run: hTick },
  { name: "reconcile", usage: "reconcile", summary: "run one reconcile pass", run: hReconcile },
  { name: "status", usage: "status", summary: "print configuration summary", run: hStatus },
  { name: "inspect", usage: "inspect [owner/repo|work-item-id]", summary: "inspect durable state", run: hInspect },
  { name: "history", usage: "history [work-item-id]", summary: "show retained activity", run: hHistory },
  { name: "enqueue", usage: "enqueue <owner/repo#number>", summary: "admit an issue explicitly (R14)", run: hEnqueue },
  { name: "pause", usage: "pause <owner/repo|work-item-id>", summary: "pause triage/work", run: hPause },
  { name: "resume", usage: "resume <owner/repo|work-item-id>", summary: "resume paused repo/work", run: hResume },
  { name: "unpause", usage: "unpause <owner/repo|work-item-id>", summary: "reset a paused repo/work", run: hUnpause },
  { name: "cleanup", usage: "cleanup <work-item-id>", summary: "release a failed-hold work item", run: hCleanup },
  { name: "install-agents", usage: "install-agents [--force]", summary: "deploy Tissue agents to the OpenCode global dir", run: hInstallAgents },
  { name: "doctor", usage: "doctor", summary: "run environment self-checks", run: hDoctor },
  { name: "smoke", usage: "smoke", summary: "run a smoke self-check", run: hSmoke },
];

export function usage(prog: string): string {
  const lines = [`usage: ${prog} <command> [args]`, "", "commands:"];
  for (const c of TABLE) lines.push(`  ${c.name.padEnd(10)} ${c.usage.padEnd(22)} ${c.summary}`);
  return lines.join("\n");
}

export function lookupCommand(name: string): CommandEntry | undefined {
  return TABLE.find((c) => c.name === name);
}

/** Command dispatch entrypoint. Returns a process exit code. */
export async function main(argv: string[]): Promise<number> {
  const command = argv[2];
  const rest = argv.slice(3);
  const logger = new JsonLogger(stdout, "info");

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    if (command === undefined) {
      stdout.write(usage("tissue") + "\n");
      return 1;
    }
    stdout.write(usage("tissue") + "\n");
    return 0;
  }

  const entry = lookupCommand(command);
  if (!entry) {
    stdout.write(`unknown command: ${command}\n`);
    stdout.write(usage("tissue") + "\n");
    return 2;
  }

  const configPath = process.env.TISSUE_CONFIG ?? "./tissue.yml";
  const ctx = makeContext(configPath, logger.op(command));
  try {
    return await entry.run(ctx, rest);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof OperationError) {
      logger.warn("command_failed", { command, code: err instanceof OperationError ? err.code : "CONFIG", reason: err.message });
      stdout.write(JSON.stringify({ error: { code: err instanceof OperationError ? err.code : "CONFIG_ERROR", message: err.message } }) + "\n");
      return err instanceof OperationError ? err.exitCode : 3;
    }
    if (err instanceof Error) {
      logger.error("command_failed", { command, reason: err.message });
      stdout.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

// Allow direct execution: node src/cli.ts <command>
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
if (typeof process.argv[1] === "string") {
  try {
    if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
      main(process.argv).then((code) => {
        process.exitCode = code;
      });
    }
  } catch {
    /* not the main entrypoint */
  }
}

