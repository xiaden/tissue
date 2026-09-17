// tests/integration/p5-agent-deployment.test.ts
//
// Production-closure coverage for the resident AGENT DEPLOYMENT boundary:
//
//   A. The OpenCode GLOBAL agent directory resolves deterministically and
//      absolutely (never from the process CWD), and the checked-in source
//      definitions are a distinct location from the deployed ones.
//   B. `installAgentDefinitions` deploys the checked-in definitions idempotently,
//      refuses to overwrite a divergent file without --force, and is
//      filesystem-only (no OpenCode DB access, no child process, no serve).
//   C. Production startup AND `tissue doctor` fail closed when the deployed
//      definitions are missing, invalid, or drifted from the checked-in source.
//   D. Enabled production work always addresses the dedicated Tissue identity:
//      triage sends `tissue-triage`, resolution sends `tissue-resolve`, and a
//      config that omits every agent/model setting still does both — never the
//      resident OpenCode default agent, and never a silently selected model.
//
// Fakes are limited to external boundaries: the typed-argv fake-gh executable,
// the pessimistic loopback OpenCode server behind the REAL OpenCodeHttp transport,
// and temporary local git repositories. No real remote, service, or OpenCode DB is
// touched, and no service is ever restarted.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installAgentDefinitions,
  resolveOpenCodeGlobalAgentsDir,
  resolveSourceAgentsDir,
  validateTissueAgentDefinitions,
} from "../../src/runtime/resident.ts";
import { parseConfig } from "../../src/config/load.ts";
import {
  TISSUE_RESOLVE_AGENT,
  TISSUE_TRIAGE_AGENT,
  type RepositoryConfig,
  type TissueConfig,
} from "../../src/config/types.ts";
import { createProductionAssembly } from "../../src/runtime/entrypoint.ts";
import { runNormalLoopPass } from "../../src/runtime/daemon.ts";
import { getActiveResolutionSession, listRepositories, listSessions } from "../../src/db/repositories.ts";
import { doctorOperation } from "../../src/controller/ops.ts";
import { GhClient } from "../../src/integrations/gh-client.ts";
import { runGit } from "../../src/integrations/git-client.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import { createTestDb } from "../helpers/db.ts";
import { createTempRepo } from "../helpers/git.ts";
import { defaultNomarrMeta, writeFakeGh, type FakeGhScenario } from "../helpers/fake-gh.ts";
import { startPessimisticServer } from "../helpers/pessimistic-opencode-server.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ID = "xiaden/nomarr";
const WORK_ITEM_ID = "wi-xiaden-nomarr-7";
const BASELINE = "2026-01-01T00:00:00.000Z";
const ISSUE_CREATED = "2026-06-01T00:00:00.000Z";
const T0 = Date.parse("2026-07-01T00:00:00.000Z");

/** Deploy the checked-in definitions into a fresh OpenCode-global-shaped dir. */
function freshDeployedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tissue-deploy-"));
  const status = installAgentDefinitions({ targetDir: dir });
  assert.equal(status.ok, true, status.errors.join("; "));
  return dir;
}

test("A: the OpenCode global agent directory resolves absolutely and never from the CWD", () => {
  assert.equal(resolveOpenCodeGlobalAgentsDir({ TISSUE_OPENCODE_AGENTS_DIR: "/srv/oc/agents" }), "/srv/oc/agents");
  assert.equal(resolveOpenCodeGlobalAgentsDir({ XDG_CONFIG_HOME: "/xdg" }), join("/xdg", "opencode", "agents"));
  assert.equal(resolveOpenCodeGlobalAgentsDir({ HOME: "/home/someone" }), join("/home/someone", ".config", "opencode", "agents"));
  // A relative path is refused outright — that is the ambiguous behavior removed.
  assert.throws(() => resolveOpenCodeGlobalAgentsDir({ TISSUE_OPENCODE_AGENTS_DIR: "agents" }), /absolute/);
  assert.throws(() => resolveOpenCodeGlobalAgentsDir({}), /TISSUE_OPENCODE_AGENTS_DIR/);

  // The checked-in source dir is absolute, distinct, and really contains the sources.
  const source = resolveSourceAgentsDir();
  assert.ok(source.startsWith("/"), "source dir is absolute");
  assert.equal(existsSync(join(source, "tissue-triage.md")), true);
  assert.equal(existsSync(join(source, "tissue-resolve.md")), true);
});

test("B: install deploys idempotently, refuses divergence without --force, and is filesystem-only", () => {
  const source = resolveSourceAgentsDir();
  const target = mkdtempSync(join(tmpdir(), "tissue-install-"));
  try {
    const first = installAgentDefinitions({ targetDir: target });
    assert.equal(first.ok, true, first.errors.join("; "));
    assert.deepEqual(first.results.map((r) => r.action), ["installed", "installed"]);
    for (const name of ["tissue-triage.md", "tissue-resolve.md"]) {
      assert.equal(readFileSync(join(target, name), "utf8"), readFileSync(join(source, name), "utf8"));
    }

    // Idempotent: an identical deployment is a no-op, never a rewrite.
    const second = installAgentDefinitions({ targetDir: target });
    assert.equal(second.ok, true);
    assert.deepEqual(second.results.map((r) => r.action), ["unchanged", "unchanged"]);

    // A divergent deployed file is refused unless --force is explicit.
    const edited = readFileSync(join(target, "tissue-triage.md"), "utf8") + "\n# operator edit\n";
    writeFileSync(join(target, "tissue-triage.md"), edited);
    const refused = installAgentDefinitions({ targetDir: target });
    assert.equal(refused.ok, false);
    assert.equal(refused.results.find((r) => r.role === "triage")?.action, "exists-divergent");
    assert.equal(readFileSync(join(target, "tissue-triage.md"), "utf8"), edited, "operator edit is preserved");
    assert.ok(refused.errors.some((e) => /--force/.test(e)));

    const forced = installAgentDefinitions({ targetDir: target, force: true });
    assert.equal(forced.ok, true, forced.errors.join("; "));
    assert.equal(readFileSync(join(target, "tissue-triage.md"), "utf8"), readFileSync(join(source, "tissue-triage.md"), "utf8"));

    // Filesystem-only: the deployment/validation module never opens OpenCode's DB
    // and never spawns a child process (so no serve is started, restarted, or reaped).
    const code = readFileSync(join(ROOT, "src", "runtime", "resident.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /opencode\.db/);
    assert.doesNotMatch(code, /child_process|spawn\s*\(|execFile/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("C: startup and doctor fail closed on missing or drifted deployed definitions", async () => {
  const empty = mkdtempSync(join(tmpdir(), "tissue-empty-agents-"));
  const stateDir = mkdtempSync(join(tmpdir(), "tissue-doctor-"));
  const healthy = freshDeployedDir();
  const tissue = createTestDb();
  const server = await startPessimisticServer();
  const logger = new JsonLogger(new CapturingSink().writeable());
  const config: TissueConfig = { pollIntervalSeconds: 60, maxConcurrentGlobal: 1, retentionDays: 30, agents: {}, repos: [] };
  const prior = process.env.TISSUE_OPENCODE_AGENTS_DIR;
  // Deterministic registry mount fixture: `doctor` now also asserts the managed-
  // session registry mount (plan I, P3-S2), so point it at a real directory listed
  // in an injected mount table instead of the container-only default path.
  const registryRoot = mkdtempSync(join(tmpdir(), "tissue-doctor-registry-"));
  const registryDir = join(registryRoot, "registry");
  mkdirSync(registryDir, { recursive: true });
  const registryMountInfo = join(registryRoot, "mountinfo");
  writeFileSync(registryMountInfo, `40 20 0:100 / ${registryDir} rw,relatime - ext4 /dev/sda rw\n`, "utf8");
  const priorRegistryDir = process.env.TISSUE_SESSION_REGISTRY_DIR;
  const priorRegistryMountInfo = process.env.TISSUE_SESSION_REGISTRY_MOUNTINFO;
  process.env.TISSUE_SESSION_REGISTRY_DIR = registryDir;
  process.env.TISSUE_SESSION_REGISTRY_MOUNTINFO = registryMountInfo;
  try {
    // Missing: a definition the resident would need is simply not deployed.
    const missing = validateTissueAgentDefinitions({ agentsDir: empty, sourceDir: resolveSourceAgentsDir() });
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((e) => /missing host-global triage agent definition/.test(e)));
    assert.ok(missing.errors.some((e) => /missing host-global resolution agent definition/.test(e)));
    await assert.rejects(
      createProductionAssembly({ config, logger, db: tissue.db, stateDir, endpoint: server.baseUrl(), agentsDir: empty }),
      /invalid host-global Tissue agent definitions/,
      "startup fails closed when the deployed agents are missing",
    );

    // Drift: a stale deployed definition cannot silently survive a source update.
    const driftedDir = freshDeployedDir();
    try {
      const triagePath = join(driftedDir, "tissue-triage.md");
      writeFileSync(triagePath, readFileSync(triagePath, "utf8") + "\n# stale deployed copy\n");
      const drifted = validateTissueAgentDefinitions({ agentsDir: driftedDir, sourceDir: resolveSourceAgentsDir() });
      assert.equal(drifted.ok, false);
      assert.equal(drifted.agents.find((a) => a.role === "triage")?.sourceDrift, true);
      assert.ok(drifted.errors.some((e) => /drifted from the checked-in source/.test(e)));
      await assert.rejects(
        createProductionAssembly({ config, logger, db: tissue.db, stateDir, endpoint: server.baseUrl(), agentsDir: driftedDir }),
        /invalid host-global Tissue agent definitions/,
        "startup fails closed on drifted deployed agents",
      );

      // doctor reports the same failure and refuses to claim health.
      process.env.TISSUE_OPENCODE_AGENTS_DIR = driftedDir;
      const report = doctorOperation({ config, stateDir, logger }) as { ok: boolean; agents: { ok: boolean; agentsDir: string } };
      assert.equal(report.ok, false, "doctor fails closed on drift");
      assert.equal(report.agents.ok, false);
      assert.equal(report.agents.agentsDir, driftedDir);
    } finally {
      rmSync(driftedDir, { recursive: true, force: true });
    }

    // A correctly deployed directory is healthy (agent identity, not model, is required).
    process.env.TISSUE_OPENCODE_AGENTS_DIR = healthy;
    const okReport = doctorOperation({ config, stateDir, logger }) as { ok: boolean; agents: { ok: boolean; agentsDir: string; sourceDir: string | null } };
    assert.equal(okReport.ok, true, "a fresh deployment is healthy");
    assert.equal(okReport.agents.ok, true);
    assert.equal(okReport.agents.agentsDir, healthy);
    assert.equal(okReport.agents.sourceDir, resolveSourceAgentsDir(), "doctor compares against the checked-in source");
  } finally {
    if (prior === undefined) delete process.env.TISSUE_OPENCODE_AGENTS_DIR;
    else process.env.TISSUE_OPENCODE_AGENTS_DIR = prior;
    if (priorRegistryDir === undefined) delete process.env.TISSUE_SESSION_REGISTRY_DIR;
    else process.env.TISSUE_SESSION_REGISTRY_DIR = priorRegistryDir;
    if (priorRegistryMountInfo === undefined) delete process.env.TISSUE_SESSION_REGISTRY_MOUNTINFO;
    else process.env.TISSUE_SESSION_REGISTRY_MOUNTINFO = priorRegistryMountInfo;
    tissue.cleanup();
    await server.close();
    rmSync(empty, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(healthy, { recursive: true, force: true });
    rmSync(registryRoot, { recursive: true, force: true });
  }
});

test("D: enabled work always addresses the dedicated agents, even when config omits agent and model", async () => {
  const temp = await createTempRepo();
  const tissue = createTestDb();
  const server = await startPessimisticServer();
  const logger = new JsonLogger(new CapturingSink().writeable());
  const stateRoot = join(process.cwd(), ".tissue", `e2e-agents-${process.pid}-${Date.now()}`);
  const deployed = freshDeployedDir();
  let clock = T0;

  const scenario: FakeGhScenario = {
    meta: defaultNomarrMeta(),
    issueList: {
      [REPO_ID]: [{ number: 7, title: "fix the thing", body: "details", state: "OPEN", updatedAt: ISSUE_CREATED, createdAt: ISSUE_CREATED, labels: [] }],
    },
    protection: {
      [`repos/${REPO_ID}/branches/main/protection`]: {
        required_status_checks: { contexts: ["ci"], checks: [] },
        required_pull_request_reviews: { required_approving_review_count: 1 },
        enforce_admins: { enabled: false },
      },
    },
    prCreateNumber: 101,
    prChecks: { [`${REPO_ID}#101`]: [{ name: "ci", status: "IN_PROGRESS", conclusion: "PENDING" }] },
    prReviews: { [`${REPO_ID}#101`]: [] },
  };
  const fake = writeFakeGh(scenario);
  const priorStateDir = process.env.TISSUE_STATE_DIR;
  process.env.TISSUE_STATE_DIR = stateRoot;

  try {
    const url = `https://github.com/${REPO_ID}.git`;
    await runGit(["remote", "set-url", "origin", url], { cwd: temp.clone });
    await runGit(["config", `url.${temp.bare}.insteadOf`, url], { cwd: temp.clone });

    // Config OMITS `agents` entirely: neither identity nor model is configured.
    const config = parseConfig(
      [
        "pollIntervalSeconds: 300",
        "repos:",
        `  - owner: xiaden`,
        `    name: nomarr`,
        `    remote: ${url}`,
        `    localDir: ${temp.clone}`,
        `    baselineBefore: '${BASELINE}'`,
        `    baseBranch: main`,
        `    labels: []`,
        `    autoMerge: false`,
        "",
      ].join("\n"),
      "p5-agents.yml",
    );
    assert.equal(config.agents.triage?.agent, TISSUE_TRIAGE_AGENT, "omitted triage agent defaults to the dedicated identity");
    assert.equal(config.agents.resolution?.agent, TISSUE_RESOLVE_AGENT, "omitted resolution agent defaults to the dedicated identity");
    assert.equal(config.agents.triage?.model, undefined, "model remains an optional T8 (f) choice");
    assert.equal(config.agents.resolution?.model, undefined);

    const repo = config.repos[0] as RepositoryConfig;
    assert.equal(repo.owner, "xiaden");

    const assembly = await createProductionAssembly({
      config,
      logger,
      db: tissue.db,
      stateDir: stateRoot,
      endpoint: server.baseUrl(),
      agentsDir: deployed,
      gh: new GhClient({ binary: fake.binary }),
      now: () => new Date(clock),
    });

    await assembly.reconcile();
    assert.equal(listRepositories(tissue.db)[0]!.capability_state, "ready");
    const pass1 = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass1.errors, []);

    // Triage always sends tissue-triage, with no silently selected model.
    const triageSession = listSessions(tissue.db).find((s) => s.kind === "triage")!;
    assert.match(triageSession.id, /^ses_[A-Za-z0-9]+$/);
    assert.equal(triageSession.requested_agent, TISSUE_TRIAGE_AGENT);
    assert.equal(triageSession.requested_model_json, null);
    const triageUser = server.getRec(triageSession.id)?.messages.find((m) => m.info.role === "user");
    assert.equal((triageUser?.info as { agent?: string } | undefined)?.agent, TISSUE_TRIAGE_AGENT, "resident received the dedicated triage agent");
    assert.equal((triageUser?.info as { model?: unknown } | undefined)?.model, undefined);

    // Resolution always sends tissue-resolve (same session, no default-agent fallback).
    const resolution = getActiveResolutionSession(tissue.db, WORK_ITEM_ID)!;
    assert.match(resolution.id, /^ses_[A-Za-z0-9]+$/);
    const resolutionRow = listSessions(tissue.db).find((s) => s.id === resolution.id)!;
    assert.equal(resolutionRow.requested_agent, TISSUE_RESOLVE_AGENT);
    assert.equal(resolutionRow.requested_model_json, null);
    const resUser = server.getRec(resolution.id)?.messages.find((m) => m.info.role === "user");
    assert.equal((resUser?.info as { agent?: string } | undefined)?.agent, TISSUE_RESOLVE_AGENT, "resident received the dedicated resolution agent");
    assert.equal((resUser?.info as { model?: unknown } | undefined)?.model, undefined);

    // The resident service is never restarted by any of this.
    assert.equal(server.getRec(resolution.id)?.deleted, false);
  } finally {
    if (priorStateDir === undefined) delete process.env.TISSUE_STATE_DIR;
    else process.env.TISSUE_STATE_DIR = priorStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(deployed, { recursive: true, force: true });
    await server.close();
    fake.cleanup();
    tissue.cleanup();
    await temp.cleanup();
  }
});
