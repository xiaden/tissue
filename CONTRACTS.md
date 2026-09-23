# Public Contracts

This document publishes the contracts exchanged across Tissue's controller and resident-agent boundaries. The authoritative implementation is [`src/domain/envelopes.ts`](src/domain/envelopes.ts); runtime resolution responses are consumed by [`readResolutionResult`](src/integrations/opencode-driver.ts) and returned as [`ResolutionResult`](src/controller/session-driver.ts).

## ResolutionEnvelope

A resolution agent returns one bounded JSON object describing the result of work on one existing WorkItem. It is a proposal for a single controller-owned lifecycle transition, not an instruction to create identities or perform controller side effects.

### Shape

```json
{
  "kind": "resolution",
  "envelope_id": "controller-assigned-id",
  "work_item_id": "existing-work-item-id",
  "outcome": "completed",
  "reason": "optional bounded rationale"
}
```

Fields:

- `kind` — required literal `resolution`.
- `envelope_id` — required identifier used for durable at-least-once deduplication.
- `work_item_id` — required identifier of the existing WorkItem whose lifecycle is proposed to move.
- `outcome` — required one of `completed`, `awaiting_review`, `needs_changes`, `awaiting_decision`, or `deferred`.
- `dependency` — optional object `{ "kind": "issue" | "work_item", "id": string }`. It is required for `deferred` and forbidden for every other outcome.
- `reason` — optional human/agent rationale, at most 2,000 characters.

`envelope_id`, `work_item_id`, and `dependency.id` must be non-empty identifier-safe strings. They may contain only ASCII letters, digits, `.`, `_`, `/`, `:`, and `-`, and are capped at 160 characters. Malformed values are rejected by bounded validation.

### Runtime consumption and application

The OpenCode adapter reads the latest parent-linked assistant text, rejects empty or oversized output (over 16,000 characters), parses JSON, requires an object with `kind: "resolution"`, and requires `work_item_id` to match the requested WorkItem. It then runs the same envelope validation before returning `ResolutionResult` (`{ envelope, assistantId? }`) to the controller.

The controller validates the envelope again before applying it. The referenced WorkItem must exist, and the proposed transition must be legal for its current state. Outcomes map to lifecycle states and transition events as follows:

| Outcome | Target state | Event |
|---|---|---|
| `completed` | `COMPLETED` | `completed` |
| `awaiting_review` | `WAITING` | `await_review` |
| `needs_changes` | `RUNNING` | `resume` |
| `awaiting_decision` | `AWAITING_DECISION` | `await_decision` |
| `deferred` | `DEFERRED` | `defer` |

`awaiting_decision` is the human-decision waiting outcome and maps to `AWAITING_DECISION`; it is distinct from `deferred`, which waits for exactly one recorded issue or WorkItem dependency and maps to `DEFERRED`. For `deferred`, the validated dependency is recorded on the WorkItem before the state transition. Only verified completion of that dependency may release `DEFERRED`; restart, elapsed time, reconcile, or a generic `BLOCKED` transition must not release it. Every applied transition records the envelope id, outcome, dependency (or `null`), and reason in the transition audit. A `completed` envelope means that the agent finished its repair turn, not that the controller has completed the WorkItem: completion remains on the verified push, pull-request, protection, and merge effect path and is not a generic WorkItem resolution-state application. Reapplying an envelope already applied to the WorkItem, or applying one whose target state is already reached, returns an auditable `noop_duplicate` result and does not create a second effect.

Resolution agents must return this envelope together with the local verification they performed, as described in [`agents/tissue-resolve.md`](agents/tissue-resolve.md). The controller owns durability, lifecycle effects, worktrees, sessions, and pull requests.

## GitHub prose delivery boundary

GitHub-originating prose is untrusted until final controller retrieval/serialization for an agent-visible context. `decideCurrentGithubProse` in `src/controller/trust.ts` reads the current `security.trustedGithubUsers` configuration on each operation, strictly normalizes the stored login using bounded ASCII semantics, and returns only an ephemeral `TRUSTED`/`DENIED` result. Missing, unknown, malformed, or unusable author/configuration data is denied; startup-cached policies, persisted decisions, policy revisions, object ownership, and prior delivery do not authorize later prose.

The concrete controller seams are `buildTriageDigest` in `src/controller/triage.ts`, which filters issue/PR title and body previews while preserving typed objective fields, and `buildBundleText`/`relayOldestInbox` in `src/controller/inbox-relay.ts`, which rebuild an allowlisted typed inbox projection and re-check it before pending claim, `DELIVERING` resume, bundle construction, and prompt transport. `src/runtime/daemon.ts` and `src/runtime/entrypoint.ts` propagate the runtime configuration path. Whole persisted payload JSON is not an agent-facing projection.

The current contract preserves objective identifiers, lifecycle state, timestamps, SHAs/checks, mergeability, conflicts, and other typed reconciliation facts independently of prose authorization. The existing managed-session moderation refusal remains unchanged. Reactions, inline review comments/threads, and review-body delivery have no current production consumer and are explicit unsupported, fail-closed residuals; any future consumer must apply the same current-config final filter.
