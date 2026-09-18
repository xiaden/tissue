import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

interface ReprobeResult {
  status: string;
  pluginsDir: string;
  residentUrl: string;
  reason?: string;
}

function runUnauthorizedReprobe(output: string, pluginsDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/l14-reprobe.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TISSUE_L14_OUTPUT: output,
        TISSUE_OPENCODE_PLUGINS_DIR: pluginsDir,
        TISSUE_L14_BASE_URL: "http://127.0.0.1:1",
        TISSUE_L14_AUTHORIZED: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("l14-reprobe records unavailable without authorization and performs no live operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tissue-l14-test-"));
  const pluginsDir = join(root, "plugins");
  const output = join(root, "result.json");
  try {
    const run = await runUnauthorizedReprobe(output, pluginsDir);

    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    assert.match(run.stdout, /"status":"unavailable"/);
    assert.equal(existsSync(pluginsDir), false, "unauthorized run must not create or contact the plugin directory");
    assert.deepEqual(readdirSync(root), ["result.json"]);

    const result = JSON.parse(readFileSync(output, "utf8")) as ReprobeResult;
    assert.equal(result.status, "unavailable");
    assert.equal(result.pluginsDir, pluginsDir);
    assert.equal(result.residentUrl, "http://127.0.0.1:1");
    assert.equal(result.reason, "no explicit resident authorization; live operations were not attempted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
