// tests/_diag_http.ts  (throwaway diagnostic — remove after use)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeHttp } from "../src/integrations/opencode-http.ts";

const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

const cwd = mkdtempSync(join(tmpdir(), "diag-http-"));
const username = process.env.OPENCODE_SERVER_USERNAME ?? "";
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const port = await freePort();
const env = { ...process.env }; delete env.OPENCODE_PID; delete env.OPENCODE;
const child = spawn("/usr/local/bin/opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd, env, stdio: ["ignore", "ignore", "ignore"] });
const step = (s: string) => console.log(`[step] ${s}`);

const http = new OpenCodeHttp({ baseUrl: `http://127.0.0.1:${port}`, password, username, timeoutMs: 10_000 });
// readiness using http? there is no /doc method; raw fetch with timeout
const auth = password ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` } : {};
step("readiness");
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`http://127.0.0.1:${port}/doc`, { headers: auth, signal: AbortSignal.timeout(2000) }); if (r.ok) { step("doc ready"); break; } } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 250));
}
step("createSession");
const created = await http.createSession(cwd);
step("created " + created.id);
step("listSessions");
await http.listSessions(cwd);
step("getSession");
await http.getSession(created.id);
step("sessionStatus");
await http.sessionStatus();
step("listMessages");
await http.listMessages(created.id);
step("firstEvent");
const ev = await http.firstEvent(8000);
step("event " + ev.type);
step("abortSession");
await http.abortSession(created.id);
step("deleteSession");
await http.deleteSession(created.id);
step("ALL DONE");
child.kill("SIGTERM");
await new Promise((r) => child.once("exit", r));
setTimeout(() => process.exit(0), 200);
