// Plan N Phase 1 — Docker-free structural packaging specification.
//
// This is the executable structural half of DD §15/§16 acceptance A/C/D/G.
// Assertions requiring a running container are intentionally deferred to the
// exact Plan O container legs documented below; they are not silently inferred
// from text or asserted here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "../..");
const composeText = () => readFileSync(resolve(ROOT, "compose.yml"), "utf8");
const compose = (): Record<string, any> => parse(composeText()) as Record<string, any>;
const service = (name: string): Record<string, any> => {
  const value = compose().services?.[name];
  assert.ok(value, `compose service ${name} must exist`);
  return value as Record<string, any>;
};

function mountsOf(value: Record<string, any>): string[] {
  return (value.volumes ?? []) as string[];
}

function mountFor(value: Record<string, any>, path: string): string {
  const match = mountsOf(value).find((mount) => mount.split(":").slice(1, 2)[0] === path);
  assert.ok(match, `mount ${path} must be declared`);
  return match;
}

// P1-S1: the complete Docker-free packaging contract.
test("P1-S1 packaging topology declares the contracted service policy, mounts, and environment", () => {
  const tissue = service("tissue");
  const opencode = service("opencode");
  const text = composeText();
  assert.deepEqual(tissue.expose, ["8787"]);
  assert.equal("ports" in tissue, false, "tissue must not publish a host port");
  assert.equal("depends_on" in tissue, false);
  assert.equal("depends_on" in opencode, false);
  assert.equal(tissue.restart, "on-failure:3");
  assert.deepEqual(tissue.cap_drop, ["ALL"]);
  assert.equal(tissue.security_opt?.includes("no-new-privileges:true"), true);
  assert.equal(tissue.user, "1000:1000");
  assert.equal("read_only" in tissue, false);
  assert.equal("tmpfs" in tissue, false);
  assert.match(JSON.stringify(tissue.healthcheck), /8787/);
  assert.doesNotMatch(JSON.stringify(tissue.healthcheck), /opencode|4096/i, "liveness must not probe resident OpenCode");
  assert.match(text, /tissue-net/);

  const expectedEnv = {
    TISSUE_STATE_DIR: "/var/lib/tissue/state",
    TISSUE_WORKTREE_ROOT: "/srv/tissue/worktrees",
    TISSUE_SESSION_REGISTRY_DIR: "/tissue-session-registry",
    TISSUE_MODERATION_DIR: "/tissue-moderation",
    TISSUE_OPENCODE_URL: "http://opencode:4096",
    TISSUE_OPENCODE_ALLOWED_ORIGINS: "http://opencode:4096",
    TISSUE_OPENCODE_PLUGINS_DIR: "/home/opencode/.config/opencode/plugins",
    TISSUE_OPENCODE_AGENTS_DIR: "/home/opencode/.config/opencode/agents",
    TISSUE_CONFIG: "/config/tissue.yml",
    TISSUE_HTTP_PORT: "8787",
  };
  assert.deepEqual(tissue.environment, expectedEnv);

  // RA-01: the eight contracted mount paths and modes.
  assert.match(mountFor(tissue, "/var/lib/tissue/state"), /:rw$/);
  assert.equal(mountsOf(opencode).some((mount) => mount.includes(":/var/lib/tissue/state")), false);
  assert.match(mountFor(tissue, "/srv/tissue/worktrees"), /:rw$/);
  assert.match(mountFor(opencode, "/srv/tissue/worktrees"), /:rw$/);
  assert.match(mountFor(tissue, "/tissue-session-registry"), /:rw$/);
  assert.match(mountFor(opencode, "/tissue-session-registry"), /:ro$/);
  assert.match(mountFor(tissue, "/tissue-moderation"), /:ro$/);
  assert.match(mountFor(opencode, "/tissue-moderation"), /:rw$/);
  assert.match(mountFor(tissue, "/home/opencode/.config/opencode/plugins"), /:ro$/);
  assert.match(mountFor(opencode, "/home/opencode/.config/opencode/plugins"), /:rw$/);
  assert.match(mountFor(tissue, "/home/opencode/.config/opencode/agents"), /:ro$/);
  assert.match(mountFor(opencode, "/home/opencode/.config/opencode/agents"), /:rw$/);
  assert.ok(mountsOf(tissue).some((mount) => mount.includes("/config/tissue.yml") && mount.endsWith(":ro")));
  assert.ok(mountsOf(tissue).some((mount) => mount.split(":").slice(1, 2)[0]?.startsWith("/workspace/")));
});

// P1-S2: named acceptance evidence. Runtime halves are explicitly Plan O.
test("P1-S2 acceptance A/C/D/G structural evidence", () => {
  const tissue = service("tissue");
  const opencode = service("opencode");
  assert.ok(tissue.image, "A: tissue has its own image");
  assert.deepEqual(tissue.entrypoint, ["/app/container/entrypoint.sh"]);
  assert.deepEqual(tissue.networks, ["tissue-net"]);
  assert.deepEqual(opencode.networks, ["tissue-net"]);
  assert.equal(mountFor(tissue, "/srv/tissue/worktrees"), mountFor(opencode, "/srv/tissue/worktrees"), "D: worktree paths are byte-identical");
  const checkoutT = mountsOf(tissue).find((mount) => mount.includes("/workspace/"));
  const checkoutO = mountsOf(opencode).find((mount) => mount.includes("/workspace/"));
  assert.equal(checkoutT, checkoutO, "D: monitored checkout paths are byte-identical");
  assert.ok(mountFor(tissue, "/var/lib/tissue/state"));
  assert.equal(mountsOf(opencode).some((mount) => mount.includes("/var/lib/tissue/state")), false, "G: state is Tissue-only");
  assert.notEqual(mountFor(tissue, "/var/lib/tissue/state").split(":")[1], "/srv/tissue/worktrees", "G: private state is not under shared worktrees");

  // DEFERRED TO PLAN O: leg 1 build/boot; leg 4 docker network inspect;
  // leg 5 in-container path equality and live mount modes. This test owns only
  // parse-level structural evidence and must remain Docker-free.
});

// P1-S3 is owned by the existing module-level registry startup sequence specs
// in p6-registry.test.ts; the shell entrypoint is deliberately deferred to N.
// P1-S5 Docker-only clauses: Plan O legs 1, 4, and 5 above.
