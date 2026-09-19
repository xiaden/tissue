import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4096);
const sessions = new Map();
const requests = [];
let sessionSequence = 1;
let projectSequence = 1;
let logicalTime = 1_700_000_000_000;

const operations = new Set([
  "POST /session", "GET /session", "GET /session/{sessionID}", "DELETE /session/{sessionID}",
  "POST /session/{sessionID}/abort", "GET /session/status", "GET /session/{sessionID}/message",
  "POST /session/{sessionID}/message", "POST /session/{sessionID}/prompt_async", "GET /event",
]);

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
function tick() { logicalTime += 1; return logicalTime; }
function record(method, route, status, sessionID) {
  requests.push({ method, route, status, ...(sessionID ? { sessionID } : {}) });
  if (requests.length > 32) requests.shift();
}
function finish(res, method, route, status, body, sessionID) {
  record(method, route, status, sessionID);
  if (status === 204) { res.statusCode = status; return res.end(); }
  return json(res, status, body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("malformed JSON")); }
    });
    req.on("error", reject);
  });
}
function sessionView(session) {
  return { id: session.id, projectID: session.projectID, directory: session.directory, title: session.title, version: "1.18.31-fixture", time: session.time };
}
function appendUser(session, text, body) {
  const id = `msg_${session.sequence++}`;
  session.messages.push({ info: { id, sessionID: session.id, role: "user", time: { created: tick() }, agent: body.agent ?? "fixture", ...(body.model ? { model: body.model } : {}) }, parts: [{ id: `part_${session.sequence}`, type: "text", text }] });
  return id;
}
function appendAssistant(session, parentID, text = "fixture response") {
  const id = `msg_${session.sequence++}`;
  session.messages.push({ info: { id, sessionID: session.id, role: "assistant", time: { created: tick(), completed: logicalTime }, parentID, mode: "normal", path: { cwd: session.directory, root: session.directory } }, parts: [{ id: `part_${session.sequence}`, type: "text", text }] });
  return id;
}
function promptText(body) {
  return (body?.parts ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}
function validPrompt(body) {
  return body && Array.isArray(body.parts) && body.parts.length > 0 && body.parts.every((part) => part && part.type === "text" && typeof part.text === "string");
}
function createSession(directory) {
  const now = tick();
  const session = { id: `ses_${sessionSequence++}`, projectID: `fixture-project-${projectSequence++}`, directory, title: "tissue-ci-fixture", time: { created: now, updated: now }, status: "idle", messages: [], sequence: 1 };
  sessions.set(session.id, session);
  return session;
}
function routeTemplate(method, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (pathname === "/event") return `${method} /event`;
  if (parts[0] !== "session") return `${method} ${pathname}`;
  if (parts.length === 1) return `${method} /session`;
  if (parts.length === 2 && parts[1] === "status") return `${method} /session/status`;
  if (parts.length === 2) return `${method} /session/{sessionID}`;
  if (parts.length === 3) return `${method} /session/{sessionID}/${parts[2]}`;
  return `${method} ${pathname}`;
}
function getSession(id) { const session = sessions.get(id); return session && !session.deleted ? session : undefined; }

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "fixture"}`);
  const method = req.method ?? "GET";
  const route = routeTemplate(method, url.pathname);
  try {
    if (url.pathname === "/health" && method === "GET") return finish(res, method, "/health", 200, { ok: true, fixture: true, recorded: requests.length });
    if (!operations.has(route) && url.pathname !== "/health") return finish(res, method, route, 404, { error: "unknown fixture operation", route });
    if (url.pathname === "/event") {
      record(method, route, 200);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      return res.end(`event: server.connected\ndata: ${JSON.stringify({ type: "server.connected", properties: { fixture: true, logicalTime } })}\n\n`);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && method === "POST") return finish(res, method, route, 200, sessionView(createSession(url.searchParams.get("directory") ?? "")));
    if (parts.length === 1 && method === "GET") {
      const directory = url.searchParams.get("directory");
      return finish(res, method, route, 200, [...sessions.values()].filter((s) => !s.deleted && (directory === null || s.directory === directory)).map(sessionView));
    }
    if (parts.length === 2 && parts[1] === "status") {
      if (method !== "GET") return finish(res, method, route, 501, { error: "known operation is not implemented", route });
      const result = {};
      for (const session of sessions.values()) if (!session.deleted && session.status !== "idle") result[session.id] = { type: session.status, ...(session.status === "retry" ? { attempt: 1, message: "fixture retry", next: logicalTime + 10 } : {}) };
      return finish(res, method, route, 200, result);
    }
    const session = getSession(parts[1]);
    if (parts.length === 2 && method === "GET") return finish(res, method, route, session ? 200 : 404, session ? sessionView(session) : { error: "missing session" }, parts[1]);
    if (parts.length === 2 && method === "DELETE") { if (session) session.deleted = true; return finish(res, method, route, 204, undefined, parts[1]); }
    if (!session) return finish(res, method, route, 404, { error: "missing session" }, parts[1]);
    if (parts[2] === "abort" && method === "POST") { session.status = "idle"; return finish(res, method, route, 204, undefined, session.id); }
    if (parts[2] === "message" && method === "GET") return finish(res, method, route, 200, session.messages, session.id);
    if ((parts[2] === "message" || parts[2] === "prompt_async") && method === "POST") {
      const body = await readJson(req);
      if (!validPrompt(body)) return finish(res, method, route, 400, { error: "prompt parts must contain text" }, session.id);
      const text = promptText(body);
      const parentID = appendUser(session, text, body);
      if (parts[2] === "prompt_async") {
         session.status = text.includes("retry ") ? "retry" : "busy";
         setTimeout(() => { if (!session.deleted) { appendAssistant(session, parentID); session.status = "idle"; } }, 5);
         return finish(res, method, route, 204, undefined, session.id);
       }
      const assistantID = appendAssistant(session, parentID, text.includes("Return exactly one JSON triage envelope") ? JSON.stringify({ kind: "triage", envelope_id: "fixture-envelope", issue_id: "fixture-issue", disposition: "READY", reason: "fixture" }) : "fixture response");
      session.status = "idle";
      return finish(res, method, route, 200, session.messages.find((entry) => entry.info.id === assistantID), session.id);
    }
    return finish(res, method, route, 501, { error: "known operation is not implemented", route }, session.id);
  } catch (error) { return finish(res, method, route, 400, { error: error instanceof Error ? error.message : String(error) }); }
}

const server = createServer((req, res) => void route(req, res));
server.listen(port, "0.0.0.0", () => { const address = server.address(); console.log(`FIXTURE_READY ${typeof address === "object" && address ? address.port : port}`); });
