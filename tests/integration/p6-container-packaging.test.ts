// Plan N — Docker-free executable coverage for the container packaging contract.
// Docker build/startup evidence remains deferred because Docker is unavailable here;
// these tests exercise the shell contract and the build recipe's observable inputs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ENTRYPOINT = join(ROOT, "container/entrypoint.sh");
const PREPARE = join(ROOT, "container/prepare-volumes.sh");
const DOCKERFILE = join(ROOT, "Dockerfile");

function runBash(args: string[], env?: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync("bash", args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("container scripts pass shell syntax validation", () => {
  for (const script of [ENTRYPOINT, PREPARE]) {
    const result = runBash(["-n", script]);
    assert.equal(result.status, 0, `${script} must parse: ${result.stderr}`);
  }
});

test("prepare-volumes creates only Tissue-writable directories without requiring chown", () => {
  const root = mkdtempSync(join(tmpdir(), "tissue-volume-prep-"));
  const dirs = {
    state: join(root, "state"),
    worktrees: join(root, "worktrees"),
    registry: join(root, "registry"),
    moderation: join(root, "moderation"),
    plugins: join(root, "plugins"),
    agents: join(root, "agents"),
  };
  const result = runBash([PREPARE], {
    TISSUE_STATE_DIR: dirs.state,
    TISSUE_WORKTREE_ROOT: dirs.worktrees,
    TISSUE_SESSION_REGISTRY_DIR: dirs.registry,
    TISSUE_MODERATION_DIR: dirs.moderation,
    TISSUE_OPENCODE_PLUGINS_DIR: dirs.plugins,
    TISSUE_OPENCODE_AGENTS_DIR: dirs.agents,
  });

  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /"event":"volumes\.prepared"/);
  for (const directory of [dirs.state, dirs.worktrees, dirs.registry]) {
    assert.equal(statSync(directory).isDirectory(), true, `${directory} must be created`);
  }
  for (const directory of [dirs.moderation, dirs.plugins, dirs.agents]) {
    assert.equal(existsSync(directory), false, `${directory} must remain owner-side and unprepared`);
  }
});

test("tissue-deploy invokes only the supported plugin installer", () => {
  const compose = readFileSync(join(ROOT, "compose.yml"), "utf8");
  assert.match(compose, /tissue-deploy:[\s\S]*?command: \["install-plugin"\]/);
  assert.doesNotMatch(compose, /tissue-deploy:[\s\S]*?command: \["deploy"\]/);
});

test("entrypoint prepares volumes before daemon exec and fails before daemon on preparation error", () => {
  const source = readFileSync(ENTRYPOINT, "utf8");
  const prepareCall = source.indexOf("/app/container/prepare-volumes.sh");
  const daemonExec = source.indexOf("exec node src/runtime/entrypoint.ts daemon");
  assert.ok(prepareCall >= 0, "entrypoint must invoke prepare-volumes.sh");
  assert.ok(daemonExec > prepareCall, "daemon must start after volume preparation");
  assert.match(source, /^set -euo pipefail$/m, "preparation failure must stop startup");
  assert.match(source, /^exec node src\/runtime\/entrypoint\.ts daemon$/m);
});

test("Dockerfile packages runtime assets, runtime dependencies, executable scripts, and UID/GID contract", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  assert.match(dockerfile, /^FROM node:26-bookworm-slim$/m);
  assert.match(dockerfile, /apt-get install[\s\\\n]+--no-install-recommends[\s\\\n]+--yes git gh/);
  assert.match(dockerfile, /^COPY package\.json package-lock\.json \.\/$/m);
  assert.match(dockerfile, /^RUN npm ci --omit=dev$/m);
  for (const asset of ["src", "container", "agents", "plugin"]) {
    assert.match(dockerfile, new RegExp(String.raw`^COPY ${asset} \.\/${asset}$`, "m"));
  }
  assert.match(dockerfile, /chmod 0555 \/app\/container\/entrypoint\.sh \/app\/container\/prepare-volumes\.sh/);
  assert.match(dockerfile, /chown -R 1000:1000/);
  assert.match(dockerfile, /^USER 1000:1000$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["\/app\/container\/entrypoint\.sh"\]$/m);
  assert.equal(existsSync(join(ROOT, "package-lock.json")), true);
  assert.equal(existsSync(join(ROOT, "container/entrypoint.sh")), true);
  assert.equal(existsSync(join(ROOT, "container/prepare-volumes.sh")), true);
});

// Keep this test's fixture operation explicit: the script must remain executable
// in the source tree, as required by the Dockerfile's chmod contract.
test("container startup scripts are executable source assets", () => {
  for (const script of [ENTRYPOINT, PREPARE]) {
    assert.equal((statSync(script).mode & 0o111) !== 0, true, `${script} must be executable`);
  }
});
