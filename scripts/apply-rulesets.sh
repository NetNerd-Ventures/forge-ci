#!/usr/bin/env bash
# Renders rulesets/*.json for a consumer repo and applies them with gh.
# Idempotent: a ruleset named "forge-ci: <branch>" is updated in place.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATES="$HERE/../rulesets"
REPO="" MODE="" INTEGRATION="" PRODUCTION="" DRY_RUN=false NO_QUEUE=false
EXTRA=()

usage() {
  echo "Usage: apply-rulesets.sh --repo owner/name --mode two-tier|single-tier --integration <branch> --production <branch> [--extra-gate <job name>]... [--no-merge-queue] [--dry-run]" >&2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --integration) INTEGRATION="$2"; shift 2 ;;
    --production) PRODUCTION="$2"; shift 2 ;;
    --extra-gate) EXTRA+=("$2"); shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-merge-queue) NO_QUEUE=true; shift ;;
    *) usage; exit 1 ;;
  esac
done
if [ -z "$REPO" ] || [ -z "$MODE" ] || [ -z "$INTEGRATION" ] || [ -z "$PRODUCTION" ]; then
  usage
  exit 1
fi

case "$MODE" in
  two-tier)
    [ "$INTEGRATION" != "$PRODUCTION" ] || { echo "two-tier needs integration != production" >&2; exit 1; } ;;
  single-tier)
    [ "$INTEGRATION" = "$PRODUCTION" ] || { echo "single-tier needs integration == production" >&2; exit 1; } ;;
  *) echo "unknown mode: $MODE" >&2; exit 1 ;;
esac

# Check-runs from a called workflow are named "<caller job id> / <callee job name>";
# the caller job ids are fixed to `gates` and `review` by the forge templates.
contexts=("gates / typecheck" "gates / unit tests" "gates / migration drift" "gates / gitleaks" "gates / actionlint")
[ "$MODE" = "two-tier" ] && contexts+=("review / cross-model review")
contexts+=("${EXTRA[@]+"${EXTRA[@]}"}")
contexts_json=$(printf '%s\n' "${contexts[@]}" | jq -R '{context: .}' | jq -s .)

# Merge queues are not available on private repositories outside GitHub Enterprise
# Cloud (the API rejects the merge_queue rule with an empty 422). --no-merge-queue
# strips the rule; and because without a queue there is no bot acting as the "last
# pusher" — and GitHub never lets an author approve their own PR — a single-tier
# ruleset without a queue drops the approval requirement too: the required checks
# plus the human merge click are the gate. Two-tier keeps its approval on the
# promote PR, which the App opens, so a solo human can still approve it.
render() { # template branch add_queue solo
  local tpl="$1" branch="$2" add_queue="$3" solo="${4:-false}"
  jq --arg branch "$branch" --argjson checks "$contexts_json" --argjson add_queue "$add_queue" --argjson solo "$solo" '
    .name = ("forge-ci: " + $branch)
    | .conditions.ref_name.include = ["refs/heads/" + $branch]
    | (.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks) = $checks
    | .rules |= map(if $add_queue == false and .type == "merge_queue" then empty else . end)
    | if $solo then
        (.rules[] | select(.type == "pull_request") | .parameters.required_approving_review_count) = 0
        | (.rules[] | select(.type == "pull_request") | .parameters.require_last_push_approval) = false
        | (.rules[] | select(.type == "pull_request") | .parameters.dismiss_stale_reviews_on_push) = false
      else . end
    | if $add_queue and ([.rules[].type] | index("merge_queue") == null) then
        .rules += [{type: "merge_queue", parameters: {merge_method: "MERGE", grouping_strategy: "ALLGREEN",
          min_entries_to_merge: 1, max_entries_to_merge: 5, max_entries_to_build: 5,
          min_entries_to_merge_wait_minutes: 0, check_response_timeout_minutes: 30}}]
      else . end
  ' "$tpl"
}

apply() { # rendered_json
  local body="$1" name id
  name=$(jq -r .name <<<"$body")
  if [ "$DRY_RUN" = true ]; then
    printf '%s\n' "$body"
    echo "# would apply ruleset '$name' to $REPO"
    return
  fi
  id=$(gh api "repos/$REPO/rulesets" --paginate -q '.[] | [.id, .name] | @tsv' | awk -F'\t' -v n="$name" '$2 == n {print $1; exit}')
  if [ -n "$id" ]; then
    gh api -X PUT "repos/$REPO/rulesets/$id" --input - <<<"$body" > /dev/null
    echo "updated ruleset '$name' ($id) on $REPO"
  else
    gh api -X POST "repos/$REPO/rulesets" --input - <<<"$body" > /dev/null
    echo "created ruleset '$name' on $REPO"
  fi
}

queue=true; [ "$NO_QUEUE" = true ] && queue=false
if [ "$MODE" = "two-tier" ]; then
  apply "$(render "$TEMPLATES/integration.json" "$INTEGRATION" "$queue")"
  apply "$(render "$TEMPLATES/production.json" "$PRODUCTION" false)"
else
  apply "$(render "$TEMPLATES/production.json" "$PRODUCTION" "$queue" "$([ "$queue" = false ] && echo true || echo false)")"
fi
