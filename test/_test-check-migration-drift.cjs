#!/usr/bin/env node
/**
 * scripts/check-migration-drift.cjs (repo root): the --check-db ledger
 * reconciliation.
 *
 *   node test/_test-check-migration-drift.cjs
 *
 * Offline. Every case runs the real script as a child process against a stub
 * `psql` placed first on PATH, the same pattern as _test-migrate-sh.cjs. The
 * stub answers the ledger query from a scripted state and records the SQL it
 * was asked to run, so "it read _migration_log" is checked against what psql
 * was actually handed, not against the script's own messages.
 *
 * Each case gets its own temp dir with the script copied into `scripts/` and
 * a fixture `supabase/migrations/`, because the script derives the migrations
 * dir from REPO_ROOT (default: its cwd) plus MIGRATIONS_DIR. The offline
 * checks (filename shape, duplicates, gaps) are covered by `npm run
 * check:migrations` on the real tree; the fixtures here are kept gap-free so
 * only the ledger checks speak.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-migration-drift.cjs');

let pass = 0;
const fail = [];
const ok = (cond, label, detail) => {
  if (cond) pass++;
  else fail.push(`${label}${detail === undefined ? '' : `\n      ${detail}`}`);
};
const eq = (got, exp, label) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) pass++;
  else fail.push(`${label}\n      got ${g}\n      exp ${e}`);
};

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'check-drift-'));
process.on('exit', () => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

// ── stub psql ──────────────────────────────────────────────────────────────
//
// PSQL_STUB_LEDGER is one filename per line, the exact `filename` column of
// _migration_log. PSQL_STUB_FAIL makes every call exit 2 with an error on
// stderr, the way a bad connection string does.
const STUB = `#!/usr/bin/env bash
set -u
LOG="$PSQL_STUB_LOG"
{
  echo "--- call"
  printf 'args:'; printf ' %q' "$@"; echo
} >> "$LOG"
sql=""
prev=""
for a in "$@"; do
  [[ "$prev" == "-c" ]] && sql="$a"
  prev="$a"
done
printf 'sql: %s\\n' "$sql" >> "$LOG"
if [[ -n "\${PSQL_STUB_FAIL:-}" ]]; then
  echo "psql: error: connection to server failed: stub" >&2
  exit 2
fi
case "$sql" in
  *"from _migration_log"*) printf '%s\\n' "\${PSQL_STUB_LEDGER:-}" ;;
  *) echo "stub: unexpected query: $sql" >&2; exit 3 ;;
esac
exit 0
`;
const STUB_DIR = path.join(TMP_ROOT, 'bin');
fs.mkdirSync(STUB_DIR);
fs.writeFileSync(path.join(STUB_DIR, 'psql'), STUB, { mode: 0o755 });

// ── fixture tree ───────────────────────────────────────────────────────────

let caseNo = 0;
function makeCase(migrations) {
  const dir = path.join(TMP_ROOT, `case-${++caseNo}`);
  const migDir = path.join(dir, 'supabase', 'migrations');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(migDir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-migration-drift.cjs'));
  for (const name of migrations) fs.writeFileSync(path.join(migDir, name), 'select 1;\n');
  return dir;
}

function run(dir, args, { ledger = [], env = {}, failPsql = false } = {}) {
  const log = path.join(dir, 'psql.log');
  fs.writeFileSync(log, '');
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-migration-drift.cjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    // DATABASE_URL is deliberately absent unless a case sets it.
    env: {
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      HOME: process.env.HOME,
      PSQL_STUB_LOG: log,
      PSQL_STUB_LEDGER: ledger.join('\n'),
      PSQL_STUB_FAIL: failPsql ? '1' : '',
      ...env,
    },
  });
  const calls = fs.readFileSync(log, 'utf8');
  return { status: r.status, all: r.stdout + r.stderr, calls };
}

const FILES = ['001_first.sql', '002_second.sql', '003_third.sql'];
const DB = { DATABASE_URL: 'postgresql://stub' };

// ── all applied ────────────────────────────────────────────────────────────

{
  const dir = makeCase(FILES);
  const r = run(dir, ['--check-db'], { ledger: FILES, env: DB });
  eq(r.status, 0, 'all applied: exits 0');
  ok(/0 orphans, 0 unapplied/.test(r.all), 'all applied: summary says "0 orphans, 0 unapplied"', r.all);
  ok(/select filename from _migration_log order by migration_number/i.test(r.calls), 'all applied: psql was asked for _migration_log filenames', r.calls);
  ok(!/schema_migrations/.test(r.calls), 'all applied: psql was not asked about supabase_migrations.schema_migrations');
  ok(!/WARN|FAIL/.test(r.all), 'all applied: no warnings or failures', r.all);
}

{
  const dir = makeCase(FILES);
  const r = run(dir, ['--check-db', '--strict'], { ledger: FILES, env: DB });
  eq(r.status, 0, 'all applied under --strict: exits 0');
  ok(/0 orphans, 0 unapplied/.test(r.all), 'all applied under --strict: summary says "0 orphans, 0 unapplied"', r.all);
}

// ── orphan: a ledger row with no file ──────────────────────────────────────

{
  const dir = makeCase(FILES);
  const r = run(dir, ['--check-db'], { ledger: [...FILES, '004_only_in_db.sql'], env: DB });
  eq(r.status, 1, 'orphan: exits 1 without --strict');
  ok(/FAIL[^]*004_only_in_db\.sql/.test(r.all), 'orphan: named under FAIL', r.all);
  ok(/1 orphans, 0 unapplied/.test(r.all), 'orphan: summary says "1 orphans, 0 unapplied"', r.all);
  ok(!/schema_migrations/.test(r.all), 'orphan: remediation hint no longer points at schema_migrations', r.all);
}

// ── unapplied: a file with no ledger row ───────────────────────────────────

{
  const dir = makeCase(FILES);
  const r = run(dir, ['--check-db'], { ledger: FILES.slice(0, 2), env: DB });
  eq(r.status, 0, 'unapplied without --strict: exits 0');
  ok(/WARN[^]*003_third\.sql/.test(r.all), 'unapplied without --strict: named under WARN', r.all);
  ok(!/FAIL/.test(r.all), 'unapplied without --strict: no FAIL line', r.all);
  ok(/0 orphans, 1 unapplied/.test(r.all), 'unapplied without --strict: summary says "0 orphans, 1 unapplied"', r.all);
}

{
  const dir = makeCase(FILES);
  const r = run(dir, ['--check-db', '--strict'], { ledger: FILES.slice(0, 2), env: DB });
  eq(r.status, 1, 'unapplied with --strict: exits 1');
  ok(/FAIL[^]*003_third\.sql/.test(r.all), 'unapplied with --strict: named under FAIL', r.all);
  ok(/0 orphans, 1 unapplied/.test(r.all), 'unapplied with --strict: summary says "0 orphans, 1 unapplied"', r.all);
}

// ── an orphan and an unapplied file together ───────────────────────────────

{
  const dir = makeCase(FILES);
  const r = run(dir, ['--check-db'], { ledger: ['001_first.sql', '002_second.sql', '009_ghost.sql'], env: DB });
  eq(r.status, 1, 'orphan + unapplied: exits 1');
  ok(/1 orphans, 1 unapplied/.test(r.all), 'orphan + unapplied: summary says "1 orphans, 1 unapplied"', r.all);
}

// ── --check-db without DATABASE_URL ────────────────────────────────────────

{
  const dir = makeCase(FILES);
  const r = run(dir, ['--check-db']);
  eq(r.status, 1, 'no DATABASE_URL: exits 1');
  ok(/FAIL[^]*DATABASE_URL/.test(r.all), 'no DATABASE_URL: FAIL names the variable', r.all);
  ok(!/--- call/.test(r.calls), 'no DATABASE_URL: psql never invoked');
  ok(!/0 orphans, 0 unapplied/.test(r.all), 'no DATABASE_URL: does not claim a clean ledger', r.all);
}

// ── psql itself fails ──────────────────────────────────────────────────────
//
// A dead connection must be an error, never "0 orphans, 0 unapplied".

{
  const dir = makeCase(FILES);
  const r = run(dir, ['--check-db', '--strict'], { ledger: FILES, env: DB, failPsql: true });
  eq(r.status, 1, 'psql failure: exits 1');
  ok(/FAIL[^]*Database check failed/.test(r.all), 'psql failure: reported as FAIL', r.all);
  ok(!/0 orphans, 0 unapplied/.test(r.all), 'psql failure: does not claim a clean ledger', r.all);
}

// ── --strict without --check-db is a usage error ───────────────────────────

{
  const dir = makeCase(FILES);
  const r = run(dir, ['--strict']);
  eq(r.status, 1, '--strict alone: exits 1');
  ok(/--strict[^]*--check-db/.test(r.all), '--strict alone: says it needs --check-db', r.all);
}

// ── unknown argument is a usage error ──────────────────────────────────────

{
  const dir = makeCase(FILES);
  const r = run(dir, ['--check-database'], { env: DB });
  eq(r.status, 1, 'unknown argument: exits 1');
  ok(/Unknown argument: --check-database/.test(r.all), 'unknown argument: named in the error', r.all);
  ok(!/--- call/.test(r.calls), 'unknown argument: psql never invoked');
}

// ── offline run still says nothing about the ledger ────────────────────────

{
  const dir = makeCase(FILES);
  const r = run(dir, []);
  eq(r.status, 0, 'offline: exits 0');
  ok(!/orphans/.test(r.all), 'offline: no ledger summary without --check-db', r.all);
  ok(!/--- call/.test(r.calls), 'offline: psql never invoked');
}

// ── forge-ci: env-driven paths ──────────────────────────────────────────────

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-env-'));
  fs.mkdirSync(path.join(root, 'db', 'mig'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db', 'mig', '001_a.sql'), '');
  fs.writeFileSync(path.join(root, 'db', 'mig', '002_b.sql'), '');
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, REPO_ROOT: root, MIGRATIONS_DIR: 'db/mig' }, encoding: 'utf8' });
  ok(r.status === 0 && r.stdout.includes('2'), 'MIGRATIONS_DIR honoured: two files, no drift', `status=${r.status}\n      stdout=${r.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-missing-'));
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, REPO_ROOT: root }, encoding: 'utf8' });
  ok(r.status === 2 && r.stderr.includes('Migrations directory not found'), 'missing dir exits 2', `status=${r.status}\n      stderr=${r.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
}

if (fail.length) {
  console.error(`\n${fail.length} FAILED:\n  - ${fail.join('\n  - ')}\n`);
  console.log(`${pass} passed, ${fail.length} failed`);
  process.exit(1);
}
console.log(`${pass} passed, 0 failed`);
