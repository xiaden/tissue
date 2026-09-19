# Infrastructure and release audit

## A′ scope

The release package contains one s6-rc `longrun` for the A′ supervised reconcile daemon. It uses the existing host supervisor, one separate Tissue SQLite/WAL database, loopback-only local surfaces, typed `/usr/bin/gh`/git subprocesses, and real durable OpenCode-created sessions. D′ is documentation-only and is not co-built.

> **SUPERSEDED (2026-09-18; current container packaging).** The A′ statements below describe the historical/host s6 release shape and must not be read as the complete current deployment topology. The independently packaged Tissue container now has a Docker-network-only `8787` listener and may bind its internal health listener to `0.0.0.0`; Compose uses `expose`, never host `ports`. This establishes the listener/health foundation only. It does **not** claim production cutover or release readiness. The host s6 A′ service remains loopback-only and resident-only. See `artifacts/requirements/TISSUE-MIGRATION-REQUEST.md` (L5/L6/L22/L23/L24), `artifacts/plans/pending/TASK-tissue-N-container-packaging.md` (Contracts), and `compose.yml`.

## Persistence and topology

### Historical A′ host topology

- Production migrations are exactly one: `{ version: 1, name: "initial_schema" }` (`SCHEMA_VERSION = 1`). There is no `owned_serves` table and no owned-serve/legacy-serve lifecycle. There are no forward migrations, compatibility shims, legacy-column support, or upgrade paths.
- Reconciliation is resident-only: one supervised Tissue daemon (`deploy/s6-rc/tissue`) connects to the pre-existing resident OpenCode endpoint via `TISSUE_OPENCODE_URL` and never starts, supervises, reaps, or restarts a serve.
- Disposable worktrees use the absolute `TISSUE_WORKTREE_ROOT` environment override when set, with layout `<TISSUE_WORKTREE_ROOT>/<owner>-<name>/<work-item-id>`; when unset, the root falls back byte-identically to `<TISSUE_STATE_DIR>/worktrees` (or `.tissue/worktrees`).

## Prohibited infrastructure audit

| Item | Result |
|---|---|
| GitHub App | Not present / not required |
| Webhook or public inbound service | Not present; polling is the correctness path |
| GitHub Actions runner (release runtime) | Not present / not required; dev-time CI is repository tooling only (see Development-time CI) |
| Redis or external queue | Not present; SQLite inbox/outbox is local |
| Dashboard | Not present; CLI/status/history/inspect are the operator surface |
| Second Tissue database | Not present; one configured `tissue.db` only |
| Fake sessions | Not used in production; fixtures are test-only |
| Owned/legacy OpenCode serve lifecycle | Not present; resident endpoint only |
| Forward migrations / compatibility shims / upgrade paths | Not present; single `initial_schema` (v1) only |
| Resident OpenCode/s6 restart in this execution | Not performed |

## Development-time CI (recorded decision)

The Tissue release package still ships no Actions runner: the A′ runtime is the single s6-rc `longrun` described above. Separately, this repository now uses GitHub Actions purely as a development-time quality gate:

- `.github/workflows/ci.yml` runs the deterministic gate (`npm run typecheck`, `npm run lint`, `npm test`) in its `verify` job on pushes and pull requests to `main`; `verify` remains the required status check on the protected branch.
- The same workflow defines a GitHub-hosted `container` job with nine individually named Docker/Compose legs: build, Compose config, boot, `tissue-net` membership, registry RW/RO and mount assertions, loud registry-mount failure handling, healthy `tissue doctor`, real `ses_*` behavioural smoke, and Plan M's fresh-process plugin-resolution case. The job creates a CI-only overlay using pinned `opencode-ai@1.18.18` as a stand-in; this does not define the production resident and the workflow does not claim resident plugin load or run `fired`.
- The container job is an execution venue for development-time evidence, not release-runtime infrastructure. No hosted run, first `opencode debug config` output, or per-leg CI result is recorded here; the job is not documented as a required branch check. Hosted evidence is fail-closed: an authorized operator must record the GitHub run ID, all nine individually named leg outcomes (build, Compose config, boot, network membership, registry/mount assertions, loud registry-mount failure, healthy `tissue doctor`, behavioural smoke, and Plan M's fresh-process resolution), and the uploaded `leg-*.log` artifact reference. The first Leg 9 `opencode debug config --json` output must be retained raw with its exit code, JSON-recognition result, and exact `tissue-moderation.ts` membership in the resolved plugin set. Nonzero or unrecognized output is not a pass; provide equivalent deterministic fresh-process evidence with the same record or leave the requirement blocked/escalated. Leg 3 follows Plan N/M topology and stand-in ownership as applicable, Leg 5 follows Plans H/I/N, and Leg 9 executes Plan M's owned test case while Plan O supplies only the execution venue. Production cutover, release readiness, and owner-side resident service/mount decisions remain outside this workflow.
- `.github/workflows/codeql.yml` runs CodeQL code scanning for JavaScript/TypeScript on `main` and on a weekly schedule.
- `.github/dependabot.yml` keeps npm dependencies and SHA-pinned actions current.

`main` is protected: changes require a pull request and a passing `verify` check, and force pushes and deletions are blocked (administrators retain an explicit bypass). This is repository tooling, not product infrastructure: it adds no runner, daemon, or network surface to the A′/D′ topology and changes no R1–R22 requirement. It is recorded here so the "GitHub Actions runner: not present" entry above is not read as drift.

Any implementation or documentation mismatch against R1–R22 must be recorded as `REQUIREMENT_DRIFT`; it must not be repaired by weakening a requirement, promoting historical evidence, or inventing a release claim. This audit does not claim release readiness: RG-1 and RG-3/RG-4/RG-5/RG-6 remain blocked, RG-2 is deterministic-only, and RG-5 is deterministic/supporting-only. The owner authorized T8 (a), (g), and (h) as ACCEPTED; the remaining T8 (b), (c), (d), (e), (f), (i), and (j) remain `NEEDS_DECISION` with owner and deadline.
