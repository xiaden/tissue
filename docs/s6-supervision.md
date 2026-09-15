# A′ s6-rc supervision

Tissue runs as the A′ supervised reconcile daemon: one resident Node controller, one separate Tissue SQLite database, and real OpenCode-created `ses_...` sessions. The checked-in package is a service definition, not a service restart request. D′ remains a retained documented alternative in the design document and is not co-built.

## Install (operator action)

Install only from a reviewed checkout. The service directory is `deploy/s6-rc/tissue`; copy or link it into the host's s6-rc source directory, then compile/update the s6-rc database using the host's normal s6-rc procedure. Do not place credentials in the service definition. The service is noninteractive: `TISSUE_OPENCODE_URL` and the optional `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD` must be supplied by the protected supervisor environment, are inherited, and are never embedded in the package. The checked-in `tissue/run` does not source an env file; it uses execline `importas -D` to default `TISSUE_STATE_DIR` to `/workspace/Tissue/.tissue` and `TISSUE_CONFIG` to `/workspace/Tissue/tissue.yml`, with any protected-environment value taking precedence. The service connects to the already-running resident OpenCode and never starts, supervises, restarts, or reaps a serve.

The service uses `/usr/bin/env node /workspace/Tissue/src/runtime/entrypoint.ts daemon`, passes the protected environment through, does not fork, and binds no public surface. Verify the configured checkout, `/usr/bin/gh`, authentication, repository capability, and directory permissions before enabling it.

## Agent deployment

The resident OpenCode service does **not** discover `<Tissue>/agents`. OpenCode resolves reusable Markdown agents from its GLOBAL agent directory, and Tissue resolution sessions are rooted in monitored-repository worktrees, so the Tissue checkout is not a reliable discovery location for them. The checked-in `agents/tissue-triage.md` and `agents/tissue-resolve.md` are therefore SOURCE artifacts, and the deployed copies the resident actually uses must be installed into the global directory:

```sh
node /workspace/Tissue/src/cli.ts install-agents          # idempotent
node /workspace/Tissue/src/cli.ts install-agents --force  # overwrite a divergent local edit
```

`install-agents` resolves the deployment target deterministically — `TISSUE_OPENCODE_AGENTS_DIR` when set, otherwise `$XDG_CONFIG_HOME/opencode/agents` or `$HOME/.config/opencode/agents` — creates it if needed, preserves file permissions, refuses to overwrite a divergent existing file without `--force`, never touches OpenCode's SQLite database, and never restarts the resident service. The service definition sets `TISSUE_OPENCODE_AGENTS_DIR` explicitly (default `/home/opencode/.config/opencode/agents`) so agent resolution never depends on the service working directory; a protected-environment value takes precedence.

Startup and `tissue doctor` fail closed when either deployed definition is missing, invalid, violates the role tool profile, or has drifted from the checked-in source (deterministic SHA-256 content comparison). Working directory is irrelevant to all of it.

## Stop and status

Use the fixed service name and the host's s6 tools:

```sh
s6-rc -d change tissue
s6-svstat /run/service/tissue
s6-svstat -o up,ready,down /run/service/tissue
```

These commands operate on the supervisor only; they do not delete Tissue state or OpenCode sessions. `tissue status`, `tissue inspect`, and `tissue history` are the authoritative application views. A stopped service is not evidence of a failed WorkItem.

## Recovery

Recovery is a level-triggered reconciliation, not blind restart. After a crash or host reboot, inspect `s6-svstat`, run `tissue doctor` (local database/config/state summary, including deployed-agent validation), then run one `tissue reconcile` before enabling normal service operation. P0–P6 reconciliation verifies the Tissue WAL/database, repository capabilities, resident-endpoint reachability, the real session census (without any serve lifecycle), worktrees, PRs, leases, effects, drift, and terminal-unattached inbox housekeeping. It resumes only legal durable states.

A PID/start-time mismatch is never killed. A wedged session becomes `FAILED_HOLD` with retained evidence; use `tissue inspect <wi>` and the human-approved `tissue cleanup <wi>` path. Never remove a real session or edit OpenCode's database. Logs are telemetry, not sessions, and export is not core retention.

## Execution constraint

No resident OpenCode or s6 service was restarted during this release-docs execution. RG-1 and RG-3/RG-4/RG-5/RG-6 remain blocked without accepted current evidence; RG-2 is deterministic-only and RG-5 is supporting-only. No gate waiver or promotion is implied.
