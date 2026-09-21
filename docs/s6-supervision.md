# s6-rc supervision

The host package runs Tissue as one s6 `longrun` supervised reconcile daemon. It is a service definition, not a request to restart services. Tissue uses a private SQLite database and real OpenCode-created `ses_*` sessions while connecting to an independently running resident OpenCode service.

`TISSUE_STATE_DIR` is private to Tissue. Monitored checkouts and created worktrees are shared at identical absolute paths. The managed-session registry is a separate persisted mount, Tissue read/write and OpenCode read-only. Marker present means `MANAGED`; marker absent or unreadable means `UNMANAGED` and inert. There is no readiness sentinel, cache, or third state.

## Install

Install only from the reviewed checkout. Copy or link `deploy/s6-rc/tissue` into the host s6-rc source directory and compile/update the s6-rc database using the host procedure. The service directory contains `tissue/type` and `tissue/run`.

The run script executes:

```text
/usr/bin/env node /workspace/Tissue/src/runtime/entrypoint.ts daemon
```

It inherits protected environment values and defaults `TISSUE_CONFIG` to `/workspace/Tissue/tissue.yml` and `TISSUE_STATE_DIR` to `/workspace/Tissue/.tissue` when they are not supplied. Provide `TISSUE_OPENCODE_URL` and optional `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD` through the protected supervisor environment. Do not put credentials in the service definition. The service does not source an environment file and never starts, supervises, restarts, or reaps OpenCode.

Before enabling the service, verify the checkout, `/usr/bin/gh`, authentication, repository capability, directory permissions, and resident endpoint.

## Deploy agents and plugin

The resident resolves agents from its global directory, not from `<Tissue>/agents`:

```sh
node /workspace/Tissue/src/cli.ts install-agents
node /workspace/Tissue/src/cli.ts install-agents --force
```

The target is `TISSUE_OPENCODE_AGENTS_DIR`, otherwise `$XDG_CONFIG_HOME/opencode/agents` or `$HOME/.config/opencode/agents`. Installation is filesystem-only, idempotent, and refuses divergent files without `--force`.

Deploy the moderation plugin separately:

```sh
node /workspace/Tissue/src/cli.ts install-plugin
node /workspace/Tissue/src/cli.ts install-plugin --force
```

The target is `TISSUE_OPENCODE_PLUGINS_DIR`, otherwise the resident global plugin directory. The deployment path writes only the Tissue-owned plugin and its deployment record. It clears the previous load beacon, does not touch OpenCode's database, and does not restart OpenCode. After the owner starts OpenCode, the load beacon must match the deployed SHA and restart epoch. A missing, stale, or mismatched beacon keeps managed work disabled; `tissue doctor` reports the reason.

## Operate and recover

```sh
s6-rc -d change tissue
s6-svstat /run/service/tissue
s6-svstat -o up,ready,down /run/service/tissue
tissue doctor
tissue reconcile
tissue status
```

After a crash or reboot, inspect supervisor state, run `doctor`, then one `reconcile` before normal operation. Startup asserts the persisted registry mount and prunes markers without database rows before entering the loop. A failed assertion is loud and fatal. Never delete OpenCode sessions, edit its database, or kill a PID with a mismatched start time. Use `tissue inspect <wi>` and human-approved `tissue cleanup <wi>` for `FAILED_HOLD` recovery.
