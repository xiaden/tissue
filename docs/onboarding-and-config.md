# Onboarding and configuration

Tissue reads a small YAML configuration file selected by `TISSUE_CONFIG` (default `./tissue.yml`). Start with `tissue.example.yml`, configure the repository list and resident endpoint in the environment, then run the local checks before enabling the daemon.

## YAML settings

Top-level keys are:

- `pollIntervalSeconds` — polling interval; defaults to `300` and must be at least `10`.
- `maxConcurrentGlobal` — global active-work limit; defaults to `3` and must be at least `1`.
- `retentionDays` — durable-history retention; defaults to `90` and must be at least `1`.
- `agents.triage` and `agents.resolution` — optional dedicated agent names and model values. Names default to `tissue-triage` and `tissue-resolve`.
- `repos` — repository configuration entries; the example leaves this empty until an operator chooses repositories.

Each repository entry supplies owner, name, local checkout, enablement, polling/capacity overrides, base branch, labels, baseline, merge policy, and optional push-fork fields. `remote` URLs must not contain credentials. A push fork may use `pushOwner`, `pushName`, and `pushRemote`; the target repository need not grant push permission. Configuration is scalar data, not a policy language, and unknown keys or secret-shaped values are rejected.

## Environment

- `TISSUE_CONFIG` — YAML path, default `./tissue.yml`.
- `TISSUE_STATE_DIR` — private Tissue state root, default `.tissue`; the database is `${TISSUE_STATE_DIR}/tissue.db`.
- `TISSUE_WORKTREE_ROOT` — absolute shared worktree root. If unset, Tissue uses `${TISSUE_STATE_DIR}/worktrees`.
- `TISSUE_SESSION_REGISTRY_DIR` — absolute persisted registry path, default `/tissue-session-registry`. Relative paths and `/run` paths are rejected.
- `TISSUE_SESSION_REGISTRY_MOUNTINFO` — optional diagnostic mount-table override for `status` and `doctor`; production normally leaves it unset and reports whether it was overridden.
- `TISSUE_OPENCODE_URL` — required HTTP(S) URL for the already-running resident OpenCode service. Credentials must not be embedded in the URL.
- `TISSUE_OPENCODE_ALLOWED_ORIGINS` — optional exact-origin allowlist; the configured origin must match one entry exactly when set.
- `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` — optional credentials supplied separately from the URL.
- `TISSUE_OPENCODE_AGENTS_DIR` — resident global agent directory override.
- `TISSUE_OPENCODE_PLUGINS_DIR` — resident global plugin directory override; it must be absolute.
- `TISSUE_MODERATION_DIR` — moderation deployment records and load beacon directory.
- `TISSUE_HTTP_PORT` — internal health listener port, default `8787`.

Without an explicit allowlist, the resident endpoint must resolve to loopback or a private address. With an allowlist, the origin must exactly match an allowlist entry. Wildcard binds, public hosts, non-HTTP(S) schemes, and embedded credentials are rejected before credentials are attached. In Compose, the deliberate exact-origin value is `http://opencode:4096` on `tissue-net`.

## Storage boundaries

Tissue's private state, shared worktrees, and managed-session registry are distinct. The registry is Tissue read/write and OpenCode read-only. A present `ses_*` marker is `MANAGED`; every absent or unreadable marker is `UNMANAGED`. Marker contents are never read. Startup asserts a real writable persisted mount and prunes markers without matching durable session rows. No readiness file, cache, or third state is used.

## Agent and plugin deployment

The resident service resolves agents and plugins from its global directories, not from this checkout. Deploy the checked-in definitions with:

```sh
node src/cli.ts install-agents
node src/cli.ts install-agents --force
node src/cli.ts install-plugin
node src/cli.ts install-plugin --force
```

The commands are idempotent. They refuse divergent existing files unless `--force` is supplied, never touch OpenCode's database, and never restart the resident. `tissue doctor` compares deployed agents and the Tissue-owned plugin with checked-in source. Plugin load additionally requires a matching post-boot beacon and deployment record.

## Safety and merge policy

Use the validated `/usr/bin/gh` binary and typed subprocess arguments. Do not print tokens, read credential files into logs, or put credentials in remotes. `autoMerge: true` remains fail-closed: identity, protection, required approvals/checks, and mergeability must all be known and satisfied. Unknown protection, drafts, conflicts, or unmet gates do not merge. `autoMerge: false` never creates a merge effect.
