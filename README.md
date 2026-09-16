# Tissue

Tissue (Triaged Issue Execution) is a local, autonomous GitHub maintenance controller. It uses a durable, separate Tissue SQLite database and real OpenCode-created `ses_...` sessions; it does not add a dashboard, webhook, external queue, or second database.

## Setup

Requirements: Node.js 26+, a local checkout, and authenticated `/usr/bin/gh` when repository operations are enabled.

```sh
npm ci
cp tissue.example.yml tissue.yml
# edit tissue.yml with monitored repositories and absolute local paths
npm run typecheck
npm run lint
npm test
```

Configuration is intentionally small YAML: repository owner/name/path, polling and capacity defaults, retention, and optional agent model settings. Secrets, policy DSL, credential-bearing URLs, and unsafe identifiers are rejected. See [onboarding and configuration](docs/onboarding-and-config.md).

## Continuous integration

The deterministic gate (`npm run typecheck`, `npm run lint`, `npm test`) runs in CI on pushes and pull requests to `main` (`.github/workflows/ci.yml`). `main` is protected: it requires a pull request and a passing `verify` check, and blocks force pushes and deletions. CodeQL code scanning runs on `main` and on a weekly schedule. See [infrastructure audit](docs/infrastructure-audit.md).

## CLI and supervision

```sh
tissue status
tissue daemon
tissue tick
tissue reconcile
tissue enqueue OWNER/REPO#NUMBER
tissue inspect OWNER/REPO
tissue history WORK_ITEM_ID
tissue doctor
tissue smoke
```

`tissue daemon` is the A-prime resident loop; `tissue tick`/`reconcile` run one shared pass. A-prime is the only implementation target and the s6 package is loopback-only. D-prime is documented as a retained alternative, not co-built. See [CLI and JSONL](docs/cli-and-jsonl.md), [operations runbook](docs/operations-runbook.md), and [s6 supervision](docs/s6-supervision.md).

## Release and evidence

Release records are non-promotional. Current deterministic evidence and superseded historical counts are documented in [release inputs](artifacts/designs/process/tissue-p4-release-inputs.md), [R1–R22 traceability](artifacts/designs/process/tissue-p4-traceability.md), [infrastructure audit](docs/infrastructure-audit.md), [release artifacts](artifacts/release/tissue-release-artifacts.md), and the [Plan E final report](artifacts/release/tissue-plan-e-final-report.md). Real RG-1/RG-3/RG-4/RG-5/RG-6 remain blocked without accepted current evidence; RG-2 remains deterministic-only and RG-5 supporting-only. No gate waiver, service restart, or promotion is implied.
