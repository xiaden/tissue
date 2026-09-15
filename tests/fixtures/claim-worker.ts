// tests/fixtures/claim-worker.ts
//
// Standalone child process used by the lease-race test to prove durable mutual
// exclusion of claimNextWorkItem ACROSS processes (the DB is the only correct
// mutex). Opens the same SQLite file, attempts ONE claim, prints the result on a
// single `CLAIM\t<json>` line, and exits. Run via: node <this file> <dbfile> <globalLimit>

import { openTissueDb, closeDb } from "../../src/db/open.ts";
import { claimNextWorkItem } from "../../src/controller/queue.ts";

const [, , dbPath, globalLimitArg] = process.argv;
if (!dbPath || globalLimitArg === undefined) {
  process.stderr.write("usage: claim-worker.ts <dbfile> <globalLimit>\n");
  process.exit(2);
}

const globalLimit = Number(globalLimitArg);
const db = openTissueDb(dbPath, { busyTimeoutMs: 5000 });
try {
  const claim = claimNextWorkItem(db, new Date(), { globalLimit });
  if (claim) {
    process.stdout.write(`CLAIM\t${JSON.stringify(claim)}\n`);
    process.exit(0);
  }
  process.stdout.write("CLAIM\tnull\n");
  process.exit(0);
} catch (err) {
  process.stderr.write(`ERROR\t${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
} finally {
  closeDb(db);
}
