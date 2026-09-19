# shellcheck shell=bash
# Extraction hygiene: no source-project leftovers, both fixture modes exist,
# and no event data leaks into run: blocks outside env:.

# No source-project-specific value may survive extraction (CHANGELOG.md excepted).
hits=$(grep -rniE 'lolliforce|LF_CI_APP|agency-admin|agency-portal|jr-law|platform/supabase|@lolliforce/ui' \
  --exclude=CHANGELOG.md --exclude=test_hygiene.sh --exclude-dir=.git --exclude-dir=node_modules . || true)
assert_eq "" "$hits" "no source-project-specific strings remain"

for wf in gates open-pr cross-model-review migrate deploy-status promote; do
  assert_file ".github/workflows/$wf.yml" "workflow $wf exists"
  assert_contains "$(cat ".github/workflows/$wf.yml")" "forge-ci-ref:" "$wf declares forge-ci-ref"
done
for wf in gates open-pr cross-model-review migrate deploy-status; do
  assert_file "test/fixtures/consumer-single-tier/.github/workflows/$wf.yml" "single-tier caller $wf"
done
assert_eq "" "$(ls test/fixtures/consumer-single-tier/.github/workflows/promote.yml 2>/dev/null)" "single-tier has no promote caller"

# No ${{ }} inside any run: block (event data must arrive through env:).
# A run: | block ends at the first non-blank line whose indentation is <= the
# indentation of the "run: |" line itself -- not at the first line starting
# with "- ", which also matches a markdown list item inside a heredoc body
# (e.g. a PR-body "- [ ] ..." line), and would end the block early.
bad=$(awk '
FNR==1 { inrun=0 }
inrun && $0 !~ /^[[:space:]]*$/ {
  match($0, /^[[:space:]]*/)
  if (RLENGTH <= runIndent) inrun=0
}
match($0, /^[[:space:]]*run: \|/) {
  match($0, /^[[:space:]]*/)
  runIndent = RLENGTH
  inrun = 1
  next
}
inrun && /\$\{\{/ { print FILENAME": "$0 }
' .github/workflows/*.yml || true)
assert_eq "" "$bad" "no expression interpolation inside run blocks"
