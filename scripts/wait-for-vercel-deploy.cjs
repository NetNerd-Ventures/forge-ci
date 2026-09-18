#!/usr/bin/env node
/**
 * Wait for the Vercel deployment of one commit to reach a terminal state and
 * exit accordingly, so a push to staging or main that Vercel never turns
 * READY is a red check instead of a silent gap.
 *
 *   node scripts/wait-for-vercel-deploy.cjs --sha <sha> --project-id <prj_…> --team-id <team_…>
 *                                           --target <production|preview> --paths <comma-separated repo paths>
 *                                           [--timeout-min 20] [--grace-min 3] [--base <sha>]
 *
 * Node 22, no dependencies (global fetch). VERCEL_TOKEN comes from the
 * environment, goes into one Authorization header, and is never printed,
 * never written, never part of a URL. Errors print the HTTP status and a
 * snippet of the response body, which Vercel never echoes the token into.
 *
 * REPO_ROOT (env, default process.cwd()) is where the diff against --paths
 * runs; the caller's checkout, never this script's own directory.
 *
 * Polls GET /v6/deployments?projectId=&teamId=&sha=&target=&limit=5 every
 * 20 s. The response shape below was read from a real call on 2026-09-18,
 * not assumed: `deployments[]` carries `state` and `readyState` (both
 * present, same value), `url` (host only, no scheme), `inspectorUrl` (the
 * Vercel dashboard page with the build log), `createdAt` (ms),
 * `errorMessage` (only on failed and canceled deployments),
 * `meta.githubCommitSha` and `target`, which is the string "production" on
 * a main deployment and null (not "preview") on a staging one. The target
 * is both a query filter and re-checked on every record, because Vercel
 * dedupes by SHA: without it a preview deployment of the same commit would
 * satisfy the main check.
 *
 * Outcomes (last stdout line is the verdict; the workflow puts it in the step
 * summary):
 *   READY <url>                            exit 0
 *   SKIPPED ignored build step, ...        exit 0  Vercel recorded a CANCELED
 *       deployment whose errorMessage says the Ignored Build Step returned
 *       exit code 0, AND the same diff the ignoreCommand runs is empty. An
 *       ignoreCommand skip is NOT "no deployment": Vercel creates the record
 *       and cancels it, so a plain "CANCELED is red" rule would fail every
 *       push that leaves one app untouched.
 *   FAILED <state> <inspectorUrl>          exit 1  ERROR, a real CANCELED, or
 *       an ignoreCommand skip on a commit whose diff DID touch the app (the
 *       gate skipped something it should have built; that is a broken gate,
 *       never green).
 *   TIMEOUT ...                            exit 1  still pending, or no record
 *       at all, after --timeout-min. "No record" is never green: a skip
 *       leaves a CANCELED record, so no record means the git integration
 *       did not fire. When the diff is empty the line says so, because the
 *       fix is on the Vercel side, not in the commit.
 *   UNKNOWN ...                            exit 2  a state this script does
 *       not understand, a record whose sha is not the one asked for, or a
 *       body that is not the documented shape. Never exit 0 on a guess.
 *   HTTP <status> ...                      exit 2  any API error other than a
 *       transient 5xx/429, which is retried with backoff.
 *
 * The diff is `git diff --quiet <base> <sha> -- <app paths>` run from the
 * repo root, the same paths each app's vercel.json ignoreCommand lists. --base
 * defaults to <sha>^; the workflow passes github.event.before so the range is
 * exactly the pushed commits. A base that the checkout does not have (a force
 * push, the all-zero sha of a first push) falls back to <sha>^ with a note,
 * the same fallback the ignoreCommand itself uses.
 */
'use strict';

const { spawnSync } = require('child_process');

const API = 'https://api.vercel.com';
const POLL_MS = 20_000;
const LIMIT = 5;
const MAX_TRANSIENT_RETRIES = 8;
// Observed text: "The deployment was canceled because the Ignored Build Step
// command returned exit code 0." Matched loosely so a rewording of the rest of
// the sentence does not turn every skip into a failure.
const IGNORED_BUILD_STEP_MESSAGE =
  'The deployment was canceled because the Ignored Build Step command returned exit code 0.';
const IGNORED_BUILD_STEP_RE = /ignored build step/i;
const TARGETS = ['production', 'preview'];
const ZERO_SHA = /^0{40}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();

function parseArgs(argv) {
  const out = { sha: null, projectId: null, teamId: null, target: null, timeoutMin: 20, graceMin: 3, base: null, paths: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--sha': out.sha = next(); break;
      case '--project-id': out.projectId = next(); break;
      case '--team-id': out.teamId = next(); break;
      case '--target': out.target = next(); break;
      case '--base': out.base = next(); break;
      case '--paths': out.paths = next().split(',').map((p) => p.trim()).filter(Boolean); break;
      case '--timeout-min': out.timeoutMin = Number(next()); break;
      case '--grace-min': out.graceMin = Number(next()); break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  // Presence checks first, so a request missing several flags reports the
  // flag that's absent rather than a format complaint about one that's
  // present but malformed.
  if (!out.sha) throw new Error('--sha is required');
  if (!out.projectId) throw new Error('--project-id is required');
  if (!out.teamId) throw new Error('--team-id is required');
  if (!out.target) throw new Error('--target is required');
  if (!out.paths || out.paths.length === 0) throw new Error('--paths is required');
  if (!SHA_RE.test(out.sha)) throw new Error(`--sha must be a hex commit sha, got ${JSON.stringify(out.sha)}`);
  if (!TARGETS.includes(out.target)) throw new Error(`--target must be production or preview (got ${out.target})`);
  if (!Number.isFinite(out.timeoutMin) || out.timeoutMin <= 0) throw new Error('--timeout-min must be a positive number');
  if (!Number.isFinite(out.graceMin) || out.graceMin < 0) throw new Error('--grace-min must be a number >= 0');
  if (!out.base || ZERO_SHA.test(out.base)) out.base = null;
  return out;
}

/** The v6 list query. No token here: it travels in the Authorization header only. */
function buildQuery({ projectId, teamId, sha, target }) {
  return new URLSearchParams({ projectId, teamId, sha, target, limit: String(LIMIT) });
}

function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Vercel writes target "production" on main and null on a preview. */
function recordMatchesTarget(record, target) {
  const t = record.target ?? null;
  return target === 'production' ? t === 'production' : (t === null || t === 'preview');
}

const withScheme = (u) => (typeof u === 'string' && u && !/^https?:\/\//.test(u) ? `https://${u}` : u);

/**
 * Reduce the v6 `deployments` array to one verdict for `sha` on `target`.
 * Records for the other target are ignored (the query filters them already;
 * this is the check that does not trust the filter). The newest remaining
 * record decides, so a redeploy of the same sha supersedes the earlier one.
 */
function classifyDeployments(deployments, sha, target) {
  if (!Array.isArray(deployments)) throw new Error('v6 response has no deployments array');
  if (!TARGETS.includes(target)) throw new Error(`target must be production or preview (got ${target})`);
  const mine = deployments.filter((d) => d && typeof d === 'object' && recordMatchesTarget(d, target));
  if (mine.length === 0) return { kind: 'none' };
  const newest = [...mine].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0];
  const state = newest.readyState ?? newest.state;
  const recordSha = newest.meta && newest.meta.githubCommitSha;
  if (typeof recordSha !== 'string' || !recordSha.startsWith(sha)) {
    return { kind: 'unknown', state: `for a different commit (${recordSha || 'no meta.githubCommitSha'}), state ${state}` };
  }
  const inspector = withScheme(newest.inspectorUrl) || withScheme(newest.url);
  switch (state) {
    case 'READY':
      return { kind: 'ready', url: withScheme(newest.url) };
    case 'ERROR':
      return { kind: 'error', state, url: inspector };
    case 'CANCELED':
      if (IGNORED_BUILD_STEP_RE.test(String(newest.errorMessage ?? ''))) return { kind: 'ignored', state, url: inspector };
      return { kind: 'canceled', state, url: inspector };
    case 'QUEUED':
    case 'INITIALIZING':
    case 'BUILDING':
      return { kind: 'pending', state };
    default:
      return { kind: 'unknown', state: String(state) };
  }
}

/**
 * The decision table. `diffEmpty` is a thunk: the diff only runs when the
 * verdict depends on it. Returns { action: 'exit', code, line } or { action: 'poll' }.
 */
function decide({ classification: c, diffEmpty, elapsedMs, graceMs, timeoutMs, sha, paths }) {
  const mins = Math.round(timeoutMs / 60_000);
  const timedOut = elapsedMs >= timeoutMs;
  const pathList = paths.join(' ');
  switch (c.kind) {
    case 'ready':
      return { action: 'exit', code: 0, line: `READY ${c.url}` };
    case 'error':
    case 'canceled':
      return { action: 'exit', code: 1, line: `FAILED ${c.state} ${c.url}` };
    case 'ignored':
      if (diffEmpty()) return { action: 'exit', code: 0, line: `SKIPPED ignored build step, no changes in ${pathList}` };
      return {
        action: 'exit', code: 1,
        line: `FAILED ${c.state} ${c.url} (ignored build step skipped a commit that changed ${pathList})`,
      };
    case 'pending':
      if (timedOut) return { action: 'exit', code: 1, line: `TIMEOUT deployment for ${sha} still ${c.state} after ${mins} min` };
      return { action: 'poll' };
    case 'none':
      // Never green. An ignoreCommand skip leaves a CANCELED record, so no
      // record at all means Vercel's git integration did not see the push.
      // The grace window only delays the (memoized) diff, which is run once
      // to make the timeout line say where to look.
      if (!timedOut) return { action: 'poll' };
      if (elapsedMs >= graceMs && diffEmpty()) {
        return {
          action: 'exit', code: 1,
          line: `TIMEOUT no deployment for ${sha} after ${mins} min (diff empty, but Vercel recorded no ignored-build deployment either)`,
        };
      }
      return { action: 'exit', code: 1, line: `TIMEOUT no deployment for ${sha} after ${mins} min` };
    default:
      return { action: 'exit', code: 2, line: `UNKNOWN deployment state ${c.state} for ${sha}` };
  }
}

// ── impure shell ───────────────────────────────────────────────────────────

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/** Memoized: runs `git diff --quiet <base> <sha> -- <paths>` at most once. */
function makeDiffEmpty(base, sha, paths, cwd = REPO_ROOT) {
  let result;
  return () => {
    if (result !== undefined) return result;
    let b = base;
    if (b && git(['cat-file', '-e', `${b}^{commit}`], cwd).status !== 0) {
      console.log(`note: base ${b} is not in this checkout, diffing against ${sha}^ instead`);
      b = null;
    }
    if (!b) b = `${sha}^`;
    const r = git(['diff', '--quiet', b, sha, '--', ...paths], cwd);
    if (r.status === 0) result = true;
    else if (r.status === 1) result = false;
    else {
      throw new Error(`git diff --quiet ${b} ${sha} failed (exit ${r.status}): ${(r.stderr || '').trim().slice(0, 300)}`);
    }
    console.log(`diff ${b}..${sha} -- ${paths.join(' ')}: ${result ? 'no changes' : 'changes'}`);
    return result;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sleep, but never past `deadline` (ms epoch). */
async function sleepUntil(ms, deadline) {
  const capped = Math.max(0, Math.min(ms, deadline - Date.now()));
  if (capped > 0) await sleep(capped);
}

async function fetchDeployments(url, token, deadline) {
  let transient = 0;
  for (;;) {
    if (transient > 0 && Date.now() >= deadline) {
      throw new Error(`gave up retrying the Vercel API at the deadline after ${transient} transient failure(s)`);
    }
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      // Network failure: the message carries no header, so it is safe to print.
      if (++transient > MAX_TRANSIENT_RETRIES) throw new Error(`fetch failed ${transient} times: ${err.message}`);
      const wait = Math.min(POLL_MS * transient, 120_000);
      console.log(`fetch error (${err.message}); retry ${transient}/${MAX_TRANSIENT_RETRIES} in ${wait / 1000}s`);
      await sleepUntil(wait, deadline);
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      let body;
      try { body = JSON.parse(text); } catch { throw new Error(`v6 response is not JSON: ${text.slice(0, 200)}`); }
      return body.deployments;
    }
    if (isTransientStatus(res.status)) {
      if (++transient > MAX_TRANSIENT_RETRIES) {
        throw new Error(`HTTP ${res.status} ${transient} times in a row: ${text.slice(0, 200)}`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(POLL_MS * transient, 120_000);
      console.log(`HTTP ${res.status}; retry ${transient}/${MAX_TRANSIENT_RETRIES} in ${wait / 1000}s`);
      await sleepUntil(wait, deadline);
      continue;
    }
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    console.error('VERCEL_TOKEN is not set');
    return 2;
  }
  const paths = args.paths;
  const url = `${API}/v6/deployments?${buildQuery({ projectId: args.projectId, teamId: args.teamId, sha: args.sha, target: args.target })}`;
  const diffEmpty = makeDiffEmpty(args.base, args.sha, paths);
  const timeoutMs = args.timeoutMin * 60_000;
  const graceMs = args.graceMin * 60_000;
  const started = Date.now();
  const deadline = started + timeoutMs;
  console.log(`Waiting for ${args.projectId} ${args.target} deployment of ${args.sha} (timeout ${args.timeoutMin} min, grace ${args.graceMin} min)`);

  for (;;) {
    const deployments = await fetchDeployments(url, token, deadline);
    const classification = classifyDeployments(deployments, args.sha, args.target);
    const elapsedMs = Date.now() - started;
    const verdict = decide({ classification, diffEmpty, elapsedMs, graceMs, timeoutMs, sha: args.sha, paths });
    if (verdict.action === 'exit') {
      console.log(verdict.line);
      return verdict.code;
    }
    console.log(`${Math.round(elapsedMs / 1000)}s: ${classification.kind}${classification.state ? ` (${classification.state})` : ''}, polling again in ${POLL_MS / 1000}s`);
    await sleepUntil(POLL_MS, deadline);
  }
}

module.exports = {
  parseArgs, buildQuery, classifyDeployments, decide, isTransientStatus, recordMatchesTarget,
  makeDiffEmpty, IGNORED_BUILD_STEP_MESSAGE, IGNORED_BUILD_STEP_RE,
};

// process.exitCode, not process.exit(): exit() can drop a pending stdout
// write on a pipe, and the last line IS the verdict the workflow reads.
if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      // err.message never contains the token: it is built from status codes,
      // body snippets and git stderr only.
      console.error(`ERROR ${err.message}`);
      process.exitCode = 2;
    },
  );
}
