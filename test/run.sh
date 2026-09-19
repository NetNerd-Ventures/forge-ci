#!/usr/bin/env bash
# Runs every JS harness and every shell test. No npm, no framework.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
status=0

for f in test/_test-*.cjs; do
  [ -f "$f" ] || continue
  printf '%s\n' "$f"
  node "$f" || status=1
done

# shellcheck source=test/lib.sh
. test/lib.sh
for f in test/test_*.sh; do
  [ -f "$f" ] || continue
  printf '%s\n' "$f"
  # shellcheck disable=SC1090
  . "$f" || status=1
done
printf '\n%d shell assertions, %d failed\n' "$FORGE_CI_TESTS_RUN" "$FORGE_CI_TESTS_FAILED"
[ "$FORGE_CI_TESTS_FAILED" -eq 0 ] || status=1
exit "$status"
