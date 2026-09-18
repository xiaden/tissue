#!/usr/bin/env bash
set -euo pipefail

# OQ1 volume preparation. The long-running Tissue service owns only its
# writable state, shared worktree, and session-registry paths. Owner-side
# moderation/plugin/agent mounts are read-only here and are prepared by deploy.
# It is safe to run repeatedly and fails loudly on any mkdir/chown failure.
uid=1000
gid=1000
state_dir="${TISSUE_STATE_DIR:-/var/lib/tissue/state}"
worktree_dir="${TISSUE_WORKTREE_ROOT:-/srv/tissue/worktrees}"
registry_dir="${TISSUE_SESSION_REGISTRY_DIR:-/tissue-session-registry}"
paths=("$state_dir" "$worktree_dir" "$registry_dir")
mkdir -p "${paths[@]}"
chown -R "${uid}:${gid}" "${paths[@]}"
printf '{"event":"volumes.prepared","uid":%s,"gid":%s}\n' "$uid" "$gid"
