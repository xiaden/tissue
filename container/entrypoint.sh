#!/usr/bin/env bash
set -euo pipefail

log() { printf '{"event":"container.%s"}\n' "$1"; }

log "prepare_volumes.start"
/app/container/prepare-volumes.sh

# The Node startup path owns the authoritative registry mount assertion and
# marker reconciliation immediately before assembly/daemon work. No sentinel is
# published here; any failed assertion terminates this container non-zero.
log "registry_reconciliation.start"
exec node src/runtime/entrypoint.ts daemon
