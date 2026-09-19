// tests/helpers/pessimistic-opencode-server.ts
//
// M6 TEST-ONLY pessimistic fake OpenCode server (DD RG-3/RG-4 evidence inputs).
// A node:http loopback server speaking the historical OpenCode REST surface used by
// the REAL driver (opencode-http.ts / opencode-driver.ts) so the driver contract
// tests exercise the production transport end-to-end against a controllable
// server — no SDK client, no real `opencode serve`, no shared opencode.db.
//
// "Pessimistic" here means the fake does NOT assume prompts always succeed: it
// models persist-and-queue when a prompt arrives while busy, accepted-but-
// incomplete 204 responses, missing/late (empty) message history, busy/retry
// status transitions, compaction summary turns (summary=true / mode=compaction)
// parented to a nonce user message, parent-linked assistant turns, and real
// nonce-bearing user messages. Each failure/queue scenario is expressible and is
// genuinely simulated — the driver must gate on idle and must never treat an
// acceptance (204 / busy / noReply / summary / compaction) as completion.
//
// This file is a TEST helper only. It never appears in production code paths.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { OcHistoryEntry, OcMessage, OcSession, OcSessionStatus, OcTextPart } from "../../src/integrations/opencode-http.ts";

interface SessionRec extends OcSession {
  status: OcSessionStatus;
  deleted: boolean;
  messages: OcHistoryEntry[];
  historyEmpty: boolean; // message history endpoint returns 200 [] (late/missing transcript)
  pendingAsyncUserMsgId?: string; // accepted-but-incomplete async prompt waiting to flush
  msgSeq: number;
}

export interface PessimisticServerOptions {
  version?: string;
  /** Assign a server-side projectID for a directory (defaults to a counter). */
  projectIdFor?: (directory: string) => string;
  /** Session id prefix (default "ses_"). Override to test non-ses_ rejection. */
  sessionIdPrefix?: string;
  /** When set, every request must carry matching HTTP Basic credentials. */
  username?: string;
  password?: string;
}

export class PessimisticOpenCodeServer {
  private readonly server: Server;
  private readonly opts: { version: string } & Omit<PessimisticServerOptions, "version">;
  private sessions = new Map<string, SessionRec>();
  private seq = 1;
  private projSeq = 1;
  port = 0;
  /**
   * When a sync/async prompt arrives on a busy session. Historical release-gate
   * does NOT busy-reject (RG-3): it accepts the prompt and persists the user
   * message. Default is therefore the aligned `accept_no_reply`; `http_409`
   * remains only as an explicit opt-in robustness scenario — never as an
   * assumed server contract.
   */
  promptWhileBusy: "http_409" | "accept_no_reply" = "accept_no_reply";
  /** When set, sync prompts return this HTTP error instead of a turn (never assume success). */
  syncPromptErrorCode: number | null = null;
  /**
   * When set, the GLOBAL GET /session/status route fails with this code while
   * per-session lookups keep working. Models a service-level/route failure, which
   * must never be read as per-session loss.
   */
  globalStatusErrorCode: number | null = null;
  /** Count of requests rejected for missing/incorrect credentials (auth evidence). */
  authRejections = 0;
  /** Total HTTP requests observed (validates ordering: e.g. zero before endpoint validation). */
  requestCount = 0;

  constructor(opts: PessimisticServerOptions = {}) {
    this.opts = { version: "1.18.18", ...opts };
    this.server = createServer((req, res) => void this.route(req, res));
  }

  /** Start listening on 127.0.0.1:0 (random loopback port). */
  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const a = this.server.address() as AddressInfo;
        this.port = a.port;
        resolve();
      });
    });
    return this.port;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Read-only snapshot of live (non-deleted) sessions. */
  liveSessions(): SessionRec[] {
    return [...this.sessions.values()].filter((s) => !s.deleted);
  }

  getRec(sessionId: string): SessionRec | undefined {
    return this.sessions.get(sessionId);
  }

  sessionByDirectory(directory: string): SessionRec | undefined {
    for (const s of this.sessions.values()) {
      if (!s.deleted && s.directory === directory) return s;
    }
    return undefined;
  }

  // ---- scenario helpers -------------------------------------------------------

  /** Report busy (type busy) for the session. */
  setBusy(sessionId: string): void {
    this.must(sessionId).status = { type: "busy" };
  }

  /** Report retry (non-idle, with attempt/message/next) for the session. */
  setRetry(sessionId: string, attempt = 1, message = "retry", next = Date.now()): void {
    this.must(sessionId).status = { type: "retry", attempt, message, next };
  }

  setIdle(sessionId: string): void {
    this.must(sessionId).status = { type: "idle" };
  }

  /** Simulate the transcript not yet being readable (empty history, 200 []). */
  setHistoryEmpty(sessionId: string, empty = true): void {
    this.must(sessionId).historyEmpty = empty;
  }

  /** Simulate the session no longer existing server-side. */
  deleteSession(sessionId: string): void {
    const r = this.sessions.get(sessionId);
    if (r) r.deleted = true;
  }

  /** Append a nonce-bearing user message (as a real server would after a prompt). */
  appendUserMessage(sessionId: string, text: string, identity: { agent?: string; model?: { providerID: string; modelID: string } } = {}): string {
    const r = this.must(sessionId);
    const id = `msg_${r.msgSeq++}`;
    const msg: OcMessage = {
      id,
      sessionID: r.id,
      role: "user",
      time: { created: Date.now() },
      agent: identity.agent ?? "build",
      ...(identity.model ? { model: identity.model } : {}),
    };
    const part: OcTextPart = { id: `p_${r.msgSeq}`, type: "text", text };
    r.messages.push({ info: msg, parts: [part] });
    return id;
  }

  /** Append an assistant turn parented to a given (nonce) user message. */
  appendAssistantTurn(sessionId: string, opts: { parentID: string; text?: string; summary?: boolean; mode?: string }): string {
    const r = this.must(sessionId);
    const id = `msg_${r.msgSeq++}`;
    const msg: OcMessage = {
      id,
      sessionID: r.id,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: opts.parentID,
      mode: opts.mode ?? "normal",
      ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
      path: { cwd: r.directory, root: r.directory },
    };
    const part: OcTextPart = { id: `p_${r.msgSeq}`, type: "text", text: opts.text ?? "ok" };
    r.messages.push({ info: msg, parts: [part] });
    return id;
  }

  /** Complete a pending async prompt: produce the assistant turn for its nonce user message. */
  flushAsync(sessionId: string, opts: { text?: string } = {}): string | undefined {
    const r = this.must(sessionId);
    const parentId = r.pendingAsyncUserMsgId;
    if (!parentId) return undefined;
    r.pendingAsyncUserMsgId = undefined;
    r.status = { type: "idle" };
    return this.appendAssistantTurn(sessionId, { parentID: parentId, mode: "normal", ...(opts.text !== undefined ? { text: opts.text } : {}) });
  }

  private must(sessionId: string): SessionRec {
    const r = this.sessions.get(sessionId);
    if (!r || r.deleted) throw new Error(`pessimistic server: no live session ${sessionId}`);
    return r;
  }

  private newSession(directory: string): SessionRec {
    const prefix = this.opts.sessionIdPrefix ?? "ses_";
    const id = `${prefix}${this.seq++}`;
    const projectID = this.opts.projectIdFor ? this.opts.projectIdFor(directory) : `project-${this.projSeq++}`;
    const now = Date.now();
    const rec: SessionRec = {
      id,
      projectID,
      directory,
      title: `pes-${this.seq}`,
      version: this.opts.version,
      time: { created: now, updated: now },
      status: { type: "idle" },
      deleted: false,
      messages: [],
      historyEmpty: false,
      msgSeq: 1,
    };
    this.sessions.set(id, rec);
    return rec;
  }

  // ---- HTTP routing -----------------------------------------------------------

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requestCount += 1;
    const url = new URL(req.url ?? "/", this.baseUrl());
    const method = req.method ?? "GET";
    const segments = url.pathname.split("/").filter(Boolean); // ['session', id?, sub?]
    const q = url.searchParams;

    if (this.opts.username !== undefined || this.opts.password !== undefined) {
      if (!this.authorized(req)) {
        this.authRejections++;
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Basic realm="opencode"');
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    try {
      if (segments[0] !== "session") {
        if (url.pathname === "/event") return this.sse(req, res);
        return this.json(res, 404, { error: "not_found" });
      }
      const id = segments[1];
      const sub = segments[2];

      // GET /session/status
      if (url.pathname === "/session/status" && method === "GET") {
        if (this.globalStatusErrorCode !== null) {
          // Injected service-level failure on the GLOBAL status route: a dependency
          // failure, never evidence about one individual session.
          return this.json(res, this.globalStatusErrorCode, { error: "status_unavailable" });
        }
        const map: Record<string, OcSessionStatus> = {};
        for (const r of this.sessions.values()) {
          if (r.deleted || r.status.type === "idle") continue; // idle not reported (mirrors real)
          map[r.id] = r.status;
        }
        return this.json(res, 200, map);
      }

      // POST /session
      if (!id && method === "POST") {
        const directory = q.get("directory") ?? "";
        const rec = this.newSession(directory);
        return this.json(res, 200, this.publicSession(rec));
      }
      // GET /session
      if (!id && method === "GET") {
        const dir = q.get("directory");
        const list = [...this.sessions.values()]
          .filter((r) => !r.deleted && (dir === null || r.directory === dir))
          .map((r) => this.publicSession(r));
        return this.json(res, 200, list);
      }
      if (!id) return this.json(res, 400, { error: "bad_request" });

      const rec = this.sessions.get(id);
      // GET /session/{id}
      if (!sub && method === "GET") {
        if (!rec || rec.deleted) return this.json(res, 404, { error: "not_found" });
        return this.json(res, 200, this.publicSession(rec));
      }
      // DELETE /session/{id}
      if (!sub && method === "DELETE") {
        if (rec) rec.deleted = true;
        res.statusCode = 204;
        res.end();
        return;
      }
      // GET /session/{id}/message (history)
      if (sub === "message" && method === "GET") {
        if (!rec || rec.deleted) return this.json(res, 404, { error: "not_found" });
        return this.json(res, 200, rec.historyEmpty ? [] : rec.messages);
      }
      // POST /session/{id}/abort
      if (sub === "abort" && method === "POST") {
        if (!rec || rec.deleted) return this.json(res, 404, { error: "not_found" });
        rec.status = { type: "idle" };
        rec.pendingAsyncUserMsgId = undefined;
        res.statusCode = 204;
        res.end();
        return;
      }
      // POST /session/{id}/message (sync prompt) and /prompt_async
      if ((sub === "message" || sub === "prompt_async") && method === "POST") {
        if (!rec || rec.deleted) return this.json(res, 404, { error: "not_found" });
        const body = await this.readJson(req);
        const isAsync = sub === "prompt_async";
        return this.handlePrompt(rec, body, isAsync, res);
      }
      return this.json(res, 404, { error: "not_found" });
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: String((err as Error).message) }));
    }
  }

  private async handlePrompt(
    rec: SessionRec,
    body: { parts?: { type?: string; text?: string }[]; noReply?: boolean; agent?: string; model?: { providerID: string; modelID: string } },
    isAsync: boolean,
    res: ServerResponse,
  ): Promise<void> {
    const text = (body.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
    const identity = { ...(body.agent !== undefined ? { agent: body.agent } : {}), ...(body.model ? { model: body.model } : {}) };
    const busy = rec.status.type !== "idle";
    // Pessimistic busy handling: never assume a prompt issued while busy succeeds.
    if (busy) {
      if (this.promptWhileBusy === "http_409") {
        return this.json(res, 409, { error: "session_busy" });
      }
      // accept_no_reply (default, aligned with real 1.18.18 RG-3): accept the
      // prompt, persist the nonce user message, and keep the session busy.
      // Acceptance NEVER implies completion. Async acceptance is HTTP 204; a
      // sync prompt produces no assistant turn (desync, not success).
      const queuedMsgId = this.appendUserMessage(rec.id, text, identity);
      if (isAsync) {
        // Persist-and-queue: the message can still be completed later via flushAsync.
        rec.pendingAsyncUserMsgId = queuedMsgId;
        res.statusCode = 204;
        res.end();
        return;
      }
      return this.json(res, 200, this.emptyTurnJson(rec));
    }
    // Sync prompts may be forced to fail (never assume success).
    if (!isAsync && this.syncPromptErrorCode !== null) {
      return this.json(res, this.syncPromptErrorCode, { error: "prompt_failed" });
    }

    // Create the nonce-bearing user message first (mirrors a real server).
    const userMsgId = this.appendUserMessage(rec.id, text, identity);

    if (isAsync) {
      // Accepted-but-incomplete (204). No assistant turn until flushAsync.
      rec.status = { type: "busy" };
      rec.pendingAsyncUserMsgId = userMsgId;
      res.statusCode = 204;
      res.end();
      return;
    }
    // Sync prompt while idle: noReply means a user injection with no AI turn.
    if (body.noReply === true) {
      rec.status = { type: "idle" };
      return this.json(res, 200, this.emptyTurnJson(rec));
    }
    rec.status = { type: "busy" };
    const triageText = this.triageResponse(text);
    const assistantId = this.appendAssistantTurn(rec.id, {
      parentID: userMsgId,
      mode: "normal",
      ...(triageText !== undefined ? { text: triageText } : {}),
    });
    rec.status = { type: "idle" };
    return this.json(res, 200, this.turnJson(rec, assistantId, userMsgId));
  }

  private triageResponse(text: string): string | undefined {
    if (!text.includes("Return exactly one JSON triage envelope")) return undefined;
    const issueId = /issue_id=([^\s]+)/.exec(text)?.[1];
    if (!issueId) return undefined;
    return JSON.stringify({
      kind: "triage",
      envelope_id: `env-triage-${issueId}`,
      issue_id: issueId,
      disposition: "READY",
      reason: "test boundary semantic response",
    });
  }

  private emptyTurnJson(_rec: SessionRec): Record<string, unknown> {
    // Sync response shape requires an assistant info; a noReply/busy server that
    // produces no AI turn is a desync — return a malformed/empty turn so the
    // driver treats it as NOT an assistant completion (never completion).
    return {};
  }

  private turnJson(rec: SessionRec, assistantId: string, _userMsgId: string): Record<string, unknown> {
    const entry = rec.messages.find((m) => m.info.id === assistantId);
    if (!entry) return {};
    return { info: entry.info, parts: entry.parts };
  }

  private publicSession(rec: SessionRec): OcSession {
    return {
      id: rec.id,
      projectID: rec.projectID,
      directory: rec.directory,
      title: rec.title,
      version: rec.version,
      time: rec.time,
    };
  }

  private sse(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: server.connected\ndata: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    // Close after the first event so http.firstEvent is deterministic.
    res.end();
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const expected = `${this.opts.username ?? ""}:${this.opts.password ?? ""}`;
    return decoded === expected;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

/** Start a pessimistic fake server on a free loopback port. */
export async function startPessimisticServer(opts: PessimisticServerOptions = {}): Promise<PessimisticOpenCodeServer> {
  const srv = new PessimisticOpenCodeServer(opts);
  await srv.start();
  return srv;
}
