# Tissue A' s6-rc packaging (production resident daemon)

This directory holds the s6-rc service definition for the resident A'
supervised reconcile daemon controller. The service is a `longrun` supervised
by s6-svscan (already PID 1 on this host), stays resident, and is loopback-only
by construction.

## Non-goals (D' is never co-built)

- No child `opencode run` process launching per turn.
- No durable `turn_in_flight` ledger.
- No process-group reaping of leader processes.
- No `0.0.0.0` / public binding anywhere.

The D' alternative shell is documented in the DD only; it is not a release implementation.

## Files

- `tissue/type` — `longrun` (s6-rc service type).
- `tissue/run` — execlineb entrypoint that execs Node in `daemon` mode.

## Runtime contract

The entrypoint consumes production `daemon` mode, performs startup reconcile once, and remains resident for level-triggered normal passes. `tick` and `reconcile` are one-pass CLI operations. The dependency-only startup probe is not the production path. The no-D' constraint remains in force.

The service is noninteractive and connects to the already-running resident OpenCode via an inherited `TISSUE_OPENCODE_URL` (with optional `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`); it never starts, supervises, restarts, or reaps a serve. The run script uses execline `importas -D` to default `TISSUE_CONFIG` and `TISSUE_STATE_DIR` to the checkout paths when the protected supervisor environment does not supply them, and embeds no credentials.
