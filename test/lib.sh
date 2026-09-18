#!/usr/bin/env bash
# shellcheck shell=bash
# Shared assertions for test/test_*.sh. Sourced, not executed.
FORGE_CI_TESTS_RUN=0
FORGE_CI_TESTS_FAILED=0

_pass() { FORGE_CI_TESTS_RUN=$((FORGE_CI_TESTS_RUN + 1)); }
_fail() {
  FORGE_CI_TESTS_RUN=$((FORGE_CI_TESTS_RUN + 1))
  FORGE_CI_TESTS_FAILED=$((FORGE_CI_TESTS_FAILED + 1))
  printf '  FAIL %s\n' "$1" >&2
}

assert_eq() { # expected actual label
  if [ "$1" = "$2" ]; then _pass; else _fail "$3: expected '$1', got '$2'"; fi
}
assert_contains() { # haystack needle label
  case "$1" in *"$2"*) _pass ;; *) _fail "$3: '$2' not found" ;; esac
}
assert_file() { # path label
  if [ -f "$1" ]; then _pass; else _fail "$2: missing $1"; fi
}
