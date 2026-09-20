// tests/integration/p6-moderation-behaviour.test.ts
//
// Phase 3 (plan L) behaviour specification for the GitHub moderation plugin
// (`plugin/tissue-moderation.ts`). Complements `p6-matcher.test.ts`: that file
// pins the matcher against DD §9.3; this file pins the end-to-end hook, refusal,
// logging, and load-beacon behaviour against DD §9.2(b)/§9.4/§9.5/§9.6 and the
// requirement ledger L19/L20/L21.
//
// Driven entirely through the single public export (adversarial IP-5 / opencode
// #42451 — the module keeps exactly one runtime export):
//
//     const hooks = await TissueModeration({});
//     await hooks["tool.execute.before"]({ tool, sessionID, callID }, { args });
//
// Conventions mirror `p6-matcher.test.ts`: real `mkdtempSync` registry and
// moderation directories, a real empty `ses_*` marker file, env save/restore,
// and a `process.stderr.write` spy for the "exactly one structured record"
// contract. The env seams are `TISSUE_SESSION_REGISTRY_DIR` (default
// `/tissue-session-registry`) and `TISSUE_MODERATION_DIR` (default
// `/tissue-moderation`).
//
// P3-S3 verification reads the beacon the factory writes immediately after it
// builds its hooks object; P3-S5 asserts the refusal is the verbatim L19
// sentence and that no log record carries secret material.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { TissueModeration } from "../../plugin/tissue-moderation.ts";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "ses_TestBehaviour0001";

// L19 / DD §9.4 — single line, single spaces, no line breaks.
const REFUSAL_SENTENCE =
  "GitHub conversational content for this automated Tissue session is moderated by Tissue. Use the GitHub context supplied to the current work item/session instead of retrieving issue, PR, review, or comment content directly.";

// Split so the test source itself never matches a `ghp_*` secret scan.
const SENTINEL = "ghp_" + "SUPERSECRETSENTINEL";

interface HookInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface HookOutput {
  args: Record<string, unknown>;
}

type BeforeHook = (input: HookInput, output: HookOutput) => Promise<void> | void;

interface Ctx {
  hooks: { "tool.execute.before": BeforeHook };
  root: string;
  registryDir: string;
  moderationDir: string;
  cleanup: () => void;
}

type RegistryMode = "dir" | "absent" | "file";
type ModerationMode = "dir" | "absent" | "file" | "conflict";

function makeTemp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `tissue-p6-behaviour-${tag}-`));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Build a ready-to-drive context: real temp registry/moderation directories
 * (with a real empty marker file when requested) and the single public export
 * constructed with a minimal `{}` context. Env seams are saved and restored.
 */
async function makeCtx(
  tag: string,
  opts: {
    marker?: string | null;
    registry?: RegistryMode;
    moderation?: ModerationMode;
  } = {},
): Promise<Ctx> {
  const root = makeTemp(tag);
  const registryDir = join(root, "registry");
  const moderationDir = join(root, "moderation");
  const registryMode = opts.registry ?? "dir";
  const moderationMode = opts.moderation ?? "dir";

  if (registryMode === "dir") {
    mkdirSync(registryDir, { recursive: true });
    if (opts.marker !== undefined && opts.marker !== null) {
      writeFileSync(join(registryDir, opts.marker), "", "utf8");
    }
  } else if (registryMode === "file") {
    // A regular file where the registry directory is expected: statSync on the
    // marker path throws ENOTDIR deterministically, independent of the uid.
    writeFileSync(registryDir, "not a directory", "utf8");
  }

  if (moderationMode === "dir" || moderationMode === "conflict") {
    mkdirSync(moderationDir, { recursive: true });
    if (moderationMode === "conflict") {
      // Force the atomic rename to fail after the temporary beacon is created.
      mkdirSync(join(moderationDir, "plugin-loaded.json"));
    }
  } else if (moderationMode === "file") {
    // A regular file where the moderation directory is expected: the atomic
    // beacon write fails (ENOTDIR) and must be logged + swallowed.
    writeFileSync(moderationDir, "not a directory", "utf8");
  }

  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  try {
    const hooks = (await TissueModeration({})) as unknown as {
      "tool.execute.before": BeforeHook;
    };
    return {
      hooks,
      root,
      registryDir,
      moderationDir,
      cleanup: () => {
        restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
        restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (err) {
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function invoke(
  ctx: Ctx,
  tool: string,
  args: Record<string, unknown>,
  sessionID: string = SESSION_ID,
): Promise<void> {
  return Promise.resolve(
    ctx.hooks["tool.execute.before"](
      { tool, sessionID, callID: "call_p6behaviour" },
      { args },
    ),
  );
}

function expectAllow(
  fn: () => Promise<void>,
  label: string,
): Promise<void> {
  return assert.doesNotReject(fn, `expected ALLOW (resolve, no throw) for: ${label}`);
}

function expectDeny(fn: () => Promise<void>, label: string): Promise<void> {
  return assert.rejects(fn, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(
      message.includes(REFUSAL_SENTENCE),
      `expected the verbatim L19 refusal for: ${label}`,
    );
    return true;
  });
}

/**
 * Replace `process.stderr.write` for the duration of an assertion so record
 * counts and record bodies can be inspected. Always restored in a `finally`.
 */
function captureStderr(): {
  lines: () => string[];
  restore: () => void;
} {
  const original = process.stderr.write;
  let buffer = "";
  const spy = ((chunk: unknown): boolean => {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString("utf8");
    return true;
  }) as unknown as typeof process.stderr.write;
  process.stderr.write = spy;
  return {
    lines: () => buffer.split("\n").filter((line) => line.trim() !== ""),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

// ===========================================================================
// P3-S4.1 — MANAGED session: conversational reads refused; development work
// allowed.
// ===========================================================================

test("P3-S4 managed: conversational reads are refused with the L19 refusal while dev/build/release work succeeds", async () => {
  const ctx = await makeCtx("managed", { marker: SESSION_ID });
  try {
    const refused: Array<[string, Record<string, unknown>]> = [
      ["bash", { command: "gh issue view 5" }],
      ["bash", { command: "gh pr view 3 --comments" }],
      ["bash", { command: "gh api repos/o/r/issues" }],
      ["webfetch", { url: "https://github.com/o/r/issues/5" }],
    ];
    for (const [tool, args] of refused) {
      await expectDeny(() => invoke(ctx, tool, args), `${tool} ${JSON.stringify(args)}`);
    }

    const allowed: Array<[string, Record<string, unknown>]> = [
      ["bash", { command: "git commit -m msg" }],
      ["bash", { command: "git fetch origin" }],
      ["bash", { command: "git push" }],
      ["bash", { command: "curl -L https://github.com/o/r/releases/download/v1/a.tgz" }],
      ["bash", { command: "npm test" }],
      ["bash", { command: "npm run build" }],
      ["bash", { command: "cargo test" }],
    ];
    for (const [tool, args] of allowed) {
      await expectAllow(() => invoke(ctx, tool, args), `${tool} ${JSON.stringify(args)}`);
    }
  } finally {
    ctx.cleanup();
  }
});

// ===========================================================================
// P3-S4.2 — UNMANAGED session: the same conversational reads are not refused.
// ===========================================================================

test("P3-S4 unmanaged (marker absent): conversational reads are not refused", async () => {
  const ctx = await makeCtx("unmanaged", { marker: null });
  try {
    const reads: Array<[string, Record<string, unknown>]> = [
      ["bash", { command: "gh issue view 5" }],
      ["bash", { command: "gh pr view 3 --comments" }],
      ["bash", { command: "gh api repos/o/r/issues" }],
      ["webfetch", { url: "https://github.com/o/r/issues/5" }],
    ];
    for (const [tool, args] of reads) {
      await expectAllow(() => invoke(ctx, tool, args), `${tool} ${JSON.stringify(args)}`);
    }
  } finally {
    ctx.cleanup();
  }
});

// ===========================================================================
// P3-S4.3 — absent / unreadable registry: completely inert (no throw, no log).
// DD §9.5 outranks the plan's loose grouping.
// ===========================================================================

test("P3-S4 absent registry: inert for a conversational read with zero records", async () => {
  const stderr = captureStderr();
  try {
    const ctx = await makeCtx("absent-registry", {
      marker: null,
      registry: "absent",
    });
    try {
      await expectAllow(
        () => invoke(ctx, "bash", { command: "gh issue view 5" }),
        "absent registry",
      );
      assert.equal(stderr.lines().length, 0, "absent registry must not log");
    } finally {
      ctx.cleanup();
    }
  } finally {
    stderr.restore();
  }
});

test("P3-S4 unreadable registry (ENOTDIR): inert for a conversational read with zero records", async () => {
  const stderr = captureStderr();
  try {
    const ctx = await makeCtx("file-registry", { registry: "file" });
    try {
      await expectAllow(
        () => invoke(ctx, "bash", { command: "gh api repos/o/r/issues" }),
        "unreadable registry",
      );
      assert.equal(stderr.lines().length, 0, "unreadable registry must not log");
    } finally {
      ctx.cleanup();
    }
  } finally {
    stderr.restore();
  }
});

// ===========================================================================
// P3-S4.4 — unknown tool (plain no-op) and malformed args (one record each).
// ===========================================================================

test("P3-S4 unknown tools are a plain no-op (no record)", async () => {
  const ctx = await makeCtx("unknown-tool", { marker: SESSION_ID });
  const stderr = captureStderr();
  try {
    for (const tool of ["read", "edit", "grep"]) {
      const before = stderr.lines().length;
      await expectAllow(
        () => invoke(ctx, tool, { filePath: "src/app.ts" }),
        `unknown tool ${tool}`,
      );
      assert.equal(
        stderr.lines().length,
        before,
        `unknown tool ${tool} must not log a record`,
      );
    }
  } finally {
    stderr.restore();
    ctx.cleanup();
  }
});

test("P3-S4 malformed args are no-ops with exactly one record each", async () => {
  const ctx = await makeCtx("malformed-args", { marker: SESSION_ID });
  const stderr = captureStderr();
  try {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["bash", { command: 123 }],
      ["webfetch", { url: { not: "a string" } }],
    ];
    for (const [tool, args] of cases) {
      const before = stderr.lines().length;
      await expectAllow(() => invoke(ctx, tool, args), `malformed ${tool}`);
      assert.equal(
        stderr.lines().length - before,
        1,
        "malformed args must write exactly one structured record",
      );
    }
  } finally {
    stderr.restore();
    ctx.cleanup();
  }
});

// ===========================================================================
// P3-S4.5 — load beacon: atomic write with exactly seven documented fields.
// ===========================================================================

test("P3-S4 beacon: plugin-loaded.json has exactly the seven documented fields and no leftover temp file", async () => {
  const stderr = captureStderr();
  try {
    const ctx = await makeCtx("beacon", { marker: SESSION_ID });
    try {
      // A successful beacon write emits no record.
      assert.equal(
        stderr.lines().length,
        0,
        "a successful beacon write must not log",
      );

      const beaconPath = join(ctx.moderationDir, "plugin-loaded.json");
      const beacon = JSON.parse(readFileSync(beaconPath, "utf8")) as Record<
        string,
        unknown
      >;

      assert.deepEqual(
        Object.keys(beacon).sort(),
        [
          "kind",
          "loadedAt",
          "nonce",
          "pid",
          "pluginSha256",
          "pluginVersion",
          "serverStartedAt",
        ],
        "beacon must carry exactly the seven documented fields",
      );
      assert.equal(beacon.kind, "loaded");

      const pluginUrl = new URL(
        "../../plugin/tissue-moderation.ts",
        import.meta.url,
      );
      const expectedSha = createHash("sha256")
        .update(readFileSync(pluginUrl))
        .digest("hex");
      assert.equal(
        beacon.pluginSha256,
        expectedSha,
        "pluginSha256 must be the SHA-256 of the on-disk plugin source",
      );

      assert.equal(typeof beacon.pluginVersion, "string");
      assert.ok(
        (beacon.pluginVersion as string).length > 0,
        "pluginVersion must be a non-empty string",
      );

      assert.equal(typeof beacon.loadedAt, "number");
      assert.equal(typeof beacon.serverStartedAt, "number");
      assert.ok(Number.isFinite(beacon.loadedAt as number), "loadedAt finite");
      assert.ok(
        Number.isFinite(beacon.serverStartedAt as number),
        "serverStartedAt finite",
      );
      assert.ok(
        (beacon.serverStartedAt as number) <= (beacon.loadedAt as number),
        "serverStartedAt <= loadedAt",
      );
      const delta =
        (beacon.loadedAt as number) - (beacon.serverStartedAt as number);
      assert.ok(
        Math.abs(delta - process.uptime() * 1000) < 60_000,
        "loadedAt - serverStartedAt must approximate process.uptime()*1000",
      );

      assert.equal(beacon.pid, process.pid);
      assert.equal(typeof beacon.nonce, "string");
      assert.ok(
        (beacon.nonce as string).length > 0,
        "nonce must be a non-empty string",
      );

      assert.deepEqual(
        readdirSync(ctx.moderationDir).sort(),
        ["plugin-loaded.json"],
        "no leftover temp file may remain in the moderation directory",
      );
    } finally {
      ctx.cleanup();
    }
  } finally {
    stderr.restore();
  }
});

// ===========================================================================
// P3-S4.6 — beacon write failure: moderation is not disabled, nothing throws.
// ===========================================================================

test("P3-S4 beacon failure: factory resolves and hooks keep working", async () => {
  const stderr = captureStderr();
  try {
    const ctx = await makeCtx("beacon-failure", {
      marker: SESSION_ID,
      moderation: "conflict",
    });
    try {
      // The failed beacon write is observable as exactly one structured
      // failure record, and the failed atomic write must not leave a sibling
      // temporary file behind.
      const beaconFailureRecords = stderr.lines();
      assert.equal(beaconFailureRecords.length, 1, "beacon failure must log exactly one record");
      const beaconFailure = JSON.parse(beaconFailureRecords[0] as string) as Record<string, unknown>;
      assert.equal(beaconFailure.rule, "beacon-write-failed");
      assert.equal(beaconFailure.tool, "plugin");
      assert.equal(beaconFailure.sessionID, "unknown");
      assert.equal(beaconFailure.target, "unavailable");
      assert.deepEqual(
        readdirSync(ctx.moderationDir).sort(),
        ["plugin-loaded.json"],
        "beacon failure must clean up its temporary sibling file",
      );

      assert.equal(typeof ctx.hooks["tool.execute.before"], "function");
      await expectDeny(
        () => invoke(ctx, "bash", { command: "gh issue view 5" }),
        "moderation must keep working when the beacon write fails",
      );
    } finally {
      ctx.cleanup();
    }
  } finally {
    stderr.restore();
  }
});

// ===========================================================================
// P3-S5 — verbatim refusal + no-secrets log record.
// ===========================================================================

test("P3-S5 refusal is the verbatim L19 sentence and the block log carries no secrets", async () => {
  const priorToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = SENTINEL;
  const ctx = await makeCtx("refusal-secrets", { marker: SESSION_ID });
  const stderr = captureStderr();
  try {
    let message = "";
    await assert.rejects(
      () => invoke(ctx, "bash", { command: "gh issue view 5" }),
      (err: unknown) => {
        message = err instanceof Error ? err.message : String(err);
        return true;
      },
      "a positive match must reject",
    );

    // Verbatim, single-line, character-for-character.
    assert.ok(
      message.includes(REFUSAL_SENTENCE),
      "refusal must contain the verbatim L19 sentence",
    );
    assert.ok(!message.includes("\n"), "refusal must be a single line");
    for (const forbidden of ["command not found", "ENOENT", "not found"]) {
      assert.ok(
        !message.includes(forbidden),
        `refusal must not look like a missing-command/environment failure (${forbidden})`,
      );
    }

    // Exactly one structured record carrying the required diagnostic fields.
    const lines = stderr.lines();
    assert.equal(lines.length, 1, "a block must write exactly one record");
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(typeof record.ts, "string");
    assert.equal(record.sessionID, SESSION_ID);
    assert.equal(record.tool, "bash");
    assert.equal(typeof record.rule, "string");
    assert.ok((record.rule as string).length > 0, "rule must be present");
    assert.equal(typeof record.target, "string");
     assert.equal(record.target, "gh issue view");

    // No secret material anywhere in the captured log output.
    const all = lines.join("\n");
    assert.ok(!all.includes(SENTINEL), "log output must never contain secret material");
  } finally {
    stderr.restore();
    ctx.cleanup();
    restoreEnv("GITHUB_TOKEN", priorToken);
  }
});

// ===========================================================================
// P5-S1 — Phase 5 security/boundary regressions (spec-first RED).
//
//   * L-SEC-TMP-001: a symlink planted at the exact temporary beacon path the
//     implementation is about to open must not be followed; the symlink target
//     sentinel stays unchanged and no beacon is published.
//   * L-BEACON-CLEANUP-001: a write failure after temporary creation must
//     remove the temporary file, log exactly one failure, and publish nothing.
//     Success and rename-failure remain clean (also pinned by P3-S4).
//   * L-REGISTRY-ENV-001: relative, explicitly-empty, and unsupported
//     `TISSUE_SESSION_REGISTRY_DIR` values are invalid, stay UNMANAGED, and are
//     completely inert even when a `ses_*` marker is reachable in the
//     accidentally resolved path.
//   * L-SEC-LOG-001: beacon failure never leaks credential material.
//
// Deterministic interception: `process.getBuiltinModule("node:fs")` is
// temporarily replaced with a patched view so the symlink is planted at the
// captured temp path immediately before the real builtin op delegates and the
// write failure is thrown from the wrapped op — no timing, sleeps, or guessed
// filename. `statSync` is overridden to simulate a reachable marker for the
// empty/unsupported registry values. Always restored in a `finally`.
// ===========================================================================

type NodeFs = typeof import("node:fs");

function withFsPatch<T>(
  patch: (patched: Record<string, unknown>, real: NodeFs) => void,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  const originalGet = process.getBuiltinModule;
  const realFs = (originalGet as (id: string) => unknown)("node:fs") as NodeFs;
  const patched = Object.create(realFs) as Record<string, unknown>;
  patch(patched, realFs);
  (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule = (
    id: string,
  ) => (id === "node:fs" ? patched : (originalGet as (id: string) => unknown)(id));
  const restore = (): void => {
    (process as unknown as { getBuiltinModule: typeof originalGet }).getBuiltinModule =
      originalGet;
  };
  try {
    const result = fn();
    if (result !== null && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(restore);
    }
    restore();
    return result as T;
  } catch (error) {
    restore();
    throw error;
  }
}

/** The beacon writer's temporary sibling path (dot-prefixed, named after the beacon). */
function isBeaconTempPath(candidate: unknown): candidate is string {
  if (typeof candidate !== "string") return false;
  const slash = candidate.lastIndexOf("/");
  const base = slash === -1 ? candidate : candidate.slice(slash + 1);
  return base.startsWith(".") && base.includes("plugin-loaded.json");
}

function invokeHook(
  hooks: { "tool.execute.before": BeforeHook },
  tool: string,
  args: Record<string, unknown>,
  sessionID: string = SESSION_ID,
): Promise<void> {
  return Promise.resolve(
    hooks["tool.execute.before"]({ tool, sessionID, callID: "call_p5" }, { args }),
  );
}

/** Build a plugin context with an arbitrary registry-dir env value. */
async function makeManualCtx(
  tag: string,
  registryValue: string,
): Promise<{
  hooks: { "tool.execute.before": BeforeHook };
  moderationDir: string;
  cleanup: () => void;
}> {
  const root = makeTemp(tag);
  const moderationDir = join(root, "moderation");
  mkdirSync(moderationDir, { recursive: true });
  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryValue;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  try {
    const hooks = (await TissueModeration({})) as unknown as {
      "tool.execute.before": BeforeHook;
    };
    return {
      hooks,
      moderationDir,
      cleanup: () => {
        restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
        restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (err) {
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

test("P5-S1 L-REGISTRY-ENV-001: a relative registry dir is invalid and inert despite a reachable marker", async () => {
  const markerRoot = makeTemp("p5-registry-relative-markers");
  const markerDir = join(markerRoot, "registry");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, SESSION_ID), "", "utf8");
  const relativeValue = relative(process.cwd(), markerDir);
  assert.notEqual(relativeValue, "", "fixture sanity: a non-empty relative path is constructed");
  const stderr = captureStderr();
  const ctx = await makeManualCtx("p5-registry-relative", relativeValue);
  try {
    await expectAllow(
      () => invokeHook(ctx.hooks, "bash", { command: "gh issue view 5" }),
      "relative registry dir",
    );
    assert.equal(stderr.lines().length, 0, "an invalid registry dir must not log");
    assert.equal(
      stderr.lines().some((line) => line.includes(REFUSAL_SENTENCE)),
      false,
      "an invalid registry dir must not refuse",
    );
  } finally {
    stderr.restore();
    ctx.cleanup();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

test("P5-S1 L-REGISTRY-ENV-001: an explicitly empty registry dir is invalid and inert", async () => {
  const stderr = captureStderr();
  try {
    await withFsPatch(
      (patched) => {
        patched.statSync = () => ({ isFile: () => true, isDirectory: () => true });
      },
      async () => {
        const ctx = await makeManualCtx("p5-registry-empty", "");
        try {
          await expectAllow(
            () => invokeHook(ctx.hooks, "bash", { command: "gh issue view 5" }),
            "empty registry dir",
          );
          assert.equal(stderr.lines().length, 0, "an empty registry dir must not log");
        } finally {
          ctx.cleanup();
        }
      },
    );
  } finally {
    stderr.restore();
  }
});

test("P5-S1 L-REGISTRY-ENV-001: an unsupported registry dir value is invalid and inert", async () => {
  const markerRoot = makeTemp("p5-registry-unsupported-markers");
  const markerDir = join(markerRoot, "registry");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, SESSION_ID), "", "utf8");
  const unsupportedValue = `file://${markerDir}`;
  const stderr = captureStderr();
  try {
    await withFsPatch(
      (patched) => {
        patched.statSync = () => ({ isFile: () => true, isDirectory: () => true });
      },
      async () => {
        const ctx = await makeManualCtx("p5-registry-unsupported", unsupportedValue);
        try {
          await expectAllow(
            () => invokeHook(ctx.hooks, "bash", { command: "gh issue view 5" }),
            "unsupported registry dir",
          );
          assert.equal(stderr.lines().length, 0, "an unsupported registry dir must not log");
        } finally {
          ctx.cleanup();
        }
      },
    );
  } finally {
    stderr.restore();
    rmSync(markerRoot, { recursive: true, force: true });
  }
});

test("P5-S1 L-SEC-TMP-001: a symlink planted at the beacon temp path is refused and its target is unchanged", async () => {
  const root = makeTemp("p5-beacon-symlink");
  const registryDir = join(root, "registry");
  const moderationDir = join(root, "moderation");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(moderationDir, { recursive: true });
  writeFileSync(join(registryDir, SESSION_ID), "", "utf8");
  const sentinelPath = join(root, "sentinel.txt");
  const sentinelContent = "SENTINEL-MUST-NOT-CHANGE";
  writeFileSync(sentinelPath, sentinelContent, "utf8");

  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const stderr = captureStderr();
  try {
    await withFsPatch(
      (patched, realFs) => {
        const plant = (candidate: unknown): void => {
          if (!isBeaconTempPath(candidate)) return;
          try {
            realFs.symlinkSync(sentinelPath, candidate);
          } catch {
            /* the exact temp path may already be planted by a prior op */
          }
        };
        patched.openSync = function (path: unknown, ...rest: unknown[]): unknown {
          plant(path);
          return (realFs.openSync as unknown as (...a: unknown[]) => unknown)(path, ...rest);
        };
        patched.writeFileSync = function (path: unknown, ...rest: unknown[]): unknown {
          plant(path);
          return (realFs.writeFileSync as unknown as (...a: unknown[]) => unknown)(path, ...rest);
        };
      },
      async () => {
        await TissueModeration({});
        assert.equal(
          readFileSync(sentinelPath, "utf8"),
          sentinelContent,
          "the planted symlink target must remain unchanged",
        );
        assert.equal(
          readdirSync(moderationDir).includes("plugin-loaded.json"),
          false,
          "no beacon may be published through a planted symlink",
        );
        const lines = stderr.lines();
        assert.equal(lines.length, 1, "exactly one beacon-write-failed record");
        const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
        assert.equal(record.rule, "beacon-write-failed");
        assert.equal(record.tool, "plugin");
        assert.equal(record.sessionID, "unknown");
        assert.equal(record.target, "unavailable");
      },
    );
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5-S1 L-BEACON-CLEANUP-001: a write failure after temp creation removes the temp and logs exactly one failure", async () => {
  const root = makeTemp("p5-beacon-write-failure");
  const registryDir = join(root, "registry");
  const moderationDir = join(root, "moderation");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(moderationDir, { recursive: true });
  writeFileSync(join(registryDir, SESSION_ID), "", "utf8");

  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const stderr = captureStderr();
  try {
    await withFsPatch(
      (patched, realFs) => {
        patched.openSync = function (path: unknown, ...rest: unknown[]): unknown {
          return (realFs.openSync as unknown as (...a: unknown[]) => unknown)(path, ...rest);
        };
        patched.writeSync = function (fd: unknown, ...rest: unknown[]): unknown {
          if (typeof fd === "number") throw new Error("injected-write-failure");
          return (realFs.writeSync as unknown as (...a: unknown[]) => unknown)(fd, ...rest);
        };
      },
      async () => {
        await TissueModeration({});
        const names = readdirSync(moderationDir);
        assert.equal(
          names.includes("plugin-loaded.json"),
          false,
          "no final beacon may be published after a write failure",
        );
        assert.deepEqual(names, [], "the temporary file must be removed on write failure");
        const lines = stderr.lines();
        assert.equal(lines.length, 1, "a write failure must log exactly one record");
        const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
        assert.equal(record.rule, "beacon-write-failed");
      },
    );
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P5-S1 L-BEACON-CLEANUP-001: beacon success publishes and rename failure cleans up", async () => {
  const stderr = captureStderr();
  try {
    const success = await makeCtx("p5-beacon-success", { marker: SESSION_ID });
    try {
      assert.deepEqual(
        readdirSync(success.moderationDir).sort(),
        ["plugin-loaded.json"],
        "a successful beacon write publishes exactly the final file",
      );
      assert.equal(stderr.lines().length, 0, "a successful beacon write must not log");
    } finally {
      success.cleanup();
    }

    const conflict = await makeCtx("p5-beacon-rename-failure", {
      marker: SESSION_ID,
      moderation: "conflict",
    });
    try {
      assert.deepEqual(
        readdirSync(conflict.moderationDir).sort(),
        ["plugin-loaded.json"],
        "a rename failure must leave only the pre-existing final path",
      );
      const lines = stderr.lines();
      assert.equal(lines.length, 1, "a rename failure must log exactly one record");
      const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
      assert.equal(record.rule, "beacon-write-failed");
      assert.equal(record.target, "unavailable");
    } finally {
      conflict.cleanup();
    }
  } finally {
    stderr.restore();
  }
});

test("P5-S1 L-SEC-LOG-001: a beacon failure never leaks credential material", async () => {
  const priorToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghp_" + "BeaconSecretSentinel";
  const secret = process.env.GITHUB_TOKEN;
  const stderr = captureStderr();
  try {
    const ctx = await makeCtx("p5-beacon-credential", {
      marker: SESSION_ID,
      moderation: "conflict",
    });
    try {
      const lines = stderr.lines();
      assert.equal(lines.length, 1, "a beacon failure must log exactly one record");
      const all = lines.join("\n");
      assert.equal(all.includes(secret), false, "the beacon failure record must not leak credentials");
      assert.equal(all.includes("user:pass"), false, "the beacon failure record must not leak credentials");
      const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
      assert.equal(record.rule, "beacon-write-failed");
      assert.equal(record.target, "unavailable");
    } finally {
      ctx.cleanup();
    }
  } finally {
    stderr.restore();
    restoreEnv("GITHUB_TOKEN", priorToken);
  }
});


// ===========================================================================
// QA round 3 — surviving fail-open paths for managed-session hook inputs.
// ===========================================================================

test("QA round 3 classifySession: malformed session IDs stay unmanaged and inert", async () => {
  const stderr = captureStderr();
  const ctx = await makeCtx("invalid-session-id", { marker: SESSION_ID });
  try {
    for (const sessionID of ["ses_", "session_123", "ses_bad-id"]) {
      await expectAllow(
        () => invoke(ctx, "bash", { command: "gh issue view 5" }, sessionID),
        `invalid session ID ${sessionID}`,
      );
    }
    assert.equal(
      stderr.lines().length,
      0,
      "malformed session IDs must bypass moderation without logging",
    );
  } finally {
    ctx.cleanup();
    stderr.restore();
  }
});

test("QA round 3 webfetch: malformed URLs fail open without logging in a managed session", async () => {
  const stderr = captureStderr();
  const ctx = await makeCtx("malformed-webfetch-url", { marker: SESSION_ID });
  try {
    for (const url of ["https://", "not a url"]) {
      await expectAllow(
        () => invoke(ctx, "webfetch", { url }),
        `malformed webfetch URL ${url}`,
      );
    }
    assert.equal(
      stderr.lines().length,
      0,
      "unparseable webfetch URLs must fail open without logging",
    );
  } finally {
    ctx.cleanup();
    stderr.restore();
  }
});

// ===========================================================================
// P6-S1 — residual security regressions (spec-first RED).
// ===========================================================================

const P6_REGISTRY_VALUES = [
  "relative-registry",
  "",
  "/run/tissue-session-registry",
  "/tmp/tissue/\u0001registry",
  "/tmp/../tmp/tissue-session-registry",
] as const;

test("P6-S1 L-REGISTRY-ENV-001: every invalid explicit registry value stays inert", async () => {
  const stderr = captureStderr();
  try {
    for (const [index, registryValue] of P6_REGISTRY_VALUES.entries()) {
      await withFsPatch(
        (patched) => {
          patched.statSync = () => ({ isFile: () => true, isDirectory: () => true });
        },
        async () => {
          const ctx = await makeManualCtx(`p6-registry-invalid-${index}`, registryValue);
          try {
            await expectAllow(
              () => invokeHook(ctx.hooks, "bash", { command: "gh issue view 5" }),
              `invalid registry value ${JSON.stringify(registryValue)}`,
            );
            assert.equal(stderr.lines().length, 0, "invalid registry must be completely inert");
          } finally {
            ctx.cleanup();
          }
        },
      );
    }
  } finally {
    stderr.restore();
  }
});

test("P6-S1 L-FS-MODERATION-DIR-001: invalid moderation directories publish no beacon and do not touch outside", async () => {
  const root = makeTemp("p6-moderation-dir");
  const registryDir = join(root, "registry");
  const outside = join(root, "outside");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(registryDir, SESSION_ID), "", "utf8");
  writeFileSync(join(outside, "sentinel"), "unchanged", "utf8");
  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  const invalidValues = [
    "relative-moderation",
    "",
    `${outside}/../outside`,
    "/tmp/../tmp/tissue-moderation",
  ];
  try {
    for (const [index, value] of invalidValues.entries()) {
      const dedicatedOutside = join(outside, `case-${index}`);
      mkdirSync(dedicatedOutside, { recursive: true });
      process.env.TISSUE_MODERATION_DIR = value;
      const before = readdirSync(dedicatedOutside);
      await TissueModeration({});
      assert.deepEqual(readdirSync(dedicatedOutside), before, `invalid value ${JSON.stringify(value)} must not publish outside`);
      assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "unchanged");
    }
  } finally {
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});

// The contract permits the absent-env default `/tissue-moderation`. Redirect
// only that absolute path through the fs seam so this test never writes to a
// live/shared mount while still proving the plugin requested the pinned default.
test("P6-S1 default moderation dir: absent env publishes the seven-field beacon without logging", async () => {
  const root = makeTemp("p6-moderation-default");
  const registryDir = join(root, "registry");
  const redirectedDir = join(root, "redirected-default");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(redirectedDir, { recursive: true });
  writeFileSync(join(registryDir, SESSION_ID), "", "utf8");

  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  delete process.env.TISSUE_MODERATION_DIR;
  const stderr = captureStderr();
  const requestedPaths: string[] = [];
  const redirect = (candidate: unknown): unknown => {
    if (typeof candidate !== "string") return candidate;
    if (!candidate.startsWith("/tissue-moderation/")) return candidate;
    requestedPaths.push(candidate);
    return join(redirectedDir, candidate.slice("/tissue-moderation/".length));
  };

  try {
    await withFsPatch(
      (patched, realFs) => {
        patched.mkdirSync = (path: unknown, ...rest: unknown[]): unknown =>
          (realFs.mkdirSync as unknown as (...args: unknown[]) => unknown)(redirect(path), ...rest);
        patched.openSync = (path: unknown, ...rest: unknown[]): unknown =>
          (realFs.openSync as unknown as (...args: unknown[]) => unknown)(redirect(path), ...rest);
        patched.writeSync = (fd: unknown, ...rest: unknown[]): unknown =>
          (realFs.writeSync as unknown as (...args: unknown[]) => unknown)(fd, ...rest);
        patched.closeSync = (fd: unknown): unknown => realFs.closeSync(fd as number);
        patched.lstatSync = (path: unknown, ...rest: unknown[]): unknown =>
          (realFs.lstatSync as unknown as (...args: unknown[]) => unknown)(redirect(path), ...rest);
        patched.renameSync = (oldPath: unknown, newPath: unknown): unknown =>
           (realFs.renameSync as unknown as (...args: unknown[]) => unknown)(
             redirect(oldPath),
             redirect(newPath),
           );
      },
      async () => {
        await TissueModeration({});
        assert.ok(
          requestedPaths.length >= 2,
          "default beacon publication must access the pinned /tissue-moderation path",
        );
        assert.ok(
          requestedPaths.every((path) => path.startsWith("/tissue-moderation/")),
          "all redirected beacon paths must use the pinned default directory",
        );

        const beaconPath = join(redirectedDir, "plugin-loaded.json");
        const beacon = JSON.parse(readFileSync(beaconPath, "utf8")) as Record<string, unknown>;
        assert.deepEqual(Object.keys(beacon).sort(), [
          "kind",
          "loadedAt",
          "nonce",
          "pid",
          "pluginSha256",
          "pluginVersion",
          "serverStartedAt",
        ]);
        assert.equal(beacon.kind, "loaded");
        assert.equal(typeof beacon.pluginSha256, "string");
        assert.equal(typeof beacon.pluginVersion, "string");
        assert.equal(typeof beacon.loadedAt, "number");
        assert.equal(typeof beacon.serverStartedAt, "number");
        assert.equal(beacon.pid, process.pid);
        assert.equal(typeof beacon.nonce, "string");
        assert.deepEqual(readdirSync(redirectedDir).sort(), ["plugin-loaded.json"]);
        assert.equal(stderr.lines().length, 0, "a successful default beacon write must not log");
      },
    );
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});


// ===========================================================================
// P8-S1 — beacon integrity regressions (spec-first RED).
// ===========================================================================

test("P8-S1 short beacon writes fail closed without publication or leftovers", async () => {
  const root = makeTemp("p8-short-write");
  const registryDir = join(root, "registry");
  const moderationDir = join(root, "moderation");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(moderationDir, { recursive: true });
  writeFileSync(join(registryDir, SESSION_ID), "", "utf8");
  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const stderr = captureStderr();
  try {
    await withFsPatch((patched, realFs) => {
      patched.writeSync = function (fd: unknown, ...rest: unknown[]): unknown {
        const result = (realFs.writeSync as unknown as (...args: unknown[]) => number)(fd, ...rest);
        return Math.max(0, result - 1);
      };
    }, async () => { await TissueModeration({}); });
    assert.equal(readdirSync(moderationDir).includes("plugin-loaded.json"), false);
    assert.deepEqual(readdirSync(moderationDir), []);
    assert.equal(stderr.lines().length, 1);
    assert.equal((JSON.parse(stderr.lines()[0] as string) as Record<string, unknown>).rule, "beacon-write-failed");
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P8-S1 beacon temp replacement between close and rename fails closed", async () => {
  const root = makeTemp("p8-race");
  const registryDir = join(root, "registry");
  const moderationDir = join(root, "moderation");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(moderationDir, { recursive: true });
  writeFileSync(join(registryDir, SESSION_ID), "", "utf8");
  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const stderr = captureStderr();
  try {
    await withFsPatch((patched, realFs) => {
      let temp: string | undefined;
      patched.openSync = function (path: unknown, ...rest: unknown[]): unknown {
        temp = typeof path === "string" && isBeaconTempPath(path) ? path : temp;
        return (realFs.openSync as unknown as (...args: unknown[]) => unknown)(path, ...rest);
      };
      patched.renameSync = function (from: unknown, to: unknown): unknown {
        if (typeof from === "string" && from === temp) {
          realFs.unlinkSync(from);
          realFs.symlinkSync(join(root, "outside"), from);
        }
        return (realFs.renameSync as unknown as (...args: unknown[]) => unknown)(from, to);
      };
    }, async () => { await TissueModeration({}); });
    assert.equal(readdirSync(moderationDir).includes("plugin-loaded.json"), false);
    assert.equal(stderr.lines().length, 1);
    assert.equal((JSON.parse(stderr.lines()[0] as string) as Record<string, unknown>).rule, "beacon-write-failed");
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});


// ===========================================================================
// P9-S1 — beacon publication identity replacement regression (RED).
// ===========================================================================

test("P9-S1 beacon replacement after verification fails closed without publishing substituted content", async () => {
  const root = makeTemp("p9-beacon-identity");
  const registryDir = join(root, "registry");
  const moderationDir = join(root, "moderation");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(moderationDir, { recursive: true });
  writeFileSync(join(registryDir, SESSION_ID), "", "utf8");
  const outsidePayload = join(root, "outside-payload.json");
  writeFileSync(outsidePayload, JSON.stringify({ substituted: true }), "utf8");
  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const stderr = captureStderr();
  try {
    await withFsPatch((patched, realFs) => {
      let temp: string | undefined;
      patched.openSync = function (path: unknown, ...rest: unknown[]): unknown {
        temp = typeof path === "string" && isBeaconTempPath(path) ? path : temp;
        return (realFs.openSync as unknown as (...a: unknown[]) => unknown)(path, ...rest);
      };
      patched.renameSync = function (from: unknown, to: unknown): unknown {
        if (typeof from === "string" && from === temp) {
          realFs.unlinkSync(from);
          realFs.copyFileSync(outsidePayload, from);
        }
        return (realFs.renameSync as unknown as (...a: unknown[]) => unknown)(from, to);
      };
    }, async () => { await TissueModeration({}); });
    assert.equal(readdirSync(moderationDir).includes("plugin-loaded.json"), false);
    assert.deepEqual(readdirSync(moderationDir), []);
    const lines = stderr.lines();
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0] as string) as Record<string, unknown>).rule, "beacon-write-failed");
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});


// ===========================================================================
// P10-S1 — beacon identity, cleanup, concurrency, and directory-boundary RED.
// ===========================================================================

test("P10-S1 beacon preserves foreign final path and refuses moderation-dir symlink/ancestor replacement", async () => {
  const root = makeTemp("p10-beacon-boundary");
  const registryDir = join(root, "registry");
  const moderationDir = join(root, "moderation");
  const outside = join(root, "outside");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(moderationDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(registryDir, SESSION_ID), "", "utf8");
  writeFileSync(join(moderationDir, ".plugin-loaded.json.foreign.tmp"), "foreign", "utf8");
  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const stderr = captureStderr();
  try {
    await TissueModeration({});
    assert.equal(readFileSync(join(moderationDir, ".plugin-loaded.json.foreign.tmp"), "utf8"), "foreign");
    const link = join(root, "moderation-link");
    try { symlinkSync(outside, link); } catch { /* platform fixture */ }
    process.env.TISSUE_MODERATION_DIR = link;
    await TissueModeration({});
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(stderr.lines().length, 1);
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P10-S1 beacon refuses an ancestor replaced by a symlink after validation without touching outside", async () => {
  const root = makeTemp("p10-beacon-ancestor-race");
  const registryDir = join(root, "registry");
  const ancestor = join(root, "moderation-parent");
  const moderationDir = join(ancestor, "moderation");
  const outside = join(root, "outside");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(moderationDir, { recursive: true });
  mkdirSync(join(outside, "moderation"), { recursive: true });
  writeFileSync(join(registryDir, SESSION_ID), "", "utf8");
  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const stderr = captureStderr();
  try {
    await withFsPatch((patched, realFs) => {
      let replaced = false;
      patched.lstatSync = function (path: unknown, ...rest: unknown[]): unknown {
        const result = (realFs.lstatSync as unknown as (...args: unknown[]) => unknown)(path, ...rest);
        if (!replaced && path === moderationDir) {
          replaced = true;
          renameSync(ancestor, join(root, "moderation-parent-moved"));
          symlinkSync(outside, ancestor);
        }
        return result;
      };
    }, async () => {
      await TissueModeration({});
      assert.deepEqual(readdirSync(join(outside, "moderation")), [], "ancestor replacement must not write outside");
      assert.equal(readdirSync(moderationDir).length, 0, "no beacon may be published through the replaced ancestor");
      assert.equal(stderr.lines().length, 1, "ancestor replacement must log exactly one safe failure");
      const record = JSON.parse(stderr.lines()[0] as string) as Record<string, unknown>;
      assert.equal(record.rule, "beacon-write-failed");
      assert.equal(record.target, "unavailable");
    });
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P10-S1 concurrent beacon factories publish one valid identity-bound beacon and clean siblings", async () => {
  const root = makeTemp("p10-beacon-concurrent");
  const registryDir = join(root, "registry");
  const moderationDir = join(root, "moderation");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(moderationDir, { recursive: true });
  writeFileSync(join(registryDir, SESSION_ID), "", "utf8");
  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const stderr = captureStderr();
  try {
    await Promise.all(Array.from({ length: 8 }, () => TissueModeration({})));
    const names = readdirSync(moderationDir);
    assert.equal(names.filter((name) => name === "plugin-loaded.json").length, 1);
    assert.equal(names.some((name) => name.endsWith(".tmp")), false);
    const beacon = JSON.parse(readFileSync(join(moderationDir, "plugin-loaded.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(beacon).sort(), [
      "kind", "loadedAt", "nonce", "pid", "pluginSha256", "pluginVersion", "serverStartedAt",
    ]);
    assert.equal(beacon.kind, "loaded");
    assert.equal(beacon.pluginSha256, createHash("sha256").update(readFileSync(new URL("../../plugin/tissue-moderation.ts", import.meta.url))).digest("hex"));
    assert.equal(typeof beacon.pluginVersion, "string");
    assert.equal(typeof beacon.loadedAt, "number");
    assert.equal(typeof beacon.serverStartedAt, "number");
    assert.equal(beacon.pid, process.pid);
    assert.equal(typeof beacon.nonce, "string");
    assert.ok((beacon.nonce as string).length > 0);
    assert.equal(stderr.lines().length <= 7, true);
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});
