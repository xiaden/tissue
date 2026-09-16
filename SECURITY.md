# Security policy

## Supported versions

Tissue is pre-release (`0.1.0`) and is not release-ready, so no version
currently receives security support. See `docs/infrastructure-audit.md`.

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability), or contact the maintainer through the
repository owner's profile. Include a description, reproduction steps, and the
impact you believe it has. We will acknowledge receipt and coordinate a fix and
disclosure.

## Scope

In scope: the controller source under `src/`, its CLI, the configuration loader,
and the typed `gh`/git integration boundary.

Out of scope: the host OpenCode runtime, third-party dependencies, and
user-operated host configuration.
