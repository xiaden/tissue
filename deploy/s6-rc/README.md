# Tissue s6-rc package

This directory contains the host s6-rc service definition for Tissue's resident reconcile daemon. The service is an s6 `longrun` supervised by the host's s6 tooling.

## Files

- `tissue/type` — declares the `longrun` service type.
- `tissue/run` — execline entrypoint that execs Node in `daemon` mode.

## Runtime contract

The entrypoint runs `/usr/bin/env node /workspace/Tissue/src/runtime/entrypoint.ts daemon`. It consumes protected environment values, defaults `TISSUE_CONFIG` to `/workspace/Tissue/tissue.yml` and `TISSUE_STATE_DIR` to `/workspace/Tissue/.tissue`, and does not embed credentials.

Tissue connects to the already-running resident OpenCode endpoint from `TISSUE_OPENCODE_URL`, with optional credentials in separate environment variables. It never starts, supervises, restarts, or reaps OpenCode and does not bind a public listener in the host s6 shape.

The service owns private Tissue state. Worktrees are shared at identical absolute paths with OpenCode, and the managed-session registry is a separate persisted mount with Tissue read/write and OpenCode read-only access. Registry membership has exactly two states: marker present is `MANAGED`; marker absent or unreadable is `UNMANAGED`. Startup requires a real writable registry mount and prunes markers with no durable session row.

## Installation and operation

Copy or link `deploy/s6-rc/tissue` into the host s6-rc source directory, then compile/update the s6-rc database using the host procedure. Install global agents and the Tissue-owned plugin separately with the CLI. The long-running service reads those deployment mounts read-only; plugin load is confirmed only by a matching post-boot beacon.

Use the host's s6 tools for supervisor state and the Tissue CLI for application state:

```sh
s6-svstat -o up,ready,down /run/service/tissue
tissue doctor
tissue reconcile
tissue status
```

A supervisor state is not a work-item result. Preserve `FAILED_HOLD` evidence and use explicit human cleanup when required. Never edit the OpenCode database or delete real sessions.
