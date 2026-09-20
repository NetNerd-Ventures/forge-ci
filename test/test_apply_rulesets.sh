# shellcheck shell=bash
# apply-rulesets.sh renders the right contexts per mode and talks to gh correctly.
_ar() { PATH="$PWD/test/fixtures/fake-gh:$PATH" FAKE_GH_LOG="$1" bash scripts/apply-rulesets.sh "${@:2}"; }

log=$(mktemp)
out=$(_ar "$log" --repo o/r --mode two-tier --integration staging --production main --extra-gate "build gates" --dry-run)
assert_contains "$out" '"forge-ci: staging"' "two-tier renders integration ruleset"
assert_contains "$out" '"forge-ci: main"' "two-tier renders production ruleset"
assert_contains "$out" '"gates / typecheck"' "contexts carry the caller job prefix"
assert_contains "$out" '"review / cross-model review"' "two-tier requires cross-model review"
assert_contains "$out" '"build gates"' "extra gate is a required context"
assert_eq "0" "$(wc -l < "$log" | tr -d ' ')" "dry-run calls gh zero times"

log=$(mktemp)
out=$(_ar "$log" --repo o/r --mode single-tier --integration main --production main --dry-run)
assert_eq "1" "$(grep -c '"name": "forge-ci: main"' <<<"$out")" "single-tier renders one ruleset"
assert_eq "0" "$(grep -c 'cross-model review' <<<"$out")" "single-tier does not require cross-model review"
assert_contains "$out" '"merge_queue"' "single-tier production ruleset has the merge queue"
assert_contains "$out" '"required_approving_review_count": 1' "single-tier production still needs an approval"

log=$(mktemp)
_ar "$log" --repo o/r --mode two-tier --integration staging --production main >/dev/null
assert_eq "2" "$(grep -c 'api -X POST' "$log")" "fresh repo: two POSTs"

log=$(mktemp)
FAKE_GH_EXISTING="forge-ci: main" _ar "$log" --repo o/r --mode two-tier --integration staging --production main >/dev/null
assert_eq "1" "$(grep -c 'api -X PUT repos/o/r/rulesets/42' "$log")" "existing ruleset: PUT by id"
assert_eq "1" "$(grep -c 'api -X POST' "$log")" "the other one is still POSTed"

out=$(_ar "$(mktemp)" --repo o/r --mode single-tier --integration staging --production main --dry-run 2>&1 || true)
assert_contains "$out" "single-tier needs integration == production" "mode/branch mismatch is rejected"

# --no-merge-queue: private repos outside Enterprise Cloud cannot have a queue.
log=$(mktemp)
out=$(_ar "$log" --repo o/r --mode single-tier --integration main --production main --no-merge-queue --dry-run)
assert_eq "0" "$(grep -c '"merge_queue"' <<<"$out")" "single-tier --no-merge-queue has no queue rule"
assert_contains "$out" '"required_approving_review_count": 0' "single-tier without a queue needs no approval (solo human cannot approve own PR)"
assert_contains "$out" '"require_last_push_approval": false' "no last-push approval without a queue bot"
out=$(_ar "$log" --repo o/r --mode two-tier --integration staging --production main --no-merge-queue --dry-run)
assert_eq "0" "$(grep -c '"merge_queue"' <<<"$out")" "two-tier --no-merge-queue strips the integration queue"
assert_contains "$out" '"required_approving_review_count": 1' "two-tier keeps the promote-PR approval"
