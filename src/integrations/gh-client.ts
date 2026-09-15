// src/integrations/gh-client.ts
//
// M5 identifier-safe GitHub client (R17, DD "Worktrees, polling, identifier-safe
// subprocesses", CONTRACTS `pollRepository`/`verifyRepository` inputs). Every
// GitHub operation is a /usr/bin/gh subprocess built from TYPED argv arrays —
// never a shell string, never interpolated GitHub text. JSON reads use fixed
// --json field lists; issue/PR numbers and SHAs are numeric/typed; any untrusted
// body text is supplied via stdin / --body-file, never on a command line.
//
// Binary hygiene: the real verified binary is `/usr/bin/gh` (gh 2.97.0/2.98.0
// security releases fixed terminal-escape injection). PATH `gh` is an unverified
// AFT shim and must NEVER be used. A client rejects a non-absolute binary name so
// the PATH shim can never be reached by accident. Credentials are never read,
// echoed, or logged; diagnostics are redacted before they reach a log.
//
// Real-GitHub operations in this phase are READ-ONLY (version / auth / repository
// metadata / protection snapshots). Effect argv builders (issue comment, close,
// etc.) exist so downstream phases drive them through the same typed-argv, body-
// file path, but real-GitHub mutation is out of scope and is only exercised
// against fake-gh fixtures in tests.

import { spawn } from "node:child_process";

export const DEFAULT_GH_BINARY = "/usr/bin/gh";
/**
 * gh 2.97.0 and 2.98.0 are security releases (terminal-escape-sequence
 * injection, request-path traversal, partial token disclosure, attestation
 * signer matcher). Any version older than 2.97.0 is rejected outright.
 */
export const MIN_GH_VERSION = "2.97.0";

const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const GITHUB_TOKEN_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
];

// ---- typed result / error model -------------------------------------------------

export interface GhSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GhErrorKind =
  | "rate_limited"
  | "auth"
  | "not_found"
  | "bad_request"
  | "network"
  | "unknown";

/** A classified, redacted gh failure. Never carries a credential. */
export class GhError extends Error {
  readonly kind: GhErrorKind;
  readonly exitCode: number | null;
  constructor(kind: GhErrorKind, message: string, exitCode: number | null = null) {
    super(`gh ${kind}: ${message}`);
    this.name = "GhError";
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

/** An argument that is not identifier-safe and must never reach gh argv. */
export class GhArgError extends Error {
  constructor(message: string) {
    super(`gh-argv: ${message}`);
    this.name = "GhArgError";
  }
}

// ---- pure safety helpers ---------------------------------------------------------

/** Mask credential-shaped content out of a diagnostic string before it is logged. */
export function redactGhText(text: string): string {
  let out = text;
  for (const re of GITHUB_TOKEN_SHAPES) out = out.replace(re, "[REDACTED]");
  // user:pass@-embedded URLs (never logged verbatim)
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@");
  return out;
}

/** Classify a nonzero gh run from its captured output. Pure and unit-testable. */
export function classifyGhFailure(exitCode: number, stdout: string, stderr: string): GhErrorKind {
  const hay = `${stdout}\n${stderr}`.toLowerCase();
  if (/secondary rate limit|api rate limit|rate limit exceeded|"rate limit"/.test(hay)) {
    return "rate_limited";
  }
  if (/bad credentials|not logged in|authentication failed|could not read username|401/i.test(hay)) {
    return "auth";
  }
  if (/not found|404|does not exist|repository .* not found/i.test(hay)) {
    return "not_found";
  }
  if (/validation failed|422|unprocessable|conflict|409/i.test(hay)) {
    return "bad_request";
  }
  if (exitCode === 0) return "unknown";
  return "unknown";
}

export interface GhVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `gh --version` stdout ("gh version 2.98.0 (2026-08-20)") or return null. */
export function parseGhVersion(text: string): GhVersion | null {
  const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compareVersions(a: GhVersion, b: GhVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Parse the minimum accepted version string into comparable parts. */
export function parseMinGhVersion(text: string): GhVersion {
  const parts = text.split(".").map((p) => Number(p));
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
}

/** True when `version` is at least `min`. */
export function ghVersionAtLeast(version: GhVersion, min: GhVersion): boolean {
  return compareVersions(version, min) >= 0;
}

/** Assert an owner/repo name is identifier-safe for use in a gh slug. */
export function assertRepoIdentifier(value: string, field: string): string {
  if (value.length === 0 || value.length > 100 || CONTROL_RE.test(value) || !REPO_ID_RE.test(value)) {
    throw new GhArgError(`${field}: '${redactGhText(value)}' is not identifier-safe (must match [A-Za-z0-9._-])`);
  }
  return value;
}

/** Assert a value is a non-negative integer identifier (issue/PR number, etc.). */
export function assertNumericId(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 2 ** 53) {
    throw new GhArgError(`${field}: expected a non-negative integer identifier, got '${value}'`);
  }
  return value;
}

/** Assert a branch is exactly a controller-generated `tissue/wi_<opaque>` shape. */
export function assertControllerBranch(value: string, field = "branch"): string {
  if (!/^tissue\/wi_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || CONTROL_RE.test(value)) {
    throw new GhArgError(`${field}: only controller-generated 'tissue/wi_<opaque>' branches are allowed`);
  }
  return value;
}

/** Assert a general branch ref is identifier-safe and option-injection-free. */
export function assertBranchRef(value: string, field = "branch"): string {
  if (
    value.length === 0 ||
    value.length > 200 ||
    CONTROL_RE.test(value) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  ) {
    throw new GhArgError(`${field}: '${redactGhText(value)}' is not a valid identifier-safe branch ref`);
  }
  if (value.startsWith("-")) throw new GhArgError(`${field}: branch must not start with '-'`);
  return value;
}

/** Compose an identifier-safe "owner/name" slug from already-validated parts. */
export function repoSlug(owner: string, name: string): string {
  assertRepoIdentifier(owner, "owner");
  assertRepoIdentifier(name, "name");
  return `${owner}/${name}`;
}

// ---- subprocess transport (typed argv only, no shell) ----------------------------

export interface SpawnOptions {
  stdinData?: string;
  timeoutMs?: number;
  /** Working directory for the child process (git operations run `-C`-free). */
  cwd?: string;
}

/** Run an argv array (never a shell string) and capture stdout/stderr. */
export async function runCaptured(
  binary: string,
  args: readonly string[],
  opts: SpawnOptions = {},
): Promise<GhSpawnResult> {
  return await new Promise<GhSpawnResult>((resolve) => {
    const child = spawn(binary, args as string[], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => stdout.push(c));
    child.stderr?.on("data", (c: Buffer) => stderr.push(c));
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    };
    child.on("error", (err: NodeJS.ErrnoException) => {
      // Spawn-level failure (ENOENT / permission) is a network-ish hard error.
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: `spawn failed: ${err.code ?? err.message}`,
      });
    });
    child.on("close", (code) => finish(code ?? -1));
    if (opts.stdinData !== undefined) {
      child.stdin?.on("error", () => {
        /* broken pipe when the child never reads stdin — ignore */
      });
      child.stdin?.write(opts.stdinData);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
      }, opts.timeoutMs);
      child.on("close", () => clearTimeout(t));
    }
  });
}

// ---- typed argv builders ---------------------------------------------------------

/** Fixed JSON field sets are enumerated, never free-form. */
export const JSON_ISSUE_FIELDS = "number,title,labels,updatedAt,state,createdAt";
export const JSON_REPO_META_FIELDS = "default_branch,has_issues,permissions";
export const JSON_RATE_FIELDS = "rate";

export const argvVersion = (): readonly string[] => ["--version"];
export const argvAuthStatus = (): readonly string[] => ["auth", "status"];

export interface RepoMetaQuery {
  owner: string;
  name: string;
}

/** `gh api repos/O/R --jq '{...}'` — read-only repository capability metadata. */
export function argvRepoMeta(q: RepoMetaQuery): readonly string[] {
  const slug = repoSlug(q.owner, q.name);
  return ["api", `repos/${slug}`, "--jq", `{${JSON_REPO_META_FIELDS}}`];
}

export interface ProtectionQuery {
  owner: string;
  name: string;
  /** The base branch whose protection is being read. Identifier-safe ref name. */
  branch: string;
}

/** `gh api repos/O/R/branches/B/protection` — 404 means "not protected" (surfaced). */
export function argvProtection(q: ProtectionQuery): readonly string[] {
  const slug = repoSlug(q.owner, q.name);
  assertBranchRef(q.branch, "branch");
  return ["api", `repos/${slug}/branches/${q.branch}/protection`];
}

export interface IssueListQuery {
  owner: string;
  name: string;
  state: "open" | "closed" | "all";
  limit: number;
}

/** `gh issue list -R O/R --state ... --limit N --json <fixed>`. */
export function argvIssueList(q: IssueListQuery): readonly string[] {
  const slug = repoSlug(q.owner, q.name);
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100) {
    throw new GhArgError("issue list limit must be an integer in [1,100]");
  }
  return [
    "issue",
    "list",
    "-R",
    slug,
    "--state",
    q.state,
    "--limit",
    String(q.limit),
    "--json",
    JSON_ISSUE_FIELDS,
  ];
}

/** `gh issue view <N> -R O/R --json <fixed>` — read a specific issue by NUMBER. */
export function argvIssueView(owner: string, name: string, number: number): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "issueNumber");
  return ["issue", "view", String(number), "-R", slug, "--json", JSON_ISSUE_FIELDS];
}

/** `gh issue view <N> -R O/R --json body` — bounded body fetch keyed by NUMBER. */
export function argvIssueBody(owner: string, name: string, number: number): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "issueNumber");
  return ["issue", "view", String(number), "-R", slug, "--json", JSON_ISSUE_BODY_FIELDS];
}

/** `gh issue view <N> -R O/R --json comments` — bounded comment read by NUMBER. */
export function argvIssueComments(owner: string, name: string, number: number): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "issueNumber");
  return ["issue", "view", String(number), "-R", slug, "--json", JSON_COMMENT_FIELDS];
}

/** Effect input: comment body goes via --body-file - / stdin, never the command line. */
export function argvIssueComment(owner: string, name: string, number: number): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "issueNumber");
  return ["issue", "comment", String(number), "-R", slug, "--body-file", "-"];
}

/** Effect input: close an issue by NUMBER (no free text). */
export function argvIssueClose(owner: string, name: string, number: number): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "issueNumber");
  return ["issue", "close", String(number), "-R", slug];
}

/** Effect input: reopen an issue by NUMBER (no free text). */
export function argvIssueReopen(owner: string, name: string, number: number): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "issueNumber");
  return ["issue", "reopen", String(number), "-R", slug];
}

// ---- pull-request polling / effect argv builders --------------------------------
// All JSON reads use enumerated field sets; only numbers, states, refs and SHAs
// cross argv. PR titles/bodies are controller-authored and bodies go via stdin.

// P2: PR head identity (headRepositoryOwner/headRepository) is a first-class
// fixed field so a foreign fork on the same controller branch can be told apart
// from the writable push-owner head and is never adopted as the controller PR.
export const JSON_PR_LIST_FIELDS =
  "number,state,headRefName,headRefOid,headRepositoryOwner,headRepository,updatedAt,mergeable,mergeStateStatus,isDraft,url";
export const JSON_PR_VIEW_FIELDS =
  "number,state,headRefName,headRefOid,headRepositoryOwner,headRepository,mergeable,mergeStateStatus,isDraft,reviewDecision,url";
export const JSON_COMMENT_FIELDS = "comments";
export const JSON_ISSUE_BODY_FIELDS = "body";
export const JSON_PR_CHECKS_FIELDS = "number,statusCheckRollup";
export const JSON_PR_REVIEWS_FIELDS = "number,reviews";

export interface PrListQuery {
  owner: string;
  name: string;
  state: "open" | "closed" | "merged" | "all";
  limit: number;
}

/** `gh pr list -R O/R --state ... --limit N --json <fixed>`. */
export function argvPrList(q: PrListQuery): readonly string[] {
  const slug = repoSlug(q.owner, q.name);
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100) {
    throw new GhArgError("pr list limit must be an integer in [1,100]");
  }
  return ["pr", "list", "-R", slug, "--state", q.state, "--limit", String(q.limit), "--json", JSON_PR_LIST_FIELDS];
}

/** `gh pr view <N> -R O/R --json <fixed>` — read PR state/mergeability by NUMBER. */
export function argvPrView(owner: string, name: string, number: number): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "prNumber");
  return ["pr", "view", String(number), "-R", slug, "--json", JSON_PR_VIEW_FIELDS];
}

/** `gh pr view <N> --json number,statusCheckRollup` — required-check state. */
export function argvPrChecks(owner: string, name: string, number: number): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "prNumber");
  return ["pr", "view", String(number), "-R", slug, "--json", JSON_PR_CHECKS_FIELDS];
}

/** `gh pr view <N> --json number,reviews` — review/approval state. */
export function argvPrReviews(owner: string, name: string, number: number): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "prNumber");
  return ["pr", "view", String(number), "-R", slug, "--json", JSON_PR_REVIEWS_FIELDS];
}

/** `gh pr view <N> --json comments` — bounded PR comment read by NUMBER. */
export function argvPrComments(owner: string, name: string, number: number): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "prNumber");
  return ["pr", "view", String(number), "-R", slug, "--json", JSON_COMMENT_FIELDS];
}

export interface PrCreateQuery {
  owner: string;
  name: string;
  /** Controller-generated head ref (later validated as tissue/wi_<opaque> by the effect). */
  head: string;
  /** Optional owner of a writable fork supplying the head branch. */
  headOwner?: string;
  /** Base branch (identifier-safe). */
  base: string;
  /** Controller-authored title (bounded, no control chars); body arrives via stdin. */
  title: string;
}

/** `gh pr create -R O/R --head H --base B --title T --body-file -` (body via stdin). */
export function argvPrCreate(q: PrCreateQuery): readonly string[] {
  const slug = repoSlug(q.owner, q.name);
  assertControllerBranch(q.head, "head");
  if (q.headOwner !== undefined) assertRepoIdentifier(q.headOwner, "headOwner");
  assertBranchRef(q.base, "base");
  if (q.title.length === 0 || q.title.length > 200 || CONTROL_RE.test(q.title)) {
    throw new GhArgError("pr title must be 1..200 chars with no control characters");
  }
  return ["pr", "create", "-R", slug, "--head", q.headOwner ? `${q.headOwner}:${q.head}` : q.head, "--base", q.base, "--title", q.title, "--body-file", "-"];
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** `gh pr merge <N> -R O/R --<method>` — never --admin, never --force. */
export function argvPrMerge(owner: string, name: string, number: number, method: MergeMethod): readonly string[] {
  const slug = repoSlug(owner, name);
  assertNumericId(number, "prNumber");
  if (method !== "merge" && method !== "squash" && method !== "rebase") {
    throw new GhArgError(`merge method must be merge|squash|rebase, got '${method}'`);
  }
  return ["pr", "merge", String(number), "-R", slug, `--${method}`];
}

// ---- read-only repository metadata -----------------------------------------------

export interface RepoMeta {
  owner: string;
  name: string;
  defaultBranch: string | null;
  issuesEnabled: boolean | null;
  permissions: { admin: boolean | null; push: boolean | null; pull: boolean | null } | null;
}

export interface ProtectionState {
  /** True when branch protection is enabled; false (with no error) when 404/unprotected. */
  enabled: boolean;
  requiredApprovals: number | null;
  enforceAdmins: boolean | null;
  requiredChecks: readonly string[] | null;
}

// ---- the client ------------------------------------------------------------------

export interface GhClientOptions {
  /** Absolute path to a validated gh binary. Default `/usr/bin/gh`. */
  binary?: string;
  /** gh 2.97.0+ (security releases). Overridable only for version-parsing tests. */
  minVersion?: string;
}

export interface AuthStatus {
  authenticated: boolean;
  host: string;
  account?: string;
}

export interface GhValidation {
  binary: string;
  version: string;
  versionOk: boolean;
  authenticated: boolean;
  account?: string;
}

/**
 * Safe /usr/bin/gh transport. Instances reject a bare/non-absolute binary so the
 * unverified PATH `gh` AFT shim can never be reached. All methods spawn typed
 * argv arrays and throw classified, redacted GhError on failure.
 */
export class GhClient {
  readonly binary: string;
  readonly minVersion: string;
  private readonly minParsed: GhVersion;

  constructor(opts: GhClientOptions = {}) {
    this.binary = opts.binary ?? DEFAULT_GH_BINARY;
    this.minVersion = opts.minVersion ?? MIN_GH_VERSION;
    if (!this.binary.startsWith("/")) {
      throw new GhError("unknown", `gh binary must be an absolute path (PATH 'gh' shim is unverified), got '${this.binary}'`);
    }
    this.minParsed = parseMinGhVersion(this.minVersion);
  }

  /** Run a typed argv array against the validated binary; returns raw output. */
  async run(args: readonly string[], opts: SpawnOptions = {}): Promise<GhSpawnResult> {
    const res = await runCaptured(this.binary, args, opts);
    return res;
  }

  /** Run and parse fixed --json output; throws a classified GhError on failure. */
  async runJson(args: readonly string[], opts: SpawnOptions = {}): Promise<unknown> {
    const res = await this.run(args, opts);
    if (res.exitCode !== 0) {
      const kind = classifyGhFailure(res.exitCode, res.stdout, res.stderr);
      if (res.exitCode === -1) {
        throw new GhError("network", redactGhText(res.stderr.trim() || "spawn failed"), res.exitCode);
      }
      throw new GhError(kind, redactGhText(`${res.stderr.trim()}\n${res.stdout.trim()}`.trim()), res.exitCode);
    }
    if (res.stdout.trim().length === 0) {
      throw new GhError("unknown", "gh returned an empty response where JSON was expected", 0);
    }
    try {
      return JSON.parse(res.stdout) as unknown;
    } catch (err) {
      throw new GhError("unknown", `gh did not return valid JSON: ${redactGhText((err as Error).message)}`, res.exitCode);
    }
  }

  /** Validate the resolved binary's version and authentication state. */
  async validate(): Promise<GhValidation> {
    const versionOut = await this.run(argvVersion());
    const parsed = parseGhVersion(versionOut.stdout);
    const versionOk = parsed !== null && ghVersionAtLeast(parsed, this.minParsed);
    const auth = await this.authStatus();
    if (versionOut.exitCode !== 0 || auth.authenticated === false) {
      return {
        binary: this.binary,
        version: redactGhText(versionOut.stdout.trim()),
        versionOk,
        authenticated: auth.authenticated,
        account: auth.account,
      };
    }
    return {
      binary: this.binary,
      version: versionOut.stdout.trim(),
      versionOk,
      authenticated: auth.authenticated,
      account: auth.account,
    };
  }

  /** `gh auth status` — authenticated read of account/scopes (never a token). */
  async authStatus(): Promise<AuthStatus> {
    const res = await this.run(argvAuthStatus());
    if (res.exitCode !== 0) {
      const kind = classifyGhFailure(res.exitCode, res.stdout, res.stderr);
      return { authenticated: false, host: "unknown", account: undefined };
    }
    const m = /logged in to ([a-z0-9.-]+) (?:account|as) ([A-Za-z0-9._-]+)/i.exec(res.stdout);
    return {
      authenticated: true,
      host: m?.[1] ?? "github.com",
      account: m?.[2],
    };
  }

  /**
   * Read repository capability metadata (default branch, Issues enabled,
   * permissions). Missing capability is SURFACED (null/false fields), never
   * silently healthy.
   */
  async repoMeta(q: RepoMetaQuery): Promise<RepoMeta> {
    const data = (await this.runJson(argvRepoMeta(q))) as Record<string, unknown>;
    const permissions = isRecord(data.permissions)
      ? {
          admin: boolOrNull(data.permissions.admin),
          push: boolOrNull(data.permissions.push),
          pull: boolOrNull(data.permissions.pull),
        }
      : null;
    return {
      owner: q.owner,
      name: q.name,
      defaultBranch: typeof data.default_branch === "string" ? data.default_branch : null,
      issuesEnabled: boolOrNull(data.has_issues),
      permissions,
    };
  }

  /**
   * Read branch-protection metadata. A 404 (branch unprotected) is a real,
   * surfaced `{ enabled: false }` state — not an error. Any other failure throws
   * a classified GhError.
   */
  async protection(q: ProtectionQuery): Promise<ProtectionState> {
    const res = await this.run(argvProtection(q));
    if (res.exitCode === 0) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(res.stdout) as Record<string, unknown>;
      } catch {
        throw new GhError("unknown", "gh returned non-JSON protection metadata", 0);
      }
      const requiredApprovals =
        isRecord(data.required_pull_request_reviews) &&
        typeof data.required_pull_request_reviews.required_approving_review_count === "number"
          ? data.required_pull_request_reviews.required_approving_review_count
          : null;
      const checks = isRecord(data.required_status_checks)
        ? stringArrayOrNull(data.required_status_checks.contexts)
        : null;
      return {
        enabled: true,
        requiredApprovals,
        enforceAdmins: isRecord(data.enforce_admins)
          ? boolOrNull(data.enforce_admins.enabled)
          : null,
        requiredChecks: checks,
      };
    }
    const kind = classifyGhFailure(res.exitCode, res.stdout, res.stderr);
    if (kind === "not_found") {
      return { enabled: false, requiredApprovals: null, enforceAdmins: null, requiredChecks: null };
    }
    throw new GhError(kind, redactGhText(`${res.stderr.trim()}\n${res.stdout.trim()}`.trim()), res.exitCode);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function stringArrayOrNull(v: unknown): readonly string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}
