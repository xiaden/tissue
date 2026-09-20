// src/controller/session-registry.ts
//
// Managed-session registry (plan I; DD-tissue-container-migration §8; ledger
// L11/L12/L13/L18 as amended by OWNER AMENDMENT 2 (2026-09-16); ADR-005, which
// supersedes ADR-004). The registry is `/tissue-session-registry/` (Tissue RW /
// OpenCode RO), holding one empty marker file per managed `ses_*` id. It is a
// projection of CURRENT Tissue automation ownership, not of durable session
// existence.
//
// TWO-STATE MODEL (normative):
//     marker exists               => MANAGED   => plugin moderation applies
//     marker absent or unreadable => UNMANAGED => the plugin is completely inert
// Classification is a single `statSync` existence check on the marker path.
// Marker CONTENTS are never read — the marker is an empty ownership token.
//
// SINGLE INVARIANT (normative): Tissue MUST NOT prompt or resume an OpenCode
// session unless that session's marker currently exists.
//
// There is NO `.ready`/`.initialized` sentinel, NO UNKNOWN classification, NO
// registry-wide readiness state, NO freshness state, NO classification cache,
// NO blackout, and NO transactional whole-registry rehydration. The registry
// fails open at the plugin on a mount failure; the compensating control is the
// mount assertion here, converted by the startup caller into a loud non-zero
// exit and an unhealthy `doctor` report.
//
// Classification never uses a `readdir` snapshot, never HTTP, and never a
// cache: `listMarkerSessionIds` (readdir) is used only by the prune and by
// `doctor`, never by classification. Every classification error path returns
// UNMANAGED and never throws (OpenCode is never made unavailable).

import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { validateAbsolutePath } from "../config/load.ts";
import type { TissueDb } from "../db/open.ts";
import { listSessions } from "../db/repositories.ts";
import type { JsonLogger } from "../logging/jsonl.ts";

/**
 * The default registry directory on the host-persisted volume (DD §8, L11).
 * Never a per-container `/run` tmpfs path.
 */
const DEFAULT_REGISTRY_DIR = "/tissue-session-registry";

/**
 * Marker file names are `ses_*` ids matching /^ses_[A-Za-z0-9]+$/, as pinned by
 * DD §8.2 and the plan I Contracts section. The suffix is alphanumeric only,
 * which is also path-safe: it admits no separator and no `.`/`..` segment.
 */
const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

/** Production mount table (field 5 is the mount point); injectable for tests. */
const PROC_SELF_MOUNTINFO = "/proc/self/mountinfo";

/** Typed verdict of the registry mount assertion (`ok` gates startup). */
export interface RegistryMountStatus {
  /** The registry directory the assertion was made against. */
  dir: string;
  /** The path exists and is a directory. */
  exists: boolean;
  /** Tissue can write to the directory (permission bits + access check). */
  writable: boolean;
  /** `/proc/self/mountinfo` lists the path as a real mounted volume. */
  realMount: boolean;
  /** `exists && writable && realMount` — the single gate callers convert to a non-zero exit. */
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

/** Ordered result of the startup pre-step (assert mount -> prune extras -> report). */
export interface RegistryStartupReport {
  dir: string;
  /** True once the mount assertion passed; a failed assertion throws instead. */
  mountAsserted: boolean;
  /** Marker ids with no `opencode_sessions` row, removed this run. */
  pruned: string[];
  /** Marker count after the prune (for the `doctor`/status surface). */
  markerCount: number;
  at: string;
}

/**
 * Resolve the registry directory: `TISSUE_SESSION_REGISTRY_DIR` when set
 * (validated absolute and returned verbatim), otherwise the host-persisted
 * default `/tissue-session-registry`. CWD-independent (mirrors the agents-dir
 * precedent). Relative values and per-container `/run` tmpfs values are
 * refused: the marker filesystem must survive restart (L13).
 */
export function resolveSessionRegistryDir(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const configured = env.TISSUE_SESSION_REGISTRY_DIR;
  if (configured === undefined) return DEFAULT_REGISTRY_DIR;
  const dir = validateAbsolutePath(configured, "TISSUE_SESSION_REGISTRY_DIR");
  if (dir === "/run" || dir.startsWith("/run/")) {
    throw new Error(
      `TISSUE_SESSION_REGISTRY_DIR must be host-persisted, not a /run tmpfs path: '${dir}'`,
    );
  }
  return dir;
}

/**
 * Absolute marker path `<dir>/<ses_*>`. Refuses any id that is not a
 * filesystem-safe `ses_*` identifier (no separators, no `.`/`..` segments).
 */
export function markerPath(dir: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`refusing invalid session id '${sessionId}' for a registry marker`);
  }
  return join(dir, sessionId);
}

/**
 * Two-state classification: one `statSync` existence check on the marker path.
 * Returns `MANAGED` when the marker exists (even as a torn/partial entry) and
 * `UNMANAGED` for every other outcome — absent marker, absent/unreadable
 * registry directory, invalid id — and NEVER throws. Marker contents are never
 * read.
 *
 * The optional `opts.statSync` seam exists only so tests can assert the single
 * `statSync`; production callers use the 2-argument form.
 */
export function classifySessionMarker(
  dir: string,
  sessionId: string,
  opts: { statSync?: (path: string) => unknown } = {},
): "MANAGED" | "UNMANAGED" {
  const stat: (path: string) => unknown = opts.statSync ?? statSync;
  try {
    stat(markerPath(dir, sessionId));
    return "MANAGED";
  } catch {
    return "UNMANAGED";
  }
}

/**
 * Create a marker with ONE atomic create (`O_CREAT|O_EXCL`, i.e. flag `wx`).
 * A failure throws so the caller can fail closed; a torn/partial marker still
 * exists => MANAGED (over-moderation is the explicitly safe direction). Joins
 * the fail-closed set at the session-creation funnel (plan J).
 */
export function createSessionMarker(dir: string, sessionId: string): void {
  const marker = markerPath(dir, sessionId);
  const fd = openSync(marker, "wx");
  closeSync(fd);
}

/**
 * Remove a marker. Idempotent: returns whether a marker was actually removed
 * (false when it was already absent). Plan J owns the caller contract that a
 * marker is never removed during an executing agent turn.
 */
export function deleteSessionMarker(dir: string, sessionId: string): boolean {
  const marker = markerPath(dir, sessionId);
  try {
    unlinkSync(marker);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * List marker session ids under `dir`, filtered to the `ses_*` form. Used by
 * the startup prune and by `doctor`; NEVER used for classification. An absent
 * or unreadable registry directory yields `[]` (there are no markers to act on).
 */
export function listMarkerSessionIds(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => SESSION_ID_RE.test(entry));
}

/** Parse a mountinfo field, decoding octal escapes (`\040` space etc.). */
function decodeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/** True when `dir` is stat-able as a directory. */
function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when the directory's permission bits and the process access check both
 * permit a write. `accessSync(W_OK)` alone is insufficient: a root-run test
 * process bypasses mode bits, so the write bits are checked explicitly first.
 */
function isWritableDirectory(dir: string): boolean {
  let mode: number;
  try {
    mode = statSync(dir).mode;
  } catch {
    return false;
  }
  if ((mode & 0o222) === 0) return false;
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `/proc/self/mountinfo` lists `dir` as a mount point (field 5).
 * A container-local empty directory is absent from the table and therefore is
 * NOT a real mounted volume — the mount-failure case the assertion catches.
 */
function isListedMountPoint(dir: string, mountInfoPath: string): boolean {
  let content: string;
  try {
    content = readFileSync(mountInfoPath, "utf8");
  } catch {
    return false;
  }
  const target = resolve(dir);
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split(" ");
    const mountPoint = fields[4];
    if (mountPoint !== undefined && resolve(decodeMountField(mountPoint)) === target) {
      return true;
    }
  }
  return false;
}

/**
 * Assert the registry path exists, is writable by Tissue, and is a real mounted
 * volume (verified against `/proc/self/mountinfo`, overridable via
 * `opts.mountInfoPath` for deterministic tests). Returns a typed status; it
 * never throws, and callers convert `ok === false` into a loud non-zero exit /
 * unhealthy `doctor` report. A container-local empty directory reports
 * `realMount === false`.
 */
export function assertRegistryMount(
  dir: string,
  opts: { mountInfoPath?: string } = {},
): RegistryMountStatus {
  const mountInfoPath = opts.mountInfoPath ?? PROC_SELF_MOUNTINFO;
  const exists = isDirectory(dir);
  const writable = isWritableDirectory(dir);
  const realMount = isListedMountPoint(dir, mountInfoPath);
  const ok = exists && writable && realMount;
  const reason = ok
    ? undefined
    : !exists
      ? "registry directory does not exist"
      : !writable
        ? "registry directory is not writable"
        : "registry path is not a real mounted volume";
  return { dir, exists, writable, realMount, ok, ...(reason !== undefined ? { reason } : {}) };
}

/**
 * Prune marker files whose session id has NO `opencode_sessions` row (the
 * crash-after-marker-before-DB window). Reads `listSessions(db)` exactly once
 * and removes only ids absent from that set; never blanket-marks DB sessions.
 * Idempotent. Emits one structured `registry.marker_pruned` record per removed
 * id via the optional logger, carrying the id and reason and never marker
 * contents. The 2-argument form is the production signature; the logger is an
 * optional third argument supplied by the startup caller.
 */
export function pruneMarkersWithoutDbRow(
  dir: string,
  db: TissueDb,
  logger?: JsonLogger,
): string[] {
  const known = new Set(listSessions(db).map((session) => session.id));
  const pruned: string[] = [];
  for (const id of listMarkerSessionIds(dir)) {
    if (known.has(id)) continue;
    if (deleteSessionMarker(dir, id)) {
      pruned.push(id);
      logger?.info("registry.marker_pruned", { id, reason: "no-db-row" });
    }
  }
  return pruned;
}

/**
 * Ensure a marker exists immediately before a prompt/resume of an existing
 * session (the single invariant on the resume path). Idempotent: a marker that
 * already exists is left untouched; otherwise one atomic create is performed.
 */
export function ensureSessionMarkerBeforeResume(dir: string, sessionId: string): void {
  if (classifySessionMarker(dir, sessionId) === "MANAGED") return;
  createSessionMarker(dir, sessionId);
}

/**
 * Ordered startup reconciliation, run once per container start strictly before
 * the daemon loop: assert the mount (THROW on failure) -> prune markers with no
 * DB row -> return the report. There is NO publish/unpublish/blackout step and
 * no whole-registry rehydration — the registry has no readiness state.
 *
 * The optional `opts.mountInfoPath` seam makes the mount assertion deterministic
 * in tests; production callers use the 3-argument form.
 */
export async function runStartupRegistryReconciliation(
  db: TissueDb,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  logger: JsonLogger,
  opts: { mountInfoPath?: string } = {},
): Promise<RegistryStartupReport> {
  const dir = resolveSessionRegistryDir(env);
  const mount = assertRegistryMount(dir, opts);
  if (!mount.ok) {
    throw new Error(
      `registry mount assertion failed for '${dir}': ${mount.reason ?? "unknown reason"}`,
    );
  }
  const pruned = pruneMarkersWithoutDbRow(dir, db, logger);
  return {
    dir,
    mountAsserted: true,
    pruned,
    markerCount: listMarkerSessionIds(dir).length,
    at: new Date().toISOString(),
  };
}
