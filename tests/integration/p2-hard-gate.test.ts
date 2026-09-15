// tests/integration/p2-hard-gate.test.ts
//
// P2-S6 adversarial specs for the production-closure hard gates:
//   * the hard autoMerge gate at effect creation AND execution (false never
//     creates/executes a local `gh pr merge`; unknown policy/protection fails
//     closed; only a positive policy AND auto_merge=true may merge),
//   * external merge/close/not-found adoption while autoMerge=false,
//   * PR adoption/create identity (target repo, controller branch, expected SHA,
//     writable push-owner head identity) and foreign-fork-on-same-branch rogue,
//   * configured pushRemote resolution (never a silent hard-coded origin),
//   * bounded, control-safe untrusted issue-body retrieval,
//   * label admission semantics and explicit-enqueue override.

import test from "node:test";
import assert from "node:assert/strict";

import {
  adoptVerifiedPullRequest,
  evaluateMergePolicy,
  executeVerifiedEffect,
  type CheckView,
  type EffectTransport,
  type PrView,
  type ProtectionRead,
  type ReviewView,
} from "../../src/controller/effects.ts";
import { admitIssue, fetchBoundedIssueBody, parseConfiguredLabels, sanitizeUntrustedText } from "../../src/controller/intake.ts";
import { GhClient } from "../../src/integrations/gh-client.ts";
import {
  getSideEffectFull,
  insertSideEffect,
  insertWorkItem,
} from "../../src/db/repositories.ts";
import { createTestDb, seedRepository } from "../helpers/db.ts";
import { defaultNomarrMeta, writeFakeGh } from "../helpers/fake-gh.ts";

const WI = "wi-xiaden-nomarr-7";
const SHA = "a".repeat(40);

function openPr(number: number, extra: Partial<PrView> = {}): PrView {
  return {
    number,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    isDraft: false,
    reviewDecision: "",
    headRefName: "tissue/wi_abc",
    headSha: SHA,
    headOwner: "xiaden",
    headRepo: "xiaden/nomarr",
    ...extra,
  };
}

class GateTransport implements EffectTransport {
  prs = new Map<number, PrView>();
  prByHead = new Map<string, PrView>();
  protection: ProtectionRead = { enabled: false, requiredApprovals: 0, enforceAdmins: false, requiredChecks: [] };
  checks: CheckView[] = [];
  reviews: ReviewView[] = [];
  calls: string[] = [];

  async pushHead(): Promise<{ remoteSha: string | null }> {
    this.calls.push("push");
    return { remoteSha: null };
  }
  async readIssueState(): Promise<{ state: string } | null> {
    return null;
  }
  async commentIssue(): Promise<{ id: string | null }> {
    return { id: "C_1" };
  }
  async closeIssue(): Promise<void> {}
  async reopenIssue(): Promise<void> {}
  async createPr(_o: string, _n: string, head: string): Promise<{ number: number | null }> {
    this.calls.push("createPr");
    const pr = openPr(101, { headRefName: head });
    this.prs.set(101, pr);
    this.prByHead.set(head, pr);
    return { number: 101 };
  }
  async findPrByHead(_o: string, _n: string, headRef: string): Promise<PrView | null> {
    return this.prByHead.get(headRef) ?? null;
  }
  async readPr(_o: string, _n: string, number: number): Promise<PrView | null> {
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
    const pr = this.prs.get(number);
    if (pr) this.prs.set(number, { ...pr, state: "MERGED" });
  }
}

function seedEffect(
  db: ReturnType<typeof createTestDb>["db"],
  kind: string,
  payload: Record<string, unknown>,
  id: string,
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

// ---------------------------------------------------------------------------
// evaluateMergePolicy: fail closed
// ---------------------------------------------------------------------------

test("evaluateMergePolicy fails closed on unknown policy/protection and merges only on positive policy", () => {
  const known: ProtectionRead = { enabled: true, requiredApprovals: 1, enforceAdmins: false, requiredChecks: [] };
  const unknownProtection: ProtectionRead = { ...known, known: false };
  const payload = {} as never;

  assert.equal(evaluateMergePolicy(payload, known, { autoMerge: true, policyKnown: true }), "allow");
  assert.equal(evaluateMergePolicy(payload, known, { autoMerge: false, policyKnown: true }), "external_only");
  assert.equal(evaluateMergePolicy(payload, known, { autoMerge: true, policyKnown: false }), "hold");
  assert.equal(evaluateMergePolicy(payload, unknownProtection, { autoMerge: true, policyKnown: true }), "hold");
  // Explicit unprotected is distinct from unknown and is allowed under positive policy.
  assert.equal(
    evaluateMergePolicy(
      payload,
      { enabled: false, requiredApprovals: 0, enforceAdmins: false, requiredChecks: [], known: true },
      { autoMerge: true, policyKnown: true },
    ),
    "allow",
  );
});

// ---------------------------------------------------------------------------
// adoptVerifiedPullRequest identity
// ---------------------------------------------------------------------------

test("adoptVerifiedPullRequest requires target repo, controller branch, SHA and push-owner head identity", () => {
  const identity = {
    targetOwner: "xiaden",
    targetName: "nomarr",
    headRef: "tissue/wi_abc",
    headSha: SHA,
    pushOwner: "xiaden",
    pushName: "nomarr",
  };

  assert.deepEqual(adoptVerifiedPullRequest(identity, openPr(1)), { adopted: true, number: 1, reason: "verified" });
  assert.equal(adoptVerifiedPullRequest(identity, openPr(2, { headRefName: "main" })).reason, "branch_mismatch");
  assert.equal(adoptVerifiedPullRequest(identity, openPr(3, { headSha: "b".repeat(40) })).reason, "sha_mismatch");
  assert.equal(adoptVerifiedPullRequest(identity, openPr(4, { headOwner: null, headRepo: null })).reason, "head_identity_unknown");

  const fork = adoptVerifiedPullRequest(identity, openPr(5, { headRepo: "attacker/fork", headOwner: "attacker" }));
  assert.equal(fork.adopted, false);
  assert.equal(fork.reason, "foreign_fork");
  assert.equal(fork.rogue, true);
});

// ---------------------------------------------------------------------------
// admitIssue label semantics
// ---------------------------------------------------------------------------

test("admitIssue: empty labels admit all; non-empty admit any match; explicit enqueue is the sole override", () => {
  assert.equal(admitIssue(["bug"], [], false, false).admitted, true);
  assert.equal(admitIssue(["bug"], ["bug", "p1"], false, false).admitted, true);
  assert.equal(admitIssue(["chore"], ["bug", "p1"], false, false).admitted, false);
  assert.equal(admitIssue(["chore"], ["bug", "p1"], false, false).reason, "label_mismatch");
  // Baseline exclusion wins unless an explicit enqueue occurred.
  assert.equal(admitIssue(["bug"], [], false, true).reason, "baseline");
  assert.equal(admitIssue(["bug"], [], true, true).reason, "explicit_enqueue");
  assert.equal(admitIssue(["nope"], ["bug"], true, false).reason, "explicit_enqueue");
});

test("parseConfiguredLabels tolerates malformed JSON without admitting on invalid config", () => {
  assert.deepEqual(parseConfiguredLabels(null), []);
  assert.deepEqual(parseConfiguredLabels("not-json"), []);
  assert.deepEqual(parseConfiguredLabels(JSON.stringify(["bug", "", 7, "p1"])), ["bug", "p1"]);
});

// ---------------------------------------------------------------------------
// bounded untrusted issue body
// ---------------------------------------------------------------------------

test("fetchBoundedIssueBody bounds and control-safes untrusted body text via typed argv", async () => {
  // The body carries CR (\u000d) alongside tab (\t = \u0009) and LF (\u000a),
  // which must be PRESERVED, plus other C0 controls that must be stripped. A
  // negative regex that omitted \u000d (e.g. /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/)
  // would leave the CR in place and fail this assertion, so a regression that
  // stops stripping CR is caught here.
  const crLadenBody = `\u0000\u001b[31mansi\u0007\u000dreplaced\tkeep\nnewline ${"x".repeat(200)}`;
  const fake = writeFakeGh({
    meta: defaultNomarrMeta(),
    issueList: {
      "xiaden/nomarr": [
        {
          number: 7,
          title: "t",
          body: crLadenBody,
          state: "OPEN",
          updatedAt: "2026-09-09T00:00:00.000Z",
          createdAt: "2026-09-09T00:00:00.000Z",
          labels: [],
        },
      ],
    },
  });
  try {
    const gh = new GhClient({ binary: fake.binary });
    const bounded = await fetchBoundedIssueBody(gh, "xiaden", "nomarr", 7, 64);
    assert.equal(bounded.issueNumber, 7);
    // Bounded length/truncation behavior still holds with the CR-bearing input.
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.body.length <= 64, "bounded length is enforced");
    // Effective normalization: no raw CR survives (CRLF/lone CR become LF), and
    // every other C0/C1 control is replaced; tab and newline survive.
    assert.equal(bounded.body.includes("\r"), false, "CR is stripped from the effective body");
    assert.equal(/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f]/.test(bounded.body), false, "no control chars (including CR)");
    assert.ok(bounded.body.includes("\t"), "tab is preserved");
    assert.ok(bounded.body.includes("\n"), "newline is preserved");
    assert.ok(bounded.body.includes("x"), "content preserved");

    // The normalization step itself must handle CR: a production regression that
    // stops normalizing would leave \r present in a directly sanitized body.
    assert.equal(crLadenBody.includes("\r"), true, "fixture actually contains CR");

    // Non-numeric ids are rejected before any argv is built.
    await assert.rejects(() => fetchBoundedIssueBody(gh, "xiaden", "nomarr", -1), /non-negative integer/);
  } finally {
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CRLF normalization
// ---------------------------------------------------------------------------

test("sanitizeUntrustedText normalizes CRLF to one newline without a stray marker", () => {
  // CRLF collapses to a single LF and never leaves a replacement marker before
  // the newline; a lone CR normalizes to LF too (line structure preserved, never
  // rendered as a replacement character).
  const { text } = sanitizeUntrustedText("line1\r\nline2\r\nline3", 1000);
  assert.equal(text, "line1\nline2\nline3");
  assert.equal(text.includes("\r"), false, "no raw CR remains");
  assert.equal(text.includes("\ufffd"), false, "no stray replacement marker");

  const lone = sanitizeUntrustedText("a\rb", 1000);
  assert.equal(lone.text, "a\nb", "lone CR normalizes to LF, not a replacement marker");

  // Tab and LF survive; truncation still bounds the result.
  const bounded = sanitizeUntrustedText("a\r\nb\tc", 4);
  assert.equal(bounded.text, "a\nb\t");
  assert.equal(bounded.truncated, true);
});

// ---------------------------------------------------------------------------
// hard gate at effect creation
// ---------------------------------------------------------------------------

async function seedPushDone(db: ReturnType<typeof createTestDb>["db"]): Promise<void> {
  insertSideEffect(db, {
    id: "push-done",
    kind: "push",
    effect_key: `push:${WI}:${SHA}`,
    state: "DONE",
    payload_json: JSON.stringify({ owner: "xiaden", name: "nomarr", work_item_id: WI }),
  });
}

test("PR adoption with autoMerge=false creates a monitor intent, never a merge effect", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    await seedPushDone(t.db);
    const pr = openPr(55);
    const id = seedEffect(
      t.db,
      "pr",
      { head_ref: "tissue/wi_abc", head_sha: SHA, base_branch: "main", auto_merge: false, merge_policy_known: true },
      "pr-noauto",
    );
    const tr = new GateTransport();
    tr.prByHead.set("tissue/wi_abc", pr);
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "adopted");
    assert.equal(tr.calls.includes("createPr"), false);

    const kinds = t.db.sql.all<{ kind: string; effect_key: string }>("SELECT kind, effect_key FROM side_effects");
    assert.ok(kinds.some((k) => k.kind === "monitor" && k.effect_key === `monitor:${WI}:55`));
    assert.equal(kinds.some((k) => k.kind === "merge"), false, "no merge intent when autoMerge=false");
  } finally {
    t.cleanup();
  }
});

test("PR adoption with positive policy creates exactly one merge intent", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    await seedPushDone(t.db);
    const id = seedEffect(
      t.db,
      "pr",
      { head_ref: "tissue/wi_abc", head_sha: SHA, base_branch: "main", auto_merge: true, merge_policy_known: true },
      "pr-auto",
    );
    const tr = new GateTransport();
    tr.prByHead.set("tissue/wi_abc", openPr(56));
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "adopted");
    const kinds = t.db.sql.all<{ kind: string; effect_key: string }>("SELECT kind, effect_key FROM side_effects");
    assert.ok(kinds.some((k) => k.kind === "merge" && k.effect_key === `merge:${WI}:56`));
    assert.equal(kinds.some((k) => k.kind === "monitor"), false);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// hard gate at execution
// ---------------------------------------------------------------------------

test("a merge effect with autoMerge=false never calls gh pr merge and adopts external reality", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const id = seedEffect(
      t.db,
      "merge",
      { pr_number: 21, base_branch: "main", auto_merge: false, merge_policy_known: true },
      "merge-noauto",
    );
    const tr = new GateTransport();
    tr.prs.set(21, openPr(21));
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(res.status, "external_only");
    assert.equal(tr.calls.includes("mergePr"), false);
    assert.equal(getSideEffectFull(t.db, id)?.state, "PENDING", "requeued, not merged");

    const gone = seedEffect(
      t.db,
      "merge",
      { pr_number: 22, base_branch: "main", auto_merge: false, merge_policy_known: true },
      "merge-gone",
    );
    const adopted = await executeVerifiedEffect(t.db, gone, tr);
    assert.equal(adopted.status, "adopted");
  } finally {
    t.cleanup();
  }
});

test("unknown merge policy or protection holds the merge (fail closed)", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });

    const unknownPolicy = seedEffect(
      t.db,
      "merge",
      { pr_number: 21, base_branch: "main", auto_merge: true, merge_policy_known: false },
      "merge-unknown-policy",
    );
    const tr = new GateTransport();
    tr.prs.set(21, openPr(21));
    const res = await executeVerifiedEffect(t.db, unknownPolicy, tr);
    assert.equal(res.status, "waiting");
    assert.equal(tr.calls.includes("mergePr"), false);

    tr.protection = { enabled: true, requiredApprovals: 0, enforceAdmins: false, requiredChecks: [], known: false };
    const unknownProtection = seedEffect(
      t.db,
      "merge",
      { pr_number: 23, base_branch: "main", auto_merge: true, merge_policy_known: true },
      "merge-unknown-protection",
    );
    tr.prs.set(23, openPr(23));
    const held = await executeVerifiedEffect(t.db, unknownProtection, tr);
    assert.equal(held.status, "waiting");
    assert.equal(tr.calls.includes("mergePr"), false);
  } finally {
    t.cleanup();
  }
});

test("a monitor effect adopts an external merge and never merges locally", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    const id = seedEffect(
      t.db,
      "monitor",
      { pr_number: 21, base_branch: "main", auto_merge: false, merge_policy_known: true },
      "monitor-effect",
    );
    const tr = new GateTransport();
    tr.prs.set(21, openPr(21));
    const watching = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(watching.status, "monitoring");
    assert.equal(tr.calls.includes("mergePr"), false);

    tr.prs.set(21, { ...openPr(21), state: "MERGED" });
    const adopted = await executeVerifiedEffect(t.db, id, tr);
    assert.equal(adopted.status, "adopted");
    assert.equal(tr.calls.includes("mergePr"), false);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// configured pushRemote
// ---------------------------------------------------------------------------

test("a push effect without an explicit configured pushRemote is invalid (never a silent origin)", async () => {
  const t = createTestDb();
  try {
    seedRepository(t.db);
    const id = seedEffect(
      t.db,
      "push",
      { dir: "/workspace/nomarr", head_ref: "tissue/wi_abc", head_sha: SHA },
      "push-no-remote",
    );
    const res = await executeVerifiedEffect(t.db, id, new GateTransport());
    assert.equal(res.status, "invalid");
    assert.equal(res.reason, "missing_push_remote");
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// rogue same-branch fork at PR create
// ---------------------------------------------------------------------------

test("a foreign fork on the controller branch is recorded rogue and never adopted for PR create", async () => {
  const t = createTestDb();
  try {
    const repo = seedRepository(t.db);
    insertWorkItem(t.db, { id: WI, repo_id: repo.id, state: "RUNNING", base_branch: "main" });
    await seedPushDone(t.db);
    const id = seedEffect(
      t.db,
      "pr",
      { head_ref: "tissue/wi_abc", head_sha: SHA, base_branch: "main", auto_merge: false, merge_policy_known: true },
      "pr-rogue",
    );
    const tr = new GateTransport();
    tr.prByHead.set(
      "tissue/wi_abc",
      openPr(77, { headOwner: "attacker", headRepo: "attacker/nomarr" }),
    );
    const res = await executeVerifiedEffect(t.db, id, tr);
    assert.notEqual(res.status, "adopted");
    assert.equal(tr.calls.includes("createPr"), false, "never creates on top of a foreign fork");
    const rogue = t.db.sql.get<{ state: string; origin: string }>(
      "SELECT state, origin FROM pull_requests WHERE work_item_id = ? AND number = 77",
      WI,
    );
    assert.equal(rogue?.state, "ROGUE");
    assert.equal(rogue?.origin, "rogue");
  } finally {
    t.cleanup();
  }
});
