# Tissue s6-rc recovery

After an unexpected stop, inspect supervisor state, run `tissue doctor`, then one `tissue reconcile`. Reconciliation verifies the resident endpoint, real session census (without any serve lifecycle), repository capabilities, worktrees, PRs, leases, effects, drift, and terminal-unattached inbox rows. Preserve `FAILED_HOLD`; only an explicit human `tissue cleanup <wi>` may destroy its disposable artifacts. Never kill a PID with a mismatched start time and never delete an OpenCode session or database.
