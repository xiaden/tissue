// tests/integration/effects.test.ts
//
// P2-S3 spec-first tests for verified side effects: only committed outbox
// intents execute, every effect is re-verified before DONE, merge is guarded by
// protection/checks/reviews/mergeability (human approval -> WAITING, never
// bypassed), and already-merged/closed/not-found reality is adopted instead of
// duplicated. Also exercises the production GhEffectTransport through the SAME
// typed-argv path against fake-gh (no real remote mutation).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  GhEffectTransport,
  executeVerifiedEffect,
  type CheckView,
  type EffectTransport,
  type PrView,
  type ProtectionRead,
  type ReviewView,
} from "../../src/controller/effects.ts";
import { argvPrMerge, GhClient, GhError } from "../../src/integrations/gh-client.ts";
import { pushBranch, runGit } from "../../src/integrations/git-client.ts";
import {
  addWorkItemDependency,
  getSideEffectFull,
  listTransitions,
  insertPullRequest,
  insertSideEffect,
  insertWorkItem,
} from "../../src/db/repositories.ts";
import { createTestDb, seedRepository } from "../helpers/db.ts";
import { claimNextWorkItem } from "../../src/controller/queue.ts";
import { createTempRepo } from "../helpers/git.ts";
import { defaultNomarrMeta, readEffectLog, writeFakeGh } from "../helpers/fake-gh.ts";

const WI = "wi-xiaden-nomarr-7";

function openPr(number: number): PrView {
  return { number, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false, reviewDecision: "", headOwner: "xiaden", headRepo: "xiaden/nomarr" };
}

class FakeTransport implements EffectTransport {
  issueStates = new Map<number, string>();
  prs = new Map<number, PrView>();
  prByHead = new Map<string, PrView>();
  protection: ProtectionRead = { enabled: false, requiredApprovals: 0, enforceAdmins: false, requiredChecks: [] };
  checks: CheckView[] = [];
  reviews: ReviewView[] = [];
  calls: string[] = [];
  remoteSha: string | null = null;
  throwOn = new Map<string, unknown>();

  private maybeThrow(op: string): void {
    if (this.throwOn.has(op)) throw this.throwOn.get(op);
  }

  async pushHead(_dir: string, _branch: string, _sha: string): Promise<{ remoteSha: string | null }> {
    this.calls.push("push");
    this.maybeThrow("push");
    return { remoteSha: this.remoteSha };
  }
  async readIssueState(_o: string, _n: string, number: number): Promise<{ state: string } | null> {
    const state = this.issueStates.get(number);
    return state ? { state } : null;
  }
  async commentIssue(): Promise<{ id: string | null }> {
    this.calls.push("comment");
    this.maybeThrow("comment");
    return { id: "C_1" };
  }
  async closeIssue(_o: string, _n: string, number: number): Promise<void> {
    this.calls.push("close");
    this.maybeThrow("close");
    this.issueStates.set(number, "CLOSED");
  }
  async reopenIssue(_o: string, _n: string, number: number): Promise<void> {
    this.calls.push("reopen");
    this.issueStates.set(number, "OPEN");
  }
  async createPr(_o: string, _n: string, head: string, _b: string, _t: string, _body: string): Promise<{ number: number | null }> {
    this.calls.push("createPr");
    this.maybeThrow("createPr");
    const pr = openPr(101);
    this.prs.set(101, pr);
    this.prByHead.set(head, pr);
    return { number: 101 };
  }
  async findPrByHead(_o: string, _n: string, headRef: string): Promise<PrView | null> {
    return this.prByHead.get(headRef) ?? null;
  }
  async readPr(_o: string, _n: string, number: number): Promise<PrView | null> {
    this.maybeThrow("readPr");
    return this.prs.get(number) ?? null;
  }
  async readProtection(): Promise<ProtectionRead> {
    return this.protection;
  }
  async readChecks(): Promise<CheckView[]> {
    return this.checks;
  }
  async readReviews(): Promise<ReviewView[]> {
    return this.reviews;
  }
  async mergePr(_o: string, _n: string, number: number): Promise<void> {
    this.calls.push("mergePr");
    this.maybeThrow("mergePr");
    const pr = this.prs.get(number);
    if (pr) this.prs.set(number, { ...pr, state: "MERGED" });
  }
}

function seedEffect(
  db: ReturnType<typeof createTestDb>["db"],
  kind: string,
  payload: Record<string, unknown>,
  id = `eff-${kind}`,
): string {
  insertSideEffect(db, {
    id,
    kind,
    effect_key: `${kind}:${id}`,
    state: "PENDING",
    payload_json: JSON.stringify({ owner: "xiaden", name: "nomarr", work_item_id: WI, ...payload }),
  });
  return id;
}

test("comment effect executes once and is an auditable no-op when DONE", async () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    const id = seedEffect(t.db, "comment", { issue_number: 7, body: "hello" });
    const tr = new FakeTransport();
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "done");
    assert.equal(tr.calls.filter((c) => c === "comment").length, 1);
    const again = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(again.status, "already_done");
    assert.equal(tr.calls.filter((c) => c === "comment").length, 1);
  } finally {
    t.cleanup();
  }
});

test("close adopts an already-closed issue instead of re-closing", async () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    const id = seedEffect(t.db, "close", { issue_number: 7 });
    const tr = new FakeTransport();
    tr.issueStates.set(7, "CLOSED");
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "adopted");
    assert.equal(tr.calls.includes("close"), false);
  } finally {
    t.cleanup();
  }
});

test("close mutates then verifies the new state before DONE", async () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    const id = seedEffect(t.db, "close", { issue_number: 7 });
    const tr = new FakeTransport();
    tr.issueStates.set(7, "OPEN");
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "done");
    assert.equal(tr.issueStates.get(7), "CLOSED");
  } finally {
    t.cleanup();
  }
});

test("push requires the remote SHA to match before DONE", async () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    const sha = "a".repeat(40);
    const id = seedEffect(t.db, "push", { dir: "/workspace/nomarr", head_ref: "tissue/wi_abc", head_sha: sha, push_remote: "origin" });
    const tr = new FakeTransport();
    tr.remoteSha = sha;
    assert.equal((await executeVerifiedEffect(t.db, id, tr)).status, "done");

    const id2 = seedEffect(t.db, "push", { dir: "/workspace/nomarr", head_ref: "tissue/wi_abc", head_sha: sha, push_remote: "origin" }, "eff-push-2");
    tr.remoteSha = "b".repeat(40);
    const res = await executeVerifiedEffect(t.db, id2, tr);
    assert.equal(res.status, "retry");
    assert.equal(res.reason, "remote_sha_mismatch");
  } finally {
    t.cleanup();
  }
});

test("PR creation adopts an existing PR for the head ref (crash-safe, no duplicate)", async () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    const sha = "a".repeat(40);
    seedEffect(t.db, "push", { dir: "/workspace/nomarr", head_ref: "tissue/wi_abc", head_sha: sha, push_remote: "origin" }, "push-for-pr");
    const pushRow = getSideEffectFull(t.db, "push-for-pr");
    t.db.sql.run("UPDATE side_effects SET state = 'DONE' WHERE id = ?", pushRow!.id);
    const id = seedEffect(t.db, "pr", { head_ref: "tissue/wi_abc", head_sha: sha, base_branch: "main", title: "t", body: "b" });
    const tr = new FakeTransport();
    tr.prByHead.set("tissue/wi_abc", openPr(55));
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "adopted");
    assert.equal(tr.calls.includes("createPr"), false);
  } finally {
    t.cleanup();
  }
});

test("guarded merge holds WAITING when a required human approval is missing (never bypasses)", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const id = seedEffect(t.db, "merge", { pr_number: 21, base_branch: "main", auto_merge: true, merge_policy_known: true });
    const tr = new FakeTransport();
    tr.prs.set(21, openPr(21));
    tr.protection = { enabled: true, requiredApprovals: 1, enforceAdmins: false, requiredChecks: [] };
    tr.reviews = [{ reviewId: "R1", state: "COMMENTED", author: "bob" }];

    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "waiting");
    assert.equal(res.reason, "human_approval_required");
    assert.equal(tr.calls.includes("mergePr"), false, "must not merge without approval");
    const wi = t.db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", WI);
    assert.equal(wi?.state, "WAITING");
    const eff = getSideEffectFull(t.db, id);
    assert.equal(eff?.state, "PENDING", "effect requeued, not failed");
  } finally {
    t.cleanup();
  }
});

test("guarded merge holds WAITING while required checks are not green", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const id = seedEffect(t.db, "merge", { pr_number: 21, base_branch: "main", auto_merge: true, merge_policy_known: true });
    const tr = new FakeTransport();
    tr.prs.set(21, openPr(21));
    tr.protection = { enabled: true, requiredApprovals: 0, enforceAdmins: false, requiredChecks: ["ci"] };
    tr.checks = [{ name: "ci", status: "IN_PROGRESS", conclusion: "PENDING" }];
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "waiting");
    assert.match(res.reason ?? "", /^checks_pending/);
    assert.equal(tr.calls.includes("mergePr"), false);
  } finally {
    t.cleanup();
  }
});

test("merge proceeds only when mergeable, verified merged, and updates local PR state", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    insertPullRequest(t.db, { id: "pr-local-21", work_item_id: WI, repo_id: repo.id, number: 21, head_ref: "tissue/wi_abc", state: "ACTIVE" });
    const id = seedEffect(t.db, "merge", { pr_number: 21, base_branch: "main", auto_merge: true, merge_policy_known: true });
    const tr = new FakeTransport();
    tr.prs.set(21, openPr(21));
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "done");
    assert.equal(tr.calls.includes("mergePr"), true);
    const local = t.db.sql.get<{ state: string }>("SELECT state FROM pull_requests WHERE id = ?", "pr-local-21");
    assert.equal(local?.state, "MERGED");
  } finally {
    t.cleanup();
  }
});

test("merge adopts external reality: already MERGED / not found", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const merged = seedEffect(t.db, "merge", { pr_number: 21, base_branch: "main", auto_merge: true, merge_policy_known: true }, "eff-merged");
    const tr = new FakeTransport();
    tr.prs.set(21, { ...openPr(21), state: "MERGED" });
    assert.equal((await executeVerifiedEffect(t.db, merged, tr)).status, "adopted");

    const gone = seedEffect(t.db, "merge", { pr_number: 22, base_branch: "main", auto_merge: true, merge_policy_known: true }, "eff-gone");
    assert.equal((await executeVerifiedEffect(t.db, gone, tr)).status, "adopted");
    assert.equal(tr.calls.includes("mergePr"), false);
  } finally {
    t.cleanup();
  }
});

test("verified merge releases deferred dependents atomically and deterministically", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    insertWorkItem(t.db, { id: "wi-release-a", repo_id: repo.id, state: "DEFERRED", base_branch: "main" });
    insertWorkItem(t.db, { id: "wi-release-b", repo_id: repo.id, state: "DEFERRED", base_branch: "main" });
    insertWorkItem(t.db, { id: "wi-paused", repo_id: repo.id, state: "PAUSED_WORK", base_branch: "main" });
    const releaseA = addWorkItemDependency(t.db, "wi-release-a", { kind: "work_item", id: WI });
    const releaseB = addWorkItemDependency(t.db, "wi-release-b", { kind: "work_item", id: WI });
    const paused = addWorkItemDependency(t.db, "wi-paused", { kind: "work_item", id: WI });
    t.db.sql.run("UPDATE work_item_dependencies SET created_at = ? WHERE id IN (?, ?, ?)", "2026-09-09T00:00:00.000Z", releaseA.id, releaseB.id, paused.id);
    insertPullRequest(t.db, { id: "pr-release", work_item_id: WI, repo_id: repo.id, number: 21, head_ref: "tissue/wi_abc", state: "ACTIVE" });
    const id = seedEffect(t.db, "merge", { pr_number: 21, base_branch: "main", auto_merge: true, merge_policy_known: true }, "eff-release");
    const tr = new FakeTransport();
    tr.prs.set(21, { ...openPr(21), state: "MERGED" });
    assert.equal((await executeVerifiedEffect(t.db, id, tr)).status, "adopted");
    assert.deepEqual(
      ["wi-release-a", "wi-release-b"].map((dependent) => t.db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", dependent)?.state),
      ["READY", "READY"],
    );
    assert.equal(t.db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", "wi-paused")?.state, "PAUSED_WORK");
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM state_transitions WHERE event = 'dependency_completed'")?.c, 2);
    assert.deepEqual(
      [releaseA, releaseB, paused]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((relation) => t.db.sql.get<{ state: string }>("SELECT state FROM work_item_dependencies WHERE id = ?", relation.id)?.state),
      ["SETTLED", "SETTLED", "SETTLED"],
      "every active relation is settled, including preserved dependents",
    );
    assert.deepEqual(
      t.db.sql
        .all<{ entity_id: string }>(
          "SELECT entity_id FROM state_transitions WHERE event = 'dependency_completed' ORDER BY id",
        )
        .map((transition) => transition.entity_id),
      ["wi-release-a", "wi-release-b"].sort((a, b) => {
        const relationA = [releaseA, releaseB].find((relation) => relation.dependent_work_item_id === a)!;
        const relationB = [releaseA, releaseB].find((relation) => relation.dependent_work_item_id === b)!;
        return relationA.id.localeCompare(relationB.id);
      }),
      "release audits follow created_at/id relation order",
    );
    assert.equal(claimNextWorkItem(t.db, new Date("2026-09-09T00:01:00.000Z")), null, "completion does not directly admit READY dependents");
    assert.equal(t.db.sql.get<{ state: string }>("SELECT state FROM side_effects WHERE id = ?", id)?.state, "DONE");
    assert.equal((await executeVerifiedEffect(t.db, id, tr)).status, "already_done");
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM state_transitions WHERE event = 'dependency_completed'")?.c, 2);
    assert.deepEqual(
      [releaseA, releaseB, paused].map((relation) => t.db.sql.get<{ state: string }>("SELECT state FROM work_item_dependencies WHERE id = ?", relation.id)?.state),
      ["SETTLED", "SETTLED", "SETTLED"],
      "repeat execution does not resurrect settled relations",
    );
  } finally {
    t.cleanup();
  }
});

test("verified merge rolls back completion and release together on audit failure", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    insertWorkItem(t.db, { id: "wi-invalid-release", repo_id: repo.id, state: "DEFERRED", base_branch: "main" });
    const relation = addWorkItemDependency(t.db, "wi-invalid-release", { kind: "work_item", id: WI });
    t.db.sql.exec("CREATE TRIGGER fail_release_audit AFTER INSERT ON state_transitions WHEN NEW.entity_id = 'wi-invalid-release' BEGIN SELECT RAISE(ABORT, 'forced release audit failure'); END");
    insertPullRequest(t.db, { id: "pr-rollback", work_item_id: WI, repo_id: repo.id, number: 21, head_ref: "tissue/wi_abc", state: "ACTIVE" });
    const id = seedEffect(t.db, "merge", { pr_number: 21, base_branch: "main", auto_merge: true, merge_policy_known: true }, "eff-rollback");
    const tr = new FakeTransport();
    tr.prs.set(21, { ...openPr(21), state: "MERGED" });
    assert.equal((await executeVerifiedEffect(t.db, id, tr)).status, "retry");
    assert.equal(t.db.sql.get<{ state: string }>("SELECT state FROM side_effects WHERE id = ?", id)?.state, "FAILED");
    assert.equal(t.db.sql.get<{ state: string }>("SELECT state FROM work_items WHERE id = ?", WI)?.state, "RUNNING");
    assert.equal(t.db.sql.get<{ state: string }>("SELECT state FROM pull_requests WHERE id = ?", "pr-rollback")?.state, "ACTIVE");
    assert.equal(t.db.sql.get<{ state: string }>("SELECT state FROM work_item_dependencies WHERE id = ?", relation.id)?.state, "ACTIVE");
    assert.equal(t.db.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM state_transitions WHERE entity_id = ?", WI)?.c, 0);
  } finally {
    t.cleanup();
  }
});

test("an unmergeable PR is requeued, never merged", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const id = seedEffect(t.db, "merge", { pr_number: 21, base_branch: "main", auto_merge: true, merge_policy_known: true });
    const tr = new FakeTransport();
    tr.prs.set(21, { ...openPr(21), mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "retry");
    assert.equal(res.reason, "not_mergeable");
    assert.equal(tr.calls.includes("mergePr"), false);
    assert.equal(getSideEffectFull(t.db, id)?.state, "PENDING");
  } finally {
    t.cleanup();
  }
});

test("transient transport failures back off; parse-invalid payloads are terminal", async () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    const id = seedEffect(t.db, "comment", { issue_number: 7, body: "x" });
    const tr = new FakeTransport();
    tr.throwOn.set("comment", new GhError("network", "connection reset", -1));
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "retry");
    const row = t.db.sql.get<{ state: string; next_attempt_at: string | null }>(
      "SELECT state, next_attempt_at FROM side_effects WHERE id = ?",
      id,
    );
    assert.equal(row?.state, "FAILED");
    assert.ok(row?.next_attempt_at, "transient failure schedules a retry");

    const bad = seedEffect(t.db, "comment", { issue_number: 7 }, "eff-bad");
    t.db.sql.run("UPDATE side_effects SET payload_json = ? WHERE id = ?", "not-json", bad);
    const badRes = await executeVerifiedEffect(t.db, bad, tr);
    assert.equal(badRes.status, "invalid");
  } finally {
    t.cleanup();
  }
});

test("GhEffectTransport drives gh through typed argv: comment, close, and guarded merge", async () => {
  const fake = writeFakeGh({
    meta: defaultNomarrMeta(),
    issueList: { "xiaden/nomarr": [{ number: 7, title: "t", state: "OPEN", updatedAt: "2026-09-09T00:00:00.000Z", createdAt: "2026-09-09T00:00:00.000Z", labels: [] }] },
    protection: {
      "repos/xiaden/nomarr/branches/main/protection": { required_pull_request_reviews: { required_approving_review_count: 1 } },
    },
    prView: {
      "xiaden/nomarr#21": { number: 21, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false, reviewDecision: "" },
    },
    prReviews: { "xiaden/nomarr#21": [] },
  });
  try {
    const t = createTestDb();
    try {
      seedRepository(t.db);
      const gh = new GhClient({ binary: fake.binary });
      const tr = new GhEffectTransport({ gh });

      const commentId = seedEffect(t.db, "comment", { issue_number: 7, body: "closing" });
      assert.equal((await executeVerifiedEffect(t.db, commentId, tr)).status, "done");

      const closeId = seedEffect(t.db, "close", { issue_number: 7 });
      assert.equal((await executeVerifiedEffect(t.db, closeId, tr)).status, "done");
      assert.equal((await executeVerifiedEffect(t.db, closeId, tr)).status, "already_done");

      // Protected branch requires 1 approval and there are none: hold, never merge.
      const mergeId = seedEffect(t.db, "merge", { pr_number: 21, base_branch: "main", auto_merge: true, merge_policy_known: true });
      const res = await executeVerifiedEffect(t.db, mergeId, tr);
      assert.equal(res.status, "waiting");

      const log = readEffectLog(fake.effectLogPath);
      assert.ok(log.some((e) => e.kind === "issue.comment" && e.body === "closing"));
      assert.ok(log.some((e) => e.kind === "issue.close"));
      assert.equal(log.some((e) => e.kind === "pr.merge"), false, "no remote merge when approval is missing");
    } finally {
      t.cleanup();
    }
  } finally {
    fake.cleanup();
  }
});

test("no-bypass: the merge argv carries no --admin/force flag and protection gates block instead", async () => {
  const fake = writeFakeGh({
    meta: defaultNomarrMeta(),
    protection: { "repos/xiaden/nomarr/branches/main/protection": "not_protected" },
    prView: { "xiaden/nomarr#21": { number: 21, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false, reviewDecision: "" } },
    prReviews: { "xiaden/nomarr#21": [] },
  });
  try {
    const t = createTestDb();
    try {
      const repo = seedRepository(t.db);
      insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main", head_branch: "tissue/wi_abc" });
      insertPullRequest(t.db, { id: "pr-local-21", work_item_id: WI, repo_id: repo.id, number: 21, head_ref: "tissue/wi_abc", state: "ACTIVE" });
      const gh = new GhClient({ binary: fake.binary });
      const tr = new GhEffectTransport({ gh });
      const id = seedEffect(t.db, "merge", { pr_number: 21, base_branch: "main", auto_merge: true, merge_policy_known: true });
      const res = await executeVerifiedEffect(t.db, id, tr);
      assert.equal(res.status, "done");

      const merges = readEffectLog(fake.effectLogPath).filter((e) => e.kind === "pr.merge") as unknown as Array<{ method?: string; argv?: string[] }>;
      assert.equal(merges.length, 1, "exactly one merge was issued");
      const argv = merges[0]!.argv ?? [];
      assert.ok(argv.length > 0, "merge argv was captured");
      for (const forbidden of ["--admin", "--force", "--force-with-lease", "-f", "--force-if-includes"]) {
        assert.ok(!argv.includes(forbidden), `merge argv must not contain ${forbidden}: ${argv.join(" ")}`);
      }
      assert.ok(["--merge", "--squash", "--rebase"].includes(merges[0]!.method ?? ""), `expected a real merge method, got ${merges[0]!.method}`);

      // The typed argv builder is itself admin/force-free for every method.
      for (const method of ["merge", "squash", "rebase"] as const) {
        const built = argvPrMerge("xiaden", "nomarr", 21, method);
        assert.ok(built.includes(`--${method}`));
        for (const forbidden of ["--admin", "--force", "--force-with-lease"]) {
          assert.ok(!built.includes(forbidden), `argvPrMerge(${method}) must not contain ${forbidden}`);
        }
      }
    } finally {
      t.cleanup();
    }
  } finally {
    fake.cleanup();
  }
});

test("no-bypass: pushBranch argv omits --force/--force-with-lease (no force-push path)", async () => {
  const tr = await createTempRepo();
  const bin = mkdtempSync(join(tmpdir(), "tissue-fakegit-"));
  const log = join(bin, "argv.log");
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TISSUE_GIT_ARGV_LOG"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  const previousLog = process.env.TISSUE_GIT_ARGV_LOG;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.TISSUE_GIT_ARGV_LOG = log;
  try {
    await runGit(["checkout", "-b", "tissue/wi_push1"], { cwd: tr.clone });
    await pushBranch(tr.clone, "tissue/wi_push1", { remote: "origin" });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const pushLine = lines.find((l) => l.startsWith("push "));
    assert.ok(pushLine, `push was invoked: ${lines.join(" | ")}`);
    for (const forbidden of ["--force", "--force-with-lease", "-f", "--force-if-includes"]) {
      assert.ok(!pushLine!.includes(forbidden), `push argv must not contain ${forbidden}: ${pushLine}`);
    }
    assert.ok(pushLine!.includes("origin") && pushLine!.includes("tissue/wi_push1"));
  } finally {
    process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.TISSUE_GIT_ARGV_LOG;
    else process.env.TISSUE_GIT_ARGV_LOG = previousLog;
    tr.cleanup();
    rmSync(bin, { recursive: true, force: true });
  }
});
