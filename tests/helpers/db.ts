// tests/helpers/db.ts
//
// Shared helpers for M2 database tests: each test opens its own real temporary
// SQLite file (WAL) so nothing pollutes the workspace and no shared OpenCode
// state is ever touched. Helpers are excluded from the node:test glob (not
// *.test.ts) but included in type-check.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTissueDb, closeDb, type TissueDb } from "../../src/db/open.ts";
import {
  upsertRepository,
  insertIssue,
  type RepositoryRow,
  type IssueRow,
} from "../../src/db/repositories.ts";

export interface TestDb {
  db: TissueDb;
  path: string;
  cleanup: () => void;
}

/** Open a fresh Tissue DB at a unique temporary path (WAL, migrations applied). */
export function createTestDb(options: { retentionDays?: number } = {}): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "tissue-db-"));
  const path = join(dir, "tissue.db");
  const db = openTissueDb(path, { retentionDays: options.retentionDays });
  const cleanup = (): void => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, path, cleanup };
}

export const REPO_ID = "repo-xiaden-nomarr";

/** Seed a canonical repository row and return it. */
export function seedRepository(
  db: TissueDb,
  opts: { owner?: string; name?: string; id?: string; priority?: number; maxConcurrentPerRepo?: number; pollIntervalSeconds?: number } = {},
): RepositoryRow {
  const owner = opts.owner ?? "xiaden";
  const name = opts.name ?? "nomarr";
  const repoId = opts.id ?? `${owner}/${name}`;
  return upsertRepository(db, {
    id: repoId,
    owner,
    name,
    remote: `https://github.com/${owner}/${name}.git`,
    local_dir: `/workspace/${name}`,
    baseline_at: "2026-09-01T00:00:00.000Z",
    poll_interval_seconds: opts.pollIntervalSeconds ?? 300,
    priority: opts.priority ?? 0,
    max_concurrent_per_repo: opts.maxConcurrentPerRepo ?? 1,
  });
}

let issueSeq = 0;

/** Seed an issue row in `repoId`; returns it. */
export function seedIssue(
  db: TissueDb,
  repoId: string,
  overrides: Partial<IssueRow> & { number?: number; title?: string; state?: string; envelope?: import("../../src/controller/trust.ts").ProvenanceEnvelope | null } = {},
): IssueRow {
  issueSeq += 1;
  const number = overrides.number ?? issueSeq;
  return insertIssue(db, {
    id: overrides.id ?? `issue-${repoId}-${number}`,
    repo_id: repoId,
    number,
    title: overrides.title ?? `issue ${number}`,
    state: overrides.state ?? "NEW",
    updated_at: overrides.updated_at ?? "2026-09-09T00:00:00.000Z",
    ...overrides,
  });
}

/** One-shot default repo id string helper for unique cross-test ids. */
export function uniqueRepoId(tag: string): string {
  return `repo-${tag}-${Math.random().toString(36).slice(2, 8)}`;
}
