import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4096);
const sessions = new Map();
let sessionSequence = 1;
let projectSequence = 1;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
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
  return {
    id: session.id,
    projectID: session.projectID,
    directory: session.directory,
    title: session.title,
    version: "fixture-1",
    time: session.time,
  };
}

function appendUser(session, text) {
  const id = `msg_${session.sequence++}`;
  session.messages.push({
    info: { id, sessionID: session.id, role: "user", time: { created: Date.now() }, agent: "fixture" },
    parts: [{ id: `part_${session.sequence}`, type: "text", text }],
  });
  return id;
}

function appendAssistant(session, parentID, text = "fixture response") {
  const id = `msg_${session.sequence++}`;
  session.messages.push({
    info: {
      id,
      sessionID: session.id,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID,
      mode: "normal",
      path: { cwd: session.directory, root: session.directory },
    },
    parts: [{ id: `part_${session.sequence}`, type: "text", text }],
  });
  return id;
}

function promptText(body) {
  return (body?.parts ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

function createSession(directory) {
  const id = `ses_${sessionSequence++}`;
  const now = Date.now();
  const session = {
    id,
    projectID: `fixture-project-${projectSequence++}`,
    directory,
    title: "tissue-ci-fixture",
    time: { created: now, updated: now },
    status: "idle",
    messages: [],
    sequence: 1,
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  const session = sessions.get(id);
  return session && !session.deleted ? session : undefined;
}

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "fixture"}`);
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/health" && method === "GET") return json(res, 200, { ok: true, fixture: true });
    if (url.pathname === "/event" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.end(`data: ${JSON.stringify({ type: "server.connected", properties: { fixture: true } })}\n\n`);
      return;
    }
    if (parts[0] !== "session") return json(res, 404, { error: "unknown fixture route" });
    if (parts.length === 1 && method === "POST") return json(res, 200, sessionView(createSession(url.searchParams.get("directory") ?? "")));
    if (parts.length === 1 && method === "GET") {
      const directory = url.searchParams.get("directory");
      return json(res, 200, [...sessions.values()].filter((s) => !s.deleted && (directory === null || s.directory === directory)).map(sessionView));
    }
    if (parts.length === 2 && parts[1] === "status" && method === "GET") {
      const result = {};
      for (const session of sessions.values()) if (!session.deleted && session.status !== "idle") result[session.id] = session.status === "retry" ? { type: "retry", attempt: 1, message: "fixture retry", next: Date.now() + 10 } : { type: session.status };
      return json(res, 200, result);
    }
    const session = getSession(parts[1]);
    if (parts.length === 2 && method === "GET") return session ? json(res, 200, sessionView(session)) : json(res, 404, { error: "missing session" });
    if (parts.length === 2 && method === "DELETE") { if (session) session.deleted = true; res.statusCode = 204; return res.end(); }
    if (!session) return json(res, 404, { error: "missing session" });
    if (parts[2] === "abort" && method === "POST") { session.status = "idle"; res.statusCode = 204; return res.end(); }
    if (parts[2] === "message" && method === "GET") return json(res, 200, session.messages);
    if ((parts[2] === "message" || parts[2] === "prompt_async") && method === "POST") {
      const body = await readJson(req);
      const text = promptText(body);
      const parentID = appendUser(session, text);
      if (parts[2] === "prompt_async") {
        session.status = "busy";
        setTimeout(() => { if (!session.deleted) { appendAssistant(session, parentID); session.status = "idle"; } }, 25);
        res.statusCode = 204;
        return res.end();
      }
      const assistantID = appendAssistant(session, parentID, text.includes("Return exactly one JSON triage envelope") ? JSON.stringify({ kind: "triage", envelope_id: "fixture-envelope", issue_id: "fixture-issue", disposition: "READY", reason: "fixture" }) : "fixture response");
      session.status = "idle";
      return json(res, 200, session.messages.find((entry) => entry.info.id === assistantID));
    }
    return json(res, 404, { error: "unknown fixture request" });
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

const server = createServer((req, res) => void route(req, res));
server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  console.log(`FIXTURE_READY ${typeof address === "object" && address ? address.port : port}`);
});
