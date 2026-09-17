// tests/integration/p4-e2e-mvp.test.ts
//
// P3-S4 rewrite + P3-S5 end-to-end coverage over the REAL production assembly
// (`createProductionAssembly`), not a test-only loop:
//
//   test 1 — same-repository E2E: non-empty config + EMPTY Tissue DB (no test
//     `upsertRepository` seed), capability gating, real resident-shaped `ses_...`
//     sessions behind authenticated OpenCodeHttp, configured prompt metadata
//     (agent + model), bounded triage, claim/worktree, ordered inbox delivery to
//     the SAME resolution session across multiple events, controller-owned
//     push/PR/monitor effects, `autoMerge=false` never issuing `gh pr merge`,
//     external merge adoption, terminal cleanup, retained history, no restart.
//
//   test 2 — target/fork E2E: target `coaxk/subarr`, writable `xiaden/subarr`
//     via a configured `pushRemote`, no target-push requirement, expected head
//     owner/SHA, remote identity, base/Issues/protection checks, and rogue
//     foreign-fork drift retained as ROGUE and never adopted.
//
// Fakes are limited to external transport boundaries only:
//   - GitHub: the typed-argv fake-gh executable (no real remote mutation);
//   - OpenCode: the pessimistic loopback server behind the REAL authenticated
//     OpenCodeHttp/OpenCodeDriver transport.
// All git operations are local temporary repos. No service is restarted.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RepositoryConfig, TissueConfig } from "../../src/config/types.ts";
import { createProductionAssembly } from "../../src/runtime/entrypoint.ts";
import { installAgentDefinitions } from "../../src/runtime/resident.ts";
import { runNormalLoopPass } from "../../src/runtime/daemon.ts";
import {
  getActiveResolutionSession,
  getSideEffectFull,
  getWorkItem,
  insertSideEffect,
  listActivePullRequests,
  listInboxByWorkItem,
  listPullRequestsByWorkItem,
  listRepositories,
  listSessions,
  listWorktreesByWorkItem,
  setPollWatermark,
} from "../../src/db/repositories.ts";
import { getStateMachine } from "../../src/domain/state-machine.ts";
import {
  GhEffectTransport,
  executeVerifiedEffect,
} from "../../src/controller/effects.ts";
import { verifyRepository } from "../../src/controller/worktrees.ts";
import { GhClient } from "../../src/integrations/gh-client.ts";
import { OpenCodeHttp } from "../../src/integrations/opencode-http.ts";
import { runGit, remoteBranchSha } from "../../src/integrations/git-client.ts";
import { CapturingSink, JsonLogger } from "../../src/logging/jsonl.ts";
import { createTestDb } from "../helpers/db.ts";
import { createTempRepo } from "../helpers/git.ts";
import { defaultNomarrMeta, readEffectLog, writeFakeGh, type FakeGhScenario } from "../helpers/fake-gh.ts";
import { startPessimisticServer } from "../helpers/pessimistic-opencode-server.ts";

const BASELINE = "2026-01-01T00:00:00.000Z";
const ISSUE_CREATED = "2026-06-01T00:00:00.000Z";
const T0 = Date.parse("2026-07-01T00:00:00.000Z");
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
async function declareGithubRemote(cwd: string, bare: string, slug: string, remote = "origin"): Promise<void> {
  const url = `https://github.com/${slug}.git`;
  const existing = await runGit(["remote"], { cwd });
  if (!existing.stdout.split("\n").map((l) => l.trim()).includes(remote)) {
    await runGit(["remote", "add", remote, url], { cwd });
  } else {
    await runGit(["remote", "set-url", remote, url], { cwd });
  }
  await runGit(["config", `url.${bare}.insteadOf`, url], { cwd });
}

function productionConfig(repo: RepositoryConfig): TissueConfig {
  return {
    pollIntervalSeconds: 300,
    maxConcurrentGlobal: 3,
    retentionDays: 90,
    agents: {
      triage: { agent: "tissue-triage", model: MODEL },
      resolution: { agent: "tissue-resolve", model: MODEL },
    },
    repos: [repo],
  };
}

test("same-repository E2E: config + empty DB, same session, false autoMerge no-merge, external adoption, cleanup", async () => {
  const temp = await createTempRepo();
  const tissue = createTestDb();
  const server = await startPessimisticServer({ username: "tissue", password: "s3cret" });
  const logs = new CapturingSink();
  const logger = new JsonLogger(logs.writeable());
  const stateRoot = join(process.cwd(), ".tissue", `e2e-mvp-${process.pid}-${Date.now()}`);
  let clock = T0;

  const REPO_ID = "xiaden/nomarr";
  const WORK_ITEM_ID = "wi-xiaden-nomarr-7";
  const BRANCH = `tissue/wi_${WORK_ITEM_ID}`;

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
    // The controller polls this `updatedAt` and uses it as the re-observation
    // watermark. Derive it from the injected clock so poll ordering is a function
    // of `clock` alone, never the real wall clock.
    prCreateUpdatedAt: new Date(clock + 60_000).toISOString(),
    prChecks: { [`${REPO_ID}#101`]: [{ name: "ci", status: "IN_PROGRESS", conclusion: "PENDING" }] },
    prReviews: { [`${REPO_ID}#101`]: [] },
  };
  const fake = writeFakeGh(scenario);
  const priorStateDir = process.env.TISSUE_STATE_DIR;
  process.env.TISSUE_STATE_DIR = stateRoot;

  try {
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
      autoMerge: false,
      priority: 0,
    };
    const config = productionConfig(repo);

    // Empty Tissue DB: the repository row must come from config synchronization.
    assert.equal(listRepositories(tissue.db).length, 0, "test must not seed a repository row");

    // A credential-less resident client is rejected; the production transport authenticates.
    const bareClient = new OpenCodeHttp({ baseUrl: server.baseUrl() });
    await assert.rejects(() => bareClient.sessionStatus());
    assert.ok(server.authRejections >= 1, "resident transport enforces basic auth");

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
      registryDir,
      gh: new GhClient({ binary: fake.binary }),
      now: () => new Date(clock),
    });
    const portBefore = server.port;
    assert.ok(assembly.endpoint.startsWith("http://127.0.0.1:"), "endpoint label is credential-free");
    assert.equal(portBefore, server.port);

    // Capability gating: sync inserts the config-managed row but dispatch is refused
    // until reconcile verifies readiness.
    const gated = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.ok(gated.errors.some((e) => e.phase.startsWith("poll:")), "dispatch is gated before readiness");
    assert.deepEqual(gated.claimed, []);
    const synced = listRepositories(tissue.db);
    assert.equal(synced.length, 1, "repository row comes from config synchronization");
    assert.equal(synced[0]!.config_managed, 1);
    assert.notEqual(synced[0]!.capability_state, "ready");

    const reconcile = await assembly.reconcile();
    assert.ok(reconcile.phases.some((phase) => phase.phase === "P3"));
    assert.equal(listRepositories(tissue.db)[0]!.capability_state, "ready");

    // ---- pass 1: poll -> bounded triage -> promote -> claim -> worktree/session -> relay
    const pass1 = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass1.errors, []);
    assert.equal(pass1.issuesIngested, 1);
    assert.equal(pass1.triageRuns, 1);
    assert.deepEqual(pass1.claimed, [WORK_ITEM_ID]);

    const triageSession = listSessions(tissue.db).find((s) => s.kind === "triage");
    assert.ok(triageSession?.id.startsWith("ses_"), "real resident triage session");
    assert.equal(triageSession!.requested_agent, "tissue-triage");
    assert.deepEqual(JSON.parse(triageSession!.requested_model_json!), { providerID: "anthropic", modelID: "claude-3-5-sonnet" });
    const triageInfo = server.getRec(triageSession!.id)?.messages.find((m) => m.info.role === "user")?.info as
      | { agent?: string; model?: { providerID: string; modelID: string } }
      | undefined;
    assert.equal(triageInfo?.agent, "tissue-triage", "configured triage agent reached the resident");
    assert.deepEqual(triageInfo?.model, { providerID: "anthropic", modelID: "claude-3-5-sonnet" });

    const worktree = listWorktreesByWorkItem(tissue.db, WORK_ITEM_ID)[0];
    assert.ok(worktree && existsSync(worktree.path), "disposable worktree exists on disk");
    assert.equal(worktree!.branch, BRANCH);
    assert.equal(getWorkItem(tissue.db, WORK_ITEM_ID)?.state, "RUNNING");

    const resolution = getActiveResolutionSession(tissue.db, WORK_ITEM_ID);
    assert.match(resolution!.id, /^ses_[A-Za-z0-9]+$/, "one durable real resolution session");
    assert.equal(resolution!.directory, worktree!.path, "resolution session is bound to the worktree");
    const resRow = listSessions(tissue.db).find((s) => s.id === resolution!.id)!;
    assert.equal(resRow.requested_agent, "tissue-resolve");
    assert.deepEqual(JSON.parse(resRow.requested_model_json!), { providerID: "anthropic", modelID: "claude-3-5-sonnet" });

    const afterRelay = listInboxByWorkItem(tissue.db, WORK_ITEM_ID);
    assert.ok(afterRelay.length > 0);
    assert.ok(afterRelay.every((row) => row.state === "DELIVERING"), "204 accepted is not completion");

    // ---- pass 2: the real resolution assistant turn completes delivery; effects emitted
    server.flushAsync(resolution!.id, {
      text: JSON.stringify({ kind: "resolution", envelope_id: "env-e2e-1", work_item_id: WORK_ITEM_ID, outcome: "completed", reason: "repair complete" }),
    });
    const pass2 = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass2.errors, []);
    assert.ok(listInboxByWorkItem(tissue.db, WORK_ITEM_ID).every((row) => row.state === "DELIVERED"));
    const observed = listSessions(tissue.db).find((s) => s.id === resolution!.id)!;
    assert.equal(observed.observed_agent, "tissue-resolve");
    assert.deepEqual(JSON.parse(observed.observed_model_json!), { providerID: "anthropic", modelID: "claude-3-5-sonnet" });

    // ---- controller-owned effects: push (local bare) + PR create/adopt via fake gh
    let pass = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass.errors, []);
    const effectLog = readEffectLog(fake.effectLogPath);
    assert.equal(effectLog.some((e) => e.kind === "pr.create"), true, "controller-owned PR effect executed");
    const prs = listPullRequestsByWorkItem(tissue.db, WORK_ITEM_ID);
    assert.equal(prs.length, 1);
    assert.equal(prs[0]?.number, 101);
    // Canonical persisted state is ACTIVE, never gh's raw 'OPEN'. Assert both the
    // exact canonical value and membership in the domain PR-state vocabulary, so
    // an illegal state cannot silently regress to a non-canonical literal.
    assert.equal(prs[0]?.state, "ACTIVE");
    assert.ok(getStateMachine("pull_request").states.includes(prs[0]!.state), "persisted PR state is in the canonical domain vocabulary");
    // The controller-inserted row must be visible to the canonical active-PR read
    // BEFORE any later poll rewrites it (the old 'OPEN' value was invisible to
    // listActivePullRequests and ux_pr_one_active, causing an order-dependent flake).
    assert.ok(
      listActivePullRequests(tissue.db).some((row) => row.work_item_id === WORK_ITEM_ID && row.number === 101),
      "controller-inserted PR is immediately visible to listActivePullRequests",
    );
    assert.equal(
      tissue.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM pull_requests WHERE work_item_id = ? AND state = 'ACTIVE'", WORK_ITEM_ID)?.c,
      1,
      "exactly one ACTIVE PR per WorkItem satisfies ux_pr_one_active",
    );

    // autoMerge=false: a monitor intent exists and NO merge intent may exist.
    assert.equal(
      tissue.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM side_effects WHERE kind='merge'")?.c,
      0,
      "autoMerge=false must never create a merge effect",
    );
    assert.ok(
      tissue.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM side_effects WHERE kind='monitor'")?.c ?? 0 >= 1,
      "autoMerge=false monitors external reality",
    );

    // ---- same-session routing of a second meaningful event (PR comment)
    // Every controller-observable timestamp in this scenario derives from the
    // single injected `clock`, and the persisted poll watermark is aligned to that
    // same clock so PR re-observation is a deterministic function of `clock` — never
    // of real wall-clock ordering between the scenario mutation and the next poll.
    clock += 120_000;
    const commentAt = new Date(clock + 60_000).toISOString();
    setPollWatermark(tissue.db, "xiaden", "nomarr", new Date(clock).toISOString());
    updateScenario(fake.scenarioPath, (current) => {
      current.prComments = { [`${REPO_ID}#101`]: [{ id: "9001", body: "please address the lint", author: { login: "reviewer" }, createdAt: commentAt }] };
      // The created PR must clear the (clock-aligned) poll watermark to be
      // re-observed for comments.
      const list = (current.prList?.[REPO_ID] as Array<Record<string, unknown>> | undefined) ?? [];
      for (const pr of list) if (pr.number === 101) pr.updatedAt = commentAt;
      current.prList = { ...(current.prList ?? {}), [REPO_ID]: list };
      current.prChecks = { [`${REPO_ID}#101`]: [{ name: "ci", status: "IN_PROGRESS", conclusion: "PENDING" }] };
    });
    const pass3 = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass3.errors, []);
    const inboxDebug = listInboxByWorkItem(tissue.db, WORK_ITEM_ID).map((row) => `${row.kind}:${row.state}`);
    const prDebug = listPullRequestsByWorkItem(tissue.db, WORK_ITEM_ID).map((row) => `${row.number}:${row.state}:${row.head_ref}`);
    const comments = listInboxByWorkItem(tissue.db, WORK_ITEM_ID).filter((row) => row.kind === "pr_comment");
    assert.ok(comments.length >= 1, `PR comment routed into the durable inbox; inbox=${inboxDebug.join(",")} prs=${prDebug.join(",")}`);
    // Deterministic: the prior turn was adopted in pass 2, so no DELIVERING row
    // survives and this pass claims the new comment bundle in one step. No
    // retry/sleep/poll loop — the sequence is asserted directly.
    assert.ok(comments.every((row) => row.state === "DELIVERING"), "second event delivered to the same session, not a new session");
    assert.equal(getActiveResolutionSession(tissue.db, WORK_ITEM_ID)?.id, resolution!.id, "same resolution session reused");
    // The later, same-session delivery also carries the dedicated identity: an
    // omitted relay/config agent never becomes the resident default agent.
    const resentUser = server.getRec(resolution!.id)?.messages.filter((m) => m.info.role === "user").at(-1);
    assert.equal(
      (resentUser?.info as { agent?: string } | undefined)?.agent,
      "tissue-resolve",
      "later same-session inbox delivery uses the dedicated resolution agent",
    );
    server.flushAsync(resolution!.id, {
      text: JSON.stringify({ kind: "resolution", envelope_id: "env-e2e-2", work_item_id: WORK_ITEM_ID, outcome: "completed", reason: "lint fixed" }),
    });
    pass = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass.errors, []);
    assert.ok(listInboxByWorkItem(tissue.db, WORK_ITEM_ID).every((row) => row.state === "DELIVERED"));
    assert.equal(getActiveResolutionSession(tissue.db, WORK_ITEM_ID)?.id, resolution!.id, "same resolution session retained");

    // ---- check/human wait: pending checks + missing approval never merge (false path)
    assert.equal(readEffectLog(fake.effectLogPath).some((e) => e.kind === "pr.merge"), false, "no remote merge while gates unmet");

    // ---- external merge adoption: a human merges outside Tissue; monitor adopts it
    updateScenario(fake.scenarioPath, (current) => {
      current.prChecks = { [`${REPO_ID}#101`]: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] };
      current.prReviews = { [`${REPO_ID}#101`]: [{ id: "REV_1", state: "APPROVED", author: { login: "reviewer" } }] };
      current.prView = {
        ...(current.prView ?? {}),
        [`${REPO_ID}#101`]: { number: 101, state: "MERGED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false, reviewDecision: "APPROVED" },
      };
    });
    clock += 120_000;
    pass = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass.errors, []);
    assert.equal(getWorkItem(tissue.db, WORK_ITEM_ID)?.state, "COMPLETED", "external merge is adopted");
    assert.equal(listPullRequestsByWorkItem(tissue.db, WORK_ITEM_ID)[0]?.state, "MERGED");
    assert.equal(readEffectLog(fake.effectLogPath).some((e) => e.kind === "pr.merge"), false, "Tissue never issued gh pr merge");

    // ---- no service restart: same process/port and the same real session retained
    assert.equal(server.port, portBefore, "resident service is never restarted");
    const rec = server.getRec(resolution!.id);
    assert.ok(rec && rec.deleted === false, "resolution session survives the whole lifecycle");
    assert.ok((rec!.messages.length ?? 0) >= 4, "transcript history (two turns) is retained");

    // ---- terminal cleanup removes the disposable worktree while retaining history
    const final = await assembly.reconcile();
    assert.ok(final.phases.some((phase) => phase.phase === "P5"));
    assert.equal(existsSync(worktree!.path), false, "worktree removed after merge");
    assert.equal(listWorktreesByWorkItem(tissue.db, WORK_ITEM_ID).length, 1, "worktree history row retained");
    assert.ok(listSessions(tissue.db).some((s) => s.id === resolution!.id), "session row retained");
    assert.ok(listInboxByWorkItem(tissue.db, WORK_ITEM_ID).some((row) => row.state === "DELIVERED"), "inbox history retained");
  } finally {
    if (priorStateDir === undefined) delete process.env.TISSUE_STATE_DIR;
    else process.env.TISSUE_STATE_DIR = priorStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
    await server.close();
    fake.cleanup();
    tissue.cleanup();
    await temp.cleanup();
  }
});

test("target/fork E2E: target coaxk/subarr, writable xiaden/subarr via pushRemote, identity + rogue drift", async () => {
  const temp = await createTempRepo();
  const tissue = createTestDb();
  const server = await startPessimisticServer({ username: "tissue", password: "s3cret" });
  const logs = new CapturingSink();
  const logger = new JsonLogger(logs.writeable());
  const stateRoot = join(process.cwd(), ".tissue", `e2e-fork-${process.pid}-${Date.now()}`);
  let clock = T0;

  const TARGET = "coaxk/subarr";
  const PUSH = "xiaden/subarr";
  const WORK_ITEM_ID = "wi-coaxk-subarr-5";
  const BRANCH = `tissue/wi_${WORK_ITEM_ID}`;

  const scenario: FakeGhScenario = {
    meta: {
      [`repos/${TARGET}`]: { default_branch: "main", has_issues: true, permissions: { admin: false, push: false, pull: true } },
      [`repos/${PUSH}`]: { default_branch: "main", has_issues: true, permissions: { admin: false, push: true, pull: true } },
    },
    issueList: {
      [TARGET]: [{ number: 5, title: "harden parser", body: "details", state: "OPEN", updatedAt: ISSUE_CREATED, createdAt: ISSUE_CREATED, labels: [] }],
    },
    protection: {
      [`repos/${TARGET}/branches/main/protection`]: {
        required_status_checks: { contexts: ["ci"], checks: [] },
        required_pull_request_reviews: { required_approving_review_count: 1 },
        enforce_admins: { enabled: false },
      },
    },
    prCreateNumber: 201,
    prChecks: { [`${TARGET}#201`]: [{ name: "ci", status: "IN_PROGRESS", conclusion: "PENDING" }] },
    prReviews: { [`${TARGET}#201`]: [] },
  };
  const fake = writeFakeGh(scenario);
  const priorStateDir = process.env.TISSUE_STATE_DIR;
  process.env.TISSUE_STATE_DIR = stateRoot;

  try {
    await declareGithubRemote(temp.clone, temp.bare, TARGET, "origin");
    await declareGithubRemote(temp.clone, temp.bare, PUSH, "fork");

    const repo: RepositoryConfig = {
      owner: "coaxk",
      name: "subarr",
      remote: `https://github.com/${TARGET}.git`,
      targetOwner: "coaxk",
      targetName: "subarr",
      pushOwner: "xiaden",
      pushName: "subarr",
      pushRemote: "fork",
      localDir: temp.clone,
      baselineBefore: BASELINE,
      enabled: true,
      pollIntervalSeconds: 300,
      maxConcurrentPerRepo: 1,
      baseBranch: "main",
      labels: [],
      autoMerge: false,
      priority: 0,
    };
    const config = productionConfig({ ...repo, owner: "coaxk", name: "subarr" });

    assert.equal(listRepositories(tissue.db).length, 0, "test must not seed a repository row");

    const gh = new GhClient({ binary: fake.binary });

    // Remote identity + capability: target is read-only, the configured push repo is writable.
    const targetMeta = await gh.repoMeta({ owner: "coaxk", name: "subarr" });
    assert.equal(targetMeta.permissions?.push, false, "target repository is not writable");
    const pushMeta = await gh.repoMeta({ owner: "xiaden", name: "subarr" });
    assert.equal(pushMeta.permissions?.push, true, "configured push repository is writable");
    const cap = await verifyRepository(repo, gh);
    assert.equal(cap.pushRemote, "fork");
    assert.equal(cap.pushRemotePresent, true);
    assert.equal(cap.pushRemoteMatchesExpected, true);
    assert.equal(cap.writablePushVerified, true);
    assert.equal(cap.pushPermission, true, "writable push repo supplies push permission");
    assert.equal(cap.checkoutRemoteMatchesTarget, true, "origin tracks the target");
    assert.equal(cap.baseBranchMatchesDefault, true);
    assert.equal(cap.issuesEnabled, true);
    assert.equal(cap.protection.enabled, true);
    assert.equal(cap.readiness.ready, true, cap.readiness.reasons.join("; "));

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
      registryDir,
      gh,
      now: () => new Date(clock),
    });
    const portBefore = server.port;

    const reconcile = await assembly.reconcile();
    assert.ok(reconcile.phases.some((phase) => phase.phase === "P3"));

    const pass1 = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass1.errors, []);
    assert.deepEqual(pass1.claimed, [WORK_ITEM_ID]);

    const worktree = listWorktreesByWorkItem(tissue.db, WORK_ITEM_ID)[0];
    assert.ok(worktree && existsSync(worktree.path));
    const resolution = getActiveResolutionSession(tissue.db, WORK_ITEM_ID);
    assert.ok(resolution?.id.startsWith("ses_"));

    server.flushAsync(resolution!.id, {
      text: JSON.stringify({ kind: "resolution", envelope_id: "env-fork-1", work_item_id: WORK_ITEM_ID, outcome: "completed", reason: "repair complete" }),
    });
    let pass = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass.errors, []);
    pass = await runNormalLoopPass(tissue.db, config, assembly.normalLoop);
    assert.deepEqual(pass.errors, []);

    const pushEffect = getSideEffectFull(tissue.db, `fx-push-${WORK_ITEM_ID}`);
    assert.ok(pushEffect, "controller created the push intent");
    assert.equal(pushEffect!.state, "DONE", "push verified against the configured remote");
    const pushPayload = JSON.parse(pushEffect!.payload_json) as { push_remote: string; head_sha: string };
    assert.equal(pushPayload.push_remote, "fork", "push uses the configured pushRemote");
    const branchSha = await remoteBranchSha(temp.clone, BRANCH, "fork");
    assert.equal(branchSha, pushPayload.head_sha, "writable fork actually received the controller branch");

    const prs = listPullRequestsByWorkItem(tissue.db, WORK_ITEM_ID);
    assert.equal(prs.length, 1);
    assert.equal(prs[0]?.number, 201);
    assert.equal(readEffectLog(fake.effectLogPath).some((e) => e.kind === "pr.create"), true);
    // Expected head identity: the PR head owner is the writable push owner, not the target.
    const createdPr = (JSON.parse(readFileSync(fake.scenarioPath, "utf8")) as FakeGhScenario).prView?.[`${TARGET}#201`] as
      | { headRepositoryOwner?: { login?: string } }
      | undefined;
    assert.equal(createdPr?.headRepositoryOwner?.login, "xiaden", "PR head owner matches the writable fork");

    // ---- rogue same-branch foreign fork: recorded ROGUE, never adopted
    updateScenario(fake.scenarioPath, (current) => {
      const list = Array.isArray(current.prList?.[TARGET]) ? (current.prList![TARGET] as unknown[]) : [];
      current.prList = {
        ...(current.prList ?? {}),
        [TARGET]: [
          ...list,
          {
            number: 999,
            state: "OPEN",
            headRefName: "tissue/wi_wi-coaxk-subarr-99",
            headRefOid: "f".repeat(40),
            headRepositoryOwner: { login: "rogue-owner" },
            headRepository: { nameWithOwner: "rogue-owner/subarr" },
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            isDraft: false,
            reviewDecision: "",
          },
        ],
      };
    });
    insertSideEffect(tissue.db, {
      id: "eff-rogue-pr",
      kind: "pr",
      effect_key: "pr:rogue:99",
      state: "PENDING",
      payload_json: JSON.stringify({
        owner: "coaxk",
        name: "subarr",
        push_owner: "xiaden",
        push_name: "subarr",
        push_remote: "fork",
        work_item_id: WORK_ITEM_ID,
        head_ref: "tissue/wi_wi-coaxk-subarr-99",
        head_sha: "f".repeat(40),
        base_branch: "main",
        title: "rogue",
        body: "",
      }),
    });
    const rogue = await executeVerifiedEffect(tissue.db, "eff-rogue-pr", new GhEffectTransport({ gh }), { now: new Date(clock) });
    assert.equal(rogue.status, "retry");
    assert.equal(rogue.reason, "pr_identity_foreign_fork");
    const rogueRow = tissue.db.sql.get<{ id: string; state: string; origin: string }>(
      "SELECT id, state, origin FROM pull_requests WHERE id = ?",
      `pr-${WORK_ITEM_ID}-999-rogue`,
    );
    assert.equal(rogueRow?.state, "ROGUE", "foreign fork evidence retained as ROGUE");
    assert.equal(rogueRow?.origin, "rogue");
    assert.equal(
      readEffectLog(fake.effectLogPath).filter((e) => e.kind === "pr.create").length,
      1,
      "rogue fork is never created/adopted (only the controller PR was created)",
    );

    assert.equal(server.port, portBefore, "resident service is never restarted");
  } finally {
    if (priorStateDir === undefined) delete process.env.TISSUE_STATE_DIR;
    else process.env.TISSUE_STATE_DIR = priorStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
    await server.close();
    fake.cleanup();
    tissue.cleanup();
    await temp.cleanup();
  }
});
