# Stopping Tissue s6-rc

Stop only the fixed service name with `s6-rc -d change tissue`, then inspect `s6-svstat /run/service/tissue`. Stopping does not delete Tissue SQLite/WAL, logs, worktrees, or real OpenCode sessions. Use the recovery runbook before starting again.
