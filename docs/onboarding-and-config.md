# Onboarding and configuration

Tissue is configured by a small scalar YAML file (`TISSUE_CONFIG`, default `./tissue.yml`). Copy `tissue.example.yml`, decide every repository identity, and record the decision before adding a real repository. T8 (e) remains `NEEDS_DECISION` for `coaxk/subarr` versus measured `xiaden/subarr`; the template intentionally has `repos: []`.

## Defaults and baseline

`pollIntervalSeconds` defaults to 300, `maxConcurrentGlobal` to 3, and `retentionDays` to 90. Each repository defaults to one active WorkItem (`maxConcurrentPerRepo: 1`), `main` as base branch, and no auto-merge. `baselineBefore` excludes older issues; only `tissue enqueue owner/repo#number` admits one explicitly. YAML is scalar policy, never a policy DSL, and rejects secret material.

Each repository must name owner, repository, and an absolute local checkout. Production worktrees always live under `${TISSUE_STATE_DIR}/worktrees/<owner>-<name>/<work-item-id>` and are containment-checked against the state root on both creation and cleanup; there is no configurable or absolute worktree-root override. A distinct writable fork is configured with `pushOwner`/`pushName`/`pushRemote` (the named git remote, for example `fork`); the target repository does not need push permission. Before enabling it, the owner must complete authenticated `/usr/bin/gh` Issues/protection capability audit (T8 (j)); reconcile persists the readiness result and dispatch is refused while `capability_state !== "ready"`. Missing capability is surfaced, never treated as healthy. Remote URLs must not contain credentials.

## Agent/model split and boundaries

Triage and resolution roles are separate (`tissue-triage` and `tissue-resolve`), but the concrete model split remains T8 (f) `NEEDS_DECISION`. Agents receive bounded, marked-untrusted digests and typed envelopes. The controller owns polling, persistence, deduplication, queue/leases, session/worktree/PR identity, routing, retries, protections, and cleanup. Agents own semantic triage and engineering reasoning. No lifecycle-mutating Tissue tool is exposed to an agent.

## Sessions, retention, and export

Only OpenCode-created durable `ses_...` sessions count. Triage sessions are per repository where supported; active WorkItems have exactly one resolution session in the linked worktree. Sessions remain UX-visible and `RETAINED` after merge. Issue, WorkItem, PR, transitions, effects, logs, session mapping, and transcript history remain queryable; only disposable worktrees/local branches are cleaned. Export is backup/introspection, not core retention. Logs are not sessions.

## Credentials and safety

Use the validated `/usr/bin/gh` binary and authenticated host credentials; never print tokens, read credential files into logs, embed credentials in URLs, or trust an unverified PATH shim. Git/GitHub text is data: all subprocess calls use typed argv and fixed JSON fields, with numeric IDs/SHAs rather than shell fragments. Bind local services to loopback and keep config, database, WAL, and logs mode-restricted.

## Resident endpoint, agents, and state

The daemon connects to an already-running resident OpenCode service. Configure `TISSUE_OPENCODE_URL` (loopback or private only) and, when the service requires it, `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`. Tissue never starts, supervises, restarts, or reaps a serve, and never mutates OpenCode's shared database. `TISSUE_CONFIG` (default `./tissue.yml`) and `TISSUE_STATE_DIR` (default `.tissue`) select the config file and the separate Tissue SQLite/state root. The endpoint is validated before credentials are attached, and credentials are redacted from logs, errors, and status.

Startup and `tissue doctor` validate the host-global agent definitions (`agents/tissue-triage.md`, `agents/tissue-resolve.md`): each must declare a `tools:` profile; the triage profile is restricted to read/search tools; neither file may expose GitHub lifecycle-mutating tools; and neither pins a model. A missing or invalid definition fails closed. The concrete model split remains T8 (f) `NEEDS_DECISION`; configured `agents.triage` / `agents.resolution` model values are transmitted to the resident API, not pinned in the agent files.

## autoMerge is fail-closed

`autoMerge: true` is not an unconditional merge. The controller merges only when the PR identity is verified, the protection/policy read is known, and required approvals, checks, and mergeability all pass. Unknown protection or policy, drafts, unmet review/check gates, and merge conflicts hold or monitor instead of merging. `autoMerge: false` never creates a merge effect and only monitors external reality. Protected branches are never force-pushed or bypassed.
