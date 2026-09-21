# CLI, status, history, inspect, and JSONL

The CLI is a thin adapter over the controller's shared operations. It does not create a second business path.

## Commands

| Command | Purpose |
|---|---|
| `tissue daemon` | Run the resident reconcile loop. It re-probes resident health on every iteration and withholds prompt-dependent work while OpenCode is unavailable. |
| `tissue tick` / `tissue reconcile` | Run one shared reconciliation pass. |
| `tissue status` | Show capacity, leases, sessions, inbox summary, held work, WAL, housekeeping, repository readiness, resident status, plugin status, and registry status. |
| `tissue inspect [owner/repo\|work-item-id]` | Show durable repository or work-item details, sessions, worktrees, pull requests, checks, inbox state, and protection data. |
| `tissue history [work-item-id]` | Show retained transitions and housekeeping actions. |
| `tissue enqueue owner/repo#number` | Explicitly admit one issue to the configured baseline. |
| `tissue pause TARGET` | Pause triage for a repository or work for a work item. |
| `tissue resume TARGET` / `unpause TARGET` | Resume a paused repository or work item. |
| `tissue cleanup WORK_ITEM_ID` | Human-only cleanup for `FAILED_HOLD`. |
| `tissue install-agents [--force]` | Install dedicated agent definitions into the resident global agent directory. |
| `tissue install-plugin [--force]` | Install the Tissue-owned moderation plugin into the resident global plugin directory. |
| `tissue doctor` | Validate deployed agents, plugin load, registry mount, database, repositories, and resident status. |
| `tissue smoke` | Run bounded local smoke checks. |

## Status and safety

`status` returns structured, redacted JSON. The `repositoryReadiness` entries include repository id, enablement, persisted capability, readiness, check time, and reasons. The `opencode` block includes a redacted endpoint and credential-free health fields. GitHub authentication and capability remain `not_probed` until `reconcile`; `status` does not perform that audit. The registry view reports directory, mount assertion, writability, real-mount status, override status, marker count, and markers that startup would prune.

Managed sessions use exactly two states: a present `ses_*` marker is `MANAGED`; an absent or unreadable marker is `UNMANAGED`. Startup requires a writable persisted registry and prunes markers with no durable session row. Marker contents are never read, and no readiness sentinel or third state exists.

## JSONL

Each operational JSONL record contains a timestamp, level, operation id, event, and event-specific fields. Records may include repository id, work-item id, real OpenCode session id, phase, attempt, latency, result, and redaction status. Secret-like keys and credential-shaped values are masked before writing.

`state_transitions` is the durable state audit, `inbox` is the ordered delivery record, and `side_effects` is the transactional effect record. JSONL is telemetry, not a transcript or session store. `inspect` and `history` remain useful after merge because durable Issue, WorkItem, pull-request, audit, log, and session mappings are retained.

Operation ids correlate records; they do not grant authorization. All transitions are controller-owned. Post-merge cleanup removes only disposable worktree/branch artifacts and never deletes real sessions or retained history.
