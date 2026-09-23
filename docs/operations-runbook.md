# Tissue operational runbook

## Boundaries

Tissue is an independent controller. Its private database, WAL, routing state, and logs live under `TISSUE_STATE_DIR`. Monitored checkouts and created worktrees live under the separately configured `TISSUE_WORKTREE_ROOT` and are shared with OpenCode at identical absolute paths. The resident OpenCode service is a separate failure domain and Tissue never starts, supervises, restarts, or reaps it.

The managed-session registry is a third persisted domain, mounted Tissue read/write and OpenCode read-only. A present `ses_*` marker means `MANAGED`; an absent or unreadable marker means `UNMANAGED` and the plugin is inert. There is no readiness sentinel, cache, or third state. Tissue must not prompt or resume without a marker.

Plugin and agent deployment is separate from the service. The deployment commands write global OpenCode directories; the long-running daemon reads them read-only. OpenCode must boot and write a matching plugin load beacon before the plugin is considered loaded.

## Container startup and health

The packaged `tissue` service runs on `tissue-net` and exposes port `8787` to that network only. It has no host `ports` publication and does not depend on OpenCode startup. `container/prepare-volumes.sh` creates the writable state, worktree, and registry directories. `container/entrypoint.sh` then starts the Node daemon.

On startup, Tissue asserts that the registry exists, is writable, and is a real persisted mount. It prunes markers without matching `opencode_sessions` rows before assembling the resident transport or entering the loop. A failed assertion logs an error and exits non-zero. The health check is `GET /` on port `8787`; it reports JSON liveness, readiness, and resident reachability. Liveness is based on the Tissue database/process. Readiness is informational and does not restart either service.

## Start and preflight

1. Confirm the resident OpenCode service is independently running and reachable through the configured private or exact-allowlisted origin. Do not restart it merely to probe it.
2. Install the global agent definitions:

   ```sh
   node src/cli.ts install-agents
   ```

   Use `--force` only to replace a reviewed divergent local edit.
3. Install the Tissue-owned plugin through the deployment path:

   ```sh
   node src/cli.ts install-plugin
   ```

   Stop/start OpenCode according to the owner service procedure so it can load the new plugin; Tissue does not perform that lifecycle action.
4. Run `tissue doctor`. It validates the deployed agents, plugin file and load beacon, registry mount, database, configured repositories, and redacted resident status. It exits non-zero for missing/drifted deployment or failed registry assertion.
5. Run `tissue reconcile` once and review its phase summary and JSONL output. Reconcile runs one ordered P0-P6 pass: it opens/migrates the database, verifies repository and GitHub capability/readiness, probes and censuses resident OpenCode sessions and applies session-loss recovery, reconciles leases/effects/worktrees/branches/PRs, scans drift, performs terminal housekeeping, and attempts normal-loop recovery. Each phase is reported as `ok`, `fail`, or `skip`; operational phase failures do not throw away later safe reconciliation work. The command exits non-zero when any phase fails (skipped phases from an earlier prerequisite failure are not counted as failures). Repository readiness is persisted during P1.

When resident OpenCode is unavailable or P2 cannot complete, P6 is gated: prompt-dependent resume is withheld, while OpenCode-independent repository/artifact/drift/housekeeping phases still run. Reconcile does not itself release `DEFERRED` work; dependency completion is the only release trigger. It also does not release a `FAILED_HOLD` item, which requires explicit human cleanup.
6. Run `tissue status` before enabling continuous polling.

`status` does not perform the authenticated GitHub capability audit. It reports those fields as unprobed until reconciliation. Its capacity view counts `RUNNING`, `WAITING`, and `AWAITING_DECISION` as active slots; `DEFERRED` is dependency-waiting and capacity-exempt. Dispatch is refused while a configured repository is not ready.

## Normal operation

Use `tissue daemon` for the resident loop, or `tissue tick`/`tissue reconcile` for one pass. While OpenCode is unavailable, the daemon continues safe polling/ingest, promotes ready work, and executes effects, but withholds triage, resolution claims, and relay. It resumes those operations automatically after a successful health probe; it does not exit merely because the resident is unavailable. A successful reconcile pass establishes the repository capability/readiness view and may recover durable session/work-item mappings, but it never creates or replaces a lost OpenCode session.

SSE is only a wake hint. Polling and reconciliation remain correctness backstops. Do not issue concurrent prompts or create replacement sessions. A missing or irrecoverably wedged resolution session holds the owning active work item in `FAILED_HOLD` with evidence. Use `tissue inspect <wi>` and only then the human-only `tissue cleanup <wi>` path. Cleanup never deletes a real session or edits OpenCode's database.

### Changing the trusted prose allowlist

`security.trustedGithubUsers` is evaluated from the current configuration at each agent-visible triage or relay retrieval/serialization boundary. After editing the file selected by `TISSUE_CONFIG`, the new allowlist applies to future deliveries immediately: no repolling and no daemon restart are required. This includes both pending inbox rows and rows resumed from `DELIVERING`; each path re-evaluates the current configuration before prose is included. Already-produced agent history is not rewritten. The setting controls visibility of current GitHub-originating prose only; it does not authorize GitHub actions or add transports.

## Storage and recovery

Tissue owns only its own `tissue.db`, opened with foreign keys, WAL, full synchronous mode, migrations, and short write transactions. Never open, vacuum, delete, or migrate the OpenCode database. A growing WAL is an observation signal, not permission to delete it while Tissue is active.

After a crash or host reboot:

```sh
s6-svstat -o up,ready,down /run/service/tissue
tissue doctor
tissue reconcile
tissue status
```

A stopped service is not evidence that a work item failed. Preserve `FAILED_HOLD` evidence until a human explicitly cleans it. Never kill a process using a mismatched start time and never improvise database or worktree repairs.

## Worktrees and merges

Before push/PR, verify worktree identity, branch, HEAD, work item, protection, checks, reviews, and mergeability. Never force-push or bypass protection. After merge, remove only disposable worktree/local-branch artifacts; retain durable history and real sessions. `autoMerge` is fail-closed and requires verified identity, known protection, required approvals/checks, and mergeability.
