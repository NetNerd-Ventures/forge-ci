#!/usr/bin/env node
/**
 * scripts/migrate.sh (repo root): the unattended-run behaviors.
 *
 *   node test/_test-migrate-sh.cjs
 *
 * Offline. Every case runs the real script as a child process against a stub
 * `psql` placed first on PATH. The stub answers the script's ledger queries
 * from a scripted state and records every invocation (its arguments and any -f file) to a
 * log the assertions read back, so "nothing was applied" is checked against
 * what psql was actually asked to do, not against the script's own messages.
 *
 * Each case gets its own temp git repo with the script copied into
 * `scripts/` and a fixture `supabase/migrations/`; the script runs with cwd
 * set to that repo, so REPO_ROOT and MIGRATIONS_DIR default there unless a
 * case overrides them. The repo carries an
 * `origin/staging` and `origin/main` ref so the worktree guard is exercised
 * for real: HEAD is on those refs by default, and `ahead: true` adds a commit
 * past them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate.sh');

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

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-sh-'));
process.on('exit', () => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

// ── stub psql ──────────────────────────────────────────────────────────────
//
// The script's psql calls, in order (see scripts/migrate.sh):
//   -q -c "CREATE TABLE IF NOT EXISTS _migration_log ..."   connect check
//   -t -A -c "SELECT migration_number FROM _migration_log ORDER BY ..."
//   -t -A -c "SELECT filename FROM _migration_log;"
//   -t -A -F'|' -c "SELECT migration_number, filename FROM _migration_log;"
//   -v ON_ERROR_STOP=1 --single-transaction -f <file>     apply (wrapped)
//   -v ON_ERROR_STOP=1 -f <file>                          apply (unwrapped)
//   -q -c "INSERT INTO _migration_log ..."                 ledger (unwrapped/bootstrap)
//
// LEDGER is "number|filename" lines. FAIL_FILE names a migration whose apply
// must exit 1, to prove the JSON line is withheld on failure.
const STUB = `#!/usr/bin/env bash
set -u
LOG="$PSQL_STUB_LOG"
{
  echo "--- call"
  printf 'args:'; printf ' %q' "$@"; echo
} >> "$LOG"
# Never read stdin: the real psql does not with -c or -f, and the script's
# own prompts (read -r) share that stdin.
sql=""
file=""
prev=""
for a in "$@"; do
  case "$prev" in
    -c) sql="$a" ;;
    -f) file="$a" ;;
  esac
  prev="$a"
done
if [[ -n "$sql" ]]; then
  printf 'sql: %s\\n' "$sql" >> "$LOG"
fi
if [[ -n "$file" ]]; then
  echo "file: $(basename "$file")" >> "$LOG"
  echo "file-content-begin" >> "$LOG"; cat "$file" >> "$LOG"; echo "file-content-end" >> "$LOG"
  if [[ -n "\${PSQL_STUB_FAIL_FILE:-}" ]] && grep -q "$PSQL_STUB_FAIL_FILE" "$file"; then
    echo "ERROR: stub failure for $PSQL_STUB_FAIL_FILE" >&2
    exit 1
  fi
  exit 0
fi
case "$sql" in
  *"SELECT migration_number, filename"*) printf '%s' "\${PSQL_STUB_LEDGER:-}" ;;
  *"SELECT migration_number"*) printf '%s' "\${PSQL_STUB_LEDGER:-}" | cut -d'|' -f1 ;;
  *"SELECT filename"*) printf '%s' "\${PSQL_STUB_LEDGER:-}" | cut -d'|' -f2 ;;
  *) ;;
esac
exit 0
`;
const STUB_DIR = path.join(TMP_ROOT, 'bin');
fs.mkdirSync(STUB_DIR);
fs.writeFileSync(path.join(STUB_DIR, 'psql'), STUB, { mode: 0o755 });

// ── fixture repo ───────────────────────────────────────────────────────────

let caseNo = 0;
function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * migrations: { 'NNN_name.sql': 'sql text' }
 * ledger:     ['NNN|NNN_name.sql', ...] rows already in _migration_log
 * ahead:      add a commit past origin/staging and origin/main
 */
function makeCase({ migrations = {}, ahead = false, behind = 0, noGit = false } = {}) {
  const dir = path.join(TMP_ROOT, `case-${++caseNo}`);
  const migDir = path.join(dir, 'supabase', 'migrations');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(migDir, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'migrate.sh'));
  fs.chmodSync(path.join(dir, 'scripts', 'migrate.sh'), 0o755);
  for (const [name, sql] of Object.entries(migrations)) fs.writeFileSync(path.join(migDir, name), sql);
  if (!noGit) {
    git(dir, ['init', '-q', '-b', 'work']);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'base']);
    const base = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['update-ref', 'refs/remotes/origin/staging', base]);
    git(dir, ['update-ref', 'refs/remotes/origin/main', base]);
    if (ahead) {
      fs.writeFileSync(path.join(dir, 'later.txt'), 'later');
      git(dir, ['add', '.']);
      git(dir, ['commit', '-q', '-m', 'ahead']);
    }
    // behind: the tracked refs move N commits past HEAD (HEAD stays an
    // ancestor, which is the stale-checkout case the guard must warn on).
    for (let i = 1; i <= behind; i++) {
      fs.writeFileSync(path.join(dir, `remote-${i}.txt`), String(i));
      git(dir, ['add', '.']);
      git(dir, ['commit', '-q', '-m', `remote ${i}`]);
    }
    if (behind > 0) {
      const tip = git(dir, ['rev-parse', 'HEAD']);
      git(dir, ['update-ref', 'refs/remotes/origin/staging', tip]);
      git(dir, ['update-ref', 'refs/remotes/origin/main', tip]);
      git(dir, ['reset', '-q', '--hard', base]);
    }
  }
  return dir;
}

function runMigrate(dir, args, { ledger = [], env = {}, stdin = '', failFile = '' } = {}) {
  const log = path.join(dir, 'psql.log');
  fs.writeFileSync(log, '');
  const r = spawnSync('bash', [path.join(dir, 'scripts', 'migrate.sh'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    input: stdin,
    env: {
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      HOME: process.env.HOME,
      PSQL_STUB_LOG: log,
      PSQL_STUB_LEDGER: ledger.join('\n'),
      PSQL_STUB_FAIL_FILE: failFile,
      ...env,
    },
  });
  const calls = fs.readFileSync(log, 'utf8');
  // A wrapped apply hands psql a temp copy with the ledger INSERT appended, an
  // unwrapped one sends the INSERT as its own -c; either way the filename psql
  // was asked to record is the proof of what was handed over. "Handed", not
  // "applied": a file the stub was told to fail on is still listed here.
  const handedFiles = [...calls.matchAll(/INSERT INTO _migration_log \(migration_number, filename, checksum\)\s*VALUES \('[^']*', '([^']+)'/g)].map((m) => m[1]);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, all: r.stdout + r.stderr, calls, handedFiles };
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const PLAIN = 'CREATE TABLE IF NOT EXISTS t (id int);\n';
const DROP = '-- drops the old table\nDROP TABLE old_thing;\n';
const DROP_ALLOWED = '-- migrate: allow-destructive\nDROP TABLE old_thing;\n';

// ── empty ledger ───────────────────────────────────────────────────────────

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN } });
  const r = runMigrate(dir, ['staging', '--dry-run'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, 'empty ledger: dry run exits 0 instead of crashing in the HIGHEST_APPLIED pipeline');
  ok(/Pending:\s+1 migrations/.test(strip(r.all)), 'empty ledger: reports 1 pending', strip(r.all));
  ok(/Applied:\s+0 migrations/.test(strip(r.all)), 'empty ledger: "Applied: 0 migrations" on one line', strip(r.all));
  eq(r.handedFiles, [], 'empty ledger: dry run applies nothing');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN } });
  const r = runMigrate(dir, ['staging', '--yes'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, 'empty ledger: --yes apply exits 0');
  eq(r.handedFiles, ['001_first.sql'], 'empty ledger: the one pending file was handed to psql');
  ok(/--single-transaction/.test(r.calls), 'empty ledger: plain file applied under --single-transaction');
  ok(/INSERT INTO _migration_log[\s\S]*'001_first\.sql'/.test(r.calls), 'empty ledger: ledger insert rides inside the applied file');
}

// ── --yes and destructive files ────────────────────────────────────────────

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN, '002_drop.sql': DROP, '003_after.sql': PLAIN } });
  const r = runMigrate(dir, ['staging', '--yes'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 1, '--yes refuses a destructive file without the marker (exit 1)');
  eq(r.handedFiles, [], '--yes destructive refusal is a pre-flight: nothing applied, not even the clean files before it');
  ok(/002_drop\.sql/.test(strip(r.all)) && /allow-destructive/.test(strip(r.all)), '--yes destructive refusal names the file and the marker', strip(r.all));
  ok(!/Apply this migration anyway/.test(r.all), '--yes destructive refusal does not prompt');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN, '002_drop.sql': DROP, '003_trunc.sql': 'TRUNCATE t;\n' } });
  const r = runMigrate(dir, ['staging', '--yes'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 1, '--yes pre-flight: two destructive files, exit 1');
  eq(r.handedFiles, [], '--yes pre-flight: nothing applied');
  const text = strip(r.all);
  ok(/refused: 002_drop\.sql/.test(text) && /refused: 003_trunc\.sql/.test(text), '--yes pre-flight names every offending file', text);
  ok(!/refused: 001_first\.sql/.test(text), '--yes pre-flight does not name the clean file');
}

{
  // The temp files are created with a portable mktemp template (GNU coreutils
  // rejects `-t name` with no X's), so the names psql sees carry the suffix.
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN } });
  const r = runMigrate(dir, ['staging', '--yes'], { env: { DATABASE_URL: 'postgresql://stub' } });
  const wrapped = r.calls.match(/^file: (.+)$/m);
  ok(wrapped && /^lf_migrate\.[A-Za-z0-9]+$/.test(wrapped[1]), 'wrapped apply uses a mktemp template with X placeholders', wrapped && wrapped[1]);
}

{
  const dir = makeCase({ migrations: { '001_drop.sql': DROP_ALLOWED, '002_after.sql': PLAIN } });
  const r = runMigrate(dir, ['staging', '--yes'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, '--yes accepts a destructive file carrying the marker');
  eq(r.handedFiles, ['001_drop.sql', '002_after.sql'], '--yes with marker: both files applied in order');
  ok(!/Apply this migration anyway/.test(r.all), '--yes with marker: no prompt');
}

{
  // Without --yes the interactive prompt is unchanged: "no" on stdin stops.
  const dir = makeCase({ migrations: { '001_drop.sql': DROP } });
  const r = runMigrate(dir, ['staging'], { env: { DATABASE_URL: 'postgresql://stub' }, stdin: 'no\n' });
  eq(r.status, 1, 'without --yes a destructive file still prompts and "no" stops');
  ok(/Apply this migration anyway/.test(r.all), 'without --yes the destructive prompt is shown');
  eq(r.handedFiles, [], 'without --yes and "no", nothing applied');
}

// ── production prompt ──────────────────────────────────────────────────────

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN } });
  const r = runMigrate(dir, ['production', '--yes'], { env: { DATABASE_URL: 'postgresql://stub' }, stdin: '' });
  eq(r.status, 0, 'production --yes: exits 0 with stdin closed (prompt skipped)');
  ok(!/Type 'production' to confirm/.test(r.all), 'production --yes: confirm prompt not shown');
  eq(r.handedFiles, ['001_first.sql'], 'production --yes: applied');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN, '002_second.sql': PLAIN } });
  const r = runMigrate(dir, ['production'], { env: { DATABASE_URL: 'postgresql://stub' }, stdin: 'production\n' });
  eq(r.status, 0, 'production without --yes: typing "production" proceeds');
  const text = strip(r.all);
  const listAt = text.indexOf('Pending migrations:');
  const promptAt = text.indexOf("Type 'production' to confirm");
  ok(listAt >= 0 && promptAt >= 0 && listAt < promptAt, 'production: pending list is printed before the confirm prompt', `list@${listAt} prompt@${promptAt}`);
  ok(text.indexOf('002_second.sql') < promptAt, 'production: every pending filename precedes the prompt');
  eq(r.handedFiles, ['001_first.sql', '002_second.sql'], 'production confirmed: both applied');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN } });
  const r = runMigrate(dir, ['production'], { env: { DATABASE_URL: 'postgresql://stub' }, stdin: 'nope\n' });
  eq(r.status, 1, 'production without --yes: wrong word aborts');
  eq(r.handedFiles, [], 'production aborted: nothing applied');
}

// ── DATABASE_URL precedence ────────────────────────────────────────────────

{
  const dir = makeCase({ migrations: {} });
  fs.writeFileSync(path.join(dir, 'scripts', '.env.staging'), 'DATABASE_URL=postgresql://from-file\nexport ENV_FILE_WAS_SOURCED=1\n');
  const r = runMigrate(dir, ['staging', '--dry-run'], { env: { DATABASE_URL: 'postgresql://from-env' } });
  eq(r.status, 0, 'DATABASE_URL in env: exits 0');
  ok(/args: postgresql:\/\/from-env/.test(r.calls), 'DATABASE_URL in env wins over the env file');
  ok(!/from-file/.test(r.calls), 'DATABASE_URL in env: the file value never reaches psql');
  ok(!/from-env|from-file/.test(r.all), 'DATABASE_URL is never printed');
}

{
  const dir = makeCase({ migrations: {} });
  fs.writeFileSync(path.join(dir, 'scripts', '.env.staging'), 'DATABASE_URL=postgresql://from-file\n');
  const r = runMigrate(dir, ['staging', '--dry-run']);
  eq(r.status, 0, 'no DATABASE_URL in env: the env file is sourced');
  ok(/args: postgresql:\/\/from-file/.test(r.calls), 'no DATABASE_URL in env: file value used');
}

{
  const dir = makeCase({ migrations: {} });
  const r = runMigrate(dir, ['staging', '--dry-run']);
  eq(r.status, 1, 'no DATABASE_URL and no env file: exit 1');
  ok(/Credential file not found/.test(strip(r.all)), 'no DATABASE_URL and no env file: says so');
}

{
  const dir = makeCase({ migrations: {} });
  fs.writeFileSync(path.join(dir, 'scripts', '.env.staging'), 'DATABASE_URL=postgresql://from-file\n');
  const r = runMigrate(dir, ['staging', '--dry-run'], { env: { DATABASE_URL: '' } });
  ok(/args: postgresql:\/\/from-file/.test(r.calls), 'empty DATABASE_URL in env counts as unset');
}

// ── --json ─────────────────────────────────────────────────────────────────

function lastJson(r) {
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  let parsed = null;
  try { parsed = JSON.parse(lines[lines.length - 1]); } catch { parsed = `not JSON: ${lines[lines.length - 1]}`; }
  return { lines, parsed };
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN, '002_second.sql': PLAIN, '003_third.sql': PLAIN } });
  const r = runMigrate(dir, ['staging', '--yes', '--json'], { ledger: ['001|001_first.sql'], env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, '--json apply: exit 0');
  const { lines, parsed } = lastJson(r);
  eq(lines.length, 1, '--json: stdout is exactly one line');
  eq(parsed, { target: 'staging', applied: ['002_second.sql', '003_third.sql'], pending_before: 2 }, '--json apply summary shape');
  ok(/Applying 2 migrations/.test(strip(r.stderr)), '--json: the human output moved to stderr', strip(r.stderr));
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN, '002_second.sql': PLAIN } });
  const r = runMigrate(dir, ['staging', '--dry-run', '--json'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, '--json dry run: exit 0');
  eq(lastJson(r).parsed, { target: 'staging', applied: [], pending_before: 2 }, '--json dry run: applied [] and pending_before counts what would apply');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN } });
  const r = runMigrate(dir, ['production', '--yes', '--json'], { ledger: ['001|001_first.sql'], env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, '--json up to date: exit 0');
  eq(lastJson(r).parsed, { target: 'production', applied: [], pending_before: 0 }, '--json up to date: empty summary');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN, '002_bad.sql': 'ALTER TABLE nope ADD COLUMN x int;\n', '003_after.sql': PLAIN } });
  const r = runMigrate(dir, ['staging', '--yes', '--json'], { env: { DATABASE_URL: 'postgresql://stub' }, failFile: 'nope' });
  eq(r.status, 1, '--json: a psql failure exits non-zero');
  eq(r.stdout, '', '--json: no summary line on failure');
  eq(r.handedFiles, ['001_first.sql', '002_bad.sql'], '--json failure: stops at the failed file');
}

{
  const dir = makeCase({ migrations: { '001_drop.sql': DROP } });
  const r = runMigrate(dir, ['staging', '--yes', '--json'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 1, '--json: destructive refusal exits non-zero');
  eq(r.stdout, '', '--json: no summary line on destructive refusal');
}

// ── worktree guard ─────────────────────────────────────────────────────────

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN }, ahead: true });
  const r = runMigrate(dir, ['staging'], { env: { DATABASE_URL: 'postgresql://stub' }, stdin: '' });
  eq(r.status, 1, 'worktree guard: HEAD ahead of origin/staging without --yes aborts');
  ok(/origin\/staging/.test(strip(r.all)), 'worktree guard: warning names origin/staging', strip(r.all));
  eq(r.handedFiles, [], 'worktree guard abort: nothing applied');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN }, ahead: true });
  const r = runMigrate(dir, ['staging', '--yes'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, 'worktree guard: --yes continues');
  ok(/origin\/staging/.test(strip(r.all)), 'worktree guard: still warns under --yes');
  eq(r.handedFiles, ['001_first.sql'], 'worktree guard --yes: applied');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN }, ahead: true });
  const r = runMigrate(dir, ['production'], { env: { DATABASE_URL: 'postgresql://stub' }, stdin: 'production\n' });
  eq(r.status, 1, 'worktree guard: production compares against origin/main');
  ok(/origin\/main/.test(strip(r.all)), 'worktree guard: warning names origin/main');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN } });
  const r = runMigrate(dir, ['staging'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, 'worktree guard: HEAD on origin/staging passes without --yes');
  eq(r.handedFiles, ['001_first.sql'], 'worktree guard pass: applied');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN } });
  git(dir, ['update-ref', '-d', 'refs/remotes/origin/staging']);
  const r = runMigrate(dir, ['staging'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, 'worktree guard: missing origin/staging ref warns and continues');
  ok(/origin\/staging/.test(strip(r.all)) && /not found|missing|unavailable/i.test(strip(r.all)), 'worktree guard: missing ref message', strip(r.all));
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN } });
  const r = runMigrate(dir, ['staging'], { env: { DATABASE_URL: 'postgresql://stub', MIGRATE_TRACKED_REF: 'origin/custom' } });
  eq(r.status, 0, 'worktree guard: MIGRATE_TRACKED_REF overrides the default and warns/continues when unresolvable');
  ok(/origin\/custom/.test(strip(r.all)) && /not found locally/i.test(strip(r.all)), 'worktree guard: missing-ref message names the MIGRATE_TRACKED_REF override', strip(r.all));
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN }, noGit: true });
  const r = runMigrate(dir, ['staging'], { env: { DATABASE_URL: 'postgresql://stub', GIT_CEILING_DIRECTORIES: TMP_ROOT } });
  eq(r.status, 0, 'worktree guard: outside a git worktree the guard is skipped');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN }, behind: 2 });
  const r = runMigrate(dir, ['staging'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, 'worktree guard: a checkout behind origin/staging warns but continues without --yes');
  ok(/2 commits behind origin\/staging/.test(strip(r.all)), 'worktree guard: behind warning counts the commits', strip(r.all));
  eq(r.handedFiles, ['001_first.sql'], 'worktree guard behind: applied');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN }, behind: 1 });
  const r = runMigrate(dir, ['staging', '--yes'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, 'worktree guard: behind with --yes exits 0');
  ok(/1 commit behind origin\/staging/.test(strip(r.all)), 'worktree guard: behind warning shown under --yes');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN }, behind: 3 });
  const r = runMigrate(dir, ['staging', '--dry-run'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, 'worktree guard: behind warning under --dry-run exits 0');
  ok(/3 commits behind origin\/staging/.test(strip(r.all)), 'worktree guard: behind warning shown under --dry-run');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN }, ahead: true });
  const r = runMigrate(dir, ['staging', '--dry-run'], { env: { DATABASE_URL: 'postgresql://stub' } });
  eq(r.status, 0, 'worktree guard: ahead under --dry-run warns only');
  ok(/HEAD is not on origin\/staging/.test(strip(r.all)), 'worktree guard: ahead warning shown under --dry-run');
}

// ── bad arguments ──────────────────────────────────────────────────────────

{
  const dir = makeCase();
  const r = runMigrate(dir, ['staging', '--json', '--bogus']);
  eq(r.status, 1, 'unknown argument exits 1');
  eq(r.stdout, '', 'unknown argument under --json: stdout stays empty');
  ok(/Unknown argument: --bogus/.test(strip(r.stderr)), 'unknown argument reported on stderr');
}

{
  const dir = makeCase();
  const r = runMigrate(dir, ['--json']);
  eq(r.status, 1, 'missing target exits 1');
  eq(r.stdout, '', 'missing target under --json: stdout stays empty');
  ok(/Specify a target/.test(strip(r.stderr)), 'missing target reported on stderr');
}

{
  const dir = makeCase({ migrations: { '001_first.sql': PLAIN } });
  const r = runMigrate(dir, ['production'], { env: { DATABASE_URL: 'postgresql://stub' }, stdin: '' });
  eq(r.status, 1, 'production confirm with stdin closed exits 1');
  ok(/No confirmation on stdin/.test(strip(r.all)) && /--yes/.test(strip(r.all)), 'production confirm with stdin closed points at --yes', strip(r.all));
  eq(r.handedFiles, [], 'production confirm with stdin closed: nothing applied');
}

{
  const dir = makeCase({ migrations: { '001_drop.sql': DROP } });
  const r = runMigrate(dir, ['staging'], { env: { DATABASE_URL: 'postgresql://stub' }, stdin: '' });
  eq(r.status, 1, 'destructive confirm with stdin closed exits 1');
  ok(/No confirmation on stdin/.test(strip(r.all)), 'destructive confirm with stdin closed says so');
}

// ── help text ──────────────────────────────────────────────────────────────

{
  const dir = makeCase();
  const r = runMigrate(dir, ['--help']);
  eq(r.status, 0, '--help exits 0');
  ok(/--yes/.test(r.stdout) && /--json/.test(r.stdout), '--help documents --yes and --json');
}

// ── forge-ci: paths come from the environment, never from the script location ─

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-env-'));
  fs.mkdirSync(path.join(root, 'db', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db', 'migrations', '001_init.sql'), 'select 1;');
  const log = path.join(root, 'psql.log');
  fs.writeFileSync(log, '');
  const r = spawnSync('bash', [SCRIPT, 'staging', '--dry-run', '--json'], {
    encoding: 'utf8',
    env: {
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      HOME: process.env.HOME,
      PSQL_STUB_LOG: log,
      PSQL_STUB_LEDGER: '',
      REPO_ROOT: root,
      MIGRATIONS_DIR: 'db/migrations',
      DATABASE_URL: 'postgres://x',
    },
  });
  // migrate.sh does `exec 1>&2`: human output goes to stderr, the JSON line to fd 3 -> stdout.
  ok(r.status === 0 && r.stdout.includes('"pending_before":1'), 'MIGRATIONS_DIR is honoured (dry-run JSON reports one pending)', `status=${r.status}\n      stdout=${r.stdout}\n      stderr=${r.stderr}`);
  ok(r.stderr.includes('001_init.sql'), 'MIGRATIONS_DIR is honoured (pending file named on stderr)', r.stderr);
}
{
  // A quoted / prefixed value is the classic secret-paste mistake; psql would silently use the local socket.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-shape-'));
  fs.mkdirSync(path.join(root, 'supabase', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'supabase', 'migrations', '001_init.sql'), 'select 1;');
  const r = spawnSync('bash', [SCRIPT, 'staging', '--dry-run'], {
    env: { ...process.env, REPO_ROOT: root, DATABASE_URL: '"postgresql://x"', PATH: process.env.PATH },
    encoding: 'utf8',
  });
  ok(r.status === 1 && r.stderr.includes('does not look like a connection URI'), 'non-URI DATABASE_URL is rejected with a clear message', `status=${r.status}\n      stderr=${r.stderr}`);
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-missing-'));
  const r = spawnSync('bash', [SCRIPT, 'staging', '--dry-run'], {
    encoding: 'utf8',
    env: {
      PATH: `${STUB_DIR}:${process.env.PATH}`,
      HOME: process.env.HOME,
      REPO_ROOT: root,
      DATABASE_URL: 'postgres://x',
    },
  });
  eq(r.status, 2, 'missing migrations dir exits 2');
  ok(r.stderr.includes('Migrations directory not found'), 'missing migrations dir names the path', r.stderr);
}

if (fail.length) {
  console.error(`\n${fail.length} FAILED:\n  - ${fail.join('\n  - ')}\n`);
  console.log(`${pass} passed, ${fail.length} failed`);
  process.exit(1);
}
console.log(`${pass} passed, 0 failed`);
