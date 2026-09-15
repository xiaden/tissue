# Tissue s6-rc status

Use `s6-svstat -o up,ready,down /run/service/tissue` for supervisor state and `tissue status` for application state. `tissue status` reports per-repository persisted readiness (`repositoryReadiness`) and a credential-free resident-endpoint block; authenticated `gh` capability remains unprobed until `tissue reconcile`. Supervisor readiness alone does not prove queue, session, inbox, protection, WAL, repository capability, or release-gate health.
