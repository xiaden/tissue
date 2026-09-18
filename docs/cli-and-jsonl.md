# CLI, status, history, inspect, and JSONL

The CLI is a thin adapter over shared domain operations; there is no second business path.

| Command | Purpose |
|---|---|
| `tissue daemon` | Resident A′ reconcile loop under s6 |
| `tissue tick` / `tissue reconcile` | One shared P0–P6 pass |
| `tissue status` | Local capacity, leases, sessions, inbox summary, FAILED_HOLD, WAL, housekeeping, per-repository readiness, credential-free resident-endpoint status, registry mount state/marker count, and unprobed `gh` fields |
| `tissue inspect [owner/repo\|wi]` | Durable WorkItem, session, worktree, PR, inbox/check, and repository protection detail |
| `tissue history [wi]` | Retained transitions and housekeeping actions |
| `tissue enqueue owner/repo#number` | Explicit baseline admission only |
| `tissue pause/resume/unpause <target>` | Durable triage/work control |
| `tissue cleanup <wi>` | Human-only FAILED_HOLD cleanup |
| `tissue install-agents [--force]` | Deploy the dedicated Tissue agents into the OpenCode global agent dir (idempotent; refuses a divergent file without `--force`) |
| `tissue install-plugin [--force]` | Host-side one-shot deployment of the Tissue moderation plugin into the OpenCode global plugin dir; refuses a divergent `tissue-moderation.ts` without `--force`; the operator must restart OpenCode to load the deployment |
| `tissue doctor` / `tissue smoke` | Environment and bounded smoke checks; `doctor` reports the deployed plugin's load state and beacon reason, alongside agent and registry checks, and exits non-zero when its checks fail |

`install-plugin` is filesystem-only and emits one JSON result on stdout. A successful result has `ok: true`, the deployed SHA-256, and an `action` of `installed` or `unchanged`; a divergent existing file returns `ok: false`, `action: "exists-divergent"`, and exit code 1 unless `--force` is supplied. Other deployment errors likewise return `ok: false` with exit code 1. The command does not open the Tissue database, reconcile, or restart OpenCode. The host-side deploy step writes the Tissue-owned `tissue-moderation.ts` and, when `TISSUE_MODERATION_DIR` is set, its `deploy-record.json`; stop/start OpenCode separately so the resident can write the boot-bound load beacon.

`doctor` and `status` include a credential-free `plugin` object with `loaded`, `reason`, `deployedSha256`, and (when available) the beacon. `loaded` is attested from the beacon's plugin SHA and server-start epoch, not inferred from file existence. `doctor` also reports `fired.attested` separately; that attestation is not part of `doctor.ok`. JSON output is structured, redacted, and safe to retain.

`status` reports a redacted `repositoryReadiness` list (`id`, `enabled`, `configManaged`, persisted `capability`, `ready`, `checkedAt`, `reasons`) and a credential-free `opencode` block (`configured`, redacted `endpoint`, `authConfigured`, `capability: "not_probed"`). It also reports a `registry` view (`dir`, `mountAsserted`, `writable`, `realMount`, `overridden`, `markerCount`, `prunedAtStartup`); `overridden` is true only when a non-default mount table is in effect (the test/ops mount-table override) and false on the default production path; `prunedAtStartup` is the marker ids with no `opencode_sessions` row, re-derived read-only. The registry holds empty `ses_*` ownership markers only — no marker contents and no readiness sentinel cross this surface — and `doctor.ok` gates on `registry.mountAsserted` as well as the deployed agent definitions. The `gh` fields remain unprobed (`gh.binary: "/usr/bin/gh"`, `gh.authenticated: null`, `gh.version: null`, `gh.capability: "not_probed"`); the authenticated capability audit is performed by `tissue reconcile` and persisted, not by `status`. It does not provide repository protection, inbox-detail, or PR-detail inspection. Use `inspect` for that durable repository/WorkItem detail. JSON output is structured, redacted, and safe to retain. Each JSONL record has timestamp, level, operation ID (`op`), event, and event-specific fields. Operational records should carry repository ID, WorkItem ID, real OpenCode session ID, phase, attempt, latency, result, and redaction status where applicable. Secret-like keys and credential-shaped values are masked before writing.

`state_transitions` is the durable audit ledger; `inbox` is the ordered delivery ledger; `side_effects` is the transactional effect ledger; JSONL is telemetry. None is a session transcript. `ERROR` JSONL human-inspect records identify cleanup/recovery outcomes without payloads, secrets, or transcripts. Inspect/history expose retained Issue, WorkItem, PR, audit, log, and session mapping after merge. WAL size/growth and terminal-unattached housekeeping counters remain visible.

Operation IDs are correlation labels, not authorization. Every transition is controller-owned and auditable. Post-merge cleanup deletes only disposable worktree/branch artifacts and never deletes real sessions or rewrites retained history.
