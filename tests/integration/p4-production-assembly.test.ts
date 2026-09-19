// tests/integration/p4-production-assembly.test.ts
//
// P3-S4 (rewritten): exercise the SAME assembly `tissue daemon` uses, starting
// from a NON-EMPTY config and an EMPTY Tissue DB. The repository row must come
// from config synchronization (config_managed = 1), never a test seeding an
// upsertRepository row, and every dispatch must pass the persisted-readiness
// gate before it runs.
//
// Fakes are limited to external transport boundaries:
//   - GitHub: the typed-argv fake-gh executable;
//   - OpenCode: the pessimistic loopback server behind the REAL authenticated
//     OpenCodeHttp/OpenCodeDriver transport.
// No semantic driver, effect, transition, completion, or cleanup is injected.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RepositoryConfig, TissueConfig } from "../../src/config/types.ts";
import { createProductionAssembly } from "../../src/runtime/entrypoint.ts";
import { installAgentDefinitions, installModerationPlugin } from "../../src/runtime/resident.ts";
import { runNormalLoopPass } from "../../src/runtime/daemon.ts";
import {
  getActiveResolutionSession,
  getWorkItem,
  listInboxByWorkItem,
  listPullRequestsByWorkItem,
  listRepositories,
  listSessions,
  listWorktreesByWorkItem,
} from "../../src/db/repositories.ts";
import { GhClient } from "../../src/integrations/gh-client.ts";
import { runGit } from "../../src/integrations/git-client.ts";
import { OpenCodeHttp } from "../../src/integrations/opencode-http.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import { createTestDb } from "../helpers/db.ts";
import { createTempRepo } from "../helpers/git.ts";
import { defaultNomarrMeta, readEffectLog, writeFakeGh, type FakeGhScenario } from "../helpers/fake-gh.ts";
import { startPessimisticServer } from "../helpers/pessimistic-opencode-server.ts";

const REPO_ID = "xiaden/nomarr";
const WORK_ITEM_ID = "wi-xiaden-nomarr-7";
const BASELINE = "2026-01-01T00:00:00.000Z";
const ISSUE_CREATED = "2026-06-01T00:00:00.000Z";
const T0 = Date.parse("2026-07-01T00:00:00.000Z");
const BRANCH = `tissue/wi_${WORK_ITEM_ID}`;
const MODEL = "anthropic/claude-3-5-sonnet";

/**
 * Deploy the checked-in dedicated Tissue agents into `dir` (inside the test state
 * root). Production validates THAT deployment, never `<Tissue>/agents`, and the
 * directory is removed with the rest of the state root.
 */
function deployAgents(dir: string): string {
  const status = installAgentDefinitions({ targetDir: dir });
  assert.equal(status.ok, true, status.errors.join("; "));
  return dir;
}

function updateScenario(path: string, update: (scenario: FakeGhScenario) => void): void {
  const scenario = JSON.parse(readFileSync(path, "utf8")) as FakeGhScenario;
  update(scenario);
  writeFileSync(path, JSON.stringify(scenario));
}

/** Point a checkout's declared origin at a GitHub slug while routing git transport locally. */
async function declareGithubRemote(cwd: string, bare: string, slug: string): Promise<void> {
  const url = `https://github.com/${slug}.git`;
  await runGit(["remote", "set-url", "origin", url], { cwd });
  await runGit(["config", `url.${bare}.insteadOf`, url], { cwd });
}

test("production assembly starts from config + empty DB and completes the lifecycle under readiness gating", async () => {
  let temp: Awaited<ReturnType<typeof createTempRepo>> | undefined;
  let tissue: ReturnType<typeof createTestDb> | undefined;
  let server: Awaited<ReturnType<typeof startPessimisticServer>> | undefined;
  const logs = new CapturingSink();
  const logger = new JsonLogger(logs.writeable());
  let stateRoot: string | undefined;
  let pluginDir: string | undefined;
  let moderationDir: string | undefined;
  const priorModerationDir = process.env.TISSUE_MODERATION_DIR;
  const priorStateDir = process.env.TISSUE_STATE_DIR;
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
  let fake: ReturnType<typeof writeFakeGh> | undefined;

  try {
    temp = await createTempRepo();
    tissue = createTestDb();
    server = await startPessimisticServer({ username: "tissue", password: "s3cret" });
    stateRoot = join(process.cwd(), ".tissue", `production-${process.pid}-${Date.now()}`);
    pluginDir = mkdtempSync(join(tmpdir(), "tissue-p4-production-plugin-"));
    moderationDir = mkdtempSync(join(tmpdir(), "tissue-p4-production-moderation-"));
    const pluginInstall = installModerationPlugin({ pluginsDir: pluginDir, moderationDir, restartEpoch: T0 });
    assert.equal(pluginInstall.ok, true, pluginInstall.errors.join("; "));
    writeFileSync(join(moderationDir, "plugin-loaded.json"), JSON.stringify({ kind: "loaded", pluginSha256: pluginInstall.deployedSha256, serverStartedAt: T0 + 1 }));
    process.env.TISSUE_MODERATION_DIR = moderationDir;
    fake = writeFakeGh(scenario);
    process.env.TISSUE_STATE_DIR = stateRoot;
    await declareGithubRemote(temp.clone, temp.bare, REPO_ID);

    const repo: RepositoryConfig = {
      owner: "xiaden",
      name: "nomarr",
      remote: `https://github.com/${REPO_ID}.git`,
      localDir: temp.clone,
      baselineBefore: BASELINE,
      enabled: true,
      pollIntervalSeconds: 300,
      maxConcurrentPerRepo: 1,
      baseBranch: "main",
      labels: [],
      autoMerge: true,
      priority: 0,
    };
    const config: TissueConfig = {
      pollIntervalSeconds: 300,
      maxConcurrentGlobal: 3,
      retentionDays: 90,
      agents: { triage: { agent: "tissue-triage", model: MODEL }, resolution: { agent: "tissue-resolve", model: MODEL } },
      repos: [repo],
    };

    // Empty Tissue DB: no repository row was seeded by the test.
    assert.equal(listRepositories(tissue.db).length, 0, "test must not seed a repository row");

    // The resident endpoint requires authentication; a credential-less client is rejected.
    const unauthenticated = new OpenCodeHttp({ baseUrl: server.baseUrl() });
    await assert.rejects(() => unauthenticated.sessionStatus());
    assert.ok(server.authRejections >= 1, "resident transport enforces basic auth");

    // ---- production assembly (validates endpoint before attaching credentials)
    const registryDir = join(stateRoot, "registry");
    mkdirSync(registryDir, { recursive: true });
    const assembly = await createProductionAssembly({
      config,
      logger,
      db: tissue.db,
      stateDir: stateRoot,
      endpoint: server.baseUrl(),
      credentials: { username: "tissue", password: "s3cret" },
       agentsDir: deployAgents(join(stateRoot, "opencode-agents")),
       pluginsDir: pluginDir,
       registryDir,
      gh: new GhClient({ binary: fake.binary }),
      now: () => new Date(clock),
    });
    const portBefore = server.port;
    assert.equal(assembly.endpoint, server.baseUrl(), "endpoint label is credential-free");
    assert.ok(assembly.agentDefinitions.ok, "host-global agent definitions validate");

    // ---- capability gating: sync inserts the config-managed row but dispatch is refused
    const gated = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    const gatedPhases = gated.errors.map((e) => e.phase);
    assert.ok(gatedPhases.some((p) => p.startsWith("poll:")), "dispatch is gated before readiness");
    assert.deepEqual(gated.claimed, [], "nothing is claimed before readiness");
    const synced = listRepositories(tissue.db);
    assert.equal(synced.length, 1, "repository row comes from config synchronization");
    assert.equal(synced[0]!.config_managed, 1);
    assert.notEqual(synced[0]!.capability_state, "ready");

    // ---- production reconcile verifies capability and persists readiness
    const reconcile = await assembly.reconcile();
    assert.ok(reconcile.phases.some((phase) => phase.phase === "P3"));
    assert.equal(listRepositories(tissue.db)[0]!.capability_state, "ready");

    // ---- pass 1: poll -> bounded triage -> promote -> claim -> worktree/session -> relay
    const pass1 = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass1.errors, []);
    assert.equal(pass1.issuesIngested, 1);
    assert.equal(pass1.triageRuns, 1);
    assert.deepEqual(pass1.claimed, [WORK_ITEM_ID]);
    assert.equal(getWorkItem(tissue.db, WORK_ITEM_ID)?.state, "RUNNING");

    const triageSession = listSessions(tissue.db).find((s) => s.kind === "triage");
    assert.ok(triageSession?.id.startsWith("ses_"), "real resident triage session");
    assert.equal(triageSession!.requested_agent, "tissue-triage");
    assert.deepEqual(JSON.parse(triageSession!.requested_model_json!), { providerID: "anthropic", modelID: "claude-3-5-sonnet" });
    const triageUser = server.getRec(triageSession!.id)?.messages.find((m) => m.info.role === "user");
    const triageInfo = triageUser?.info as { role: "user"; agent?: string; model?: { providerID: string; modelID: string } } | undefined;
    assert.equal(triageInfo?.agent, "tissue-triage", "configured triage agent reached the resident");
    assert.deepEqual(triageInfo?.model, { providerID: "anthropic", modelID: "claude-3-5-sonnet" });
    assert.equal(triageSession!.observed_agent, "tissue-triage", "observed metadata is retained separately");
    assert.deepEqual(JSON.parse(triageSession!.observed_model_json!), { providerID: "anthropic", modelID: "claude-3-5-sonnet" });

    const worktree = listWorktreesByWorkItem(tissue.db, WORK_ITEM_ID)[0];
    assert.ok(worktree && existsSync(worktree.path), "disposable worktree exists on disk");
    assert.equal(worktree!.branch, BRANCH);

    const resolution = getActiveResolutionSession(tissue.db, WORK_ITEM_ID);
    assert.match(resolution!.id, /^ses_[A-Za-z0-9]+$/);
    assert.equal(resolution!.directory, worktree!.path, "resolution session is bound to the worktree");
    const resRow = listSessions(tissue.db).find((s) => s.id === resolution!.id)!;
    assert.equal(resRow.requested_agent, "tissue-resolve");
    assert.deepEqual(JSON.parse(resRow.requested_model_json!), { providerID: "anthropic", modelID: "claude-3-5-sonnet" });

    const afterRelay = listInboxByWorkItem(tissue.db, WORK_ITEM_ID);
    assert.ok(afterRelay.length > 0);
    assert.ok(afterRelay.every((row) => row.state === "DELIVERING"), "204 accepted is not completion");
    const resUser = server.getRec(resolution!.id)?.messages.find((m) => m.info.role === "user");
    const resInfo = resUser?.info as { role: "user"; agent?: string; model?: { providerID: string; modelID: string } } | undefined;
    assert.equal(resInfo?.agent, "tissue-resolve", "configured resolution agent preserved on inbox prompt");
    assert.deepEqual(resInfo?.model, { providerID: "anthropic", modelID: "claude-3-5-sonnet" });

    // ---- pass 2: real assistant turn completes delivery; controller emits push/PR/merge
    server.flushAsync(resolution!.id, {
      text: JSON.stringify({ kind: "resolution", envelope_id: "env-production-1", work_item_id: WORK_ITEM_ID, outcome: "completed", reason: "repair complete" }),
    });
    const pass2 = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass2.errors, []);
    assert.ok(listInboxByWorkItem(tissue.db, WORK_ITEM_ID).every((row) => row.state === "DELIVERED"));
    let pass = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass.errors, []);
    assert.equal(readEffectLog(fake.effectLogPath).some((e) => e.kind === "pr.create"), true, "controller-owned effects executed");
    assert.equal(listPullRequestsByWorkItem(tissue.db, WORK_ITEM_ID)[0]?.number, 101);

    const observed = listSessions(tissue.db).find((s) => s.id === resolution!.id)!;
    assert.equal(observed.observed_agent, "tissue-resolve");
    assert.deepEqual(JSON.parse(observed.observed_model_json!), { providerID: "anthropic", modelID: "claude-3-5-sonnet" });

    // ---- gates: autoMerge is true but protection gates are unmet -> held
    pass = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass.errors, []);
    assert.equal(getWorkItem(tissue.db, WORK_ITEM_ID)?.state, "WAITING");
    assert.equal(readEffectLog(fake.effectLogPath).some((e) => e.kind === "pr.merge"), false, "no merge before gates pass");

    // ---- gates pass externally (fake boundary): eventually merges to COMPLETED
    updateScenario(fake.scenarioPath, (current) => {
      current.prChecks = { [`${REPO_ID}#101`]: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] };
      current.prReviews = { [`${REPO_ID}#101`]: [{ id: "REV_1", state: "APPROVED", author: { login: "reviewer" } }] };
    });
    clock += 120_000;
    let completed = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      pass = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
      assert.deepEqual(pass.errors, []);
      completed = getWorkItem(tissue.db, WORK_ITEM_ID)?.state === "COMPLETED";
      if (completed) break;
    }
    assert.equal(completed, true);
    assert.equal(listPullRequestsByWorkItem(tissue.db, WORK_ITEM_ID)[0]?.state, "MERGED");

    // ---- no service restart: same process/port, same real session, retained history
    assert.equal(server.port, portBefore, "resident service is never restarted");
    const rec = server.getRec(resolution!.id);
    assert.ok(rec, "resolution session survives the whole lifecycle");
    assert.equal(rec!.deleted, false);
    assert.ok((rec!.messages.length ?? 0) >= 2, "transcript history is retained");

    // ---- terminal reconcile cleans the disposable worktree while retaining history
    const final = await assembly.reconcile();
    assert.ok(final.phases.some((phase) => phase.phase === "P5"));
    assert.equal(existsSync(worktree!.path), false, "worktree removed after merge");
    assert.equal(listWorktreesByWorkItem(tissue.db, WORK_ITEM_ID).length, 1, "worktree history row retained");
    assert.ok(listSessions(tissue.db).some((s) => s.id === resolution!.id));
    assert.ok(listInboxByWorkItem(tissue.db, WORK_ITEM_ID).some((row) => row.state === "DELIVERED"), "inbox history is retained");
  } finally {
    if (priorStateDir === undefined) delete process.env.TISSUE_STATE_DIR;
    else process.env.TISSUE_STATE_DIR = priorStateDir;
    if (priorModerationDir === undefined) delete process.env.TISSUE_MODERATION_DIR;
    else process.env.TISSUE_MODERATION_DIR = priorModerationDir;
    if (stateRoot) rmSync(stateRoot, { recursive: true, force: true });
    if (pluginDir) rmSync(pluginDir, { recursive: true, force: true });
    if (moderationDir) rmSync(moderationDir, { recursive: true, force: true });
    if (server) await server.close();
    if (fake) fake.cleanup();
    if (tissue) tissue.cleanup();
    if (temp) await temp.cleanup();
  }
});
