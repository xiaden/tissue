// plugin/tissue-moderation.ts
//
// Global OpenCode moderation plugin (plan L; DD-tissue-container-migration §9;
// requirement ledger L3/L4/L15–L21). It is loaded by the resident OpenCode
// runtime from the global plugins directory and is NOT imported by any
// repository module.
//
// LIMITS (L20): this plugin does NOT provide prompt-injection prevention. The
// work item's own issue/PR/comments are themselves untrusted content and may
// need to be delivered to the worker. The control provides: scope filtering
// through Tissue; reduction of unrelated conversational-content exposure;
// reduction of easy recursive prompt-pull behavior; and an auditable
// moderation/control point. A worker deliberately using generic
// programming/network primitives to retrieve public information is accepted
// residual risk, not an obligation to chase with sandboxing or egress controls.
// This is a behavioural guardrail, not a security sandbox.
//
// MODULE CONTRACT (adversarial IP-5 / SC-8; opencode #42451): exactly ONE
// runtime export — the named `TissueModeration`. The V1 loader invokes every
// exported function of a plugin module without validating it, so a stray helper
// export can brick the fleet. There are ZERO imports (not even `node:` builtins)
// and no throw-capable top-level evaluation: Node builtins are reached through
// the global `process.getBuiltinModule(id)` inside function bodies, and all I/O
// lives inside the factory/hook bodies. The only throw is the L19 refusal after
// a positive conversational match; every other fault is caught, logged once,
// and yields a no-op so unrelated tools are never blocked.

// --- Types (local; never imported) -----------------------------------------

interface BeaconFsStat {
  isDirectory(): boolean;
  isFile(): boolean;
  dev: number;
  ino: number;
}

interface BeaconFs {
  lstatSync(path: string): BeaconFsStat;
  statSync(path: string): BeaconFsStat;
  fstatSync(fd: number): BeaconFsStat;
  openSync(path: string, flags: string, mode?: number): number;
  closeSync(fd: number): void;
  readFileSync(path: string): Uint8Array;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeSync(fd: number, data: string, position?: number, encoding?: string): number;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

interface ToolExecuteInput {
  tool?: unknown;
  sessionID?: unknown;
  callID?: unknown;
}

interface ToolExecuteOutput {
  args?: unknown;
}

type BeforeHook = (
  input: ToolExecuteInput,
  output: ToolExecuteOutput,
) => Promise<void>;

interface PluginHooks {
  "tool.execute.before": BeforeHook;
}

type Decision =
  | { kind: "allow" }
  | { kind: "deny"; rule: string; normalizedTarget: string };

interface NormalizedUrl {
  host: string;
  path: string;
  search: string;
}

// --- Constants --------------------------------------------------------------

const MODERATION_REFUSAL =
  "GitHub conversational content for this automated Tissue session is moderated by Tissue. Use the GitHub context supplied to the current work item/session instead of retrieving issue, PR, review, or comment content directly.";

const DEFAULT_REGISTRY_DIR = "/tissue-session-registry";

// Load beacon (L21; DD §9.2(b), boot identity PE-04). Non-exported module
// constants: the module must keep exactly one runtime export.
const PLUGIN_VERSION = "1.0.0";
const DEFAULT_MODERATION_DIR = "/tissue-moderation";
const BEACON_FILENAME = "plugin-loaded.json";

// Wrapper nesting bound. A command nested deeper than this is treated as a
// matcher fault (no-op + one log record) rather than being followed further.
const MAX_WRAPPER_DEPTH = 8;

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

const ALLOW: Decision = { kind: "allow" };

const SHELL_COMMANDS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
const SHELL_VALUE_OPTIONS = new Set(["-o", "--option"]);

// --- Errors -----------------------------------------------------------------

class ModerationRefusal extends Error {}

class ModerationFault extends Error {}

class TokenizeFault extends Error {}

// --- Session classification (P2-S2) -----------------------------------------

function resolveAbsoluteDir(value: string, rejectedRoots: readonly string[] = []): string | null {
  if (value.length === 0 || !value.startsWith("/") || value.includes("\0") || [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  })) return null;
  const base = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  if (base.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (rejectedRoots.some((root) => base === root || base.startsWith(`${root}/`))) return null;
  return base;
}

function resolveRegistryDir(): string | null {
  const fromEnv = process.env.TISSUE_SESSION_REGISTRY_DIR;
  if (fromEnv === undefined) return DEFAULT_REGISTRY_DIR;
  if ([...fromEnv].some((character) => character.codePointAt(0) === 0)) return null;
  return resolveAbsoluteDir(fromEnv, ["/run", "/proc", "/sys", "/dev"]);
}

/**
 * Two-state classification: MANAGED iff the `ses_*` marker file exists.
 * A single `statSync`; every error path (missing/invalid env, invalid session
 * id, unreadable or nonexistent registry directory) is UNMANAGED. Marker
 * contents are never read, nothing is cached, and no HTTP is performed.
 */
function classifySession(sessionId: unknown): "MANAGED" | "UNMANAGED" {
  try {
    if (typeof sessionId !== "string") return "UNMANAGED";
    if (!SESSION_ID_RE.test(sessionId)) return "UNMANAGED";
    const base = resolveRegistryDir();
    if (base === null) return "UNMANAGED";
    const markerPath = `${base}/${sessionId}`;
    const { statSync } = process.getBuiltinModule("node:fs");
    statSync(markerPath);
    return "MANAGED";
  } catch {
    return "UNMANAGED";
  }
}

// --- Tokenizer (P2-S3) ------------------------------------------------------

/**
 * Quote/escape-aware single-pass tokenizer. Adjacent quoted and unquoted runs
 * concatenate into one argv token; only unquoted whitespace separates tokens.
 * An unterminated quote is a parse fault.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command.charAt(i);
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        i += 1;
        continue;
      }
      current += ch;
      started = true;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        i += 1;
        continue;
      }
      if (ch === "\\") {
        const next = command.charAt(i + 1);
        if (next !== "") {
          current += (next === "$" || next === "`") ? `\\${next}` : next;
          started = true;
          i += 2;
          continue;
        }
        current += ch;
        started = true;
        i += 1;
        continue;
      }
      current += ch;
      started = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      const next = command.charAt(i + 1);
      if (next !== "") {
        current += (next === "$" || next === "`") ? `\\${next}` : next;
        started = true;
        i += 2;
        continue;
      }
      current += ch;
      started = true;
      i += 1;
      continue;
    }
    if (
      ch === " " ||
      ch === "\t" ||
      ch === "\n" ||
      ch === "\r" ||
      ch === "\f" ||
      ch === "\v"
    ) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      i += 1;
      continue;
    }
    current += ch;
    started = true;
    i += 1;
  }
  if (quote !== null) throw new TokenizeFault("unterminated-quote");
  if (started) tokens.push(current);
  return tokens;
}

// --- Wrapper unwrapping (P2-S3) ---------------------------------------------

function isShellExecutable(command: string): boolean {
  if (SHELL_COMMANDS.has(command)) return true;
  const slash = command.lastIndexOf("/");
  if (slash <= 0 || slash === command.length - 1) return false;
  const basename = command.slice(slash + 1);
  const components = command.split("/");
  return SHELL_COMMANDS.has(basename) && components.every((segment, index) => index === 0 || segment.length > 0);
}

function shellCommandIndex(argv: string[]): number {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") return -1;
    if (token.startsWith("--")) {
      if (SHELL_VALUE_OPTIONS.has(token) || token === "--option") { i += 1; continue; }
      if (token.startsWith("--option=")) continue;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      // A short-option cluster containing `c` (e.g. -c, -ic) takes the next
      // argument as the program text. Value-taking options consume their value.
      if (token === "-o") { i += 1; continue; }
      if (token.includes("c")) return i + 1;
      continue;
    }
    return -1; // first non-option is a script file, not a `-c` program
  }
  return -1;
}

function findExecInner(argv: string[]): string[] | null {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "-exec" || token === "-execdir") {
      const inner: string[] = [];
      for (let j = i + 1; j < argv.length; j += 1) {
        const arg = argv[j]!;
        if (arg === ";" || arg === "+") break;
        inner.push(arg);
      }
      return inner;
    }
  }
  return null;
}

function unwrapTimeout(argv: string[]): string[] {
  let i = 1;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--") {
      i += 1;
      break;
    }
    if (token.startsWith("-")) {
      const takesValue =
        token === "-k" ||
        token === "--kill-after" ||
        token === "-s" ||
        token === "--signal";
      i += takesValue && token.indexOf("=") === -1 ? 2 : 1;
      continue;
    }
    break;
  }
  if (i < argv.length) i += 1; // consume the DURATION operand
  return argv.slice(i);
}

function unwrapNice(argv: string[]): string[] {
  let i = 1;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--") {
      i += 1;
      break;
    }
    if (token.startsWith("-")) {
      const takesValue = token === "-n" || token === "--adjustment";
      i += takesValue && token.indexOf("=") === -1 ? 2 : 1;
      continue;
    }
    break;
  }
  return argv.slice(i);
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function unwrapEnv(argv: string[]): string[] {
  let i = 1;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--") {
      i += 1;
      break;
    }
    if (token.startsWith("-")) {
      const takesValue =
        token === "-u" ||
        token === "--unset" ||
        token === "-C" ||
        token === "--chdir" ||
        token === "-S" ||
        token === "--split-string";
      i += takesValue && token.indexOf("=") === -1 ? 2 : 1;
      continue;
    }
    if (ENV_ASSIGN_RE.test(token)) {
      i += 1;
      continue;
    }
    break;
  }
  return argv.slice(i);
}

const XARGS_VALUE_OPTS = new Set([
  "-a",
  "--arg-file",
  "-d",
  "--delimiter",
  "-E",
  "--eof",
  "-I",
  "--replace",
  "-L",
  "--max-lines",
  "-n",
  "--max-args",
  "-P",
  "--max-procs",
  "-s",
  "--max-chars",
]);

function unwrapXargs(argv: string[]): string[] {
  let i = 1;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--") {
      i += 1;
      break;
    }
    if (token.startsWith("-") && token.length > 1) {
      const eq = token.indexOf("=");
      const optName = eq === -1 ? token : token.slice(0, eq);
      const takesValue = XARGS_VALUE_OPTS.has(token) || XARGS_VALUE_OPTS.has(optName);
      i += takesValue && eq === -1 ? 2 : 1;
      continue;
    }
    break;
  }
  return argv.slice(i);
}

function unwrapCommandLike(argv: string[]): string[] {
  let i = 1;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--") {
      i += 1;
      break;
    }
    if (token.startsWith("-") && token.length > 1) {
      i += 1;
      continue;
    }
    break;
  }
  return argv.slice(i);
}

// --- URL canonicalisation (P2-S3) -------------------------------------------

/**
 * Canonicalise a URL candidate. Returns null for anything that is not a
 * parseable http(s) URL (rule 1): such a candidate falls through untouched.
 *
 * Pinned rules: lower-case scheme/host (the WHATWG parser already case-folds
 * and applies IDNA); strip exactly one trailing dot; strip a leading `www.`
 * only for `github.com`; strip a default port only (any other port keeps the
 * origin distinct and returns a host that cannot match the github families);
 * WHATWG-normalise then percent-decode the path exactly once; keep the query
 * for search-endpoint inspection.
 */
function parseUrl(raw: string): NormalizedUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") return null;

  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1); // exactly one trailing dot
  if (host === "www.github.com") host = "github.com"; // never *.github.com

  let port = url.port;
  const defaultPort = protocol === "https:" ? "443" : "80";
  if (port === defaultPort) port = "";
  if (port !== "") return { host: `${host}:${port}`, path: "", search: "" };

  let path = url.pathname;
  path = path.replace(/\/{2,}/g, "/");
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  return { host, path, search: url.search };
}

function isConversationalSearchQuery(search: string): boolean {
  const params = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of params.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (
      key === "type" &&
      (value === "issues" ||
        value === "pulls" ||
        value === "prs" ||
        value === "discussions")
    ) {
      return true;
    }
  }
  return false;
}

// --- Endpoint-shape rules (P2-S4) -------------------------------------------

function deny(rule: string, normalizedTarget: string): Decision {
  return { kind: "deny", rule, normalizedTarget };
}

function classifyGithubPage(path: string, search: string): Decision | null {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0] === "search") {
    if (isConversationalSearchQuery(search)) return deny("github-search-page", path);
    return null;
  }
  const resource = segments[2];
  if (resource === undefined) return null;
  if (resource === "pull" || resource === "pulls") {
    const tail = segments[3];
    // Path-scoped carve-out: github.com/<o>/<r>/pull(s)?/<n>.diff|.patch
    if (tail !== undefined && /^\d+\.(diff|patch)$/.test(tail)) return null;
    return deny("github-pull-page", path);
  }
  if (resource === "issues" || resource === "discussions") {
    return deny("github-issue-page", path);
  }
  return null;
}

function classifyApiPath(path: string): Decision | null {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0] === "graphql") return deny("github-api-graphql", path);
  if (segments[0] === "search") {
    const kind = segments[1];
    if (
      kind === "issues" ||
      kind === "pulls" ||
      kind === "prs" ||
      kind === "commits" ||
      kind === "discussions"
    ) {
      return deny("github-api-search", path);
    }
    return null;
  }
  if (segments[0] === "repos" && segments[1] !== undefined && segments[2] !== undefined) {
    const sub = segments[3];
    if (sub === undefined) return null; // bare repo resource
    if (sub === "releases") return null; // path-scoped ALLOW
    if (
      sub === "pulls" &&
      segments.length === 6 &&
      segments[4] !== undefined &&
      /^\d+$/.test(segments[4]) &&
      (segments[5] === "files" || segments[5] === "commits")
    ) {
      return null; // enumerated carve-outs
    }
    // Only the conversational subtrees are DENY; every other repo sub-resource
    // falls through to fail-open (DD §9.3 lines 670/686-691/701).
    if (sub === "issues" || sub === "pulls") return deny("github-api-conversational", path);
    return null;
  }
  return null;
}

function classifyUrl(url: NormalizedUrl): Decision | null {
  if (url.host === "github.com") return classifyGithubPage(url.path, url.search);
  if (url.host === "api.github.com") return classifyApiPath(url.path);
  // raw/objects/codeload and every other host are not conversational.
  return null;
}

const GH_API_VALUE_OPTS = new Set([
  "--method",
  "-X",
  "--field",
  "-f",
  "--raw-field",
  "-F",
  "--header",
  "-H",
  "--hostname",
  "--jq",
  "-q",
  "--template",
  "-t",
  "--input",
  "--cache",
  "--preview",
]);

function matchGhApi(args: string[]): Decision {
  const positionals: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i]!;
    if (token === "--") {
      i += 1;
      while (i < args.length) {
        positionals.push(args[i]!);
        i += 1;
      }
      break;
    }
    if (token.startsWith("-") && token.length > 1) {
      const eq = token.indexOf("=");
      const optName = eq === -1 ? token : token.slice(0, eq);
      const takesValue = GH_API_VALUE_OPTS.has(token) || GH_API_VALUE_OPTS.has(optName);
      i += takesValue && eq === -1 && i + 1 < args.length ? 2 : 1;
      continue;
    }
    positionals.push(token);
    i += 1;
  }

  const rawPath = positionals.length > 0 ? positionals[0]! : "";
  const path = rawPath.replace(/^\/+/, "");
  if (path.length === 0) return ALLOW;
  const target = `gh api ${path}`;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0] === "graphql") return deny("gh-api-graphql", target);
  if (segments[0] === "repos" && segments[1] !== undefined && segments[2] !== undefined) {
    const sub = segments[3];
    if (sub === undefined) return ALLOW;
    if (sub === "releases") return ALLOW;
    if (
      sub === "pulls" &&
      segments.length === 6 &&
      segments[4] !== undefined &&
      /^\d+$/.test(segments[4]) &&
      (segments[5] === "files" || segments[5] === "commits")
    ) {
      return ALLOW;
    }
    // Only the conversational subtrees are DENY; every other repo sub-resource
    // falls through to fail-open (DD §9.3 lines 670/686-691/701).
    if (sub === "issues" || sub === "pulls") return deny("gh-api-conversational", target);
    return ALLOW;
  }
  return ALLOW;
}

function matchGh(argv: string[], depth: number): Decision {
  const rest = argv.slice(1);
  if (rest.length === 0) return ALLOW;

  let i = 0;
  while (i < rest.length) {
    const token = rest[i]!;
    if (token === "--") {
      i += 1;
      break;
    }
    if (token === "--repo" || token === "-R" || token === "--hostname") {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }

  const sub = rest[i];
  if (sub === undefined) return ALLOW;
  const action = rest[i + 1];
  // Preserve deterministic fault injection boundaries without retaining the
  // command in diagnostics; the resulting value is intentionally discarded.
  void argv.join(" ");
  const target = `gh ${sub} ${action ?? "unknown"}`;

  if (sub === "api") return matchGhApi(rest.slice(i + 1));

  if (sub === "issue") {
    if (action === "view" || action === "list") return deny("gh-issue-read", target);
    return ALLOW;
  }
  if (sub === "pr") {
    if (action === "view" || action === "list") return deny("gh-pr-read", target);
    return ALLOW;
  }
  if (sub === "search") {
    if (action === "issues" || action === "prs") {
      return deny("gh-search-conversation", target);
    }
    return ALLOW;
  }
  if (sub === "alias") {
    if (action === "set") {
      // The alias RHS is parsed with the same matcher.
      const expansion = rest.slice(i + 3).join(" ");
      if (expansion.length > 0) {
        return matchCommand(["gh", ...tokenize(expansion)], depth + 1);
      }
    }
    return ALLOW;
  }
  return ALLOW;
}

function matchCurlWget(argv: string[]): Decision {
  const command = argv[0] === "curl" || argv[0] === "wget" ? argv[0] : "network";
  const urlOptions = new Set(["--url", "-u", "--location", "-L"]);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    let candidate = token;
    const equals = token.indexOf("=");
    const option = equals === -1 ? token : token.slice(0, equals);
    if (urlOptions.has(option)) {
      if (equals !== -1) candidate = token.slice(equals + 1);
      else if (i + 1 < argv.length) { i += 1; candidate = argv[i]!; }
      else continue;
    }
    if (!/^https?:\/\//i.test(candidate)) continue;
    const parsed = parseUrl(candidate);
    if (parsed === null) continue;
    const decision = classifyUrl(parsed);
    if (decision !== null && decision.kind === "deny") {
      return deny(decision.rule, `${command}-url(${parsed.host})`);
    }
  }
  return ALLOW;
}

// --- Command matcher (P2-S3/P2-S4) ------------------------------------------

function isGhExecutable(command: string): boolean {
  if (command === "gh") return true;
  if (/[\0\x00-\x1f\x7f]/u.test(command)) return false;
  const slash = command.lastIndexOf("/");
  if (slash <= 0 || command.slice(slash + 1) !== "gh") return false;
  // Accept ordinary relative and absolute qualified executables by basename;
  // reject URI-like and empty components rather than broad substring matches.
  const prefix = command.slice(0, slash);
  return prefix.startsWith("/") || prefix.split("/").every((segment) => segment.length > 0);
}

function stripAssignmentPrefix(argv: string[]): string[] {
  let index = 0;
  while (index < argv.length && ENV_ASSIGN_RE.test(argv[index]!)) index += 1;
  return argv.slice(index);
}

function splitCompoundCommand(command: string): string[][] {
  const segments: string[][] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let substitutionDepth = 0;
  const flush = (end: number): void => {
    const text = command.slice(start, end).trim();
    if (text.length > 0) segments.push(tokenize(text));
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "`" || (ch === "$" && command.charAt(i + 1) === "(")) {
      if (ch === "$") { substitutionDepth += 1; i += 1; }
      else substitutionDepth += 1;
      continue;
    }
    if (substitutionDepth > 0) {
      if (ch === ")" && command.charAt(i - 1) !== "\\") substitutionDepth -= 1;
      else if (ch === "`" && command.charAt(i - 1) !== "\\") substitutionDepth -= 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
      flush(i);
      if ((ch === ";" || ch === "|" || ch === "&") && command.charAt(i + 1) === ch) i += 1;
      start = i + 1;
    }
  }
  if (quote !== null) throw new TokenizeFault("unterminated-quote");
  flush(command.length);
  return segments;
}

function matchCommand(argv: string[], depth: number): Decision {
  if (depth > MAX_WRAPPER_DEPTH) throw new ModerationFault("wrapper-depth-exceeded");
  const commandArgv = stripAssignmentPrefix(argv);
  if (commandArgv.length === 0) return ALLOW;
  argv = commandArgv;
  const command = argv[0]!;

  if (command === "eval") {

    const program = argv.slice(1).join(" ");
    if (program.length === 0) return ALLOW;
    return matchCommand(tokenize(program), depth + 1);
  }

  if (isShellExecutable(command)) {
    const index = shellCommandIndex(argv);
    if (index >= 0 && index < argv.length) {
      return matchCompound(argv[index]!, depth + 1);
    }
    return ALLOW;
  }

  if (command === "find") {
    const inner = findExecInner(argv);
    if (inner !== null) return matchCommand(inner, depth + 1);
    return ALLOW;
  }

  if (command === "timeout") return matchCommand(unwrapTimeout(argv), depth + 1);
  if (command === "nice") return matchCommand(unwrapNice(argv), depth + 1);
  if (command === "env") return matchCommand(unwrapEnv(argv), depth + 1);
  if (command === "xargs") return matchCommand(unwrapXargs(argv), depth + 1);
  if (command === "command" || command === "exec") {
    return matchCommand(unwrapCommandLike(argv), depth + 1);
  }

  if (isGhExecutable(command)) return matchGh(["gh", ...commandArgv.slice(1)], depth);
  if (command === "curl" || command === "wget") return matchCurlWget(commandArgv);
  return ALLOW;
}

function matchCompound(command: string, depth: number): Decision {
  // Structural scan: substitutions execute inside double quotes and backticks,
  // while single-quoted and escaped markers remain literal.
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") { i += 1; continue; }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
    } else if (ch === "'") { quote = "'"; continue; }
    else if (ch === '"') { quote = '"'; continue; }

    if (ch !== "`" && !(ch === "$" && command.charAt(i + 1) === "(")) continue;
    const isParen = ch === "$";
    const open = isParen ? i + 1 : i;
    const close = isParen ? ")" : "`";
    let level = 1;
    let end = open + 1;
    let innerQuote: "'" | '"' | null = null;
    while (end < command.length && level > 0) {
      const current = command.charAt(end);
      if (innerQuote === "'") {
        if (current === "'") innerQuote = null;
        end += 1;
        continue;
      }
      if (current === "\\") { end += 2; continue; }
      if (innerQuote === '"') {
        if (current === '"') innerQuote = null;
        end += 1;
        continue;
      }
      if (current === "'" || current === '"') { innerQuote = current; end += 1; continue; }
      if (current === close) level -= 1;
      else if (isParen && current === "$" && command.charAt(end + 1) === "(") { level += 1; end += 1; }
      end += 1;
    }
    if (level !== 0) throw new TokenizeFault("unterminated-substitution");
    const substitution = matchCompound(command.slice(open + 1, end - 1), depth + 1);
    if (substitution.kind === "deny") return substitution;
    i = end - 1;
  }
  if (quote !== null) throw new TokenizeFault("unterminated-quote");
  const segments = splitCompoundCommand(command);
  for (const segment of segments) {
    const decision = matchCommand(segment, depth);
    if (decision.kind === "deny") return decision;
  }
  return ALLOW;
}

// --- Hook evaluation --------------------------------------------------------

function evaluateToolCall(tool: string, output: ToolExecuteOutput): Decision {
  if (tool === "bash") {
    const args = output?.args as { command?: unknown } | undefined;
    const command = args?.command;
    if (typeof command !== "string") throw new ModerationFault("malformed-arguments");
    return matchCompound(command, 0);
  }
  // tool === "webfetch" (unknown tools are handled before this point)
  const args = output?.args as { url?: unknown } | undefined;
  const url = args?.url;
  if (typeof url !== "string") throw new ModerationFault("malformed-arguments");
  const parsed = parseUrl(url);
  if (parsed === null) return ALLOW;
  const decision = classifyUrl(parsed);
  if (decision?.kind === "deny") {
    return deny(decision.rule, `webfetch-url(${parsed.host})`);
  }
  return ALLOW;
}

function describeTarget(tool: string, output: ToolExecuteOutput): string {
  try {
    const args = output?.args as Record<string, unknown> | undefined;
    if (args === undefined || args === null || typeof args !== "object") {
      return "unavailable";
    }
    if (tool === "bash" && typeof args["command"] === "string") {
      const command = args["command"];
      const firstMatch = /^\s*([^\s]+)/u.exec(command);
      const token = firstMatch?.[1] ?? "unknown";
      const safe = new Set(["gh", "curl", "wget", "env", "timeout", "nice", "xargs", "command", "exec"]);
      return `bash-command(${safe.has(token) || SHELL_COMMANDS.has(token) ? token : "unknown"})`;
    }
    if (tool === "webfetch" && typeof args["url"] === "string") {
      try {
        const protocol = /^([a-z][a-z0-9+.-]*):/iu.exec(args["url"]);
        return `webfetch-url(${protocol?.[1]?.toLowerCase() ?? "unknown"})`;
      } catch {
        return "webfetch-url(unparseable)";
      }
    }
  } catch {
    /* never let diagnostics throw */
  }
  return "unavailable";
}

// --- Observability (L21) ----------------------------------------------------

/**
 * One structured stderr record per handled fault/block. Timestamp, session ID,
 * tool, matched rule, and the normalized target are sufficient for diagnosis;
 * no secrets, credentials, or auth material are ever included. Logging must
 * never throw.
 */
function logBlock(fields: {
  sessionID: string;
  tool: string;
  rule: string;
  target: string;
}): void {
  try {
    const record = {
      ts: new Date().toISOString(),
      sessionID: fields.sessionID,
      tool: fields.tool,
      rule: fields.rule,
      target: fields.target,
    };
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    /* logging must never break moderation */
  }
}

// --- Load beacon (L21; DD §9.2(b), boot identity PE-04) ---------------------

/**
 * Absolute path of this plugin's own source file, derived from `import.meta.url`
 * (works under both `node --test` and the Bun-hosted OpenCode). Returns `null`
 * when the URL is not a file URL; the beacon write then fails closed and logs
 * exactly one record. No digest is ever hard-coded.
 */
function resolvePluginPath(): string | null {
  try {
    const url = import.meta.url;
    if (typeof url !== "string" || !url.startsWith("file://")) return null;
    return decodeURIComponent(url.slice("file://".length));
  } catch {
    return null;
  }
}

function resolveModerationDir(): string | null {
  const fromEnv = process.env.TISSUE_MODERATION_DIR;
  if (fromEnv === undefined) return DEFAULT_MODERATION_DIR;
  return resolveAbsoluteDir(fromEnv, ["/run", "/proc", "/sys", "/dev"]);
}

/**
 * Write `plugin-loaded.json` atomically immediately after the factory has built
 * its hooks object: a unique temp file in the same directory, then `renameSync`
 * onto the final path. Exactly seven fields. On any failure, logs exactly one
 * structured record and returns normally — a beacon failure must never disable
 * moderation and must never throw. No record is emitted on success (the matcher
 * test spies on `process.stderr.write` and asserts exact record counts).
 */
let beaconWriteBusy = false;

/**
 * Write `plugin-loaded.json` atomically while binding every filesystem operation
 * to an already-open directory descriptor.  The descriptor-relative `/proc` path
 * prevents a later ancestor replacement from redirecting writes; identity checks
 * before and after publication turn that replacement into one safe failure.
 */
function openBoundModerationDir(fs: BeaconFs, base: string): { fd: number; path: string; identity: { dev: number; ino: number }[] } {
  const parts = base.split("/").filter(Boolean);
  let current = "";
  const identity: { dev: number; ino: number }[] = [];
  for (const part of parts) {
    current += `/${part}`;
    const statPath = current === base && base === DEFAULT_MODERATION_DIR ? `${current}/` : current;
    const stat = fs.lstatSync(statPath);
    if (!stat.isDirectory()) throw new Error("moderation-dir-ancestor-replaced");
    identity.push({ dev: stat.dev, ino: stat.ino });
  }
  const fd = fs.openSync(`${base}/`, "r");
  const bound = fs.fstatSync(fd);
  const last = identity[identity.length - 1];
  if (last === undefined || bound.dev !== last.dev || bound.ino !== last.ino) {
    fs.closeSync(fd);
    throw new Error("moderation-dir-ancestor-replaced");
  }
  return { fd, path: `${base}/`, identity };
}

function assertModerationDirIdentity(fs: BeaconFs, base: string, identity: { dev: number; ino: number }[]): void {
  const parts = base.split("/").filter(Boolean);
  let current = "";
  for (let index = 0; index < parts.length; index += 1) {
    current += `/${parts[index]}`;
    const statPath = current === base && base === DEFAULT_MODERATION_DIR ? `${current}/` : current;
    const stat = fs.lstatSync(statPath);
    const expected = identity[index];
    if (expected === undefined || !stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Error("moderation-dir-ancestor-replaced");
    }
  }
}

function writeLoadBeacon(): void {
  if (beaconWriteBusy) return;
  beaconWriteBusy = true;
  let dirFd: number | undefined;
  try {
    const fs = process.getBuiltinModule("node:fs") as BeaconFs;
    const crypto = process.getBuiltinModule("node:crypto");
    const pluginPath = resolvePluginPath();
    if (pluginPath === null) throw new Error("plugin-path-unresolved");
    const pluginSha256 = crypto.createHash("sha256").update(fs.readFileSync(pluginPath)).digest("hex");
    const dir = resolveModerationDir();
    if (dir === null) throw new Error("moderation-dir-invalid");
    if (process.env.TISSUE_MODERATION_DIR === undefined) fs.mkdirSync(`${dir}/`, { recursive: true });
    const boundDir = openBoundModerationDir(fs, dir);
    dirFd = boundDir.fd;
    const loadedAt = Date.now();
    const beacon = {
      kind: "loaded", pluginSha256, pluginVersion: PLUGIN_VERSION, loadedAt,
      serverStartedAt: loadedAt - process.uptime() * 1000, pid: process.pid, nonce: crypto.randomUUID(),
    };
    const finalPath = `${boundDir.path}/${BEACON_FILENAME}`;
    const tmpPath = `${boundDir.path}/.${BEACON_FILENAME}.${process.pid}.${loadedAt}.${crypto.randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      assertModerationDirIdentity(fs, dir, boundDir.identity);
      fd = fs.openSync(tmpPath, "wx", 0o600);
      const payload = JSON.stringify(beacon);
      const expectedBytes = Buffer.byteLength(payload, "utf8");
      const written = fs.writeSync(fd, payload, undefined, "utf8");
      if (written !== expectedBytes) throw new Error("beacon-short-write");
      fs.closeSync(fd); fd = undefined;
      const tempStat = fs.lstatSync(tmpPath);
      if (!tempStat.isFile()) throw new Error("beacon-temp-replaced");
      const tempFd = fs.openSync(tmpPath, "r");
      try {
        const bound = fs.fstatSync(tempFd);
        if (!bound.isFile() || bound.dev !== tempStat.dev || bound.ino !== tempStat.ino) throw new Error("beacon-temp-replaced");
        try { fs.lstatSync(finalPath); throw new Error("beacon-final-exists"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        assertModerationDirIdentity(fs, dir, boundDir.identity);
        fs.renameSync(tmpPath, finalPath);
      } finally { fs.closeSync(tempFd); }
      try { assertModerationDirIdentity(fs, dir, boundDir.identity); } catch (error) {
        try { fs.unlinkSync(finalPath); } catch { /* descriptor-bound best effort */ }
        throw error;
      }
      const published = fs.lstatSync(finalPath);
      if (!published.isFile() || published.dev !== tempStat.dev || published.ino !== tempStat.ino) {
        try { fs.unlinkSync(finalPath); } catch { /* best effort */ }
        throw new Error("beacon-publication-replaced");
      }
    } catch (writeError) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      throw writeError;
    }
  } catch {
    logBlock({ sessionID: "unknown", tool: "plugin", rule: "beacon-write-failed", target: "unavailable" });
  } finally {
    if (dirFd !== undefined) {
      try { (process.getBuiltinModule("node:fs") as BeaconFs).closeSync(dirFd); } catch { /* best effort */ }
    }
    beaconWriteBusy = false;
  }
}

// --- Plugin factory ---------------------------------------------------------

/**
 * The single runtime export. Tolerates the real OpenCode plugin context and a
 * minimal `{}`; returns the one-key hooks object. The hook order is fixed:
 * classify → (UNMANAGED ⇒ return, completely inert) → match → on deny log +
 * throw the L19 refusal; on allow return. Unknown tools are a plain no-op;
 * malformed args, tokenizer faults, wrapper-depth overflow, and any internal
 * exception are caught, logged once, and swallowed.
 */
export const TissueModeration = async (_context: unknown): Promise<PluginHooks> => {
  const before: BeforeHook = async (hookInput, hookOutput) => {
    let managed = false;
    try {
      managed = classifySession(hookInput?.sessionID) === "MANAGED";
    } catch {
      managed = false;
    }
    if (!managed) return;

    const tool = hookInput?.tool;
    if (tool !== "bash" && tool !== "webfetch") return;

    try {
      const decision = evaluateToolCall(tool, hookOutput);
      if (decision.kind === "deny") {
        logBlock({
          sessionID:
            typeof hookInput?.sessionID === "string" ? hookInput.sessionID : "unknown",
          tool,
          rule: decision.rule,
          target: decision.normalizedTarget,
        });
        throw new ModerationRefusal(MODERATION_REFUSAL);
      }
      return;
    } catch (error) {
      if (error instanceof ModerationRefusal) throw error;
      const rule =
        error instanceof ModerationFault || error instanceof TokenizeFault
          ? error.message
          : "internal-error";
      logBlock({
        sessionID:
          typeof hookInput?.sessionID === "string" ? hookInput.sessionID : "unknown",
        tool,
        rule,
        target: describeTarget(tool, hookOutput),
      });
      return;
    }
  };

  const hooks: PluginHooks = { "tool.execute.before": before };
  writeLoadBeacon();
  return hooks;
};
