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
