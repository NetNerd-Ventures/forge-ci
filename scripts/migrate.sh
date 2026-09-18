#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Database Migration Script
#
# Usage:
#   ./scripts/migrate.sh staging              Apply pending migrations to staging
#   ./scripts/migrate.sh production           Apply pending migrations to production (with confirmation)
#   ./scripts/migrate.sh staging --dry-run    Show pending migrations without applying
#   ./scripts/migrate.sh staging --bootstrap  Mark all existing migrations as already applied
#   ./scripts/migrate.sh production --yes --json
#                                             Unattended (CI): no prompts, one JSON summary line on stdout
#
# Credentials: DATABASE_URL from the environment when set, otherwise sourced
# from MIGRATE_ENV_FILE (default: $REPO_ROOT/scripts/.env.<target>).
#
# Environment:
#   REPO_ROOT             Consumer repo root (default: $PWD)
#   MIGRATIONS_DIR         Migrations dir, relative to REPO_ROOT (default: supabase/migrations)
#   MIGRATE_ENV_FILE       Local credentials fallback file (default: $REPO_ROOT/scripts/.env.<target>)
#   MIGRATION_LEDGER_TABLE Ledger table name (default: _migration_log)
# ─────────────────────────────────────────────────────────────

REPO_ROOT="${REPO_ROOT:-$PWD}"
MIGRATIONS_DIR="$REPO_ROOT/${MIGRATIONS_DIR:-supabase/migrations}"
LOGS_DIR="${MIGRATE_LOGS_DIR:-$REPO_ROOT/scripts/logs}"
LEDGER_TABLE="${MIGRATION_LEDGER_TABLE:-_migration_log}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ── Parse arguments ──────────────────────────────────────────

TARGET=""
DRY_RUN=false
BOOTSTRAP=false
YES=false
JSON=false

usage() {
  echo "Usage: ./scripts/migrate.sh [staging|production] [--dry-run] [--bootstrap] [--yes] [--json]"
}

for arg in "$@"; do
  case "$arg" in
    staging|production) TARGET="$arg" ;;
    --dry-run) DRY_RUN=true ;;
    --bootstrap) BOOTSTRAP=true ;;
    --yes) YES=true ;;
    --json) JSON=true ;;
    --help|-h)
      usage
      echo ""
      echo "  staging       Apply pending migrations to the staging database"
      echo "  production    Apply pending migrations to the production database"
      echo "  --dry-run     Show pending migrations without applying them"
      echo "  --bootstrap   Mark all existing migration files as already applied"
      echo "  --yes         Unattended: skip the production confirm and the worktree"
      echo "                guard. A destructive migration is then REFUSED unless the"
      echo "                file carries the line: -- migrate: allow-destructive"
      echo "  --json        Print one JSON summary line on stdout; everything else"
      echo "                goes to stderr. Shape:"
      echo '                {"target":"staging","applied":["NNN_name.sql"],"pending_before":n}'
      echo ""
      exit 0
      ;;
    *) echo -e "${RED}Unknown argument: $arg${NC}" >&2; exit 1 ;;
  esac
done

# These two fire before the --json stdout/stderr split below, so they name
# stderr themselves: a workflow's `tail -1` must never read an error as JSON.
if [[ -z "$TARGET" ]]; then
  echo -e "${RED}Error: Specify a target: staging or production${NC}" >&2
  usage >&2
  exit 1
fi

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo -e "${RED}Migrations directory not found: $MIGRATIONS_DIR${NC}" >&2
  exit 2
fi

# ── Output routing ───────────────────────────────────────────
#
# Under --json the workflow reads `tail -1` of stdout, so the human-facing
# output (colors, boxes, tee'd log lines) all moves to stderr and fd 3 keeps the
# original stdout for the single summary line. Without --json fd 3 is stdout
# too and nothing changes.

exec 3>&1
if [[ "$JSON" == true ]]; then
  exec 1>&2
fi

APPLIED_NAMES=()
PENDING_BEFORE=0

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Only ever called on a successful exit. A failure path exits 1 before reaching
# it, so a missing summary line is itself the failure signal.
emit_summary() {
  [[ "$JSON" == true ]] || return 0
  local items="" f
  for f in ${APPLIED_NAMES[@]+"${APPLIED_NAMES[@]}"}; do
    items+="${items:+,}\"$(json_escape "$f")\""
  done
  printf '{"target":"%s","applied":[%s],"pending_before":%d}\n' "$TARGET" "$items" "$PENDING_BEFORE" >&3
}

# ── Load credentials ─────────────────────────────────────────
#
# A DATABASE_URL already in the environment wins and the env file is not
# touched at all: CI presets it from a secret and has no scripts/.env.<target>.

ENV_FILE="${MIGRATE_ENV_FILE:-$REPO_ROOT/scripts/.env.$TARGET}"
CRED_SOURCE="the DATABASE_URL environment variable"

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo -e "${RED}Error: Credential file not found: $ENV_FILE${NC}"
    echo ""
    echo "Create it with:"
    echo "  echo 'DATABASE_URL=postgresql://postgres.[ref]:[password]@db.[ref].supabase.co:5432/postgres' > $ENV_FILE"
    echo ""
    echo "Find the connection string in the Supabase dashboard:"
    echo "  Project Settings → Database → Connection string (URI)"
    echo ""
    echo "Or export DATABASE_URL before running."
    exit 1
  fi

  # shellcheck source=/dev/null
  source "$ENV_FILE"
  CRED_SOURCE="$ENV_FILE"

  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo -e "${RED}Error: DATABASE_URL not set in $ENV_FILE${NC}"
    exit 1
  fi
fi

# ── Worktree guard ───────────────────────────────────────────
#
# A laptop run from a feature branch applies files that are not on the branch
# the target tracks (staging -> origin/staging, production -> origin/main), and
# a later run from the tracked branch then finds the ledger ahead of its files.
# HEAD must be reachable from the tracked ref. Local-only: outside a git
# worktree nothing is checked, and a tracked ref that is not fetched (shallow CI
# clone) only warns. --yes turns the abort into a warning, as does --dry-run,
# which applies nothing.
#
# The other direction is a warning only: a checkout BEHIND the tracked ref is
# still an ancestor, and it is exactly the case where this script no-ops on
# files it cannot see. Say how far behind, then carry on.

if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ "$TARGET" == "production" ]]; then TRACKED_REF="origin/main"; else TRACKED_REF="origin/staging"; fi
  if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "$TRACKED_REF" >/dev/null 2>&1; then
    echo -e "${YELLOW}Worktree guard: $TRACKED_REF not found locally; cannot check that HEAD is on it. Continuing.${NC}"
  elif ! git -C "$REPO_ROOT" merge-base --is-ancestor HEAD "$TRACKED_REF" 2>/dev/null; then
    echo ""
    echo -e "${YELLOW}Worktree guard: HEAD is not on $TRACKED_REF.${NC}"
    echo "  This checkout carries commits the $TARGET branch does not have, so the"
    echo "  migrations applied now may not match what $TRACKED_REF will apply later."
    if [[ "$YES" == true ]]; then
      echo -e "  ${YELLOW}Continuing because --yes was given.${NC}"
      echo ""
    elif [[ "$DRY_RUN" == true ]]; then
      echo -e "  ${YELLOW}Continuing: dry run applies nothing.${NC}"
      echo ""
    else
      echo "  Check out $TRACKED_REF (or pass --yes to override)."
      echo "Aborted."
      exit 1
    fi
  elif [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$(git -C "$REPO_ROOT" rev-parse "$TRACKED_REF")" ]]; then
    BEHIND_BY="$(git -C "$REPO_ROOT" rev-list --count "HEAD..$TRACKED_REF" 2>/dev/null || echo "?")"
    if [[ "$BEHIND_BY" == "1" ]]; then BEHIND_WORD="commit"; else BEHIND_WORD="commits"; fi
    echo ""
    echo -e "${YELLOW}Worktree guard: this checkout is $BEHIND_BY $BEHIND_WORD behind $TRACKED_REF; files added since will not be applied.${NC}"
    echo ""
  fi
fi

# ── Ensure _migration_log table exists ───────────────────────

echo -e "${CYAN}Connecting to $TARGET database...${NC}"

psql "$DATABASE_URL" -q -c "
CREATE TABLE IF NOT EXISTS $LEDGER_TABLE (
  id serial PRIMARY KEY,
  migration_number text NOT NULL UNIQUE,
  filename text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text DEFAULT current_user,
  checksum text
);
" 2>&1 || {
  echo -e "${RED}Error: Could not connect to $TARGET database.${NC}"
  echo "Check $CRED_SOURCE"
  exit 1
}

echo -e "${GREEN}Connected to $TARGET.${NC}"

# ── Get applied migrations ───────────────────────────────────

# Keyed on FILENAME, not on the number prefix.
#
# The number prefix alone was a globally unique claim: whichever branch applied
# "122" first owned that number forever, and a DIFFERENT 122_*.sql merged later
# was silently treated as already-applied — the database advanced, the file
# never ran, and nothing reported it. Two commits in this repo are cleanups of
# exactly that (6ba2cfe, e5427a4), and staging currently carries a 122 whose
# file exists on no branch.
#
# The paired failure was on the write side: ON CONFLICT (migration_number)
# DO NOTHING meant a colliding migration EXECUTED but was never recorded, so it
# would run again on the next invocation.
APPLIED=$(psql "$DATABASE_URL" -t -A -c "SELECT migration_number FROM $LEDGER_TABLE ORDER BY migration_number;" 2>/dev/null || echo "")
APPLIED_FILES=$(psql "$DATABASE_URL" -t -A -c "SELECT filename FROM $LEDGER_TABLE;" 2>/dev/null || echo "")
APPLIED_PAIRS=$(psql "$DATABASE_URL" -t -A -F'|' -c "SELECT migration_number, filename FROM $LEDGER_TABLE;" 2>/dev/null || echo "")

# ── Find pending migrations ──────────────────────────────────

PENDING=()
PENDING_FILES=()
COLLISIONS=()

for file in "$MIGRATIONS_DIR"/*.sql; do
  [[ -f "$file" ]] || continue
  filename="$(basename "$file")"
  # Extract the number prefix (e.g., "001" from "001_initial_schema.sql")
  number="${filename%%_*}"

  # Already applied — matched on the exact filename.
  if echo "$APPLIED_FILES" | grep -qxF "$filename"; then
    continue
  fi

  # This number is on record under a DIFFERENT filename. Never skip silently:
  # that is the bug. Collect it and abort before applying anything.
  if echo "$APPLIED" | grep -qx "$number"; then
    applied_as="$(echo "$APPLIED_PAIRS" | grep "^${number}|" | head -1 | cut -d'|' -f2)"
    COLLISIONS+=("$number: repo has '$filename', database recorded '$applied_as'")
    continue
  fi

  PENDING+=("$number")
  PENDING_FILES+=("$file")
done

# Out-of-order warning. Collision detection above catches "this number is
# taken"; this catches the other half — a migration merging in BELOW the
# high-water mark, so it applies after migrations that were written assuming it
# already existed. Live example: 122 and 123 are absent from this branch while
# 124+ ship, so whichever lands first leaves the other to run out of sequence.
# A warning, not a failure: applying an older migration late is usually fine
# and occasionally not, and only a human knows which.
# `|| true`: on an empty ledger grep matches nothing and exits 1, which under
# pipefail fails the substitution and, under errexit, the script, before it has
# said a word. A fresh database is the one case that must not crash.
HIGHEST_APPLIED="$(echo "$APPLIED" | grep -E '^[0-9]+$' | sort -n | tail -1 || true)"
OUT_OF_ORDER=()
if [[ -n "$HIGHEST_APPLIED" ]]; then
  # ${PENDING[@]+"${PENDING[@]}"} rather than a plain "${PENDING[@]}".
  #
  # macOS still ships bash 3.2, where expanding an EMPTY array under `set -u`
  # is treated as an unset variable and aborts the script:
  #
  #   $ bash -c 'set -u; A=(); for x in "${A[@]}"; do :; done'
  #   bash: A[@]: unbound variable
  #
  # PENDING is empty on every clean run — the normal case, when the database is
  # already up to date — so this crashed with "PENDING[@]: unbound variable"
  # before it could report "no pending migrations". The failure looked like a
  # broken connection rather than a healthy no-op.
  #
  # The `+` form expands to nothing when the array is empty and to the properly
  # quoted elements otherwise. ${#PENDING[@]} is fine bare and is left alone;
  # only the iteration form is affected.
  for n in ${PENDING[@]+"${PENDING[@]}"}; do
    if [[ "$n" =~ ^[0-9]+$ ]] && (( 10#$n < 10#$HIGHEST_APPLIED )); then
      OUT_OF_ORDER+=("$n")
    fi
  done
fi

if [[ ${#OUT_OF_ORDER[@]} -gt 0 ]]; then
  echo ""
  echo -e "${YELLOW}Out-of-order migrations pending (highest applied: $HIGHEST_APPLIED):${NC}"
  for n in "${OUT_OF_ORDER[@]}"; do
    echo -e "  ${YELLOW}!${NC} $n will apply AFTER later-numbered migrations already in the database"
  done
  echo "  Check they do not depend on schema a higher-numbered migration changed."
  echo ""
fi

if [[ ${#COLLISIONS[@]} -gt 0 ]]; then
  echo ""
  echo -e "${RED}Migration number collision — refusing to continue.${NC}"
  echo ""
  for c in "${COLLISIONS[@]}"; do
    echo -e "  ${RED}✗${NC} $c"
  done
  echo ""
  echo "A number already claimed by a different file means this migration would"
  echo "never run, silently. Renumber the repo file to the next free number and"
  echo "re-run. Do NOT edit the already-applied file."
  exit 1
fi

# ── Report ───────────────────────────────────────────────────

echo ""
echo -e "${CYAN}Target:${NC}     $TARGET"
echo -e "${CYAN}Migrations:${NC} $MIGRATIONS_DIR"
# grep -c prints "0" itself and exits 1 on no match; `|| true` rather than
# `|| echo 0`, which printed the zero twice on an empty ledger.
echo -e "${CYAN}Applied:${NC}    $(echo "$APPLIED" | grep -c . || true) migrations"
echo -e "${CYAN}Pending:${NC}    ${#PENDING[@]} migrations"
echo ""

PENDING_BEFORE=${#PENDING[@]}

if [[ ${#PENDING[@]} -eq 0 ]]; then
  echo -e "${GREEN}All migrations are up to date.${NC}"
  emit_summary
  exit 0
fi

echo "Pending migrations:"
for i in "${!PENDING[@]}"; do
  echo -e "  ${YELLOW}${PENDING[$i]}${NC} — $(basename "${PENDING_FILES[$i]}")"
done
echo ""

# ── Dry run exits here ───────────────────────────────────────

if [[ "$DRY_RUN" == true ]]; then
  echo -e "${CYAN}Dry run complete. No changes applied.${NC}"
  emit_summary
  exit 0
fi

# ── Production safety gate ───────────────────────────────────
#
# After the pending list on purpose: the person typing "production" should be
# confirming the files they just read, not a blank promise. --yes skips it;
# under --yes the per-file destructive check below is the only stop.

if [[ "$TARGET" == "production" && "$BOOTSTRAP" == false && "$YES" == false ]]; then
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║  WARNING: You are targeting PRODUCTION       ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════╝${NC}"
  echo ""
  echo -n "Type 'production' to confirm: "
  read -r confirm || { echo "" ; echo "No confirmation on stdin; pass --yes for unattended runs." >&2; exit 1; }
  if [[ "$confirm" != "production" ]]; then
    echo "Aborted."
    exit 1
  fi
  echo ""
fi

# ── Bootstrap mode ───────────────────────────────────────────

if [[ "$BOOTSTRAP" == true ]]; then
  echo -e "${YELLOW}Bootstrap mode: marking all pending migrations as already applied...${NC}"
  for i in "${!PENDING[@]}"; do
    number="${PENDING[$i]}"
    filename="$(basename "${PENDING_FILES[$i]}")"
    checksum="$(md5 -q "${PENDING_FILES[$i]}" 2>/dev/null || md5sum "${PENDING_FILES[$i]}" | awk '{print $1}')"

    psql "$DATABASE_URL" -q -c "
      INSERT INTO $LEDGER_TABLE (migration_number, filename, checksum)
      VALUES ('$number', '$filename', '$checksum')
      ON CONFLICT (migration_number) DO NOTHING;
    "
    echo -e "  ${GREEN}✓${NC} $number — $filename (marked as applied)"
    APPLIED_NAMES+=("$filename")
  done
  echo ""
  echo -e "${GREEN}Bootstrap complete. ${#PENDING[@]} migrations marked as applied.${NC}"
  emit_summary
  exit 0
fi

# ── Unattended pre-flight: destructive statements ───────────
#
# Under --yes nobody can answer the per-file prompt, so the whole batch is
# scanned before anything runs and every offender is named at once. Refusing
# up front means an unattended run never applies 1..k-1 and then stops at k.
# The opt-in is the exact line "-- migrate: allow-destructive" in the file,
# where the PR reviewer saw it.

DESTRUCTIVE_RE='^\s*(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)'
ALLOW_MARKER='-- migrate: allow-destructive'

if [[ "$YES" == true ]]; then
  REFUSED=()
  for i in "${!PENDING[@]}"; do
    if grep -qiE "$DESTRUCTIVE_RE" "${PENDING_FILES[$i]}" 2>/dev/null \
      && ! grep -qxF -- "$ALLOW_MARKER" "${PENDING_FILES[$i]}"; then
      REFUSED+=("$(basename "${PENDING_FILES[$i]}")")
    fi
  done
  if [[ ${#REFUSED[@]} -gt 0 ]]; then
    echo ""
    echo -e "${RED}Refused: ${#REFUSED[@]} pending migration(s) contain destructive statements and --yes is set.${NC}"
    for f in "${REFUSED[@]}"; do
      echo -e "  ${RED}✗${NC} refused: $f"
    done
    echo ""
    echo "Add the exact line '$ALLOW_MARKER' to each file to opt in, and get it"
    echo "reviewed. Nothing was applied."
    exit 1
  fi
fi

# ── Apply migrations ─────────────────────────────────────────

mkdir -p "$LOGS_DIR"
LOG_FILE="$LOGS_DIR/migrate-${TARGET}-$(date +%Y%m%d-%H%M%S).log"

# Temp files for the wrapped path, created with an explicit template: GNU
# mktemp rejects `-t name` with no X's, and CI runs on Linux. Cleaned up on
# every exit, including the failure paths that leave STEP_LOG for diagnosis.
RUN_FILE=""
STEP_LOG=""
cleanup_tmp() { rm -f "${RUN_FILE:-}" "${STEP_LOG:-}"; }
trap cleanup_tmp EXIT

echo "Applying ${#PENDING[@]} migrations to $TARGET..." | tee "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

APPLIED_COUNT=0

for i in "${!PENDING[@]}"; do
  number="${PENDING[$i]}"
  filepath="${PENDING_FILES[$i]}"
  filename="$(basename "$filepath")"
  checksum="$(md5 -q "$filepath" 2>/dev/null || md5sum "$filepath" | awk '{print $1}')"

  echo -e "${CYAN}── $number: $filename ──${NC}" | tee -a "$LOG_FILE"

  # Check for destructive operations
  DESTRUCTIVE=$(grep -niE "$DESTRUCTIVE_RE" "$filepath" 2>/dev/null || true)
  if [[ -n "$DESTRUCTIVE" ]]; then
    echo "" | tee -a "$LOG_FILE"
    echo -e "${RED}⚠  DESTRUCTIVE OPERATIONS DETECTED:${NC}" | tee -a "$LOG_FILE"
    echo "$DESTRUCTIVE" | tee -a "$LOG_FILE"
    echo "" | tee -a "$LOG_FILE"
    if [[ "$YES" == true ]]; then
      # The pre-flight above already refused any file without the marker, so
      # reaching here means it is present; record that in the log.
      echo -e "  ${YELLOW}Allowed: $filename carries '$ALLOW_MARKER'.${NC}" | tee -a "$LOG_FILE"
    else
      echo -n "Apply this migration anyway? (yes/no): "
      read -r answer || { echo ""; echo "No confirmation on stdin; pass --yes for unattended runs." >&2; exit 1; }
      if [[ "$answer" != "yes" ]]; then
        echo "Skipped $filename. Stopping." | tee -a "$LOG_FILE"
        echo ""
        echo -e "${YELLOW}Stopped at migration $number. $APPLIED_COUNT migrations applied before this.${NC}"
        exit 1
      fi
    fi
  fi

  # Apply the migration.
  #
  # The default path wraps the file in --single-transaction and carries the
  # _migration_log INSERT inside that same transaction, so schema and ledger commit
  # together or not at all. Without the wrapper psql autocommits statement by
  # statement: on 2026-08-22 migration 175 failed part way through on production,
  # leaving two ALTER FUNCTIONs committed and no ledger row behind them.
  #
  # A claimed migration number now fails the whole transaction, so the file is NOT
  # applied - strictly better than applying it and then failing to record it.
  #
  # Two kinds of file opt out of the wrapper:
  #   1. statements that cannot run inside a transaction block at all
  #   2. files that open their own BEGIN/COMMIT - psql would already be in a
  #      transaction, and the file's COMMIT would end the outer one early, silently
  #      un-wrapping the remainder of the file
  NON_TXN=$(grep -niE 'CREATE +INDEX +CONCURRENTLY|REINDEX +CONCURRENTLY|^[[:space:]]*VACUUM|ALTER +SYSTEM|CREATE +DATABASE|DROP +DATABASE' "$filepath" 2>/dev/null || true)
  SELF_TXN=$(grep -niE '^[[:space:]]*(BEGIN|COMMIT|ROLLBACK)[[:space:]]*;' "$filepath" 2>/dev/null || true)

  LEDGER_SQL="INSERT INTO $LEDGER_TABLE (migration_number, filename, checksum) VALUES ('$number', '$filename', '$checksum');"
  APPLY_OK=false
  WRAPPED=true

  if [[ -n "$NON_TXN" || -n "$SELF_TXN" ]]; then
    WRAPPED=false
    if [[ -n "$NON_TXN" ]]; then
      echo -e "  ${YELLOW}⚠  Non-transactional statements - applying WITHOUT --single-transaction.${NC}" | tee -a "$LOG_FILE"
      echo -e "  ${YELLOW}   A failure part way through will leave this migration half applied.${NC}" | tee -a "$LOG_FILE"
      echo "$NON_TXN" | tee -a "$LOG_FILE"
    else
      echo -e "  ${CYAN}ℹ  File manages its own transaction - not wrapping it.${NC}" | tee -a "$LOG_FILE"
    fi

    if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$filepath" >> "$LOG_FILE" 2>&1; then
      psql "$DATABASE_URL" -q -c "$LEDGER_SQL" 2>/dev/null || {
        echo -e "  ${RED}⚠ APPLIED BUT NOT RECORDED:${NC} $filename"
        echo -e "  ${RED}  The SQL ran. The log insert failed (number $number already claimed).${NC}"
        echo -e "  ${RED}  Reconcile _migration_log by hand before running again, or this${NC}"
        echo -e "  ${RED}  migration will be re-applied.${NC}"
        exit 1
      }
      APPLY_OK=true
    fi
  else
    RUN_FILE="$(mktemp "${TMPDIR:-/tmp}/lf_migrate.XXXXXX")"
    cat "$filepath" > "$RUN_FILE"
    printf '\n%s\n' "$LEDGER_SQL" >> "$RUN_FILE"

    STEP_LOG="$(mktemp "${TMPDIR:-/tmp}/lf_migrate.out.XXXXXX")"
    if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$RUN_FILE" > "$STEP_LOG" 2>&1; then
      APPLY_OK=true
    fi
    cat "$STEP_LOG" >> "$LOG_FILE"
    rm -f "$RUN_FILE"
    RUN_FILE=""
  fi

  if [[ "$APPLY_OK" == true ]]; then
    echo -e "  ${GREEN}✓ Applied${NC}" | tee -a "$LOG_FILE"
    APPLIED_COUNT=$((APPLIED_COUNT + 1))
    APPLIED_NAMES+=("$filename")
    rm -f "${STEP_LOG:-}"
    STEP_LOG=""
  else
    echo -e "  ${RED}✗ FAILED${NC}" | tee -a "$LOG_FILE"
    echo ""
    if [[ "$WRAPPED" == true && -f "${STEP_LOG:-}" ]] && grep -qi "duplicate key" "$STEP_LOG" && grep -q "_migration_log" "$STEP_LOG"; then
      echo -e "${RED}Migration $number failed: number $number may already be claimed in _migration_log.${NC}"
    fi
    echo -e "${RED}Migration $number failed. Stopping.${NC}"
    if [[ "$WRAPPED" == true ]]; then
      echo -e "${GREEN}It ran inside a transaction, so nothing from it was applied.${NC}"
    else
      echo -e "${YELLOW}It ran WITHOUT a transaction - check what landed before the failure.${NC}"
    fi
    echo -e "Check the log: ${CYAN}$LOG_FILE${NC}"
    echo "$APPLIED_COUNT migrations applied before failure."
    rm -f "${STEP_LOG:-}"
    exit 1
  fi
done

echo "" | tee -a "$LOG_FILE"
echo -e "${GREEN}Done. $APPLIED_COUNT migrations applied to $TARGET.${NC}" | tee -a "$LOG_FILE"
echo -e "Log: ${CYAN}$LOG_FILE${NC}"
emit_summary
