# forge-ci

CI scripts extracted for reuse across repos, run from a nested checkout at
`.forge-ci/scripts/` with the consumer repo as the working directory. Each
script under `scripts/` reads `REPO_ROOT` (falling back to `process.cwd()`)
for any git operation, never its own parent directory. See `test/` for the
harness per script (`node test/run.sh` or the individual `_test-*.cjs`
files).

Node 22, no npm dependencies.
