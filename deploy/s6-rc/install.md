# Installing Tissue s6-rc

This is an operator procedure, not an automatic installer. Review `tissue/run`, copy/link the service into the host s6-rc source directory, and compile/update the s6-rc database using the host's documented procedure. Then verify with `s6-svstat`; do not put tokens or credential paths containing secrets into this package.

The service is noninteractive. It connects to the already-running resident OpenCode service through an inherited `TISSUE_OPENCODE_URL`, with optional `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`; these must be supplied by the protected supervisor environment and are never embedded in this package. It never starts, supervises, restarts, or reaps an OpenCode serve.

The checked-in run script defaults `TISSUE_STATE_DIR` to `/workspace/Tissue/.tissue` and `TISSUE_CONFIG` to `/workspace/Tissue/tissue.yml` using execline `importas -D`; a value supplied by the protected supervisor environment takes precedence. It does not source an env file. To point at a different state/config path, either set the variable in the protected supervisor environment or make a reviewed package/run-script change.
