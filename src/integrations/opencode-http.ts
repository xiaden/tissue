// src/integrations/opencode-http.ts
//
// M6 raw loopback HTTP client for the OpenCode 1.18.31 server API (R3/R5/R10,
// CONTRACTS `createRealSession`/`getSessionStatus`/`promptSession`/
// `observeCompletion` inputs). This is a typed, argv-free, JSON-only transport
// over Node's global `fetch` — no subprocess, no shell, no free-form strings. It
// is the canonical transport used by src/integrations/opencode-driver.ts so the
// driver is deterministic and can be exercised end-to-end against the
// dependency-free fixture and the pessimistic historical test fake (tests/helpers/
// pessimistic-opencode-server.ts) through the same code path.
//
// Design notes:
//   - Bind everything to a caller-supplied 127.0.0.1 base URL. Never bind or
//     reach a public endpoint (R21/DD security).
//   - Sessions use server-assigned durable rows. `directory` is passed as the
//     `?directory=` query so the session binds to the intended repo/worktree
//     project (OQ3 evidence: directory+server-assigned projectID, never a
//     derived project id).
//   - When the server requires basic auth (OPENCODE_SERVER_PASSWORD), every
//     request carries `Authorization: Basic ...`. Passwords are never logged.
//   - Sync prompt = POST /session/{id}/message (turn barrier → 200
//     {info,parts}); async prompt = POST /session/{id}/prompt_async (→ 204
//     "accepted", which is NOT completion). HTTP 204 alone is never completion.
//
// Historical release-gate evidence used an older SDK/server pairing. The active
// boundary is the pinned OpenCode v1.18.31 OpenAPI contract; this module uses the
// deliberately version-skew-immune raw HTTP fallback (DD RG-6 "or tested raw
// HTTP fallback") as its canonical transport. The path is exercised by the
// driver contract tests and the deterministic fixture.

/** A session as returned by the server (create/list/get). */
export interface OcSession {
  id: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  parentID?: string;
  time: { created: number; updated: number; compacting?: number };
}

/** Server-reported session lifecycle status (busy/retry are non-idle, R10). */
export type OcSessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy" };

/** A user message or an assistant message with its parent turn. */
export interface OcUserMessage {
  id: string;
  sessionID: string;
  role: "user";
  /** User turns never have an assistant parent link. */
  parentID?: never;
  time: { created: number };
  agent: string;
  model?: { providerID: string; modelID: string };
  summary?: { title?: string; body?: string; diffs: unknown[] };
}

export interface OcAssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  parentID: string;
  mode: string;
  path?: { cwd: string; root: string };
  /** true when this assistant message is a context-compaction summary. */
  summary?: boolean;
  error?: unknown;
}

export type OcMessage = OcUserMessage | OcAssistantMessage;

/** A text part (carries the prompt/nonce text). */
export interface OcTextPart {
  id?: string;
  type: "text";
  text: string;
  synthetic?: boolean;
}

export interface OcCompactionPart {
  id?: string;
  type: "compaction";
  auto?: boolean;
}

export type OcPart = OcTextPart | OcCompactionPart | { type: string; [k: string]: unknown };

/** History list entry: the message plus its parts. */
export interface OcHistoryEntry {
  info: OcMessage;
  parts: OcPart[];
}

/** Request part inputs accepted by the prompt endpoints. */
export type OcPartInput =
  | { type: "text"; text: string; synthetic?: boolean }
  | { type: string; [k: string]: unknown };

/** Body of a sync/async prompt request (mirrors SDK 1.17.x SessionPromptData). */
export interface OcPromptBody {
  messageID?: string;
  agent?: string;
  /** Provider/model selection in OpenCode's native prompt shape. */
  model?: { providerID: string; modelID: string };
  noReply?: boolean;
  system?: string;
  /** Tool allow keys. NEVER carries a lifecycle-mutating tissue_* tool. */
  tools?: Record<string, boolean>;
  parts: OcPartInput[];
}

/** A generic server event delivered over SSE. */
export interface OcEvent {
  type: string;
  properties: Record<string, unknown>;
}

export class OpenCodeHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenCodeHttpError";
    this.status = status;
  }
}

export interface OpenCodeHttpOptions {
  /** Loopback server base URL, e.g. http://127.0.0.1:44121 (never public). */
  baseUrl: string;
  /** Basic-auth password when the serve requires OPENCODE_SERVER_PASSWORD. */
  password?: string;
  /** Basic-auth username (defaults to "" when unset). */
  username?: string;
  /** Per-request timeout in ms (default 30_000). 0 disables. */
  timeoutMs?: number;
  /** AbortSignal forwarded to every request (e.g. serve shutdown). */
  signal?: AbortSignal;
}

function encodeBasic(user: string, password: string): string {
  // Buffer base64 of "user:pass" — ASCII-safe. Never logged.
  return Buffer.from(`${user}:${password}`, "utf8").toString("base64");
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStatusMap(v: unknown): Record<string, OcSessionStatus> {
  const out: Record<string, OcSessionStatus> = {};
  if (isJsonObject(v)) {
    for (const [k, raw] of Object.entries(v)) {
      if (isJsonObject(raw) && typeof raw.type === "string") {
        if (raw.type === "idle") out[k] = { type: "idle" };
        else if (raw.type === "busy") out[k] = { type: "busy" };
        else if (raw.type === "retry") {
          out[k] = {
            type: "retry",
            attempt: typeof raw.attempt === "number" ? raw.attempt : 0,
            message: typeof raw.message === "string" ? raw.message : "",
            next: typeof raw.next === "number" ? raw.next : 0,
          };
        }
      }
    }
  }
  return out;
}

/** Guard: session ids must be the OpenCode-created `ses_...` form. */
export function assertOcSessionId(value: string, field = "sessionId"): string {
  if (!/^ses_[A-Za-z0-9]+$/.test(value)) {
    throw new OpenCodeHttpError(`${field}: not an OpenCode-created 'ses_...' identity: '${value}'`, 0);
  }
  return value;
}

/**
 * Raw loopback OpenCode HTTP transport. Every method performs a typed JSON
 * fetch; non-2xx responses throw a classified OpenCodeHttpError. Request bodies
 * are built from fixed shapes only (never untrusted text interpolated anywhere
 * except as JSON string values).
 */
export class OpenCodeHttp {
  readonly baseUrl: string;
  private readonly password?: string;
  private readonly username: string;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(opts: OpenCodeHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.password = opts.password;
    this.username = opts.username ?? "";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.signal = opts.signal;
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    let u = `${this.baseUrl}${path}`;
    if (query) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
      if (parts.length > 0) u += `?${parts.join("&")}`;
    }
    return u;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; expected?: "json" | "void" } = {},
  ): Promise<T | undefined> {
    const headers: Record<string, string> = {};
    if (this.password) {
      headers["Authorization"] = `Basic ${encodeBasic(this.username, this.password)}`;
    }
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    headers["Accept"] = "application/json";

    const controller = new AbortController();
    const outer = this.signal;
    const onOuterAbort = (): void => controller.abort();
    outer?.addEventListener("abort", onOuterAbort);
    const timer =
      this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined;

    let response: Response;
    try {
      response = await fetch(this.url(path, opts.query), {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      throw new OpenCodeHttpError(`request ${method} ${path} failed: ${(err as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }

    if (!response.ok) {
      // 404 on a session-scoped resource => the session does not exist/missing.
      const detail = await response.text().catch(() => "");
      throw new OpenCodeHttpError(
        `${method} ${path} -> HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        response.status,
      );
    }
    if (opts.expected === "void" || response.status === 204 || response.status === 201) {
      return undefined;
    }
    const text = await response.text();
    if (text.trim().length === 0) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OpenCodeHttpError(`${method} ${path} returned non-JSON`, response.status);
    }
  }

  // ---- session lifecycle -----------------------------------------------------

  /** POST /session?directory= → OpenCode-created durable session. */
  async createSession(directory: string, body: { title?: string; parentID?: string } = {}): Promise<OcSession> {
    const data = await this.request<OcSession>("POST", "/session", {
      query: { directory },
      body: Object.keys(body).length > 0 ? body : undefined,
    });
    if (!data || typeof data.id !== "string") {
      throw new OpenCodeHttpError("create session: server returned no session", 0);
    }
    return data;
  }

  /** GET /session?directory= → sessions whose directory is exactly `directory`. */
  async listSessions(directory?: string): Promise<OcSession[]> {
    const data = await this.request<unknown>("GET", "/session", {
      query: directory !== undefined ? { directory } : undefined,
    });
    return Array.isArray(data) ? (data as OcSession[]) : [];
  }

  /** GET /session/{id} → one durable session. */
  async getSession(sessionId: string): Promise<OcSession> {
    assertOcSessionId(sessionId);
    const data = await this.request<OcSession>("GET", `/session/${sessionId}`);
    if (!data || typeof data.id !== "string") {
      throw new OpenCodeHttpError(`get session ${sessionId}: no session returned`, 0);
    }
    return data;
  }

  /** DELETE /session/{id} — used only by hygiene/probes on own sessions. */
  async deleteSession(sessionId: string): Promise<void> {
    assertOcSessionId(sessionId);
    await this.request<void>("DELETE", `/session/${sessionId}`, { expected: "void" });
  }

  /** POST /session/{id}/abort. */
  async abortSession(sessionId: string): Promise<void> {
    assertOcSessionId(sessionId);
    await this.request<void>("POST", `/session/${sessionId}/abort`, { expected: "void" });
  }

  // ---- status / messages -----------------------------------------------------

  /** GET /session/status → map of session-id → observed status. */
  async sessionStatus(): Promise<Record<string, OcSessionStatus>> {
    const data = await this.request<unknown>("GET", "/session/status");
    return asStatusMap(data);
  }

  /** GET /session/{id}/message → ordered history of {info, parts}. */
  async listMessages(sessionId: string): Promise<OcHistoryEntry[]> {
    assertOcSessionId(sessionId);
    const data = await this.request<unknown>("GET", `/session/${sessionId}/message`);
    if (!Array.isArray(data)) return [];
    return (data as OcHistoryEntry[]).filter((e) => isJsonObject(e) && e.info && e.info.id);
  }

  /** POST /session/{id}/message — SYNC prompt (turn barrier). */
  async sendMessage(sessionId: string, body: OcPromptBody): Promise<OcHistoryEntry> {
    assertOcSessionId(sessionId);
    const data = await this.request<OcHistoryEntry>("POST", `/session/${sessionId}/message`, { body });
    if (!data || !data.info || typeof data.info.id !== "string") {
      throw new OpenCodeHttpError(`prompt ${sessionId}: server returned no assistant turn`, 0);
    }
    return data;
  }

  /** POST /session/{id}/prompt_async → 204 accepted (NOT completion). */
  async sendPromptAsync(sessionId: string, body: OcPromptBody): Promise<void> {
    assertOcSessionId(sessionId);
    await this.request<void>("POST", `/session/${sessionId}/prompt_async`, {
      body,
      expected: "void",
    });
  }

  // ---- SSE --------------------------------------------------------------------

  /**
   * Open GET /event and resolve with the first parsed event (the server emits
   * `server.connected` first). Reads until the first `data:` JSON line, then
   * closes the stream. A timeout guards against a silent/never-emitting server.
   */
  async firstEvent(timeoutMs = 10_000): Promise<OcEvent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.url("/event"), {
        headers: {
          ...(this.password ? { Authorization: `Basic ${encodeBasic(this.username, this.password)}` } : {}),
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new OpenCodeHttpError(`GET /event -> HTTP ${response.status}`, response.status);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new OpenCodeHttpError("GET /event closed before an event", 0);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt: OcEvent;
          try {
            evt = JSON.parse(payload) as OcEvent;
          } catch {
            continue;
          }
          try {
            await reader.cancel();
          } catch {
            /* best-effort close */
          }
          return evt;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Open GET /event and yield parsed SSE events until the stream ends or the
   * caller/serve aborts. This is a WAKE HINT / liveness feed only: no controller
   * decision may treat an event as durable truth (RG-5). Heartbeat timeouts and
   * reconnect/backoff live in the supervised wake-hint loop, not here.
   */
  async *eventStream(signal?: AbortSignal): AsyncGenerator<OcEvent> {
    const response = await fetch(this.url("/event"), {
      headers: {
        ...(this.password ? { Authorization: `Basic ${encodeBasic(this.username, this.password)}` } : {}),
        Accept: "text/event-stream",
      },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new OpenCodeHttpError(`GET /event -> HTTP ${response.status}`, response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as OcEvent;
          } catch {
            /* skip malformed event lines */
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* best-effort close */
      }
    }
  }
}
