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

The deterministic gate (`npm run typecheck`, `npm run lint`, `npm test`) runs in the `verify` job on CI pushes and pull requests to `main` (`.github/workflows/ci.yml`). The same workflow also defines a GitHub-hosted `container` job with nine named Docker/Compose legs: image build, Compose validation and boot, network membership, registry/mount assertions, loud registry-failure handling, healthy `tissue doctor`, behavioural smoke, and fresh-process OpenCode plugin resolution. Its CI-only stand-in installs the pinned `opencode-ai@1.18.18`; it is not the production resident and the workflow does not claim resident plugin load or `fired`. The container job has not supplied hosted-run evidence here, and is not stated as a required branch check. Hosted evidence is fail-closed: an authorized operator must record the GitHub run ID, the outcome of each named leg (Leg 1 Docker build, Leg 2 Compose config, Leg 3 boot, Leg 4 `tissue-net` membership, Leg 5 registry RW/RO and mounts, Leg 6 loud registry-mount failure, Leg 7 healthy `tissue doctor`, Leg 8 behavioural smoke, and Leg 9 fresh-process resolution), and the uploaded `leg-*.log` artifact reference. The operator must also retain the first Leg 9 `opencode debug config --json` raw output, exit code, valid-JSON recognition, and exact `tissue-moderation.ts` membership in the resolved plugin set. A nonzero or unrecognized result is not a pass: it requires equivalent deterministic fresh-process evidence with the same record, or remains a blocker/escalation. Leg 3 ownership follows Plan N/M topology and stand-in coverage as applicable; Leg 5 follows Plans H/I/N; Leg 9 runs Plan M's owned test case, with Plan O providing the execution venue only. `main` is protected: it requires a pull request and a passing `verify` check, and blocks force pushes and deletions. CodeQL code scanning runs on `main` and on a weekly schedule. See [infrastructure audit](docs/infrastructure-audit.md).

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
