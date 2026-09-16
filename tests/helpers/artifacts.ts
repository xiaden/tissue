// tests/helpers/artifacts.ts
//
// Release artifacts under artifacts/ are intentionally untracked local work
// products (see .gitignore), so a clean checkout (CI, a fresh clone) has none.
// Anchors that reconcile those documents skip there instead of failing on an
// absent local file; inside a developer checkout they still run and remain
// strict about a missing or drifted artifact.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const ARTIFACT_SKIP: false | string = existsSync(join(REPO_ROOT, "artifacts"))
  ? false
  : "release artifacts are not present in this checkout (untracked by design)";

export function readArtifact(rel: string): string {
  return readFileSync(join(REPO_ROOT, "artifacts", rel), "utf8");
}
