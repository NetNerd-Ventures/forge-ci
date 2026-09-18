#!/usr/bin/env node
/**
 * Migration drift guard.
 *
 * This exists because migration drift is this platform's most repeated failure,
 * and every instance was silent:
 *
 *   - Two files claimed 048. migrate.sh fails closed, so the production queue
 *     froze and nothing errored until someone ran it by hand weeks later.
 *   - 138 was committed but never applied to production, so the SEO agent's
 *     Apply button returned 422 on that page for as long as it sat there.
 *   - 139_ga4_page_totals and 140_form_submissions_attribution were applied to
 *     staging via an inline apply_migration call and never written to a file.
 *     The database moved forward; the repo did not; production could not
 *     follow, because there was nothing to apply.
 *
 * None of those produced a failing build or a red test. All three would have
 * been caught here in under a second.
 *
 * Offline checks need no credentials and are the PR gate. The database
 * reconciliation is opt-in (--check-db) because it needs a connection string.
 * It reads the one ledger, `_migration_log`, which scripts/migrate.sh owns on
 * both staging and production:
 *
 *   - orphan: a ledger row with no file in the repo. Always an error; the
 *     other environment can never catch up.
 *   - unapplied: a file with no ledger row. A warning by default (a branch
 *     ahead of the database is normal); an error under --strict, which
 *     migrate.yml uses right after applying, when "unapplied" means the
 *     apply did not do its job.
 *
 *   node scripts/check-migration-drift.cjs
 *   node scripts/check-migration-drift.cjs --check-db            # needs DATABASE_URL + psql
 *   node scripts/check-migration-drift.cjs --check-db --strict   # post-apply verification
 *
 * Environment:
 *   REPO_ROOT             Consumer repo root (default: process.cwd())
 *   MIGRATIONS_DIR         Migrations dir, relative to REPO_ROOT (default: supabase/migrations)
 *   MIGRATION_LEDGER_TABLE Ledger table name (default: _migration_log)
 *
 * The --check-db summary line always has the shape "N orphans, M unapplied"
 * so a workflow can grep it. Exit 2 if the migrations directory is missing.
 * Exit 1 on any other error. Warnings alone exit 0.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const MIGRATIONS_DIR = path.join(REPO_ROOT, process.env.MIGRATIONS_DIR || 'supabase/migrations');
const LEDGER_TABLE = process.env.MIGRATION_LEDGER_TABLE || '_migration_log';
const FILENAME_RE = /^(\d{3,})([a-z]?)_([a-z0-9_]+)\.sql$/;

const errors = [];
const warnings = [];

const CHECK_DB = process.argv.includes('--check-db');
const STRICT = process.argv.includes('--strict');
const LEDGER_QUERY = `select filename from ${LEDGER_TABLE} order by migration_number`;

const usage = () => {
  console.error('Usage: node scripts/check-migration-drift.cjs [--check-db [--strict]]');
  console.error('  --check-db   reconcile the files against _migration_log (needs DATABASE_URL + psql)');
  console.error('  --strict     with --check-db: an unapplied file is an error, not a warning');
};

for (const arg of process.argv.slice(2)) {
  if (arg !== '--check-db' && arg !== '--strict') {
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }
}
if (STRICT && !CHECK_DB) {
  console.error('--strict only makes sense with --check-db.');
  usage();
  process.exit(1);
}

// ── Load ────────────────────────────────────────────────────
if (!fs.existsSync(MIGRATIONS_DIR)) {
  console.error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  process.exit(2);
}

const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

if (files.length === 0) {
  console.error('No migration files found; refusing to report a clean run.');
  process.exit(1);
}

// ── 1. Filename shape ───────────────────────────────────────
// migrate.sh applies in filename order, so a file that does not sort with the
// others applies at the wrong time.
const parsed = [];
for (const file of files) {
  const m = FILENAME_RE.exec(file);
  if (!m) {
    errors.push(`Bad filename: ${file}: expected NNN_lower_snake_case.sql`);
    continue;
  }
  parsed.push({ file, num: parseInt(m[1], 10), suffix: m[2], name: m[3] });
}

// ── 2. Duplicate numbers ────────────────────────────────────
// The 048 case. A trailing letter (101b) is an intentional follow-up to the
// same number and is allowed; two bare NNN files are not.
const byNumber = new Map();
for (const p of parsed) {
  if (!byNumber.has(p.num)) byNumber.set(p.num, []);
  byNumber.get(p.num).push(p);
}
for (const [num, group] of [...byNumber].sort((a, b) => a[0] - b[0])) {
  const bare = group.filter((g) => g.suffix === '');
  if (bare.length > 1) {
    errors.push(
      `Duplicate migration number ${String(num).padStart(3, '0')}: ${bare.map((g) => g.file).join(', ')}\n` +
        `    Renumber all but one to the next free number (${maxNum(parsed) + 1}).`,
    );
  }
}

// ── 3. Gaps ─────────────────────────────────────────────────
// A gap is how an orphan announces itself: someone claimed the number in the
// database without leaving a file behind. Not always a bug (a number can be
// abandoned), so this warns rather than fails.
const nums = [...byNumber.keys()].sort((a, b) => a - b);
const gaps = [];
for (let n = nums[0]; n < nums[nums.length - 1]; n++) {
  if (!byNumber.has(n)) gaps.push(String(n).padStart(3, '0'));
}
if (gaps.length > 0) {
  warnings.push(
    `Gaps in the sequence: ${gaps.join(', ')}\n` +
      `    If a gap was applied to a database, it is an orphan: --check-db lists it.\n` +
      `    Recover the SQL (the ledger holds no statements; use the schema itself)\n` +
      `    and commit it as a file under that number.`,
  );
}

// ── 4. Database reconciliation (opt-in) ─────────────────────
//
// One ledger: _migration_log, written by scripts/migrate.sh on every apply
// and by `migrate.sh <target> --bootstrap` once per environment. Matched on
// the exact filename, the same key migrate.sh uses, so a renamed file under
// an applied number shows up as one orphan plus one unapplied file rather
// than disappearing.
let ledger = null; // { orphans: [...], unapplied: [...] } once the query ran
if (CHECK_DB) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    errors.push('--check-db given but DATABASE_URL is not set.');
  } else {
    try {
      const out = execFileSync('psql', [dbUrl, '-At', '-c', LEDGER_QUERY], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const applied = out.split('\n').map((s) => s.trim()).filter(Boolean);
      const fileNames = new Set(parsed.map((p) => p.file));
      const appliedSet = new Set(applied);

      const orphans = applied.filter((a) => !fileNames.has(a));
      const unapplied = parsed.map((p) => p.file).filter((f) => !appliedSet.has(f));
      ledger = { orphans, unapplied };

      if (orphans.length > 0) {
        errors.push(
          `In ${LEDGER_TABLE} with no file in the repo (orphans):\n` +
            orphans.map((o) => `      ${o}`).join('\n') +
            `\n    The other environment can never catch up to these. Either commit the\n` +
            `    SQL as a file with exactly that name, or delete the row if the change\n` +
            `    was reverted by hand:\n` +
            `      delete from ${LEDGER_TABLE} where filename = '<filename>';`,
        );
      }

      if (unapplied.length > 0) {
        const msg =
          `In the repo but not in ${LEDGER_TABLE} (unapplied):\n` +
            unapplied.map((f) => `      ${f}`).join('\n') +
            (STRICT
              ? `\n    --strict: the apply that ran before this check did not record these.\n` +
                `    Read the migrate.yml log for the failing file; do not re-run by hand\n` +
                `    until the cause is known.`
              : `\n    Expected on a branch ahead of this database. If the database is the\n` +
                `    one that is behind, migrate.yml applies these on merge.`);
        (STRICT ? errors : warnings).push(msg);
      }
    } catch (err) {
      errors.push(`Database check failed: ${err.message.split('\n')[0]}`);
    }
  }
}

// ── Report ──────────────────────────────────────────────────
function maxNum(list) {
  return list.reduce((m, p) => Math.max(m, p.num), 0);
}

console.log(`Checked ${parsed.length} migration files (highest number: ${maxNum(parsed)}).`);
if (ledger) {
  console.log(`Ledger ${LEDGER_TABLE}: ${ledger.orphans.length} orphans, ${ledger.unapplied.length} unapplied.`);
}

for (const w of warnings) console.log(`\n  WARN  ${w}`);
for (const e of errors) console.log(`\n  FAIL  ${e}`);

if (errors.length > 0) {
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}
console.log(
  warnings.length > 0
    ? `\nNo errors, ${warnings.length} warning(s).`
    : `\nNo drift detected.`,
);
