# Onboarding and configuration

Tissue reads a small YAML configuration file selected by `TISSUE_CONFIG` (default `./tissue.yml`). Start with `tissue.example.yml`, configure the repository list and resident endpoint in the environment, then run the local checks before enabling the daemon.

## YAML settings

Top-level keys are:

- `security.trustedGithubUsers` — optional list of GitHub logins whose current textual authorship may have prose included at an agent-visible retrieval/serialization boundary. This allowlist governs current GitHub-originating prose visibility, not generic GitHub action or control-content authorization. Each entry must be a valid GitHub login in the bounded ASCII grammar (1–39 characters, letters, digits, and interior hyphens); matching is ASCII case-insensitive. Do not pad entries with whitespace or rely on Unicode lookalikes.
- `pollIntervalSeconds` — polling interval; defaults to `300` and must be at least `10`.
- `maxConcurrentGlobal` — global active-work limit; defaults to `3` and must be at least `1`.
- `retentionDays` — durable-history retention; defaults to `90` and must be at least `1`.
- `agents.triage` and `agents.resolution` — optional dedicated agent names and model values. Names default to `tissue-triage` and `tissue-resolve`.
- `repos` — repository configuration entries; the example leaves this empty until an operator chooses repositories.

### Trusted GitHub users and fail-closed behavior

`security.trustedGithubUsers` is the only trust allowlist. The loader is strict: `security` accepts only the `trustedGithubUsers` key, every list item must be a string, and one invalid or malformed login rejects the configuration rather than filtering it out. Unknown root or nested keys are also rejected. The configured list is normalized into a policy using ASCII case-folding only; Tissue does not trim values, perform Unicode folding, look up identities online, infer durable IDs, or assume rename continuity.

If `security` is omitted, the list is empty, or the configuration cannot be used, `decideCurrentGithubProse` denies prose for that operation. It does not silently become a trust-all policy and does not create a `CONFIG_UNUSABLE` runtime record at this retrieval boundary. Objective facts remain separately classifiable.

GitHub-originating prose may be retained by Tissue's existing operational storage, but stored content is untrusted until an agent-visible retrieval or serialization operation. Immediately before triage, relay, prompt, transcript/history serialization, or controller-generated prose delivery, the controller reads the current configuration, normalizes the stored author explicitly, and fails closed for missing, unknown, malformed, or unusable author/configuration data. Denied prose is omitted rather than summarized or copied into diagnostics; typed objective lifecycle/reconciliation fields remain available. Reactions, inline review comments/threads, and review-body delivery are unsupported residuals with no current production consumer and remain fail-closed. No startup-cached policy, persisted decision, policy revision, object ownership, or prior delivery authorizes a later operation. Objective state remains separately usable. See the pending [retrieval-time design handoff](../artifacts/designs/pending/trusted-github-actor-boundary/DD.md) and [configuration validation](../src/config/load.ts) for the design authority and existing loader boundary.

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
