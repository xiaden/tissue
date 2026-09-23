# Tissue

Tissue (Triaged Issue Execution) is an independent controller for autonomous GitHub maintenance. It polls configured repositories, stores durable controller state in its own SQLite database, and uses an already-running resident OpenCode service for triage and resolution sessions. Tissue does not start, supervise, restart, or reap OpenCode.

## Requirements and setup

- Node.js 26 or newer
- A local checkout of this repository
- `/usr/bin/gh` with suitable authentication when repository operations are enabled
- An independently running OpenCode service reachable through an approved private endpoint

```sh
npm ci
cp tissue.example.yml tissue.yml
# Edit tissue.yml and configure the resident endpoint/environment.
npm run typecheck
npm run lint
npm test
```

The YAML file contains scalar polling, capacity, retention, agent/model, and repository settings. Secret material, credential-bearing URLs, and unsafe identifiers are rejected. See [onboarding and configuration](docs/onboarding-and-config.md).

### GitHub prose delivery boundary

GitHub-originating prose is untrusted until the controller reaches an agent-visible retrieval or serialization boundary. `decideCurrentGithubProse` in `src/controller/trust.ts` loads the current `security.trustedGithubUsers` configuration for each decision, applies strict ASCII login normalization without trimming malformed values, and returns only `TRUSTED` or `DENIED`; missing, unknown, malformed, or unusable authors/configuration fail closed. The decision is not cached or persisted as later delivery authority.

Triage uses this boundary through `buildTriageDigest` in `src/controller/triage.ts`: trusted title/body previews may be included, while denied prose is omitted and typed issue identifiers, timestamps, and queue/repository counts remain available. Inbox relay uses `buildBundleText`/`relayOldestInbox` in `src/controller/inbox-relay.ts` to emit an allowlisted typed projection rather than whole `payload_json`; pending and resumed deliveries re-evaluate the current configuration. Runtime wiring in `src/runtime/daemon.ts` and `src/runtime/entrypoint.ts` supplies the configuration path to these seams.

The existing managed-session moderation refusal remains an independent defense and is unchanged. Objective lifecycle and reconciliation facts remain usable independently of prose authorization. Reactions, inline review comments/threads, and review-body delivery have no current production consumer and remain explicit unsupported, fail-closed residuals; introducing a future consumer requires the same final current-config filter.

## Resolution completion envelope

Resolution agents return one JSON `ResolutionEnvelope` to the controller. The envelope is a proposal for one lifecycle transition of an existing WorkItem; agents do not create sessions, worktrees, pull requests, identities, or other controller state.

```json
{
  "kind": "resolution",
  "envelope_id": "unique-controller-assigned-id",
  "work_item_id": "existing-work-item-id",
  "outcome": "completed",
  "reason": "bounded rationale"
}
```

`outcome` must be one of `completed`, `awaiting_review`, `needs_changes`, `awaiting_decision`, or `deferred`. A `deferred` envelope must contain exactly one `dependency` object with `kind` set to `issue` or `work_item` and an identifier in `id`; every other outcome must omit `dependency`. `envelope_id`, `work_item_id`, and dependency identifiers are non-empty identifier-safe strings capped at 160 characters. `reason` is optional and capped at 2,000 characters.

The controller parses the latest parent-linked assistant response, requires a JSON object whose `kind` is `resolution` and whose `work_item_id` matches the requested WorkItem, then validates the bounded contract. Applying a valid envelope requires that the WorkItem exists and that the proposed transition is legal. The controller maps outcomes to `COMPLETED`, `WAITING`, `RUNNING`, `AWAITING_DECISION`, and `DEFERRED`; `awaiting_decision` means the WorkItem is waiting for a human decision, while `deferred` means it is waiting on exactly one recorded issue or WorkItem dependency. Only verified completion of that dependency may release `DEFERRED`; restart, elapsed time, reconcile, or generic `BLOCKED` handling does not release it. A `completed` envelope records that the agent finished its repair turn; the WorkItem remains on the verified push, pull-request, protection, and merge effect path rather than being completed by envelope state application. Each applied transition is audited. Reapplying an already-applied envelope or an already-reached target state produces an auditable no-op rather than a second effect. See [the detailed public contract](CONTRACTS.md).

## Runtime boundaries

Tissue has three separate storage boundaries:

1. `TISSUE_STATE_DIR` contains Tissue's private database, WAL, routing state, and logs.
2. `TISSUE_WORKTREE_ROOT` contains monitored checkouts and Tissue-created worktrees. These paths are shared with OpenCode at identical absolute paths. If unset, it falls back to `${TISSUE_STATE_DIR}/worktrees` (or `.tissue/worktrees`).
3. `TISSUE_SESSION_REGISTRY_DIR` contains one empty `ses_*` marker for each managed session. Tissue writes this registry and OpenCode reads it. A marker means `MANAGED`; an absent or unreadable marker means `UNMANAGED` and the moderation plugin is inert. There is no third readiness state or readiness sentinel.

Startup requires the registry directory to be writable and to be a real persisted mount. It removes markers that have no durable OpenCode session row before entering the daemon loop. Tissue never prompts or resumes a session without its marker.

Agent and plugin installation is separate from the long-running service. `tissue install-agents` and `tissue install-plugin` write the resident OpenCode global directories; the daemon reads those mounts read-only. A plugin file is not considered loaded until OpenCode writes a matching load beacon after boot. Installation does not restart OpenCode.

## CLI

```sh
tissue status
tissue daemon
tissue tick
tissue reconcile
tissue enqueue OWNER/REPO#NUMBER
tissue inspect OWNER/REPO
tissue history WORK_ITEM_ID
tissue pause TARGET
tissue resume TARGET
tissue cleanup WORK_ITEM_ID
tissue install-agents [--force]
tissue install-plugin [--force]
tissue doctor
tissue smoke
```

`daemon` runs the resident reconcile loop. `tick` and `reconcile` run one pass. `status`, `inspect`, and `history` expose durable controller state; `cleanup` is human-only for `FAILED_HOLD` work. See [CLI and JSONL](docs/cli-and-jsonl.md).

## Container and host supervision

`compose.yml` runs Tissue as an independent container on `tissue-net`, exposes its credential-free health listener on port `8787` to that Docker network, and publishes no host port. The resident OpenCode and any proxy remain separate services and failure domains. The container health check uses `GET /`; it does not supervise or restart OpenCode. See [operations runbook](docs/operations-runbook.md).

The host package under `deploy/s6-rc/tissue` is an s6 `longrun` for the same resident daemon. It consumes protected environment variables, uses the existing resident OpenCode endpoint, and does not manage OpenCode's lifecycle. See [s6 supervision](docs/s6-supervision.md) and [the s6 package README](deploy/s6-rc/README.md).

## CI and compatibility boundaries

The CI workflow runs deterministic typecheck, lint, and test verification. Its container job checks image/Compose topology, network membership, shared mounts, registry failure behavior, `tissue doctor`, and a dependency-free HTTP-driver fixture. Fixture results are not evidence of compatibility with real OpenCode.

A separate workflow-dispatch-only `opencode-compat` job is opt-in and requires the declared OpenCode baseline `1.18.31` plus an operator-provided command. No real-runtime compatibility or production deployment claim is made by this repository. See [infrastructure audit](docs/infrastructure-audit.md).
