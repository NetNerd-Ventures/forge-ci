# Changelog

## 1.1.4 — 2026-09-21
- `gates / gitleaks`: prints each finding (rule, file, commit, fingerprint) with the secret value redacted; previously a red gate said only `leaks found: N`.

## 1.1.3 — 2026-09-20
- `check-migration-drift.cjs`: no gap scan for timestamp-numbered migrations (Supabase CLI `YYYYMMDDHHMMSS_name.sql`); it previously tried to enumerate ~1e13 gaps and crashed with `RangeError: Invalid string length`.

## 1.1.2 — 2026-09-20
- `migrate.sh`: rejects a `DATABASE_URL` that is not a `postgresql://` URI (quoted or prefixed secret values) instead of letting psql fall back to the local socket.

## 1.1.1 — 2026-09-20
- `apply-rulesets.sh --no-merge-queue`: private repos on non-Enterprise plans; single-tier without a queue drops the approval requirement (solo humans cannot approve their own PRs).

## 1.1.0 — 2026-09-19
- `gates.yml`: pnpm support (pnpm/action-setup pinned, frozen lockfile, pnpm cache).
- `migrate.yml`: workflow_dispatch bootstrap=true seeds _migration_log via migrate.sh --bootstrap.

## 1.0.0 — 2026-09-18
- `gates.yml`: typecheck, unit tests, migration drift check, gitleaks and actionlint as `gates / <job>` check runs.
- `open-pr.yml`: opens/refreshes the feature-branch→integration-branch PR and manages draft/auto-merge state.
- `cross-model-review.yml`: posts one sticky PR comment from a vendor that did not write the change; required in two-tier, advisory in single-tier.
- `migrate.yml`: applies pending Supabase migrations and updates the ledger, reading environment-scoped `DATABASE_URL` via `secrets: inherit`.
- `deploy-status.yml`: waits for the matching Vercel deployment per project and opens/closes a failure issue.
- `promote.yml`: opens the staging→production PR (two-tier only).
- `scripts/apply-rulesets.sh`: renders and applies branch rulesets for two-tier and single-tier modes, idempotently.
- `scripts/check-migration-drift.cjs`, `scripts/migrate.sh`, `scripts/cross-model-review.mjs`, `scripts/wait-for-vercel-deploy.cjs`: the scripts the workflows above run.
- `rulesets/integration.json`, `rulesets/production.json`: branch ruleset templates.
- `test/fixtures/consumer-two-tier/`, `test/fixtures/consumer-single-tier/`: canonical caller examples for both modes, linted by `test/run.sh` and actionlint on every push.
- `test/test_hygiene.sh`: extraction hygiene checks (no source-project leftovers, both fixture modes present, no event data inside `run:` blocks).
- Extracted from LolliForce `andy/pipeline` (2026-09-18).
