import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  GhArgError,
  GhClient,
  argvIssueComment,
  argvIssueList,
  argvPrCreate,
  argvPrMerge,
  argvProtection,
} from "../../src/integrations/gh-client.ts";
import { buildTriageDigest } from "../../src/controller/triage.ts";
import { applyEnvelope, EnvelopeValidationError } from "../../src/domain/envelopes.ts";
import { runWrite } from "../../src/db/open.ts";
import { createWorktree } from "../../src/controller/worktrees.ts";
import { isPathIgnored, runGit } from "../../src/integrations/git-client.ts";
import { createTestDb, seedIssue, seedRepository } from "../helpers/db.ts";
import { createTempRepo } from "../helpers/git.ts";
import { defaultNomarrMeta, readEffectLog, writeFakeGh } from "../helpers/fake-gh.ts";
import { openTissueDb, closeDb, TissueDbError } from "../../src/db/open.ts";
import { parseConfig } from "../../src/config/load.ts";

const hostile = "$(id); `touch /tmp/pwned`; &&\u0000 control\nreview [ghp_ABCDEFGHIJKLMNOP]";

function baseYaml(state: string): string {
  return `repos:\n  - owner: xiaden\n    name: nomarr\n    localDir: ${state}/repo\n`;
}

test("hostile GitHub text stays bounded data and control characters are sanitized", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const issue = seedIssue(t.db, repo.id, { title: hostile, body_json: JSON.stringify(hostile) });
    const digest = buildTriageDigest(t.db, repo, issue);
    assert.ok(digest.titlePreview.length <= 201);
    assert.ok(digest.bodyPreview.length <= 1001);
    assert.doesNotMatch(digest.bodyPreview, /[\u0000-\u001f\u007f]/);
    assert.match(digest.bodyPreview, /\$\(id\)/);
  } finally { t.cleanup(); }
});

test("typed gh argv uses fixed JSON, controller branch, and no shell syntax", () => {
  const list = argvIssueList({ owner: "xiaden", name: "nomarr", state: "open", limit: 20 });
  assert.deepEqual(list, ["issue", "list", "-R", "xiaden/nomarr", "--state", "open", "--limit", "20", "--json", "number,title,labels,updatedAt,state,createdAt"]);
  assert.deepEqual(argvProtection({ owner: "xiaden", name: "nomarr", branch: "main" }), ["api", "repos/xiaden/nomarr/branches/main/protection"]);
  assert.deepEqual(argvIssueComment("xiaden", "nomarr", 4).slice(-2), ["--body-file", "-"]);
  assert.deepEqual(argvPrMerge("xiaden", "nomarr", 4, "squash").slice(-1), ["--squash"]);
  assert.throws(() => argvPrCreate({ owner: "xiaden", name: "nomarr", head: "feature/hostile", base: "main", title: hostile }), GhArgError);
  for (const arg of list) assert.doesNotMatch(arg, /[;$`|\s]/);
});

test("effect body travels on stdin and is not executed or logged as argv", async () => {
  const fake = writeFakeGh({ meta: defaultNomarrMeta() });
  try {
    const gh = new GhClient({ binary: fake.binary });
    await gh.run(argvIssueComment("xiaden", "nomarr", 42), { stdinData: hostile });
    const row = readEffectLog(fake.effectLogPath)[0];
    assert.equal(row?.body, hostile);
    assert.equal(row?.number, 42);
    assert.equal(row?.argv, undefined);
  } finally { fake.cleanup(); }
});

test("injected envelopes cannot create lifecycle identities and duplicate is a durable no-op", () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    const issue = seedIssue(t.db, repo.id, { state: "TRIAGE_PENDING" });
    assert.throws(() => runWrite(t.db, (tx) => applyEnvelope(tx, { kind: "triage", envelope_id: hostile, issue_id: issue.id, disposition: "READY" })), EnvelopeValidationError);
      const first = runWrite(t.db, (tx) => applyEnvelope(tx, { kind: "triage", envelope_id: "env-1", issue_id: issue.id, disposition: "READY" }));
    assert.equal(first.status, "applied");
    const duplicate = runWrite(t.db, (tx) => applyEnvelope(tx, { kind: "triage", envelope_id: "env-1", issue_id: issue.id, disposition: "READY" }));
    assert.equal(duplicate.status, "noop_duplicate");
    assert.equal((t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM opencode_sessions")?.c ?? -1), 0);
    assert.equal((t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM worktrees")?.c ?? -1), 0);
  } finally { t.cleanup(); }
});

test("worktree excludes .tissue from git add -A and only generates controller branches", async () => {
  const tr = await createTempRepo();
  // P3-S7: isolate the linked worktree under a per-run state dir and remove it so
  // repeated `npm test` runs are deterministic (the shared default dir previously
  // left `xiaden-nomarr/wi-hostile-1` behind and failed the second run). Assertions
  // are unchanged.
  const state = mkdtempSync(join(tmpdir(), "tissue-p3-sec-"));
  const previous = process.env.TISSUE_STATE_DIR;
  process.env.TISSUE_STATE_DIR = state;
  try {
    const identity = await createWorktree({ owner: "xiaden", name: "nomarr", localDir: tr.clone, enabled: true, pollIntervalSeconds: 300, maxConcurrentPerRepo: 1, baseBranch: "main", labels: [], autoMerge: false, priority: 0 }, "wi-hostile-1");
    mkdirSync(join(identity.worktreeDir, ".tissue"), { recursive: true });
    writeFileSync(join(identity.worktreeDir, ".tissue", "body.txt"), hostile);
    writeFileSync(join(identity.worktreeDir, "tracked.txt"), "safe\n");
    assert.equal(await isPathIgnored(identity.worktreeDir, ".tissue/body.txt"), true);
    const result = await runGit(["add", "-A"], { cwd: identity.worktreeDir });
    assert.equal(result.exitCode, 0);
    const staged = (await runGit(["diff", "--cached", "--name-only"], { cwd: identity.worktreeDir })).stdout;
    assert.equal(staged.trim(), "tracked.txt");
  } finally {
    if (previous === undefined) delete process.env.TISSUE_STATE_DIR;
    else process.env.TISSUE_STATE_DIR = previous;
    tr.cleanup();
    rmSync(state, { recursive: true, force: true });
  }
});

test("separate Tissue DB has restrictive state permissions and refuses OpenCode state", () => {
  const root = join(tmpdir(), `tissue-sec-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "tissue.db");
  const db = openTissueDb(path);
  closeDb(db);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.throws(() => openTissueDb(join(process.env.HOME ?? "/root", ".local/share/opencode", "blocked.db")), TissueDbError);
});

test("T8(b), T8(c), and T8(j) remain explicit unresolved decisions with truthful cleanup evidence", () => {
  const artifact = readFileSync("artifacts/designs/process/tissue-t8-phase3-security.md", "utf8");
  for (const row of ["T8 (b)", "T8 (c)", "T8 (j)"]) {
    const start = artifact.indexOf(`## ${row}`);
    assert.notEqual(start, -1, `${row} row is present`);
    const end = artifact.indexOf("\n## ", start + 1);
    const section = artifact.slice(start, end === -1 ? undefined : end);
    assert.match(section, /Status: `NEEDS_DECISION`/);
    assert.match(section, /Owner:/);
    assert.match(section, /Deadline:/);
  }
  const cleanup = artifact.slice(artifact.indexOf("## T8 (c)"), artifact.indexOf("\n## T8 (j)"));
  assert.match(cleanup, /implementation evidence is valid only because shared `cleanupOperation` emits retained, redacted human-inspect `ERROR` JSONL/);
  assert.match(cleanup, /human-only disposition/);
  assert.match(cleanup, /failure preserves `FAILED_HOLD`/);
  assert.match(cleanup, /does not resolve the owner or release decision/);
  assert.doesNotMatch(artifact, /T8 \([bcj]\)[\\s\\S]{0,500}Status: `PASS`/);
  assert.match(artifact, /no authenticated remote audit or RG evidence is represented here/);
});

test("configuration rejects injected keys and credential material", () => {
  assert.throws(() => parseConfig(baseYaml("/tmp/state") + "    token: ghp_ABCDEFGHIJKLMNOP\n"));
  assert.throws(() => parseConfig(baseYaml("/tmp/state").replace("localDir: /tmp/state/repo", "localDir: /tmp/state/repo\u0000")));
});
