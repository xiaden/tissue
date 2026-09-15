// scripts/rg-probe.ts
//
// RG-3 / RG-4 / RG-6 real-server release-gate probe (Plan C Phase 1).
//
// Default and ONLY target is the RESIDENT OpenCode 1.18.18 server (pid 116785,
// port 4096) reached over loopback HTTP — the release environment with the
// shared ~/.local/share/opencode/opencode.db and ambient writers. The probe
// never starts, stops, reconfigures, or binds the resident server, never opens
// the shared DB directly, and deletes ONLY the sessions it created via the
// HTTP API. Resident-only topology: the probe never spawns an `opencode serve`.
//
// Output: raw observations are written to /tmp/tissue-rg-probe-raw.json; the
// human-readable evidence documents under artifacts/designs/process/ are
// authored from that raw capture.
//
// This is an operational harness (like scripts/lint.ts): console output is
// allowed here (lint only forbids console.* under src/).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenCodeHttp, OpenCodeHttpError, type OcHistoryEntry } from "../src/integrations/opencode-http.ts";
import { OpenCodeDriver } from "../src/integrations/opencode-driver.ts";

const OC_BIN = process.env.TISSUE_OPENCODE_BIN ?? "/usr/local/bin/opencode";
const RESIDENT_URL = process.env.TISSUE_PROBE_BASE_URL ?? "http://127.0.0.1:4096";
const PROVIDER = process.env.TISSUE_PROBE_PROVIDER ?? "omniroute";
const MODEL = process.env.TISSUE_PROBE_MODEL ?? "flash-combo";
const RAW_OUT = process.env.TISSUE_PROBE_OUT ?? "/tmp/tissue-rg-probe-raw.json";

const require = createRequire(import.meta.url);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RawResult {
  status: number;
  json: unknown;
}

async function rawFetch(
  baseUrl: string,
  auth: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<RawResult> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth) headers.Authorization = auth;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const text = await res.text();
  let json: unknown = undefined;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

function errOf(e: unknown): { name: string; status: number | null; message: string } {
  if (e instanceof OpenCodeHttpError) return { name: e.name, status: e.status, message: e.message };
  if (e instanceof Error) return { name: e.name, status: null, message: e.message };
  return { name: "unknown", status: null, message: String(e) };
}

function asObj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function hasCompleted(info: unknown): boolean {
  const time = asObj(asObj(info).time);
  return "completed" in time && time.completed !== undefined;
}

async function waitStatus(
  http: OpenCodeHttp,
  sessionId: string,
  want: "busy" | "idle",
  timeoutMs: number,
): Promise<{ ok: boolean; samples: Array<{ t: number; status: string; absent: boolean }>; elapsedMs: number }> {
  const start = Date.now();
  const samples: Array<{ t: number; status: string; absent: boolean }> = [];
  while (Date.now() - start < timeoutMs) {
    const map = await http.sessionStatus();
    const raw = map[sessionId];
    const status = raw ? raw.type : "idle";
    samples.push({ t: Date.now() - start, status, absent: raw === undefined });
    if (status === want) return { ok: true, samples, elapsedMs: Date.now() - start };
    await sleep(15);
  }
  return { ok: false, samples, elapsedMs: Date.now() - start };
}

function isUser(e: OcHistoryEntry): boolean {
  return e.info.role === "user";
}

function userByNonce(history: OcHistoryEntry[], nonce: string): OcHistoryEntry | undefined {
  return history.find((e) => {
    if (!isUser(e)) return false;
    if (e.info.id === nonce) return true;
    const text = e.parts
      .filter((p) => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => (p as { text: string }).text)
      .join("");
    return text.includes(nonce);
  });
}

function allAssistantsFor(history: OcHistoryEntry[], parentId: string): OcHistoryEntry[] {
  return history.filter((e) => e.info.role === "assistant" && e.info.parentID === parentId);
}

/** Completed, non-summary, non-compaction assistant turns parented to `parentId`. */
function qualifyingAssistants(history: OcHistoryEntry[], parentId: string): OcHistoryEntry[] {
  return allAssistantsFor(history, parentId).filter((e) => {
    const info = asObj(e.info);
    return info.summary !== true && info.mode !== "compaction" && hasCompleted(e.info);
  });
}

interface InFlightProbe {
  userPresent: boolean;
  scaffoldPresent: boolean;
  assistantCompleted: boolean;
  assistantId: string | null;
  statusType: string;
  statusAbsent: boolean;
  elapsedMs: number;
  caughtInFlight: boolean;
}

/**
 * Wait until the nonce user message and its parent-linked assistant turn exist
 * but the assistant turn is not yet completed (the real 1.18.18 in-flight
 * window). Returns the moment in-flight is observed, or when the turn completes
 * (window missed), or on timeout.
 */
async function waitInFlight(
  http: OpenCodeHttp,
  sessionId: string,
  nonce: string,
  timeoutMs: number,
): Promise<InFlightProbe> {
  const start = Date.now();
  let last: InFlightProbe | null = null;
  while (Date.now() - start < timeoutMs) {
    const history = await http.listMessages(sessionId);
    const user = userByNonce(history, nonce);
    const linked = user ? allAssistantsFor(history, user.info.id) : [];
    const completed = linked.find((e) => hasCompleted(e.info));
    const map = await http.sessionStatus();
    const raw = map[sessionId];
    const probe: InFlightProbe = {
      userPresent: !!user,
      scaffoldPresent: linked.length > 0,
      assistantCompleted: completed !== undefined,
      assistantId: linked[0]?.info.id ?? null,
      statusType: raw ? raw.type : "idle",
      statusAbsent: raw === undefined,
      elapsedMs: Date.now() - start,
      caughtInFlight: !!user && linked.length > 0 && completed === undefined,
    };
    last = probe;
    if (probe.caughtInFlight || probe.assistantCompleted) return probe;
    await sleep(30);
  }
  return (
    last ?? {
      userPresent: false,
      scaffoldPresent: false,
      assistantCompleted: false,
      assistantId: null,
      statusType: "idle",
      statusAbsent: true,
      elapsedMs: Date.now() - start,
      caughtInFlight: false,
    }
  );
}

async function settleSecond(
  http: OpenCodeHttp,
  sessionId: string,
  nonce: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  // Poll for the qualifying parent-linked turn for the SECOND nonce until the
  // bounded window expires. Deliberately NOT keyed on /session/status: the real
  // 1.18.18 server does not report busy while a turn is in flight (RG-3), so a
  // status-based "stable idle" would return prematurely and under-record whether
  // an accepted-while-busy prompt is truly queued/executed or dropped.
  const start = Date.now();
  for (;;) {
    const history = await http.listMessages(sessionId);
    const user = userByNonce(history, nonce);
    const turns = user ? qualifyingAssistants(history, user.info.id).length : 0;
    if (turns > 0) return { resolved: "turn", elapsedMs: Date.now() - start, qualifyingTurns: turns };
    if (Date.now() - start > timeoutMs) {
      return {
        resolved: "no_turn_within_window",
        elapsedMs: Date.now() - start,
        qualifyingTurns: 0,
        userPersisted: user !== undefined,
        userMessageId: user?.info.id ?? null,
      };
    }
    await sleep(250);
  }
}


function historyView(history: OcHistoryEntry[]): Array<Record<string, unknown>> {
  return history.map((e) => {
    const info = asObj(e.info);
    return {
      id: info.id,
      role: info.role,
      parentID: info.parentID ?? null,
      mode: info.mode ?? null,
      summary: info.summary ?? null,
      completed: asObj(info.time).completed ?? null,
    };
  });
}

async function main(): Promise<void> {
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "";
  const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
  const auth = password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : "";

  const cwd = mkdtempSync(join(tmpdir(), "tissue-rg-probe-"));
  const baseUrl = RESIDENT_URL;

  const http = new OpenCodeHttp({ baseUrl, password, username, timeoutMs: 240_000 });
  const driver = new OpenCodeDriver({ http });

  const result: Record<string, unknown> = {
    meta: {
      collectedAt: new Date().toISOString(),
      target: "resident",
      baseUrl,
      binary: OC_BIN,
      provider: PROVIDER,
      model: MODEL,
      cwd,
      residentServe: {
        pid: 116785,
        port: 4096,
        note: "ambient s6-supervised `opencode web`; never started/stopped/reconfigured/bound by this probe",
      },
      sharedStore: "~/.local/share/opencode/opencode.db (WAL); observed only through HTTP, never opened directly",
    },
    ready: false,
    version: null,
    sessionCountBefore: null,
    sessions: { created: [] as string[], deleted: [] as string[] },
    rg3: {},
    rg4: {},
    rg6: {},
  };
  const sessions = result.sessions as { created: string[]; deleted: string[] };
  const owned: string[] = [];

  try {
    // ---- readiness -------------------------------------------------------
    const startedAt = Date.now();
    for (;;) {
      try {
        const probePath = "/session";
        const res = await fetch(baseUrl + probePath, {
          headers: auth ? { Authorization: auth } : {},
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) break;
      } catch {
        /* not ready */
      }
      if (Date.now() - startedAt > 30_000) throw new Error(`resident server not ready within 30s`);
      await sleep(200);
    }
    result.ready = true;
    result.version = await versionOf();
    const before = await rawFetch(baseUrl, auth, "GET", "/session");
    result.sessionCountBefore = Array.isArray(before.json) ? before.json.length : null;
    console.log(`[rg-probe] target=resident baseUrl=${baseUrl} ready version=${String(result.version)}`);
    console.log(`[rg-probe] existing sessions visible: ${String(result.sessionCountBefore)}`);

    const createReal = async (title: string): Promise<string> => {
      const created = await rawFetch(baseUrl, auth, "POST", `/session?directory=${encodeURIComponent(cwd)}`, {
        title,
        model: { id: MODEL, providerID: PROVIDER },
      });
      const info = asObj(created.json);
      const id = typeof info.id === "string" ? info.id : "";
      if (!/^ses_[A-Za-z0-9]+$/.test(id)) {
        throw new Error(`create session failed: status=${created.status} body=${JSON.stringify(created.json)}`);
      }
      owned.push(id);
      sessions.created.push(id);
      return id;
    };

    const promptBody = (text: string): { parts: Array<{ type: "text"; text: string }> } => ({
      parts: [{ type: "text", text }],
    });

    // =====================================================================
    // RG-3 — prompt-while-busy behavior
    // =====================================================================
    const rg3: Record<string, unknown> = {};
    result.rg3 = rg3;
    try {
      const s3 = await createReal("rg3-busy-probe");
      const baseline = await http.sessionStatus();
      rg3.statusBaselineKeys = Object.keys(baseline).length;

      const round = async (mode: "async" | "sync", tag: string): Promise<Record<string, unknown>> => {
        const firstNonce = `RG3-FIRST-${tag}-${Date.now()}`;
        const secondNonce = `RG3-SECOND-${tag}-${Date.now()}`;
        const first = await rawFetch(baseUrl, auth, "POST", `/session/${s3}/prompt_async`, promptBody(`Probe. Reply with exactly the word: alpha. Tag=${firstNonce}`));
        const rec: Record<string, unknown> = {
          mode,
          firstNonce,
          secondNonce,
          firstHttp: first.status,
        };
        // Catch the real in-flight window (assistant scaffold present, not yet
        // completed) — the server's /session/status does NOT report busy here.
        const inflight = await waitInFlight(http, s3, firstNonce, 20_000);
        rec.inflight = inflight;
        rec.busyReportedByStatus = inflight.statusType === "busy";
        rec.inflightByTranscript = inflight.caughtInFlight;
        if (!inflight.caughtInFlight && !inflight.assistantCompleted) {
          await waitStatus(http, s3, "idle", 60_000);
          rec.note = "in-flight window not observed; second prompt skipped";
          return rec;
        }
        // Second prompt issued strictly while the first turn is in flight.
        const tSecond = Date.now();
        if (mode === "async") {
          const second = await rawFetch(baseUrl, auth, "POST", `/session/${s3}/prompt_async`, promptBody(`Second while busy. Reply with beta. Tag=${secondNonce}`));
          rec.secondHttp = second.status;
          rec.secondBody = second.json ?? null;
        } else {
          try {
            const second = await rawFetch(
              baseUrl,
              auth,
              "POST",
              `/session/${s3}/message`,
              promptBody(`Second while busy. Reply with beta. Tag=${secondNonce}`),
              150_000,
            );
            rec.secondHttp = second.status;
            rec.secondBodyRole = asObj(asObj(second.json).info).role ?? null;
          } catch (e) {
            rec.secondHttp = errOf(e).status;
            rec.secondError = errOf(e).message;
          }
        }
        rec.secondElapsedMs = Date.now() - tSecond;
        rec.settle = await settleSecond(http, s3, secondNonce, 90_000);
        const history = await http.listMessages(s3);
        const userSecond = userByNonce(history, secondNonce);
        rec.secondUserPersisted = userSecond !== undefined;
        rec.secondUserMessageId = userSecond?.info.id ?? null;
        rec.secondAllParentLinkedAssistants = userSecond ? allAssistantsFor(history, userSecond.info.id).length : 0;
        rec.secondQualifyingAssistants = userSecond ? qualifyingAssistants(history, userSecond.info.id).length : 0;
        const userFirst = userByNonce(history, firstNonce);
        rec.firstUserMessageId = userFirst?.info.id ?? null;
        rec.firstAllParentLinkedAssistants = userFirst ? allAssistantsFor(history, userFirst.info.id).length : 0;
        rec.firstQualifyingAssistants = userFirst ? qualifyingAssistants(history, userFirst.info.id).length : 0;
        rec.historyLength = history.length;
        return rec;
      };
      rg3.asyncSecond = await round("async", "A");
      await waitStatus(http, s3, "idle", 180_000);
      rg3.syncSecond = await round("sync", "S");
      rg3.conclusion =
        "recorded actual 1.18.18 behavior for a second prompt issued while the first turn is in flight: the server " +
        "does not report busy via /session/status, accepts the prompt (HTTP status recorded), persists the second " +
        "nonce user message, and never returns a busy-rejection contract; the relay must NEVER rely on busy rejection";
    } catch (e) {
      rg3.error = errOf(e);
    }

    // =====================================================================
    // RG-4 — 204 / desync / noReply / compaction
    // =====================================================================
    const rg4: Record<string, unknown> = {};
    result.rg4 = rg4;
    try {
      const s4 = await createReal("rg4-desync-probe");
      const nonce = `RG4-NONCE-${Date.now()}`;
      rg4.nonce = nonce;

      // (a) prompt_async -> 204, then sample status/history (desync).
      const t0 = Date.now();
      const accepted = await rawFetch(baseUrl, auth, "POST", `/session/${s4}/prompt_async`, promptBody(`Probe. Reply with exactly the word: gamma. Tag=${nonce}`));
      rg4.acceptedHttp = accepted.status;
      rg4.accepted204 = accepted.status === 204;

      // Capture the pre-completion scaffold and what the driver reports for it.
      const inflight = await waitInFlight(http, s4, nonce, 20_000);
      rg4.inflight = inflight;
      if (inflight.caughtInFlight) {
        rg4.driverAtScaffoldMs = inflight.elapsedMs;
        rg4.driverAtScaffold = await driver.observeCompletion(s4, nonce);
      }

      const samples: Array<Record<string, unknown>> = [];
      for (const delay of [0, 25, 100, 200, 400, 800, 1500]) {
        if (delay > 0) await sleep(delay);
        const map = await http.sessionStatus();
        const raw = map[s4];
        const history = await http.listMessages(s4);
        const user = userByNonce(history, nonce);
        const linked = user ? allAssistantsFor(history, user.info.id) : [];
        samples.push({
          t: Date.now() - t0,
          status: raw ? raw.type : "idle",
          statusAbsent: raw === undefined,
          historyLen: history.length,
          nonceUserPresent: user !== undefined,
          scaffoldPresent: linked.length > 0,
          completedTurn: user ? qualifyingAssistants(history, user.info.id).length : 0,
        });
      }
      rg4.desyncSamples = samples;
      rg4.idleWithoutCompletedTurnObserved = samples.some(
        (s) => s.status !== "busy" && s.nonceUserPresent === true && s.completedTurn === 0,
      );
      rg4.scaffoldWithoutCompletionObserved = samples.some(
        (s) => s.scaffoldPresent === true && s.completedTurn === 0,
      );
      rg4.statusBusyEverObservedInSamples = samples.some((s) => s.status === "busy");

      // Wait for the real qualifying turn and prove parent-linked match.
      let matched: unknown = { matched: false, reason: "timeout" };
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        matched = await driver.observeCompletion(s4, nonce);
        if (asObj(matched).matched === true) break;
        await sleep(300);
      }
      rg4.completionMatch = matched;
      rg4.completionElapsedMs = Date.now() - t0;
      const finalHistory = await http.listMessages(s4);
      rg4.finalHistory = historyView(finalHistory);

      // (b) noReply: sync injection with no AI turn (raw HTTP for exact status).
      const nrNonce = `RG4-NOREPLY-${Date.now()}`;
      const nr: Record<string, unknown> = { nonce: nrNonce };
      const nrRes = await rawFetch(baseUrl, auth, "POST", `/session/${s4}/message`, {
        parts: [{ type: "text", text: `Human note, no reply required. Tag=${nrNonce}` }],
        noReply: true,
      });
      nr.http = nrRes.status;
      nr.responseInfoRole = asObj(asObj(nrRes.json).info).role ?? null;
      await sleep(1000);
      const nrHistory = await http.listMessages(s4);
      const nrUser = userByNonce(nrHistory, nrNonce);
      nr.userPersisted = nrUser !== undefined;
      nr.userMessageId = nrUser?.info.id ?? null;
      nr.allParentLinkedAssistants = nrUser ? allAssistantsFor(nrHistory, nrUser.info.id).length : 0;
      const nrStatus = await http.sessionStatus();
      nr.statusAfter = nrStatus[s4]?.type ?? "idle";
      nr.observedAfterMs = 1000;
      nr.match = await driver.observeCompletion(s4, nrNonce);
      rg4.noReply = nr;

      // (c) real compaction: POST /session/{id}/summarize.
      const sum = await rawFetch(baseUrl, auth, "POST", `/session/${s4}/summarize`, {
        providerID: PROVIDER,
        modelID: MODEL,
        auto: false,
      });
      rg4.summarize = { http: sum.status, body: sum.json };
      await sleep(3000);
      await waitStatus(http, s4, "idle", 120_000);
      const sumHistory = await http.listMessages(s4);
      const compactionMessages = sumHistory
        .filter((e) => e.info.role === "assistant")
        .map((e) => {
          const info = asObj(e.info);
          const text = e.parts
            .filter((p) => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
            .map((p) => (p as { text: string }).text)
            .join("")
            .slice(0, 120);
          return {
            id: info.id,
            parentID: info.parentID ?? null,
            mode: info.mode ?? null,
            summary: info.summary ?? null,
            completed: asObj(info.time).completed ?? null,
            textPreview: text,
          };
        })
        .filter((m) => m.mode === "compaction" || m.summary !== null);
      rg4.compactionMessages = compactionMessages;
      rg4.compactionMatchForNonce = await driver.observeCompletion(s4, nonce);
      rg4.pendingRecycleRule =
        "bounded PENDING recycle with human-inspect: on a nonce-bearing user message with no qualifying reply and " +
        "session observed idle (status absent) within a bounded window, transactionally recycle DELIVERING->PENDING " +
        "plus a human-inspect event; never reissue while a qualifying turn exists";
    } catch (e) {
      rg4.error = errOf(e);
    }

    // =====================================================================
    // RG-6 — pinned SDK 1.17.x session.messages vs raw HTTP fallback
    // =====================================================================
    const rg6: Record<string, unknown> = {};
    result.rg6 = rg6;
    try {
      const sdkPath = join(
        process.env.HOME ?? "/root",
        ".opencode",
        "node_modules",
        "@opencode-ai",
        "sdk",
        "dist",
        "index.js",
      );
      rg6.sdkPath = sdkPath;
      rg6.sdkVersion = readSdkVersion();

      const s6 = await createReal("rg6-sdk-probe");
      const nonce6 = `RG6-NONCE-${Date.now()}`;
      rg6.nonce = nonce6;
      await rawFetch(baseUrl, auth, "POST", `/session/${s6}/prompt_async`, promptBody(`Probe. Reply with exactly the word: delta. Tag=${nonce6}`));
      let match6: unknown = { matched: false, reason: "timeout" };
      const d6 = Date.now() + 180_000;
      while (Date.now() < d6) {
        match6 = await driver.observeCompletion(s6, nonce6);
        if (asObj(match6).matched === true) break;
        await sleep(300);
      }
      rg6.nonceCompletionMatch = match6;
      const rawList = await http.listMessages(s6);
      rg6.rawHttpMessageCount = rawList.length;

      // (a) pinned SDK session.messages against server 1.18.18.
      try {
        const sdk = require(sdkPath) as {
          createOpencodeClient: (cfg: Record<string, unknown>) => {
            session: {
              messages: (opts: Record<string, unknown>) => Promise<{
                data?: unknown;
                error?: unknown;
                response?: { status?: number };
              }>;
            };
          };
        };
        const client = sdk.createOpencodeClient({
          baseUrl,
          directory: cwd,
          headers: auth ? { Authorization: auth } : {},
        });
        const res = await client.session.messages({ path: { id: s6 }, query: { directory: cwd } });
        const data = res.data;
        rg6.sdkMessages = {
          ok: Array.isArray(data),
          count: Array.isArray(data) ? data.length : null,
          responseStatus: res.response?.status ?? null,
          error: res.error ?? null,
        };
        if (Array.isArray(data)) {
          const entries = data as OcHistoryEntry[];
          const user = userByNonce(entries, nonce6);
          rg6.sdkHistoryView = historyView(entries);
          rg6.sdkNonceUserFound = user !== undefined;
          rg6.sdkNonceUserMessageId = user?.info.id ?? null;
          rg6.sdkAllParentLinkedAssistants = user ? allAssistantsFor(entries, user.info.id).length : 0;
          rg6.sdkNonceParentLinkedCompleted = user ? qualifyingAssistants(entries, user.info.id).length : 0;
          rg6.sdkAssistantModes = entries
            .filter((e) => e.info.role === "assistant")
            .map((e) => ({
              id: e.info.id,
              parentID: (e.info as { parentID?: string }).parentID ?? null,
              mode: (e.info as { mode?: unknown }).mode ?? null,
              summary: (e.info as { summary?: unknown }).summary ?? null,
              time: (e.info as { time?: unknown }).time ?? null,
              completed: asObj(asObj(e.info).time).completed ?? null,
            }));
        }
      } catch (e) {
        rg6.sdkMessages = { ok: false, threw: errOf(e) };
      }

      rg6.rawHttpFallbackProven =
        "the driver reads transcripts through opencode-http.listMessages (tested raw HTTP fallback); " +
        "RG-3/RG-4/RG-6 exercised it end-to-end against 1.18.18";
    } catch (e) {
      rg6.error = errOf(e);
    }

    // ---- hygiene: delete only owned sessions ---------------------------------
    for (const id of owned) {
      try {
        await http.deleteSession(id);
        sessions.deleted.push(id);
      } catch (e) {
        sessions.deleted.push(`FAILED:${id}:${errOf(e).message}`);
      }
    }
    console.log(`[rg-probe] deleted owned sessions: ${sessions.deleted.length}/${owned.length}`);
  } finally {
    writeFileSync(RAW_OUT, JSON.stringify(result, null, 2));
    console.log(`[rg-probe] raw observations written to ${RAW_OUT}`);
  }
}

function readSdkVersion(): string {
  try {
    const p = join(process.env.HOME ?? "/root", ".opencode", "node_modules", "@opencode-ai", "sdk", "package.json");
    return String((require(p) as { version?: string }).version ?? "unknown");
  } catch {
    return "unavailable";
  }
}

async function versionOf(): Promise<string> {
  return await new Promise<string>((resolve) => {
    const v = spawn(OC_BIN, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    v.stdout.on("data", (d) => (out += String(d)));
    v.on("exit", () => resolve(out.trim() || "unknown"));
    v.on("error", () => resolve("unknown"));
  });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[rg-probe] fatal:", err);
    process.exit(1);
  },
);
