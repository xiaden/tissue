# Infrastructure audit

This document describes the infrastructure that is actually present in the repository. Tissue is an independent controller; the resident OpenCode service is an independently running dependency.

## Runtime topology

The host s6 package runs one Tissue `longrun` daemon against a private Tissue SQLite database. It uses an inherited `TISSUE_OPENCODE_URL` and never starts, supervises, restarts, or reaps OpenCode.

The Compose package runs a separate `tissue` container on the user-defined `tissue-net` bridge network. Tissue exposes credential-free `8787` only to that network and publishes no host port. The health listener serves `GET /`; liveness reflects the Tissue database/process, while registry availability and resident reachability contribute informational readiness. A closed database returns `503`; unknown methods and paths return `404`.

Storage has separate boundaries:

- private Tissue state and WAL;
- shared monitored checkouts/worktrees at identical absolute paths for Tissue and OpenCode;
- a persisted managed-session registry, Tissue read/write and OpenCode read-only;
- read-only plugin and agent mounts in the long-running Tissue service, written by the separate deployment one-shot.

The registry uses exactly two states: an existing `ses_*` marker is `MANAGED`, and an absent or unreadable marker is `UNMANAGED`. Startup requires a real writable mounted registry and prunes markers without durable session rows. There is no readiness sentinel, cache, or third classification.

## Compose and image controls

`Dockerfile` uses Node 26 bookworm-slim, installs `/usr/bin/git` and `/usr/bin/gh`, copies source/configuration assets, prepares the contracted directories, and runs as UID/GID `1000:1000`. The container entrypoint prepares writable state/worktree/registry paths and then execs the Node daemon. Compose drops all capabilities, enables `no-new-privileges`, uses failure restarts for Tissue only, and does not declare `depends_on` between Tissue and OpenCode.

The `tissue-deploy` profile is a separate one-shot writer for plugin and agent mounts. Long-running Tissue mounts those directories read-only. OpenCode must boot and produce the matching plugin load beacon; copying a plugin file alone is not proof of load.

## CI boundaries

`.github/workflows/ci.yml` has three distinct concerns:

1. `verify` runs `npm ci`, `npm run typecheck`, `npm run lint`, and `npm test` on pushes and pull requests to `main`.
2. `container` builds Tissue and a dependency-free HTTP fixture, validates Compose configuration and `tissue-net`, boots the fixture topology, checks identical shared mounts and registry modes, verifies loud registry failure, runs healthy `tissue doctor`, and runs the deterministic HTTP-driver smoke. These legs validate the fixture boundary only; they do not prove real OpenCode compatibility or resident plugin load.
3. `opencode-compat` is workflow-dispatch-only and opt-in. It requires `OPENCODE_COMPAT_VERSION=1.18.31` and an operator-provided `OPENCODE_COMPAT_COMMAND`, then runs a bounded compatibility smoke. The job is separate from fixture CI.

No real-runtime compatibility result is claimed here. A hosted job must not be treated as evidence beyond the behavior it actually executes.

## Present capabilities and limits

There is no webhook, GitHub App, dashboard, external queue, second Tissue database, or owned OpenCode serve lifecycle. Polling remains the correctness path. The repository provides local CLI, JSONL telemetry, SQLite/WAL persistence, s6 packaging, and a Docker-network-only health surface. Production deployment decisions, resident service availability, and operator-owned mounts remain outside the repository's automated fixture evidence.
