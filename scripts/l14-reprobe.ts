// scripts/l14-reprobe.ts
//
// OQ5 / L14 resident-plugin lifecycle re-probe. This harness is deliberately
// resident-only: it never starts, stops, restarts, reconfigures, or supervises
// OpenCode; never opens the OpenCode DB directly; never touches an existing
// session; and never installs more than this one temporary probe plugin.
//
// Hard limits (binding): create exactly one scratch session, perform exactly
// one tool invocation, record the tool.execute.before input shape and whether
// its sessionID is a stable ses_* identity, then delete that session and the
// probe plugin. The resolved global plugins directory must be byte-for-byte
// unchanged except for the temporary probe during the probe. An unusable result
// stops the line. No alternate inference (database reads, logs, process
// inspection, restart, or file-existence inference) is permitted.
//
// Execution is opt-in because this operation creates and deletes a real
// OpenCode session. Set TISSUE_L14_AUTHORIZED=1 only when a current resident is
// explicitly authorized. Without it this script reports unavailable and does
// not write a plugin, create a session, or contact the resident.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenCodeGlobalPluginsDir } from "../src/runtime/resident.ts";
import { OpenCodeHttp } from "../src/integrations/opencode-http.ts";

const RESIDENT_URL = process.env.TISSUE_L14_BASE_URL ?? "http://127.0.0.1:4096";
const OUTPUT = process.env.TISSUE_L14_OUTPUT ?? "artifacts/research/l14-reprobe-current.json";
const MODEL = process.env.TISSUE_L14_MODEL ?? "flash-combo";
const PROVIDER = process.env.TISSUE_L14_PROVIDER ?? "omniroute";
const PROBE_FILE = ".tissue-l14-probe.ts";

interface ProbeRecord {
  hook: "tool.execute.before";
  inputKeys: string[];
  sessionID: string;
  sessionIdIsStableSesIdentity: boolean;
  tool: string;
  callID: string;
}

interface Result {
  status: "observed" | "unavailable" | "unusable";
  residentUrl: string;
  residentVersion?: string;
  pluginsDir: string;
  observedHookInputKeys?: string[];
  sessionID?: string;
  sessionIdIsStableSesIdentity?: boolean;
  reason?: string;
}

function probeSource(recordPath: string): string {
  return `import { writeFileSync } from "node:fs";\n\nconst recordPath = ${JSON.stringify(recordPath)};\n\nexport default async function () {\n  return {\n    tool: {\n      tissue_l14_probe: {\n        description: "L14 one-shot probe tool",\n        args: {},\n        async execute() { return "l14-probe-ok"; },\n      },\n    },\n    "tool.execute.before": async (input) => {\n      writeFileSync(recordPath, JSON.stringify({\n        hook: "tool.execute.before",\n        inputKeys: Object.keys(input).sort(),\n        sessionID: input.sessionID,\n        sessionIdIsStableSesIdentity: typeof input.sessionID === "string" && /^ses_[A-Za-z0-9]+$/.test(input.sessionID),\n        tool: input.tool,\n        callID: input.callID,\n      }));\n    },\n  };\n}\n`;
}

function writeResult(result: Result): void {
  const parent = OUTPUT.slice(0, OUTPUT.lastIndexOf("/"));
  if (parent) mkdirSync(parent, { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n");
}

async function residentVersion(http: OpenCodeHttp): Promise<string> {
  const response = await fetch(`${RESIDENT_URL}/global/health`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`resident health HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  return typeof body.version === "string" ? body.version : "unknown";
}

async function main(): Promise<void> {
  const pluginsDir = resolveOpenCodeGlobalPluginsDir();
  const resultBase = { residentUrl: RESIDENT_URL, pluginsDir };
  if (process.env.TISSUE_L14_AUTHORIZED !== "1") {
    writeResult({ status: "unavailable", ...resultBase, reason: "no explicit resident authorization; live operations were not attempted" });
    console.log(JSON.stringify({ status: "unavailable", reason: "no explicit resident authorization" }));
    return;
  }

  const http = new OpenCodeHttp({ baseUrl: RESIDENT_URL, password: process.env.OPENCODE_SERVER_PASSWORD });
  let sessionID: string | undefined;
  const scratch = mkdtempSync(join(tmpdir(), "tissue-l14-"));
  const recordPath = join(scratch, "hook.json");
  const probePath = join(pluginsDir, PROBE_FILE);
  let probeCreated = false;
  try {
    const version = await residentVersion(http);
    if (!existsSync(pluginsDir)) throw new Error("resolved global plugins directory is absent");
    writeFileSync(probePath, probeSource(recordPath), { flag: "wx" });
    probeCreated = true;
    const session = await http.createSession(scratch, { title: "Tissue L14 scratch probe" });
    sessionID = session.id;
    await http.sendMessage(sessionID, {
      model: { providerID: PROVIDER, modelID: MODEL },
      parts: [{ type: "text", text: "Invoke the tissue_l14_probe tool exactly once, then stop." }],
    });
    if (!existsSync(recordPath)) throw new Error("unusable: tool.execute.before did not record an input");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as ProbeRecord;
    const observed: Result = {
      status: record.sessionIdIsStableSesIdentity ? "observed" : "unusable",
      ...resultBase,
      residentVersion: version,
      observedHookInputKeys: record.inputKeys,
      sessionID: record.sessionID,
      sessionIdIsStableSesIdentity: record.sessionIdIsStableSesIdentity,
      ...(record.sessionIdIsStableSesIdentity ? {} : { reason: "unusable: hook sessionID was not a stable ses_* identity" }),
    };
    writeResult(observed);
    console.log(JSON.stringify(observed));
    if (observed.status === "unusable") process.exitCode = 1;
  } catch (error) {
    const unavailable: Result = { status: "unavailable", ...resultBase, reason: error instanceof Error ? error.message : String(error) };
    writeResult(unavailable);
    console.log(JSON.stringify(unavailable));
    process.exitCode = 2;
  } finally {
    if (sessionID) await http.deleteSession(sessionID).catch(() => undefined);
    if (probeCreated) rmSync(probePath, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
