// tests/integration/p6-matcher.test.ts
//
// Phase 1 (plan L, spec-first) specification for the GitHub moderation plugin
// matcher (`plugin/tissue-moderation.ts`, plan L). This file is written BEFORE
// the plugin exists: every specification below is expected to fail on
// import/module-resolution (RED) until Phase 2 implements the plugin. A
// specification that passes before implementation is reported, never silently
// weakened.
//
// ---------------------------------------------------------------------------
// NORMATIVE FIXTURE — single source of truth
// ---------------------------------------------------------------------------
// The single normative acceptance fixture is DD-tissue-container-migration
// §9.3 "Matcher policy and explicit ALLOW/DENY examples" — the family table
// PLUS the eight pinned host-canonicalisation rules PLUS the pinned precedence
// (RA-02). The plan L "Behaviour spec — matcher policy" table restates the
// same fixture and adds no independent authority.
//
// The refiner report's 70-row table is RETAINED AS COVERAGE EVIDENCE ONLY. It
// is explicitly NOT the acceptance fixture (DD §9.3 "Normative fixture
// (PE-03)"). Every refiner row maps onto one of the families below, with one
// deliberate deviation: conversational WRITES (`gh issue comment`,
// `gh pr review`, `gh pr create`) are ALLOW here — deliberate override of
// refiner row 11 (DD §9.3, I3/HQ-B).
//
// ---------------------------------------------------------------------------
// MODULE CONTRACT (plan L; adversarial log IP-5 / SC-8)
// ---------------------------------------------------------------------------
// The plugin has EXACTLY ONE runtime export (`TissueModeration`, a named
// function). The OpenCode 1.18.18 loader invokes every exported function of a
// plugin module (opencode #42451), so exporting helpers can brick the fleet.
// Therefore this file imports ONLY `TissueModeration` and drives the matcher
// entirely through the public surface:
//
//     const hooks = await TissueModeration({});
//     await hooks["tool.execute.before"]({ tool, sessionID, callID }, { args });
//
// ALLOW row  => the hook resolves.
// DENY row   => the hook rejects with the §9.4 refusal message.
//
// The plugin has ZERO imports (not even `node:` builtins) and no throw-capable
// top-level evaluation; types are declared locally in Phase 2, so this file
// only needs the inferred type of the single export. `@opencode-ai/plugin` is
// NOT installed in this workspace and is never imported.
//
// ---------------------------------------------------------------------------
// TWO-STATE CLASSIFICATION (L3/L18 as amended by OWNER AMENDMENT 2)
// ---------------------------------------------------------------------------
//   marker exists               => MANAGED   => moderation applies
//   marker absent or unreadable => UNMANAGED => the plugin is completely inert
// There is NO `.ready`, NO UNKNOWN, NO readiness/freshness/cache state. The env
// seam is `TISSUE_SESSION_REGISTRY_DIR` (default `/tissue-session-registry`) and
// the marker name is the synthetic valid id `ses_TestMatcher0001`. The beacon
// env seam is `TISSUE_MODERATION_DIR`.
//
// ---------------------------------------------------------------------------
// P1-S5 PRECEDENCE (DD §9.5 outranks the plan's loose grouping)
// ---------------------------------------------------------------------------
// DD §9.5: marker-absent / registry-unreadable => UNMANAGED => return
// immediately, COMPLETELY INERT. The "no-op + one log record" contract applies
// to unexpected argument shape, matcher/tokenizer parser error, wrapper-depth
// exceeded, and internal exception; unknown tool is a plain no-op. The
// classifier is exception-total by construction (a single wrapped `statSync`),
// so a "classifier throw" is not injectable through the public surface; its
// observable consequence is tested (absent/unreadable registry => inert).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TissueModeration } from "../../plugin/tissue-moderation.ts";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "ses_TestMatcher0001";

type ToolName = "bash" | "webfetch";
type Args = Record<string, unknown>;

interface HookInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface HookOutput {
  args: Args;
}

type BeforeHook = (input: HookInput, output: HookOutput) => Promise<void> | void;

interface MatcherFixture {
  invoke: (tool: ToolName, args: Args, sessionID?: string) => Promise<void>;
  registryDir: string;
  moderationDir: string;
}

interface Case {
  label: string;
  tool: ToolName;
  args: Args;
}

/** A bash command case. */
function sh(command: string): Case {
  return { label: command, tool: "bash", args: { command } };
}

/** A webfetch URL case. */
function web(url: string): Case {
  return { label: `webfetch ${url}`, tool: "webfetch", args: { url } };
}

const REFUSAL_RE =
  /GitHub conversational content for this automated Tissue session is moderated by Tissue/;

function makeTemp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `tissue-p6-matcher-${tag}-`));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Build a ready-to-drive matcher fixture: a real temp registry directory (with
 * an optional real empty marker file) plus a real temp beacon directory, env
 * seams set, and the single public export constructed with a minimal/empty
 * context object (the factory must tolerate it and must not throw).
 */
async function makeFixture(
  tag: string,
  opts: { markerSessionId?: string | null } = {},
): Promise<{ fixture: MatcherFixture; cleanup: () => void }> {
  const root = makeTemp(tag);
  const registryDir = join(root, "registry");
  const moderationDir = join(root, "moderation");
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(moderationDir, { recursive: true });
  if (opts.markerSessionId !== undefined && opts.markerSessionId !== null) {
    writeFileSync(join(registryDir, opts.markerSessionId), "", "utf8");
  }

  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  try {
    const hooks = (await TissueModeration({})) as unknown as {
      "tool.execute.before": BeforeHook;
    };
    const invoke = async (
      tool: ToolName,
      args: Args,
      sessionID: string = SESSION_ID,
    ): Promise<void> => {
      await hooks["tool.execute.before"](
        { tool, sessionID, callID: "call_p6matcher" },
        { args },
      );
    };
    return {
      fixture: { invoke, registryDir, moderationDir },
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

async function expectAllow(
  invoke: () => Promise<void>,
  label: string,
): Promise<void> {
  await assert.doesNotReject(invoke, `expected ALLOW (resolve, no throw) for: ${label}`);
}

async function expectDeny(
  invoke: () => Promise<void>,
  label: string,
): Promise<void> {
  await assert.rejects(invoke, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, REFUSAL_RE, `expected the §9.4 refusal for: ${label}`);
    return true;
  });
}

async function allowAll(
  cases: readonly Case[],
  invoke: (tool: ToolName, args: Args) => Promise<void>,
): Promise<void> {
  for (const c of cases) await expectAllow(() => invoke(c.tool, c.args), c.label);
}

async function denyAll(
  cases: readonly Case[],
  invoke: (tool: ToolName, args: Args) => Promise<void>,
): Promise<void> {
  for (const c of cases) await expectDeny(() => invoke(c.tool, c.args), c.label);
}

/**
 * Replace `process.stderr.write` for the duration of a fault-injection
 * assertion so the "one structured record per handled fault" contract can be
 * counted. The plugin logs without importing anything, so `process.stderr.write`
 * is the observable seam. Always restored in a `finally`.
 */
function captureStderr(): { lines: () => string[]; restore: () => void } {
  const original = process.stderr.write;
  let buffer = "";
  const spy = ((chunk: unknown): boolean => {
    buffer +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
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

/** Wrap `inner` in `depth` nested `bash -c "..."` payloads. */
function nestShell(depth: number, inner: string): string {
  let command = inner;
  for (let i = 0; i < depth; i += 1) command = `bash -c ${JSON.stringify(command)}`;
  return command;
}

// ===========================================================================
// P1-S1 — file header (above). DD §9.3 + the plan table are the single
// normative fixture; the refiner 70-row table is coverage evidence only.
// ===========================================================================

// ===========================================================================
// P1-S2 — one test per ALLOW/DENY family and per canonicalisation rule.
// ===========================================================================

// --- ALLOW families ---------------------------------------------------------

test("P1-S2 ALLOW family git: git status/commit/fetch/push and a quoted conversational substring", async () => {
  const { fixture, cleanup } = await makeFixture("allow-git", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh("git status"),
        sh("git commit -m x"),
        sh("git fetch"),
        sh("git push"),
        // A conversational phrase inside a git commit message is NOT a match:
        // matcher compares argv, never the raw command substring (SC-6).
        sh('git commit -m "fix gh issue view regression"'),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 ALLOW family gh writes: conversational writes are a deliberate override of refiner row 11", async () => {
  const { fixture, cleanup } = await makeFixture("allow-gh-writes", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh("gh pr create --title x --body y"),
        sh("gh issue comment 5 -b hi"),
        sh("gh pr review 3 --approve"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 ALLOW family gh releases: release view/create/download and release API endpoints", async () => {
  const { fixture, cleanup } = await makeFixture("allow-releases", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh("gh release view"),
        sh("gh release create v1"),
        sh("gh release download v1"),
        sh("gh api repos/o/r/releases"),
        sh("gh api repos/o/r/releases/tags/v1"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 ALLOW family gh search carve-out: search code/repos is not conversation", async () => {
  const { fixture, cleanup } = await makeFixture("allow-search", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [sh('gh search code "term"'), sh("gh search repos cli")],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 ALLOW family gh non-conversational: diff/checks/run/clone/version", async () => {
  const { fixture, cleanup } = await makeFixture("allow-gh-nonconv", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh("gh pr diff 3"),
        sh("gh pr checks 3"),
        sh("gh run view 123 --log"),
        sh("gh repo clone o/r"),
        sh("gh repo view o/r"),
        sh("gh --version"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 ALLOW family gh api REST carve-outs: pulls/<n>/files and pulls/<n>/commits", async () => {
  const { fixture, cleanup } = await makeFixture("allow-api-rest", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [sh("gh api repos/o/r/pulls/3/files"), sh("gh api repos/o/r/pulls/3/commits")],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 ALLOW family quoting: quote/escape-aware splitting keeps quoted gh text inert", async () => {
  const { fixture, cleanup } = await makeFixture("allow-quoting", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [sh('git commit -m "a|b"'), sh('echo "x; gh pr view y"')],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 ALLOW family curl/wget allowed endpoints: releases, archives, tarballs, raw, objects, codeload", async () => {
  const { fixture, cleanup } = await makeFixture("allow-curl", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh("curl -L https://github.com/o/r/releases/download/v1/a.tgz"),
        sh("curl -L https://github.com/o/r/releases"),
        sh("curl -L https://github.com/o/r/archive/refs/heads/main.tar.gz"),
        sh("curl -L https://github.com/o/r/tarball/v1"),
        sh("curl -L https://codeload.github.com/o/r/tar.gz/v1"),
        sh("curl -L https://objects.githubusercontent.com/github-production-release-asset/x"),
        sh("curl -L https://raw.githubusercontent.com/o/r/main/README.md"),
        sh("curl -L https://api.github.com/repos/o/r/releases"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 ALLOW family generic primitives: accepted L20 residual (python/node/curl -K/wget -i)", async () => {
  const { fixture, cleanup } = await makeFixture("allow-generic", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh(
          "python -c \"import urllib.request; urllib.request.urlopen('https://github.com/o/r/issues/5')\"",
        ),
        sh("node -e \"fetch('https://github.com/o/r/issues/5')\""),
        sh("curl -K /tmp/curlrc"),
        sh("wget -i /tmp/urls.txt"),
        sh("curl -L https://redirect.example.com/to/github"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 ALLOW family manual session: an unmanaged session is completely inert", async () => {
  const { fixture, cleanup } = await makeFixture("allow-manual");
  try {
    await allowAll(
      [
        sh("gh issue view 5"),
        sh("gh api repos/o/r/issues"),
        web("https://github.com/o/r/issues/5"),
        web("https://github.com/o/r/pull/3"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

// --- DENY families ----------------------------------------------------------

test("P1-S2 DENY family gh conversational reads: issue view/list, pr view/list", async () => {
  const { fixture, cleanup } = await makeFixture("deny-gh-reads", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh("gh issue view 5"),
        sh("gh issue list"),
        sh("gh pr view 3 --comments"),
        sh("gh pr list"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 DENY family gh search: search issues/prs are conversational", async () => {
  const { fixture, cleanup } = await makeFixture("deny-search", { markerSessionId: SESSION_ID });
  try {
    await denyAll([sh('gh search issues "x"'), sh('gh search prs "x"')], fixture.invoke);
  } finally {
    cleanup();
  }
});

test("P1-S2 DENY family gh api REST conversational, including the RA-02 bare pulls and pulls/3", async () => {
  const { fixture, cleanup } = await makeFixture("deny-api-rest", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh("gh api repos/o/r/issues"),
        sh("gh api repos/o/r/issues/5/comments"),
        sh("gh api repos/o/r/pulls"),
        sh("gh api repos/o/r/pulls/3"),
        sh("gh api repos/o/r/pulls/3/reviews"),
        sh("gh api repos/o/r/pulls/3/reviews/5/comments"),
        sh("gh api repos/o/r/issues/5/timeline"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 DENY family gh api graphql: denied wholesale (no GraphQL semantics parsed)", async () => {
  const { fixture, cleanup } = await makeFixture("deny-graphql", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh("gh api graphql -f query='{viewer{login}}'"),
        sh("gh api /graphql"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 DENY family normalisation: extra whitespace, leading slash, and option consumption", async () => {
  const { fixture, cleanup } = await makeFixture("deny-normalise", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh("gh  api repos/o/r/issues"),
        sh("gh api /repos/o/r/issues"),
        sh("gh api --method GET repos/o/r/issues"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 DENY family wrappers: per-wrapper argument consumption, including short-option clusters with c", async () => {
  const { fixture, cleanup } = await makeFixture("deny-wrappers", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh("timeout 30 gh issue view 5"),
        sh("nice -n 10 gh pr view 3"),
        sh("env FOO=1 gh api repos/o/r/issues"),
        sh("xargs -I{} gh issue view {}"),
        sh("command gh api repos/o/r/issues"),
        sh("find . -exec gh issue view {} ;"),
        sh("eval 'gh issue view 5'"),
        sh("exec gh pr view 3"),
        sh("bash -c 'gh issue view 5'"),
        sh("bash -ic 'gh issue view 5'"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 DENY family alias: gh alias set parses the RHS with the same matcher", async () => {
  const { fixture, cleanup } = await makeFixture("deny-alias", { markerSessionId: SESSION_ID });
  try {
    await denyAll([sh('gh alias set iv "issue view"')], fixture.invoke);
  } finally {
    cleanup();
  }
});

test("P1-S2 DENY family curl/wget conversational endpoint shapes", async () => {
  const { fixture, cleanup } = await makeFixture("deny-curl", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh("curl https://github.com/o/r/issues/5"),
        sh("curl https://github.com/o/r/issues?page=2"),
        sh("curl https://github.com/o/r/pulls"),
        sh("curl https://github.com/o/r/pulls/3"),
        sh("curl https://github.com/o/r/pull/3/files"),
        sh("curl https://api.github.com/repos/o/r/issues"),
        sh("curl https://api.github.com/search/issues?q=x"),
        sh('curl "https://github.com/search?q=x&type=issues"'),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 DENY family curl/wget host normalisation: www, trailing dot, and default port canonicalise", async () => {
  const { fixture, cleanup } = await makeFixture("deny-host-norm", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh("curl -L https://www.github.com/o/r/issues/5"),
        sh("curl -L https://github.com./o/r/issues/5"),
        sh("curl -L https://GITHUB.COM:443/o/r/issues/5"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 DENY family webfetch: issue/PR/discussion/search/comment pages and api issue pages", async () => {
  const { fixture, cleanup } = await makeFixture("deny-webfetch", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        web("https://github.com/o/r/issues/5"),
        web("https://github.com/o/r/pull/3"),
        web("https://github.com/o/r/discussions/5"),
        web("https://github.com/search?q=x&type=issues"),
        web("https://github.com/o/r/issues/5#issuecomment-1"),
        web("https://api.github.com/repos/o/r/issues/5"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 ALLOW family webfetch: repo root, release tag, and raw content", async () => {
  const { fixture, cleanup } = await makeFixture("allow-webfetch", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        web("https://github.com/o/r"),
        web("https://github.com/o/r/releases/tag/v1"),
        web("https://github.com/o/r/raw/main/README.md"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

// --- Canonicalisation rules 1..8 (one test each) ----------------------------

test("P1-S2 canonicalisation rule 1: an unparseable URL candidate falls through (never treated as a URL, never throws)", async () => {
  const { fixture, cleanup } = await makeFixture("rule1-parse", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [sh('curl -L "https://"'), sh('curl -L "not a url"')],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 canonicalisation rule 2: scheme and host are lower-cased (IDNA/punycode normalisation)", async () => {
  const { fixture, cleanup } = await makeFixture("rule2-case", { markerSessionId: SESSION_ID });
  try {
    // Case-folded host reaches the github.com family.
    await expectDeny(
      () => fixture.invoke("bash", { command: "curl -L HTTPS://GITHUB.COM/o/r/issues/5" }),
      "upper-case scheme+host",
    );
    // A non-github unicode host is normalised but stays a different family.
    await expectAllow(
      () => fixture.invoke("bash", { command: "curl -L https://BÜCHER.example/straße" }),
      "unicode non-github host",
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 canonicalisation rule 3: exactly one trailing dot is stripped from the host", async () => {
  const { fixture, cleanup } = await makeFixture("rule3-dot", { markerSessionId: SESSION_ID });
  try {
    await expectDeny(
      () => fixture.invoke("bash", { command: "curl -L https://github.com./o/r/issues/5" }),
      "github.com. trailing dot",
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 canonicalisation rule 4: leading www. is stripped ONLY for github.com, never *.github.com", async () => {
  const { fixture, cleanup } = await makeFixture("rule4-www", { markerSessionId: SESSION_ID });
  try {
    await expectDeny(
      () => fixture.invoke("bash", { command: "curl -L https://www.github.com/o/r/issues/5" }),
      "www.github.com canonicalises",
    );
    await expectAllow(
      () =>
        fixture.invoke("bash", {
          command: "curl -L https://www.api.github.com/repos/o/r/issues/5",
        }),
      "www.api.github.com is not generalised to api.github.com",
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 canonicalisation rule 5: only a default port is stripped; any other port is a distinct origin", async () => {
  const { fixture, cleanup } = await makeFixture("rule5-port", { markerSessionId: SESSION_ID });
  try {
    await expectDeny(
      () => fixture.invoke("bash", { command: "curl -L https://GITHUB.COM:443/o/r/issues/5" }),
      "default https port strips to github.com",
    );
    await expectAllow(
      () => fixture.invoke("bash", { command: "curl -L https://github.com:8443/o/r/issues/5" }),
      "non-default port is a distinct origin",
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 canonicalisation rule 6: path is WHATWG-normalised then percent-decoded once", async () => {
  const { fixture, cleanup } = await makeFixture("rule6-path", { markerSessionId: SESSION_ID });
  try {
    await expectDeny(
      () => fixture.invoke("bash", { command: "curl -L https://github.com/o/r/./issues/5" }),
      "dot segment normalised",
    );
    await expectDeny(
      () => fixture.invoke("bash", { command: "curl -L https://github.com/o/r/%69ssues/5" }),
      "percent-decoded once",
    );
    await expectDeny(
      () => fixture.invoke("bash", { command: "curl -L https://github.com/o/r/issues%2F5" }),
      "an encoded slash decodes once to a path separator",
    );
    await expectAllow(
      () => fixture.invoke("bash", { command: "curl -L https://github.com/o/r/issues%252F5" }),
      "a double-encoded slash is decoded exactly once and does not smuggle the prefix",
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 canonicalisation rule 7: query/fragment dropped for path rules but the query is inspected for search", async () => {
  const { fixture, cleanup } = await makeFixture("rule7-query", { markerSessionId: SESSION_ID });
  try {
    await expectDeny(
      () => fixture.invoke("bash", { command: "curl -L https://github.com/o/r/issues?page=2" }),
      "path prefix denies with a query present",
    );
    await expectDeny(
      () =>
        fixture.invoke("bash", {
          command: 'curl -L "https://github.com/search?q=x&type=issues"',
        }),
      "search endpoint query is inspected",
    );
    await expectAllow(
      () => fixture.invoke("bash", { command: "curl -L https://github.com/o/r/releases?x=1" }),
      "query is irrelevant to a non-conversational path",
    );
  } finally {
    cleanup();
  }
});

test("P1-S2 canonicalisation rule 8: redirects are not simulated; the .diff/.patch carve-out is path-scoped", async () => {
  const { fixture, cleanup } = await makeFixture("rule8-redirect", { markerSessionId: SESSION_ID });
  try {
    await expectAllow(
      () => fixture.invoke("bash", { command: 'curl -L "https://github.com/o/r/pull/3.diff?x=1"' }),
      "path-scoped .diff carve-out",
    );
    await expectAllow(
      () => fixture.invoke("bash", { command: "curl -L https://github.com/o/r/pull/3.patch" }),
      "path-scoped .patch carve-out",
    );
    await expectDeny(
      () => fixture.invoke("bash", { command: "curl -L https://github.com/o/r/issues/5.diff" }),
      "an issues/<n>.diff path is NOT the pull(s) carve-out and stays DENY",
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// P1-S3 — precedence (RA-02). The enumerated path-scoped ALLOW carve-outs are
// evaluated BEFORE the general conversational DENY family, and no carve-out
// generalises by suffix or wildcard.
// ===========================================================================

test("P1-S3 precedence: bare pulls and pulls/3 are DENY while the enumerated carve-outs are ALLOW", async () => {
  const { fixture, cleanup } = await makeFixture("prec-basic", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [sh("gh api repos/o/r/pulls"), sh("gh api repos/o/r/pulls/3")],
      fixture.invoke,
    );
    await allowAll(
      [
        sh("gh api repos/o/r/pulls/3/files"),
        sh("gh api repos/o/r/pulls/3/commits"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S3 precedence: releases* is path-scoped ALLOW and does not leak to other resource paths", async () => {
  const { fixture, cleanup } = await makeFixture("prec-releases", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh("gh api repos/o/r/releases"),
        sh("gh api repos/o/r/releases/tags/v1"),
        sh("curl -L https://api.github.com/repos/o/r/releases/latest"),
      ],
      fixture.invoke,
    );
    // `releasesx` is not the `releases` carve-out and is not a conversational
    // resource, so DD §9.3's fail-open default applies (ALLOW).
    await allowAll([sh("gh api repos/o/r/releasesx")], fixture.invoke);
  } finally {
    cleanup();
  }
});

test("P1-S3 precedence: the path-scoped .diff/.patch carve-out is pull(s)-specific", async () => {
  const { fixture, cleanup } = await makeFixture("prec-diff", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh("curl -L https://github.com/o/r/pull/3.diff"),
        sh("curl -L https://github.com/o/r/pull/3.patch"),
        sh("curl -L https://github.com/o/r/pulls/3.diff"),
      ],
      fixture.invoke,
    );
    await denyAll(
      [
        sh("curl -L https://github.com/o/r/issues/5.diff"),
        sh("curl -L https://github.com/o/r/pull/3.diffx"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S3 precedence: no carve-out generalises by suffix or wildcard", async () => {
  const { fixture, cleanup } = await makeFixture("prec-nogen", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        // suffix on an enumerated carve-out
        sh("gh api repos/o/r/pulls/3/filesX"),
        sh("gh api repos/o/r/pulls/3/commits/abc"),
        // non-enumerated subpaths of the conversational family
        sh("gh api repos/o/r/pulls/3/reviewsX"),
        sh("gh api repos/o/r/pulls/3/changed_files"),
        // wildcard-shaped arguments are not glob-matched
        sh("gh api repos/o/r/pulls/*/files"),
        // a pull path that is neither the .diff carve-out nor an enumerated subpath
        sh("curl -L https://github.com/o/r/pull/3/files"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// P7-S1 — matcher bypass and target-disclosure regressions (spec-first RED).
// Assignment values are untrusted shell material and must never be logged.
// Path-qualified gh executables must match by safe basename only.
// Webfetch denials must retain only structural, credential-free metadata.
// ===========================================================================

test("P7-S1 assignment prefixes are skipped before matching without exposing values", async () => {
  const { fixture, cleanup } = await makeFixture("p7-assignments", { markerSessionId: SESSION_ID });
  try {
    await expectDeny(
      () => fixture.invoke("bash", { command: "GH_TOKEN=ghp_ASSIGNMENT_SECRET gh issue view 5" }),
      "sensitive assignment before gh",
    );
    await expectAllow(
      () => fixture.invoke("bash", { command: "SAFE_MODE=1 echo ready" }),
      "safe assignment before nonmatching command",
    );
  } finally { cleanup(); }
});

test("P7-S1 path-qualified gh executables match by basename and arbitrary binaries remain allowed", async () => {
  const { fixture, cleanup } = await makeFixture("p7-qualified-gh", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [sh("/usr/bin/gh issue view 5"), sh("./gh issue view 5"), sh("timeout 10 /usr/bin/gh pr view 3")],
      fixture.invoke,
    );
    await allowAll([sh("/usr/bin/not-gh issue view 5"), sh("./not-gh issue view 5")], fixture.invoke);
  } finally { cleanup(); }
});

test("P7-S1 webfetch denials refuse exactly with credential-free structural diagnostics", async () => {
  const { fixture, cleanup } = await makeFixture("p7-webfetch-secrets", { markerSessionId: SESSION_ID });
  const stderr = captureStderr();
  const secrets = [
    "https://user:pass@github.com/o/r/issues/5?token=QUERY_SECRET",
    "https://github.com/o/r/issues/bearer_SECRET/5?access_token=QUERY_SECRET",
    "https://github.com/o/r/issues/5?Authorization=Bearer%20PATH_SECRET",
  ];
  try {
    for (const url of secrets) {
      await expectDeny(() => fixture.invoke("webfetch", { url }), `credential-bearing ${url}`);
      const line = stderr.lines().at(-1) as string;
      const record = JSON.parse(line) as Record<string, unknown>;
      assert.equal(record.tool, "webfetch");
      assert.equal(record.target, "webfetch-url(github.com)");
      for (const secret of ["user", "pass", "QUERY_SECRET", "bearer_SECRET", "PATH_SECRET"]) {
        assert.equal(line.includes(secret), false, `record must not expose ${secret}`);
      }
    }
  } finally { stderr.restore(); cleanup(); }
});

// ===========================================================================
// P1-S4 — negative space. The guard is NOT a broad github.com block; normal
// engineering workflows must pass on managed sessions (L16/L17).
// ===========================================================================

test("P1-S4 negative space: normal web research is not blocked", async () => {
  const { fixture, cleanup } = await makeFixture("neg-research", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        web("https://example.com/docs"),
        web("https://developer.mozilla.org/en-US/docs/Web/API/URL"),
        web("https://www.wikipedia.org/wiki/GitHub"),
        sh("curl -L https://example.com/data.json"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S4 negative space: release/archive/tarball downloads are not blocked", async () => {
  const { fixture, cleanup } = await makeFixture("neg-downloads", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh("curl -L -O https://github.com/o/r/releases/download/v1/a.tgz"),
        sh("curl -L -O https://github.com/o/r/archive/refs/tags/v1.tar.gz"),
        sh("curl -L -O https://github.com/o/r/tarball/v1"),
        sh("wget https://codeload.github.com/o/r/tar.gz/v1"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S4 negative space: npm/pip/uv installs are not blocked", async () => {
  const { fixture, cleanup } = await makeFixture("neg-packages", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh("npm install"),
        sh("npm ci"),
        sh("pip install -r requirements.txt"),
        sh("uv sync"),
        sh("uv pip install requests"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

test("P1-S4 negative space: build, test, typecheck, lint, and clone commands are not blocked", async () => {
  const { fixture, cleanup } = await makeFixture("neg-build", { markerSessionId: SESSION_ID });
  try {
    await allowAll(
      [
        sh("npm run build"),
        sh("npm test"),
        sh("npm run lint"),
        sh("npm run typecheck"),
        sh("npx tsc --noEmit"),
        sh("cargo test"),
        sh("make ci"),
        sh("git clone https://github.com/o/r.git"),
        sh("gh repo clone o/r"),
      ],
      fixture.invoke,
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// P1-S5 — fault injection (DD §9.5). Precedence: DD §9.5 outranks the plan's
// loose grouping.
//   * marker-absent / registry-unreadable => UNMANAGED => return immediately,
//     COMPLETELY INERT (no log record).
//   * unexpected argument shape, matcher/tokenizer parser error, wrapper-depth
//     exceeded, internal exception => no-op + exactly one structured record.
//   * unknown tool => plain no-op (no record).
//   * ONLY a positive conversational match throws.
// The classifier is exception-total by construction (a single wrapped
// `statSync`), so a "classifier throw" is not injectable through the public
// surface; its observable consequence is tested instead (absent/unreadable
// registry => inert, never throws).
// ===========================================================================

test("P1-S5 fault: an absent registry mount makes the plugin completely inert, even for a conversational read", async () => {
  const root = makeTemp("fault-absent");
  const registryDir = join(root, "does-not-exist");
  const moderationDir = join(root, "moderation");
  mkdirSync(moderationDir, { recursive: true });
  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const stderr = captureStderr();
  try {
    const hooks = (await TissueModeration({})) as unknown as {
      "tool.execute.before": BeforeHook;
    };
    // Classification yields UNMANAGED; the hook returns without touching the
    // matcher, so the conversational read resolves and no record is written.
    await assert.doesNotReject(
      async () =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: SESSION_ID, callID: "c1" },
          { args: { command: "gh issue view 5" } },
        ),
      "absent registry must be inert",
    );
    assert.equal(stderr.lines().length, 0, "absent registry must not log");
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-S5 fault: an unreadable registry (ENOTDIR) still yields UNMANAGED and stays inert", async () => {
  const root = makeTemp("fault-unreadable");
  const registryDir = join(root, "registry-file");
  const moderationDir = join(root, "moderation");
  // A regular file where the registry directory is expected: statSync on the
  // marker path throws ENOTDIR deterministically, independent of the uid.
  writeFileSync(registryDir, "not a directory", "utf8");
  mkdirSync(moderationDir, { recursive: true });
  const priorRegistry = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorModeration = process.env.TISSUE_MODERATION_DIR;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_MODERATION_DIR = moderationDir;
  const stderr = captureStderr();
  try {
    const hooks = (await TissueModeration({})) as unknown as {
      "tool.execute.before": BeforeHook;
    };
    await assert.doesNotReject(
      async () =>
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: SESSION_ID, callID: "c1" },
          { args: { command: "gh api repos/o/r/issues" } },
        ),
      "unreadable registry must be inert",
    );
    assert.equal(stderr.lines().length, 0, "unreadable registry must not log");
  } finally {
    stderr.restore();
    restoreEnv("TISSUE_SESSION_REGISTRY_DIR", priorRegistry);
    restoreEnv("TISSUE_MODERATION_DIR", priorModeration);
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-S5 fault: an unknown tool is a plain no-op (no record)", async () => {
  const { fixture, cleanup } = await makeFixture("fault-unknown-tool", {
    markerSessionId: SESSION_ID,
  });
  const stderr = captureStderr();
  try {
    for (const tool of ["read", "edit", "grep"] as const) {
      const before = stderr.lines().length;
      await assert.doesNotReject(
        async () =>
          fixture.invoke(tool as unknown as ToolName, { filePath: "src/app.ts" }),
        `unknown tool ${tool} must no-op`,
      );
      assert.equal(
        stderr.lines().length,
        before,
        `unknown tool ${tool} must not log a record`,
      );
    }
  } finally {
    stderr.restore();
    cleanup();
  }
});

test("P1-S5 fault: a non-string command and a non-string url are no-ops with exactly one record each", async () => {
  const { fixture, cleanup } = await makeFixture("fault-args", {
    markerSessionId: SESSION_ID,
  });
  const stderr = captureStderr();
  try {
    for (const [tool, args] of [
      ["bash", { command: 123 }],
      ["bash", { command: { nested: true } }],
      ["webfetch", { url: { not: "a string" } }],
    ] as const) {
      const before = stderr.lines().length;
      await assert.doesNotReject(
        async () => fixture.invoke(tool as ToolName, args),
        "malformed args must no-op",
      );
      assert.equal(
        stderr.lines().length - before,
        1,
        "malformed args must write exactly one structured record",
      );
    }
  } finally {
    stderr.restore();
    cleanup();
  }
});

test("P1-S5 fault: wrapper depth beyond the limit is a no-op with exactly one record, never a throw", async () => {
  const { fixture, cleanup } = await makeFixture("fault-depth", {
    markerSessionId: SESSION_ID,
  });
  const stderr = captureStderr();
  try {
    const before = stderr.lines().length;
    await assert.doesNotReject(
      async () => fixture.invoke("bash", { command: nestShell(12, "gh issue view 5") }),
      "wrapper depth exceeded must no-op, not throw",
    );
    assert.equal(
      stderr.lines().length - before,
      1,
      "wrapper depth exceeded must write exactly one structured record",
    );
  } finally {
    stderr.restore();
    cleanup();
  }
});

test("P1-S5 fault: an unterminated quote is a no-op with exactly one unterminated-quote record", async () => {
  const { fixture, cleanup } = await makeFixture("fault-tokenize", {
    markerSessionId: SESSION_ID,
  });
  const stderr = captureStderr();
  try {
    // DD §9.5: a matcher/tokenizer parser error is a no-op + log. An odd quote
    // count makes `tokenize` throw `TokenizeFault("unterminated-quote")`
    // (plugin/tissue-moderation.ts:209); the hook catch swallows it and writes
    // exactly one structured record. Both quote styles are parser faults.
    for (const command of ['gh issue view "5', "gh issue view '5"]) {
      const before = stderr.lines().length;
      await assert.doesNotReject(
        async () => fixture.invoke("bash", { command }),
        `an unterminated quote must no-op, not throw: ${command}`,
      );
      const lines = stderr.lines();
      assert.equal(
        lines.length - before,
        1,
        `an unterminated quote must write exactly one structured record: ${command}`,
      );
      const line = lines[lines.length - 1];
      assert.ok(line !== undefined, "a structured record line must be present");
      const record = JSON.parse(line) as { rule?: unknown; target?: unknown };
      assert.equal(
        record.rule,
        "unterminated-quote",
        "the record must name the tokenizer parse fault",
      );
      assert.equal(record.target, "bash-command(gh)", "fault target must be structural and redacted");
    }
  } finally {
    stderr.restore();
    cleanup();
  }
});

test("P1-S5: faults never throw; only a positive conversational match throws (and logs once)", async () => {
  const { fixture, cleanup } = await makeFixture("fault-only-match", {
    markerSessionId: SESSION_ID,
  });
  const stderr = captureStderr();
  try {
    // Faults resolve.
    await expectAllow(
      () => fixture.invoke("bash", { command: 123 }),
      "non-string command",
    );
    await expectAllow(
      () => fixture.invoke("bash", { command: nestShell(12, "gh issue view 5") }),
      "wrapper depth exceeded",
    );
    // A genuine conversational match rejects with the §9.4 refusal and logs once.
    const before = stderr.lines().length;
    await assert.rejects(
      async () => fixture.invoke("bash", { command: "gh issue view 5" }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, REFUSAL_RE);
        return true;
      },
      "a positive match must throw the §9.4 refusal",
    );
    assert.equal(
      stderr.lines().length - before,
      1,
      "a blocked call must write exactly one structured record",
    );
  } finally {
    stderr.restore();
    cleanup();
  }
});

// ===========================================================================
// P5-S1 — L-SEC-LOG-001: fault records must never leak credentials (spec-first
// RED). The fault branch logs a redacted structural diagnostic (the fault
// classification plus non-sensitive structural metadata) — never the raw
// credential-bearing command/URL and never any credential substring.
//
// Deterministic internal-error injection: a unique credential sentinel is
// embedded in the command/URL, and `Array.prototype.join` / `String.prototype.
// split` are temporarily wrapped to throw only when their receiver contains
// that sentinel. This converts the otherwise-total matcher into the plugin's
// `internal-error` branch without timing, sleeps, or a guessed filename. Both
// prototypes are always restored in a `finally`.
// ===========================================================================

const FAULT_SECRET = "ghp_" + "FaultInjectionSentinel";
const FAULT_BASIC = "user:pass";

function withPrototypeFault<T>(sentinel: string, fn: () => Promise<T> | T): Promise<T> | T {
  const originalJoin = Array.prototype.join;
  const originalSplit = String.prototype.split;
  const containsSentinel = (value: unknown): boolean =>
    typeof value === "string" && value.includes(sentinel);
  Array.prototype.join = function (this: unknown[], separator?: string): string {
    if (Array.isArray(this) && this.some((entry) => containsSentinel(entry))) {
      throw new Error("injected-internal-error");
    }
    return originalJoin.call(this, separator);
  } as typeof Array.prototype.join;
  String.prototype.split = function (this: string, ...args: unknown[]): string[] {
    if (typeof this === "string" && containsSentinel(this)) {
      throw new Error("injected-internal-error");
    }
    return (originalSplit as unknown as (...a: unknown[]) => string[]).call(this, ...args);
  } as typeof String.prototype.split;
  const restore = (): void => {
    Array.prototype.join = originalJoin;
    String.prototype.split = originalSplit;
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

function parseFaultRecord(
  stderr: { lines: () => string[] },
  label: string,
): { rule: unknown; target: unknown; serialized: string } {
  const lines = stderr.lines();
  const line = lines[lines.length - 1];
  assert.ok(line !== undefined, `${label}: a structured record line must be present`);
  const record = JSON.parse(line) as Record<string, unknown>;
  return { rule: record.rule, target: record.target, serialized: line };
}

test("P5-S1 L-SEC-LOG-001: a wrapper-depth fault logs only a redacted structural target", async () => {
  const { fixture, cleanup } = await makeFixture("p5-log-depth", {
    markerSessionId: SESSION_ID,
  });
  const stderr = captureStderr();
  try {
    const command = nestShell(
      12,
      `curl -u ${FAULT_BASIC} https://${FAULT_BASIC}@github.com/o/r/issues/5`,
    );
    await assert.doesNotReject(
      async () => fixture.invoke("bash", { command }),
      "wrapper depth exceeded must no-op, not throw",
    );
    const { rule, target, serialized } = parseFaultRecord(stderr, "wrapper depth");
    assert.equal(rule, "wrapper-depth-exceeded");
    assert.equal(target, "bash-command(bash)");
    assert.equal(serialized.includes(command), false, "the raw command must never be logged");
    assert.equal(serialized.includes(FAULT_BASIC), false, "no credential substring may leak");
  } finally {
    stderr.restore();
    cleanup();
  }
});

test("P5-S1 L-SEC-LOG-001: a tokenizer fault logs only a redacted structural target", async () => {
  const { fixture, cleanup } = await makeFixture("p5-log-tokenize", {
    markerSessionId: SESSION_ID,
  });
  const stderr = captureStderr();
  try {
    const command = `curl -H 'Authorization: Bearer ${FAULT_SECRET}`;
    await assert.doesNotReject(
      async () => fixture.invoke("bash", { command }),
      "a tokenizer fault must no-op, not throw",
    );
    const { rule, target, serialized } = parseFaultRecord(stderr, "tokenizer fault");
    assert.equal(rule, "unterminated-quote");
    assert.equal(target, "bash-command(curl)");
    assert.equal(serialized.includes(FAULT_SECRET), false, "no credential sentinel may leak");
    assert.equal(serialized.includes("Authorization"), false, "no credential header may leak");
    assert.equal(serialized.includes(command), false, "the raw command must never be logged");
  } finally {
    stderr.restore();
    cleanup();
  }
});

test("P5-S1 L-SEC-LOG-001: an internal error logs only a redacted structural target (bash)", async () => {
  const { fixture, cleanup } = await makeFixture("p5-log-internal-bash", {
    markerSessionId: SESSION_ID,
  });
  const stderr = captureStderr();
  try {
    const command = `gh label list ${FAULT_SECRET}`;
    await withPrototypeFault(FAULT_SECRET, () => fixture.invoke("bash", { command }));
    const { rule, target, serialized } = parseFaultRecord(stderr, "internal error (bash)");
    assert.equal(rule, "internal-error");
    assert.equal(target, "bash-command(gh)");
    assert.equal(serialized.includes(FAULT_SECRET), false, "no credential sentinel may leak");
    assert.equal(serialized.includes(command), false, "the raw command must never be logged");
  } finally {
    stderr.restore();
    cleanup();
  }
});

test("P5-S1 L-SEC-LOG-001: an internal error on a credential-bearing URL logs only a redacted structural target", async () => {
  const { fixture, cleanup } = await makeFixture("p5-log-internal-web", {
    markerSessionId: SESSION_ID,
  });
  const stderr = captureStderr();
  try {
    const url = `https://${FAULT_BASIC}@github.com/o/r/${FAULT_SECRET}/issues/5`;
    await withPrototypeFault(FAULT_SECRET, () => fixture.invoke("webfetch", { url }));
    const { rule, target, serialized } = parseFaultRecord(stderr, "internal error (webfetch)");
    assert.equal(rule, "internal-error");
    assert.equal(target, "webfetch-url(https)");
    assert.equal(serialized.includes(FAULT_BASIC), false, "no embedded credential may leak");
    assert.equal(serialized.includes(FAULT_SECRET), false, "no credential sentinel may leak");
    assert.equal(serialized.includes(url), false, "the raw URL must never be logged");
  } finally {
    stderr.restore();
    cleanup();
  }
});

// ===========================================================================
// P6-S1 — residual credential, registry, and moderation-directory regressions
// (spec-first RED). These assertions are intentionally added before the repair.
// ===========================================================================

const P6_SECRET = "ghp_" + "P6CredentialSentinel";

function parseLastRecord(stderr: { lines: () => string[] }, label: string): Record<string, unknown> {
  const lines = stderr.lines();
  const line = lines[lines.length - 1];
  assert.ok(line !== undefined, `${label}: expected a structured record`);
  return JSON.parse(line) as Record<string, unknown>;
}

test("P6-S1 L-SEC-LOG-002: first command token diagnostics never expose a credential-bearing token", async () => {
  const { fixture, cleanup } = await makeFixture("p6-first-token", { markerSessionId: SESSION_ID });
  const stderr = captureStderr();
  try {
    const command = `${P6_SECRET} gh issue view "5`;
    await expectAllow(() => fixture.invoke("bash", { command }), "credential-bearing first token");
    const record = parseLastRecord(stderr, "first token");
    assert.equal(record.rule, "unterminated-quote");
    assert.equal(record.target, "bash-command(unknown)");
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes(command), false);
    assert.equal(serialized.includes(P6_SECRET), false);
  } finally {
    stderr.restore();
    cleanup();
  }
});

test("P6-S1 L-SEC-LOG-001: positive gh denial normalizes credential-bearing arguments safely", async () => {
  const { fixture, cleanup } = await makeFixture("p6-positive-credentials", { markerSessionId: SESSION_ID });
  const stderr = captureStderr();
  try {
    const command = `gh issue view 5 -H Authorization:Bearer ${P6_SECRET} -u user:pass`;
    await assert.rejects(() => fixture.invoke("bash", { command }), REFUSAL_RE);
    const lines = stderr.lines();
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(record.rule, "gh-issue-read");
    assert.equal(record.target, "gh issue view");
    const serialized = lines.join("\\n");
    assert.equal(serialized.includes(P6_SECRET), false);
    assert.equal(serialized.includes("user:pass"), false);
    assert.equal(serialized.includes(command), false);
  } finally {
    stderr.restore();
    cleanup();
  }
});


// ===========================================================================
// P8-S1 — QA Round 5 security regressions (spec-first RED).
// ===========================================================================

test("P8-S1 relative multi-component gh paths are moderated", async () => {
  const { fixture, cleanup } = await makeFixture("p8-relative-gh", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [sh("tools/gh issue view 5"), sh("bin/gh pr view 3"), sh("../bin/gh api repos/o/r/issues")],
      fixture.invoke,
    );
  } finally { cleanup(); }
});

test("P8-S1 compound shell operators inspect every command and substitution", async () => {
  const { fixture, cleanup } = await makeFixture("p8-compound", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh("echo safe; gh issue view 5"),
        sh("echo safe && gh pr view 3"),
        sh("echo safe || gh api repos/o/r/issues"),
        sh("echo safe | gh issue view 5"),
        sh("printf x\ngh issue view 5"),
        sh("echo $(gh issue view 5)"),
        sh("echo `gh pr view 3`"),
      ],
      fixture.invoke,
    );
  } finally { cleanup(); }
});

test("P8-S1 denied curl/wget diagnostics expose only structural target metadata", async () => {
  const { fixture, cleanup } = await makeFixture("p8-curl-log", { markerSessionId: SESSION_ID });
  const stderr = captureStderr();
  try {
    for (const command of [
      "curl https://user:pass@github.com/o/r/issues/5?token=QUERY_SECRET",
      "wget https://github.com/o/r/issues/Bearer_SECRET/5?access_token=QUERY_SECRET",
    ]) {
      await expectDeny(() => fixture.invoke("bash", { command }), command);
    }
    const lines = stderr.lines();
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.includes("user"), false);
      assert.equal(line.includes("pass"), false);
      assert.equal(line.includes("QUERY_SECRET"), false);
      assert.equal(line.includes("Bearer_SECRET"), false);
      const record = JSON.parse(line) as Record<string, unknown>;
      assert.match(String(record.target), /^(curl|wget)-url\(github\.com\)$/);
    }
  } finally { stderr.restore(); cleanup(); }
});


// ===========================================================================
// P9-S1 — quoted substitutions and shell option wrapper regressions (RED).
// ===========================================================================

test("P9-S1 executable substitutions in double quotes are inspected, while escaped forms stay literal", async () => {
  const { fixture, cleanup } = await makeFixture("p9-quoted-substitutions", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh('echo "$(gh issue view 5)"'),
        sh('echo "$(echo "$(gh pr view 3)")"'),
        sh('echo `gh api repos/o/r/issues`'),
        sh('echo "$(echo "$(gh issue view 5)")"'),
      ],
      fixture.invoke,
    );
    await allowAll(
      [
        sh('echo "\\$(gh issue view 5)"'),
        sh('echo "\\`gh issue view 5\\`"'),
      ],
      fixture.invoke,
    );
  } finally { cleanup(); }
});

test("P9-S1 shell value-taking options are consumed before -c", async () => {
  const { fixture, cleanup } = await makeFixture("p9-shell-options", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh("bash -o pipefail -c 'gh issue view 5'"),
        sh("bash --option pipefail -c 'gh pr view 3'"),
        sh("bash --option=pipefail -c 'gh api repos/o/r/issues'"),
        sh("bash -o pipefail -ic 'gh issue view 5'"),
      ],
      fixture.invoke,
    );
  } finally { cleanup(); }
});


// ===========================================================================
// P10-S1 — QA Round 7 critical-boundary regressions (spec-first RED).
// ===========================================================================

test("P10-S1 double-quoted backtick substitutions are inspected, including nested and escaped forms", async () => {
  const { fixture, cleanup } = await makeFixture("p10-backticks", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh('echo "`gh issue view 5`"'),
        sh('echo "`echo \"`gh pr view 3`\"`"'),
        sh('echo "`gh api repos/o/r/issues`"'),
      ],
      fixture.invoke,
    );
    await allowAll(
      [
        sh('echo "\\`gh issue view 5\\`"'),
        sh('echo "\\`echo \\\"gh pr view 3\\\"\\`"'),
      ],
      fixture.invoke,
    );
  } finally { cleanup(); }
});

test("P10-S1 path-qualified supported shells and value-taking options before -c are inspected", async () => {
  const { fixture, cleanup } = await makeFixture("p10-shell-paths", { markerSessionId: SESSION_ID });
  try {
    await denyAll(
      [
        sh("/bin/bash -o pipefail -c 'gh issue view 5'"),
        sh("./bash --option pipefail -c 'gh pr view 3'"),
        sh("tools/sh -o nounset -ic 'gh api repos/o/r/issues'"),
        sh("/usr/bin/zsh --option=pipefail -c 'gh issue view 5'"),
      ],
      fixture.invoke,
    );
    await allowAll([sh("/tmp/not-shell -c 'gh issue view 5'")], fixture.invoke);
  } finally { cleanup(); }
});

test("P10-S1 curl/wget endpoint option equals forms inspect sensitive URLs without credential disclosure", async () => {
  const { fixture, cleanup } = await makeFixture("p10-endpoint-options", { markerSessionId: SESSION_ID });
  const stderr = captureStderr();
  try {
    await denyAll(
      [
        sh("curl --url=https://github.com/o/r/issues/5"),
        sh("curl -u=https://github.com/o/r/issues/5"),
        sh("wget --url https://github.com/o/r/pulls/3"),
        sh("wget --url=https://user:pass@github.com/o/r/issues/5?token=SECRET"),
      ],
      fixture.invoke,
    );
    const lines = stderr.lines();
    assert.equal(lines.length, 4);
    assert.equal(lines.some((line) => line.includes("user") || line.includes("pass") || line.includes("SECRET")), false);
  } finally { stderr.restore(); cleanup(); }
});
