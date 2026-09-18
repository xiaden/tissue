# Tissue operational runbook

## Container startup and internal health

The packaged deployment runs Tissue as an independent `tissue` container on the user-defined `tissue-net` network. It exposes port `8787` to that Docker network only; there is no host `ports:` publication. NPM reaches the service by the Docker service name, while OpenCode remains a separate failure domain. Tissue does not use `depends_on`, so stopping or restarting one service does not implicitly restart the other.

The container entry sequence is ordered: `container/prepare-volumes.sh` prepares the contracted state, worktree, registry, moderation, plugin, and agent directories for UID/GID `1000:1000`; `container/entrypoint.sh` then invokes the Node daemon. Node asserts the registry is a real writable persistent mount and prunes markers without a durable session row before assembling transports or entering the reconcile loop. A failed assertion is logged and exits non-zero. The long-running Tissue service has read-only moderation/plugin/agent mounts; the `tissue-deploy` profile is the separate writer for deployment artifacts.

The internal health listener is credential-free and serves `GET /` on port `8787`. Its liveness result reflects Tissue DB/process progress only. The response also reports informational readiness, folded from registry-directory availability and resident reachability; resident failure does not make Tissue liveness false or supervise either service. A closed DB returns HTTP 503 while the listener remains available. Unknown paths and methods return 404. The Compose healthcheck must probe the implemented `GET /` endpoint, not `/health`; operators should treat any `/health` probe as stale configuration.

## Startup, reconcile, and authentication

1. Confirm the s6 service state with `s6-svstat` and do not restart a resident service merely to probe it.
2. Deploy the dedicated agents with `tissue install-agents` (idempotent; `--force` only to replace a divergent local edit). The resident service reads the OpenCode GLOBAL agent directory, not `<Tissue>/agents`.
3. Run `tissue doctor`; it reports the local Tissue database path/WAL setting, state directory, the registry mount state (resolved `dir`, `mountAsserted`, `writable`, `realMount`, `overridden`, `markerCount`, `prunedAtStartup`), deployed agent-definition validation (including source drift), the credential-free resident-endpoint status, and each configured repository's persisted readiness (`configManaged`, `capability`, `ready`, `reasons`). It exits non-zero when the deployed definitions are missing, invalid, or drifted, or when the registry mount assertion fails. It does not itself perform the authenticated `gh`/checkout/base-branch/Issues/protection audit.
4. Run `tissue reconcile` once. Review the P0–P6 report and ERROR JSONL before enabling polling; reconciliation is the path that performs repository/capability checks when configured.
5. Use `tissue status` for capacity, leases, sessions, inbox, PR/protection state, FAILED_HOLD, last reconcile, housekeeping, and WAL observability.

The authenticated `gh`, checkout/remotes, base branch, Issues, and protection capability audit is performed by `tissue reconcile` (its P3 phase) and persisted as each repository's `capability_state`, which `doctor` and `status` surface. Dispatch is refused while a repository is not `ready`. Authentication failures are surfaced and retried only under the typed integration policy. They are not converted to healthy or silently bypassed.

On every container start the daemon runs an ordered registry pre-step strictly before it assembles transports or enters the reconcile loop: resolve the registry directory, assert the marker filesystem exists, is writable by Tissue, and is a real host-persisted mounted volume, then prune marker files whose `ses_*` id has no `opencode_sessions` row (the crash-after-marker-before-DB window), then continue. A failed mount assertion is loud and fatal: the daemon logs `registry.mount_assertion_failed` and exits non-zero, the assembly and loop are never reached, and `tissue doctor` reports `registry.mountAsserted: false` with `ok: false`. Success is logged as `registry.startup` with the resolved `dir`, `pruned`, and `markerCount`. Startup never globally invalidates the registry and never marks every DB session; marker contents are never read.

## SQLite/WAL and shared-store hygiene

Tissue owns only its separate `tissue.db`, opened with foreign keys, WAL, FULL synchronous, timeout, migrations, and short `BEGIN IMMEDIATE` writes. Never open, vacuum, delete, or migrate the OpenCode database. Status reports WAL path and size/growth; a growing WAL is an observability signal, not permission to delete it while the process is active. Shared OpenCode-store contention and ambient writers are RG-1 evidence questions, not claims inferred from local smoke.

## Inbox, idle, and OpenCode behavior

The durable inbox is globally ordered by `inbox.id`. Relay occurs only when the existing real session is observed idle, no delivery is in flight, and no controller turn is active. Human use is allowed; pending controller events wait for post-human idle. Busy/retry are non-idle. HTTP 204 and idle alone are not completion. Completion requires the nonce-bearing user message and a parent-linked assistant turn, excluding summary/compaction. Duplicate envelopes are audited no-ops. `noReply` has its own bounded observation window.

SSE is a wake hint only. Heartbeat timeout, jittered reconnect, status resynchronization, and polling are correctness backstops. A wedge or missing qualifying turn is inspected and may become `FAILED_HOLD`; do not issue concurrent prompts or create a replacement session.

## Worktrees, PR races, and cleanup

Before push/PR, verify expected worktree, controller branch, HEAD, WorkItem, protection, checks, reviews, and mergeability. Adopt externally merged/closed reality; never force-push or bypass protection. A `FAILED_HOLD` preserves branch/worktree/session/PR evidence until an explicit human `tissue cleanup <wi>`. Terminal leftover artifacts on completed/rejected/failed history trigger cleanup retry and human inspection; they do not rewrite history as FAILED_HOLD. Post-merge cleanup removes disposable worktree and local branch, while retaining all durable history and the real session.

## Human approval and release evidence

The per-repository Issues/protection capability audit described by T8(j) is not complete merely because `doctor` succeeds; T8(j) remains `NEEDS_DECISION`, and release acceptance remains blocked.

Required review or approval is `WAITING`; resume the same session after approval. Late gate failure follows the precommitted tightening ladder (single shared serve, then serialized prompt slots) before any architecture reconsideration. Deterministic fixtures, fake sessions, historical records, 204/idle behavior, and opt-in skips never satisfy a real gate. Current inventory and blocker files are non-promotional; `releasePromotable=false`.
