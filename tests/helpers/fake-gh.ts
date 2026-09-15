// tests/helpers/fake-gh.ts
//
// A test-only executable fake for the real /usr/bin/gh. It is spawned through
// the SAME typed-argv path as production (the GhClient is pointed at this
// absolute path), so argv/security properties are exercised for real while no
// real GitHub network/credential is touched. The fake is generated at a
// temporary path per scenario so tests never depend on the machine's actual gh
// binary or its PATH shim.
//
// Extended for P2 (polling/ingest/effects): `pr list`, `pr view` (incl. the
// statusCheckRollup / reviews projections), `pr create`, `pr merge`, and
// `issue close`/`reopen`. Mutating handlers write back to the scenario file so a
// later invocation observes the new reality (verification-before-DONE tests).

import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProtectionLike = Record<string, unknown> | "not_protected";

export interface FakeGhScenario {
  versionText?: string;
  auth?: boolean;
  authHost?: string;
  account?: string;
  /** Keyed by gh api path, e.g. "repos/xiaden/nomarr". */
  meta?: Record<string, object>;
  /** Keyed by full protection api path, value JSON or "not_protected" (404). */
  protection?: Record<string, ProtectionLike>;
  /** issue list results keyed by slug "owner/name". */
  issueList?: Record<string, unknown[]>;
  /** pr list results keyed by slug "owner/name". */
  prList?: Record<string, unknown[]>;
  /** PR detail keyed by "slug#number" (reviewDecision etc). */
  prView?: Record<string, unknown>;
  /** reviews keyed by "slug#number". */
  prReviews?: Record<string, unknown[]>;
  /** statusCheckRollup keyed by "slug#number". */
  prChecks?: Record<string, unknown[]>;
  /** issue comments keyed by "slug#number" (P2 bounded event data). */
  issueComments?: Record<string, unknown[]>;
  /** PR comments keyed by "slug#number" (P2 bounded event data). */
  prComments?: Record<string, unknown[]>;
  /** Head owner fallback for `pr create` when --head has no `owner:` prefix. */
  headOwner?: string;
  /** Number assigned by `pr create`. */
  prCreateNumber?: number;
  /** Internal: absolute path where the fake appends effect logs. */
  effectLogPath?: string;
}

export interface FakeGh {
  /** Absolute path to the executable launcher (spawn this as `binary`). */
  binary: string;
  /** Directory cleaned up on cleanup(). */
  dir: string;
  cleanup: () => void;
  /** Write an effect log entry set; assert bodies were delivered via stdin. */
  effectLogPath: string;
  /** Location of the scenario JSON (mutate + rewrite for scenario changes). */
  scenarioPath: string;
}

const FAKE_SOURCE = `\
const fs = require('fs');
const scPath = process.env.TISSUE_FAKE_GH_SCENARIO;
function load() { return JSON.parse(fs.readFileSync(scPath, 'utf8')); }
let sc = load();
function save() { fs.writeFileSync(scPath, JSON.stringify(sc)); }
const args = process.argv.slice(2);
function out(msg) { process.stdout.write(msg + '\\n'); process.exit(0); }
function bad(msg) { process.stderr.write(msg + '\\n'); process.exit(1); }
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function slug() { const i = args.indexOf('-R'); return args[i + 1]; }
function jsonFields() { const i = args.indexOf('--json'); return i >= 0 ? (args[i + 1] || '') : ''; }
function logEffect(entry) {
  const p = sc.effectLogPath;
  const log = JSON.parse(fs.readFileSync(p, 'utf8').trim() || '[]');
  log.push(entry);
  fs.writeFileSync(p, JSON.stringify(log));
}
if (args[0] === '--version') out(sc.versionText || 'gh version 2.98.0 (2026-08-20)');
if (args[0] === 'auth' && args[1] === 'status') {
  if (sc.auth === false) bad('not logged in to any hosts');
  out('Logged in to ' + (sc.authHost || 'github.com') + ' account ' + (sc.account || 'xiaden'));
}
if (args[0] === 'api') {
  const p = args[1] || '';
  if (/^repos\\/[^/]+\\/[^/]+\\/branches\\/[^/]+\\/protection$/.test(p)) {
    const v = (sc.protection || {})[p];
    if (v === 'not_protected') bad('HTTP 404: Not Found (repo branch protection)');
    if (v !== undefined) out(JSON.stringify(v));
    bad('HTTP 404: Not Found (unknown protection path)');
  }
  const meta = (sc.meta || {})[p];
  if (meta !== undefined) out(JSON.stringify(meta));
  bad('HTTP 404: Not Found (unknown repo)');
}
if (args[0] === 'issue' && args[1] === 'list') {
  out(JSON.stringify((sc.issueList || {})[slug()] || []));
}
if (args[0] === 'issue' && args[1] === 'comment') {
  const s = slug();
  const number = Number(args[2]);
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (c) { body += c; });
  process.stdin.on('end', function () {
    logEffect({ kind: 'issue.comment', slug: s, number: number, body: body });
    out('');
  });
  return;
}
if (args[0] === 'issue' && (args[1] === 'close' || args[1] === 'reopen')) {
  const s = slug();
  const number = Number(args[2]);
  const target = args[1] === 'close' ? 'CLOSED' : 'OPEN';
  const list = ((sc.issueList || {})[s] || []);
  const found = list.find(function (x) { return x.number === number; });
  if (found) found.state = target;
  save();
  logEffect({ kind: 'issue.' + args[1], slug: s, number: number });
  out('');
}
if (args[0] === 'issue' && args[1] === 'view') {
  const s = slug();
  const number = Number(args[2]);
  const fields = jsonFields();
  const found = ((sc.issueList || {})[s] || []).find(function (x) { return x.number === number; });
  if (fields.indexOf('comments') >= 0) {
    out(JSON.stringify({ comments: (sc.issueComments || {})[s + '#' + number] || [] }));
  }
  if (fields.indexOf('body') >= 0) {
    out(JSON.stringify({ body: found ? (found.body || '') : '' }));
  }
  if (found !== undefined) out(JSON.stringify(found));
  bad('HTTP 404: Not Found (issue)');
}
if (args[0] === 'pr' && args[1] === 'list') {
  out(JSON.stringify((sc.prList || {})[slug()] || []));
}
if (args[0] === 'pr' && args[1] === 'view') {
  const s = slug();
  const number = Number(args[2]);
  const key = s + '#' + number;
  const fields = jsonFields();
  if (fields.indexOf('statusCheckRollup') >= 0) {
    out(JSON.stringify({ number: number, statusCheckRollup: (sc.prChecks || {})[key] || [] }));
  }
  if (fields.indexOf('reviews') >= 0) {
    out(JSON.stringify({ number: number, reviews: (sc.prReviews || {})[key] || [] }));
  }
  if (fields.indexOf('comments') >= 0) {
    out(JSON.stringify({ number: number, comments: (sc.prComments || {})[key] || [] }));
  }
  const view = (sc.prView || {})[key]
    || ((sc.prList || {})[s] || []).find(function (x) { return x.number === number; });
  if (view !== undefined) out(JSON.stringify(view));
  bad('HTTP 404: Not Found (pr)');
}
if (args[0] === 'pr' && args[1] === 'create') {
  const s = slug();
  const head = flag('--head');
  const base = flag('--base');
  const title = flag('--title');
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (c) { body += c; });
  process.stdin.on('end', function () {
    const number = sc.prCreateNumber || 101;
    const rawHead = head || '';
    const ci = rawHead.indexOf(':');
    const headOwner = ci >= 0 ? rawHead.slice(0, ci) : (sc.headOwner || s.split('/')[0]);
    const headBranch = ci >= 0 ? rawHead.slice(ci + 1) : rawHead;
    const targetName = s.split('/')[1];
    const row = {
      number: number, state: 'OPEN', headRefName: headBranch, headRefOid: sc.headSha || '',
      headRepositoryOwner: { login: headOwner },
      headRepository: { nameWithOwner: headOwner + '/' + targetName },
      updatedAt: new Date().toISOString(), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      isDraft: false, url: 'https://example.invalid/pr/' + number
    };
    sc.prList = sc.prList || {};
    sc.prList[s] = sc.prList[s] || [];
    sc.prList[s].push(row);
    sc.prView = sc.prView || {};
    sc.prView[s + '#' + number] = Object.assign({}, row, { reviewDecision: '' });
    save();
    logEffect({ kind: 'pr.create', slug: s, head: head, base: base, title: title, body: body, number: number });
    out('https://example.invalid/pr/' + number);
  });
  return;
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const s = slug();
  const number = Number(args[2]);
  const key = s + '#' + number;
  const method = args.find(function (a) { return a.indexOf('--') === 0 && a !== '--json'; }) || '';
  if ((sc.prView || {})[key]) sc.prView[key].state = 'MERGED';
  const list = ((sc.prList || {})[s] || []);
  const found = list.find(function (x) { return x.number === number; });
  if (found) found.state = 'MERGED';
  save();
  logEffect({ kind: 'pr.merge', slug: s, number: number, method: method, argv: args });
  out('');
}
bad('unhandled fake-gh argv: ' + JSON.stringify(args));
`;

const LAUNCHER = `\
#!/bin/sh
export TISSUE_FAKE_GH_SCENARIO="@SCENARIO@"
exec "@NODE@" "@SCRIPT@" "$@"
`;

/** Write an executable fake gh for a scenario. Returns spawn target + cleanup. */
export function writeFakeGh(scenario: FakeGhScenario = {}): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), "tissue-fakegh-"));
  const scenarioPath = join(dir, "scenario.json");
  const effectLogPath = join(dir, "effects.jsonl");
  const node = process.execPath;

  writeFileSync(effectLogPath, "");
  writeFakeScenario(scenarioPath, { effectLogPath, ...scenario });

  const scriptPath = join(dir, "fake-gh.cjs");
  writeFileSync(scriptPath, FAKE_SOURCE, "utf8");

  const launcher = join(dir, "gh");
  writeFileSync(
    launcher,
    LAUNCHER.replace("@SCENARIO@", scenarioPath).replace("@NODE@", node).replace("@SCRIPT@", scriptPath),
    "utf8",
  );
  chmodSync(launcher, 0o755);

  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  return { binary: launcher, dir, cleanup, effectLogPath, scenarioPath };
}

/** Rewrite the scenario JSON (for scenario switches in one test). */
export function writeFakeScenario(path: string, scenario: FakeGhScenario): void {
  writeFileSync(path, JSON.stringify(scenario), "utf8");
}

/** Read the effect log written by mutating fake handlers. */
export function readEffectLog(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, "utf8").trim();
  return raw.length === 0 ? [] : (JSON.parse(raw) as Array<Record<string, unknown>>);
}

export interface RepoMetaLike {
  default_branch: string;
  has_issues: boolean;
  permissions: { admin: boolean; push: boolean; pull: boolean };
}

export function defaultNomarrMeta(): Record<string, RepoMetaLike> {
  return {
    "repos/xiaden/nomarr": {
      default_branch: "main",
      has_issues: true,
      permissions: { admin: true, push: true, pull: true },
    },
  };
}
