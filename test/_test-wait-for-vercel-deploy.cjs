#!/usr/bin/env node
/**
 * scripts/wait-for-vercel-deploy.cjs (repo root): the pure parts.
 *
 *   node test/_test-wait-for-vercel-deploy.cjs
 *
 * Mostly offline: no network. The script exports its pure functions when
 * required as a module (arg parsing, query building, deployment
 * classification and the decision table); the poll loop is a thin shell
 * around them and is covered by the live gate in the consumer's workflow.
 * `makeDiffEmpty` is exercised against a real throwaway git repo below,
 * because the ignored-build decision has to diff the exact `--paths` the
 * caller passes inside `REPO_ROOT`, not the script's own directory.
 *
 * The fixtures mirror the v6 /deployments shape observed on 2026-09-18 with a
 * real call: `deployments[]` with `state`, `readyState`, `url`, `inspectorUrl`,
 * `createdAt`, `errorMessage`, `meta.githubCommitSha` and `target` (the
 * string "production" on main, null on staging, never "preview"). Two facts
 * shaped the decision table: an ignoreCommand skip is NOT "no deployment"
 * (Vercel records a CANCELED deployment whose errorMessage names the Ignored
 * Build Step, so a plain "CANCELED is red" rule would fail every push that
 * leaves one app untouched), and therefore "no record at all" is never an
 * expected skip and is never green.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'wait-for-vercel-deploy.cjs');
const mod = require(SCRIPT);
const {
  parseArgs, buildQuery, classifyDeployments, decide, isTransientStatus, recordMatchesTarget,
  IGNORED_BUILD_STEP_MESSAGE, IGNORED_BUILD_STEP_RE,
} = mod;

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
const throws = (fn, re, label) => {
  try { fn(); fail.push(`${label}\n      did not throw`); }
  catch (err) { if (re.test(err.message)) pass++; else fail.push(`${label}\n      threw ${err.message}`); }
};

const SHA = 'df2020b4964c37de7029918e87265fa68485c65d';
const OTHER = '9b985469ae3a02d55910504aa7f42c4ee94fd367';
const PROJECT_ID = 'prj_test';
const TEAM_ID = 'team_test';

// ── parseArgs ──────────────────────────────────────────────────────────────

const BASE_ARGS = ['--sha', SHA, '--project-id', PROJECT_ID, '--team-id', TEAM_ID, '--target', 'preview', '--paths', 'apps/web/,package.json'];
eq(parseArgs(BASE_ARGS),
  { sha: SHA, projectId: PROJECT_ID, teamId: TEAM_ID, target: 'preview', timeoutMin: 20, graceMin: 3, base: null, paths: ['apps/web/', 'package.json'] },
  'defaults: 20 min timeout, 3 min grace, no base');
eq(parseArgs(['--sha', SHA, '--project-id', PROJECT_ID, '--team-id', TEAM_ID, '--target', 'production', '--timeout-min', '5', '--grace-min', '1', '--base', OTHER, '--paths', 'apps/web/']),
  { sha: SHA, projectId: PROJECT_ID, teamId: TEAM_ID, target: 'production', timeoutMin: 5, graceMin: 1, base: OTHER, paths: ['apps/web/'] },
  'every flag is honored');
throws(() => parseArgs(['--project-id', PROJECT_ID, '--team-id', TEAM_ID, '--target', 'preview', '--paths', 'a/']), /--sha/, 'missing --sha is an error');
throws(() => parseArgs(['--sha', SHA, '--team-id', TEAM_ID, '--target', 'preview', '--paths', 'a/']), /--project-id/, 'missing --project-id is an error');
throws(() => parseArgs(['--sha', SHA, '--project-id', PROJECT_ID, '--target', 'preview', '--paths', 'a/']), /--team-id/, 'missing --team-id is an error');
throws(() => parseArgs(['--sha', SHA, '--project-id', PROJECT_ID, '--team-id', TEAM_ID, '--paths', 'a/']), /--target/, 'missing --target is an error');
throws(() => parseArgs(['--sha', SHA, '--project-id', PROJECT_ID, '--team-id', TEAM_ID, '--target', 'preview']), /--paths/, 'missing --paths is an error');
throws(() => parseArgs(['--sha', SHA, '--project-id', PROJECT_ID, '--team-id', TEAM_ID, '--target', 'staging', '--paths', 'a/']), /production or preview/,
  'a target outside production|preview is refused');
throws(() => parseArgs(['--sha', 'not-a-sha', '--project-id', PROJECT_ID, '--team-id', TEAM_ID, '--target', 'preview', '--paths', 'a/']), /sha/i, 'a non-hex sha is refused');
throws(() => parseArgs([...BASE_ARGS, '--timeout-min', 'soon']), /timeout/i, 'a non-numeric timeout is refused');
throws(() => parseArgs([...BASE_ARGS, '--bogus']), /bogus/, 'an unknown flag is refused');
eq(parseArgs([...BASE_ARGS, '--base', '0000000000000000000000000000000000000000']).base, null,
  'the all-zero base GitHub sends for a first push means "no base"');
eq(parseArgs([...BASE_ARGS, '--base', '']).base, null, 'an empty base means "no base"');
eq(parseArgs(['--sha', SHA, '--project-id', PROJECT_ID, '--team-id', TEAM_ID, '--target', 'preview', '--paths', 'apps/web/,,package.json']).paths,
  ['apps/web/', 'package.json'], '--paths drops empty entries');

// ── buildQuery ─────────────────────────────────────────────────────────────

{
  const q = buildQuery({ projectId: PROJECT_ID, teamId: TEAM_ID, sha: SHA, target: 'production' });
  eq(q.toString(), `projectId=${PROJECT_ID}&teamId=${TEAM_ID}&sha=${SHA}&target=production&limit=5`,
    'query carries projectId, teamId, sha, target and limit');
  ok(!/token/i.test(q.toString()), 'the query never carries a token');
  const q2 = buildQuery({ projectId: 'prj_1', teamId: 'team_1', sha: SHA, target: 'preview' });
  ok(q2.get('projectId') === 'prj_1' && q2.get('teamId') === 'team_1', 'query carries projectId and teamId verbatim');
}

// ── recordMatchesTarget ────────────────────────────────────────────────────

ok(recordMatchesTarget({ target: 'production' }, 'production'), 'production record matches production');
ok(!recordMatchesTarget({ target: null }, 'production'), 'a null-target (preview) record does not match production');
ok(!recordMatchesTarget({}, 'production'), 'a record with no target field does not match production');
ok(recordMatchesTarget({ target: null }, 'preview'), 'null target is what Vercel writes on a preview: matches preview');
ok(recordMatchesTarget({ target: 'preview' }, 'preview'), 'an explicit "preview" also matches preview');
ok(!recordMatchesTarget({ target: 'production' }, 'preview'), 'a production record does not match preview');

// ── IGNORED_BUILD_STEP_RE ──────────────────────────────────────────────────

ok(IGNORED_BUILD_STEP_RE.test(IGNORED_BUILD_STEP_MESSAGE), 'the regex matches the observed sentence');
ok(IGNORED_BUILD_STEP_RE.test('Canceled: ignored build step exited 0'), 'the regex is case-insensitive and does not need the full sentence');
ok(!IGNORED_BUILD_STEP_RE.test('Canceled by user'), 'a user cancel does not match');
ok(!IGNORED_BUILD_STEP_RE.test(''), 'an empty message does not match');

// ── classifyDeployments ────────────────────────────────────────────────────

const dep = (over) => ({
  uid: 'dpl_x', state: 'READY', readyState: 'READY', createdAt: 1000, target: null,
  url: 'app-abc-team.vercel.app', inspectorUrl: 'https://vercel.com/team/app/abc',
  meta: { githubCommitSha: SHA, githubCommitRef: 'staging' }, ...over,
});
const prod = (over) => dep({ target: 'production', meta: { githubCommitSha: SHA, githubCommitRef: 'main' }, ...over });

eq(classifyDeployments([], SHA, 'preview'), { kind: 'none' }, 'empty list is "none"');
throws(() => classifyDeployments([dep()], SHA, 'staging'), /production or preview/, 'a bad target is refused, not treated as preview');

// Vercel dedupes by SHA: a READY preview of the same commit must not satisfy
// the production check, and the other way round.
eq(classifyDeployments([dep()], SHA, 'production'), { kind: 'none' },
  'a READY preview record (target null) is ignored when checking production');
eq(classifyDeployments([prod()], SHA, 'production').kind, 'ready',
  'a READY production record satisfies production');
eq(classifyDeployments([prod()], SHA, 'preview'), { kind: 'none' },
  'a READY production record is ignored when checking preview');
eq(classifyDeployments([prod({ state: 'ERROR', readyState: 'ERROR', createdAt: 9000 }), dep({ createdAt: 1000 })], SHA, 'preview').kind, 'ready',
  'a newer production ERROR does not override the preview verdict');
eq(classifyDeployments([dep({ createdAt: 9000 }), prod({ state: 'ERROR', readyState: 'ERROR', createdAt: 1000 })], SHA, 'production').kind, 'error',
  'a newer preview READY does not hide the production ERROR');
eq(classifyDeployments([null, 'junk', dep()], SHA, 'preview').kind, 'ready', 'non-object entries are dropped, not crashed on');
eq(classifyDeployments([dep()], SHA, 'preview').kind, 'ready', 'READY is ready');
eq(classifyDeployments([dep()], SHA, 'preview').url, 'https://app-abc-team.vercel.app', 'ready carries the https url');
eq(classifyDeployments([dep({ state: 'ERROR', readyState: 'ERROR' })], SHA, 'preview'),
  { kind: 'error', state: 'ERROR', url: 'https://vercel.com/team/app/abc' },
  'ERROR is error and points at the inspector (build log) URL');
eq(classifyDeployments([dep({ state: 'ERROR', readyState: 'ERROR', inspectorUrl: undefined })], SHA, 'preview').url,
  'https://app-abc-team.vercel.app', 'inspectorUrl missing falls back to the deployment url');
eq(classifyDeployments([dep({ state: 'CANCELED', readyState: 'CANCELED', errorMessage: IGNORED_BUILD_STEP_MESSAGE })], SHA, 'preview'),
  { kind: 'ignored', state: 'CANCELED', url: 'https://vercel.com/team/app/abc' },
  'CANCELED with the Ignored Build Step message is an ignoreCommand skip, not a failure');
eq(classifyDeployments([dep({ state: 'CANCELED', readyState: 'CANCELED', errorMessage: 'Deployment canceled: IGNORED BUILD STEP returned 0' })], SHA, 'preview').kind,
  'ignored', 'the ignore message is matched case-insensitively on "Ignored Build Step", not on the whole sentence');
eq(classifyDeployments([dep({ state: 'CANCELED', readyState: 'CANCELED', errorMessage: 'Canceled by user' })], SHA, 'preview'),
  { kind: 'canceled', state: 'CANCELED', url: 'https://vercel.com/team/app/abc' },
  'CANCELED with any other message is a real cancel');
eq(classifyDeployments([dep({ state: 'CANCELED', readyState: 'CANCELED' })], SHA, 'preview').kind, 'canceled',
  'CANCELED with no message is a real cancel');
for (const s of ['QUEUED', 'INITIALIZING', 'BUILDING']) {
  eq(classifyDeployments([dep({ state: s, readyState: s })], SHA, 'preview'), { kind: 'pending', state: s },
    `${s} is pending`);
}
eq(classifyDeployments([dep({ state: 'DELETED', readyState: 'DELETED' })], SHA, 'preview'),
  { kind: 'unknown', state: 'DELETED' }, 'DELETED is not a state this script understands; it must not be green');
eq(classifyDeployments([dep({ state: 'SOMETHING_NEW', readyState: 'SOMETHING_NEW' })], SHA, 'preview').kind, 'unknown',
  'a state Vercel adds later is unknown, never silently green');
eq(classifyDeployments([dep({ state: undefined, readyState: undefined })], SHA, 'preview').kind, 'unknown',
  'a deployment with no state is unknown');
eq(classifyDeployments([dep({ readyState: undefined })], SHA, 'preview').kind, 'ready',
  'state is read when readyState is absent');
eq(classifyDeployments([dep({ meta: { githubCommitSha: OTHER } })], SHA, 'preview').kind, 'unknown',
  'a deployment whose commit sha is not the one asked for is not trusted (the sha filter must have matched)');
eq(classifyDeployments([dep({ meta: undefined })], SHA, 'preview').kind, 'unknown',
  'a deployment with no meta cannot be tied to the sha');
throws(() => classifyDeployments('nope', SHA, 'preview'), /array/i, 'a non-array body is a parse failure');

// Newest deployment decides, so a redeploy of the same sha supersedes the
// earlier record.
eq(classifyDeployments([
  dep({ state: 'ERROR', readyState: 'ERROR', createdAt: 1000 }),
  dep({ createdAt: 2000 }),
], SHA, 'preview').kind, 'ready', 'newest wins: an old ERROR then a READY redeploy is ready');
eq(classifyDeployments([
  dep({ createdAt: 2000 }),
  dep({ state: 'ERROR', readyState: 'ERROR', createdAt: 3000 }),
], SHA, 'preview').kind, 'error', 'newest wins: a READY then a failed redeploy is error');
eq(classifyDeployments([
  dep({ createdAt: 1000 }),
  dep({ state: 'BUILDING', readyState: 'BUILDING', createdAt: 5000 }),
], SHA, 'preview').kind, 'pending', 'newest wins: a redeploy in flight is pending');

// ── decide: the whole decision table ───────────────────────────────────────
//
// decide({ classification, diffEmpty, elapsedMs, graceMs, timeoutMs, sha, paths })
//   -> { action: 'exit', code, line } | { action: 'poll' }
// diffEmpty is a thunk so the diff runs only when the decision needs it.

const MIN = 60_000;
const PATHS = ['apps/web/', 'package.json'];
const base = { graceMs: 3 * MIN, timeoutMs: 20 * MIN, sha: SHA, paths: PATHS };
const ready = { kind: 'ready', url: 'https://x.vercel.app' };
const err = { kind: 'error', state: 'ERROR', url: 'https://vercel.com/i' };
const canceled = { kind: 'canceled', state: 'CANCELED', url: 'https://vercel.com/i' };
const ignored = { kind: 'ignored', state: 'CANCELED', url: 'https://vercel.com/i' };
const pending = { kind: 'pending', state: 'BUILDING' };
const none = { kind: 'none' };
const unknown = { kind: 'unknown', state: 'DELETED' };
const neverDiff = () => { throw new Error('diff must not run'); };

eq(decide({ ...base, classification: ready, diffEmpty: neverDiff, elapsedMs: 0 }),
  { action: 'exit', code: 0, line: 'READY https://x.vercel.app' }, 'READY exits 0 with the url, no diff needed');
eq(decide({ ...base, classification: err, diffEmpty: neverDiff, elapsedMs: 0 }),
  { action: 'exit', code: 1, line: 'FAILED ERROR https://vercel.com/i' }, 'ERROR exits 1 with the inspector url');
eq(decide({ ...base, classification: canceled, diffEmpty: neverDiff, elapsedMs: 0 }),
  { action: 'exit', code: 1, line: 'FAILED CANCELED https://vercel.com/i' }, 'a real CANCELED exits 1');
eq(decide({ ...base, classification: unknown, diffEmpty: neverDiff, elapsedMs: 0 }),
  { action: 'exit', code: 2, line: 'UNKNOWN deployment state DELETED for ' + SHA }, 'an unknown state exits 2, never 0');
eq(decide({ ...base, classification: pending, diffEmpty: neverDiff, elapsedMs: 19 * MIN }),
  { action: 'poll' }, 'pending inside the timeout keeps polling');
eq(decide({ ...base, classification: pending, diffEmpty: neverDiff, elapsedMs: 20 * MIN }),
  { action: 'exit', code: 1, line: `TIMEOUT deployment for ${SHA} still BUILDING after 20 min` },
  'pending at the timeout exits 1');

eq(decide({ ...base, classification: ignored, diffEmpty: () => true, elapsedMs: 0 }),
  { action: 'exit', code: 0, line: `SKIPPED ignored build step, no changes in ${PATHS.join(' ')}` },
  'an ignoreCommand skip with an empty diff is the expected skip: exit 0');
eq(decide({ ...base, classification: ignored, diffEmpty: () => false, elapsedMs: 0 }),
  { action: 'exit', code: 1, line: `FAILED CANCELED https://vercel.com/i (ignored build step skipped a commit that changed ${PATHS.join(' ')})` },
  'an ignoreCommand skip when the app DID change is a broken gate: exit 1, never green');

// "No record" is never green: an ignoreCommand skip leaves a CANCELED record,
// so no record at all means the git integration did not fire.
eq(decide({ ...base, classification: none, diffEmpty: neverDiff, elapsedMs: 2 * MIN }),
  { action: 'poll' }, 'no deployment inside the grace window keeps polling without running the diff');
eq(decide({ ...base, classification: none, diffEmpty: neverDiff, elapsedMs: 3 * MIN }),
  { action: 'poll' }, 'no deployment after the grace window keeps polling (never SKIPPED)');
eq(decide({ ...base, classification: none, diffEmpty: neverDiff, elapsedMs: 19 * MIN }),
  { action: 'poll' }, 'no deployment just before the timeout still polls');
eq(decide({ ...base, classification: none, diffEmpty: () => true, elapsedMs: 20 * MIN }),
  { action: 'exit', code: 1, line: `TIMEOUT no deployment for ${SHA} after 20 min (diff empty, but Vercel recorded no ignored-build deployment either)` },
  'no deployment at the timeout with an empty diff exits 1 and says the diff was empty');
eq(decide({ ...base, classification: none, diffEmpty: () => false, elapsedMs: 20 * MIN }),
  { action: 'exit', code: 1, line: `TIMEOUT no deployment for ${SHA} after 20 min` },
  'no deployment at the timeout with changes exits 1');
ok(!JSON.stringify(decide({ ...base, classification: none, diffEmpty: () => true, elapsedMs: 20 * MIN })).includes('"code":0'),
  'there is no exit-0 path for "none"');

// ── isTransientStatus ──────────────────────────────────────────────────────

for (const s of [429, 500, 502, 503, 504]) ok(isTransientStatus(s), `${s} is transient (retry)`);
for (const s of [200, 400, 401, 403, 404]) ok(!isTransientStatus(s), `${s} is not transient (exit 2)`);

// ── CLI arg validation ────────────────────────────────────────────────────

{
  const r = spawnSync(process.execPath, [SCRIPT, '--sha', 'abc', '--target', 'production'],
    { env: { ...process.env, VERCEL_TOKEN: 't' }, encoding: 'utf8' });
  ok(r.status !== 0 && r.stderr.includes('--project-id'), 'missing --project-id is an error');
  const r2 = spawnSync(process.execPath, [SCRIPT, '--sha', 'abc', '--target', 'production', '--project-id', 'p', '--team-id', 't'],
    { env: { ...process.env, VERCEL_TOKEN: 't' }, encoding: 'utf8' });
  ok(r2.status !== 0 && r2.stderr.includes('--paths'), 'missing --paths is an error');
}

// ── makeDiffEmpty ──────────────────────────────────────────────────────────
//
// The ignored-build decision must diff the given paths inside REPO_ROOT (the
// caller's cwd), not the script's own directory.

{
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'wfv-consumer-'));
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: consumer, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(consumer, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(consumer, 'apps', 'web', 'a.txt'), '1'); g('add', '.'); g('commit', '-qm', 'one');
  const diffBase = g('rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(consumer, 'apps', 'web', 'a.txt'), '2'); g('add', '.'); g('commit', '-qm', 'two');
  const diffSha = g('rev-parse', 'HEAD').stdout.trim();
  const changed = mod.makeDiffEmpty(diffBase, diffSha, ['apps/web/'], consumer)();
  const unchanged = mod.makeDiffEmpty(diffBase, diffSha, ['docs/'], consumer)();
  ok(changed === false, 'diffEmpty is false when a listed path changed');
  ok(unchanged === true, 'diffEmpty is true when no listed path changed');
  fs.rmSync(consumer, { recursive: true, force: true });
}

// ── report ─────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.log(`  FAIL ${f}`);
  process.exit(1);
}
