#!/usr/bin/env node
/**
 * Cross-model review: the pure decision functions behind
 * scripts/cross-model-review.mjs (repo root).
 *
 *   node test/_test-cross-model-review.cjs
 *
 * Pure: no DB, no network, no API key. The script is ESM, so it is loaded
 * with a dynamic import() from this CommonJS harness.
 *
 * What is pinned here is the policy, not the HTTP: which vendor reviews
 * whose code, what happens when that vendor is down, when a high finding
 * blocks the merge and when the override label lets it through, that an
 * oversized diff never reaches a model, and that the sticky comment is
 * found by its marker and nothing else.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'cross-model-review.mjs');
const CONFIG = path.join(ROOT, 'scripts', 'cross-model-review.config.json');

let pass = 0;
const fail = [];
const eq = (got, exp, label) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) pass++;
  else fail.push(`${label}\n      got ${g}\n      exp ${e}`);
};
const throws = (fn, re, label) => {
  try {
    fn();
    fail.push(`${label}\n      expected a throw, got none`);
  } catch (err) {
    if (re.test(String(err && err.message))) pass++;
    else fail.push(`${label}\n      threw ${JSON.stringify(String(err && err.message))}\n      exp match ${re}`);
  }
};

const CLAUDE = 'ajbass@gmail.com\nClaude Opus 5 (1M context) <noreply@anthropic.com>\n';
const CLAUDE_OLD = 'dlolli@gmail.com\nClaude Opus 5 <noreply@anthropic.com>\n';
const CODEX = 'ajbass@gmail.com\nCodex <codex@openai.com>\n';
const CODEX_UPPER = 'ajbass@gmail.com\nCodex <CODEX@OpenAI.com>\n';
const HUMAN = 'ajbass@gmail.com\n\n';
const HUMAN_NO_TRAILER = 'dlolli@gmail.com\n';

(async () => {
  const mod = await import(pathToFileURL(SCRIPT).href);
  const {
    detectAuthorVendors,
    chooseReviewer,
    checkDiffSize,
    DIFF_TOO_LARGE,
    evaluateVerdict,
    findStickyComment,
    STICKY_MARKER,
    OVERRIDE_LABEL,
    REVIEW_SCHEMA,
    buildPrompt,
    extractText,
    renderComment,
    loadConfig,
    parseLabels,
    hasOverride,
    COMMENT_LIMIT,
    parseArgs,
    renderSummary,
  } = mod;

  const config = loadConfig(CONFIG);

  // ── config shape ────────────────────────────────────────────────────────

  eq(Object.keys(config.models).sort(), ['anthropic', 'openai', 'xai'], 'one model id per vendor');
  eq(config.models.anthropic, 'claude-opus-5', 'the Anthropic id is the exact string, no date suffix');
  eq(config.diffCapBytes, 150 * 1024, 'the diff cap is 150 KB');
  eq(config.timeouts, { vendorMs: 600000, githubMs: 30000 }, 'vendor and GitHub fetch timeouts live in the config');
  eq(config.authors.anthropic, ['anthropic.com'], 'Anthropic trailers are matched by domain');
  eq(config.authors.openai, ['openai.com'], 'the OpenAI domain is a documented assumption, config-driven');
  for (const v of ['anthropic', 'openai', 'xai']) {
    eq(typeof config.lookedUp[v], 'string', `${v} records the date its model id was looked up`);
    eq(Array.isArray(config.fallback[v]), true, `${v} has a fallback order`);
    eq(config.fallback[v].includes(v), false, `${v} never falls back to itself`);
  }

  // ── vendor detection from trailers ──────────────────────────────────────

  eq(detectAuthorVendors(CLAUDE, config), { authors: ['human', 'anthropic'], ai: ['anthropic'] },
    'Claude-only: the human committer plus the Anthropic trailer');
  eq(detectAuthorVendors(CLAUDE + CLAUDE_OLD, config).ai, ['anthropic'],
    'two Claude commits with different display names are still one vendor');
  eq(detectAuthorVendors(CODEX, config).ai, ['openai'], 'Codex-only');
  eq(detectAuthorVendors(CODEX_UPPER, config).ai, ['openai'], 'domain match is case-insensitive');
  eq(detectAuthorVendors(CLAUDE + CODEX, config).ai, ['anthropic', 'openai'], 'mixed: both vendors, in first-seen order');
  eq(detectAuthorVendors(HUMAN, config), { authors: ['human'], ai: [] }, 'human-only, empty trailer line');
  eq(detectAuthorVendors(HUMAN_NO_TRAILER, config), { authors: ['human'], ai: [] }, 'human-only, no trailer line at all');
  eq(detectAuthorVendors('', config), { authors: [], ai: [] }, 'no commits at all');
  eq(detectAuthorVendors('someone@anthropic.com\n', config).ai, ['anthropic'],
    'an author email on a vendor domain counts too, not only trailers');
  eq(detectAuthorVendors('x@notanthropic.com\n', config).ai, [],
    'a domain that merely ends with the vendor string is not the vendor');
  eq(detectAuthorVendors('x@sub.anthropic.com\n', config).ai, ['anthropic'], 'a subdomain of the vendor domain is');

  // ── reviewer selection and fallback order ───────────────────────────────

  eq(chooseReviewer(['anthropic'], config), { primary: 'openai', order: ['openai', 'xai'] },
    'Anthropic-authored: OpenAI reviews, xAI is the fallback, Anthropic is never asked');
  eq(chooseReviewer(['openai'], config), { primary: 'anthropic', order: ['anthropic', 'xai'] },
    'OpenAI-authored: Anthropic reviews, xAI is the fallback, OpenAI is never asked');
  eq(chooseReviewer(['anthropic', 'openai'], config), { primary: 'xai', order: ['xai'] },
    'mixed: xAI reviews and there is NO fallback, both other vendors wrote the code');
  eq(chooseReviewer([], config), { primary: 'xai', order: ['xai', 'openai', 'anthropic'] },
    'human-only: xAI reviews, both others can stand in');
  for (const ai of [['anthropic'], ['openai'], ['anthropic', 'openai'], []]) {
    const { order } = chooseReviewer(ai, config);
    eq(order.some((v) => ai.includes(v)), false, `no author vendor ever appears in the order for ${JSON.stringify(ai)}`);
    eq(new Set(order).size, order.length, 'the order has no duplicates');
  }
  throws(() => chooseReviewer(['anthropic'], { ...config, fallback: { ...config.fallback, openai: ['openai'] } }),
    /fallback/i, 'a config whose fallback names the reviewer itself is rejected, not silently deduped away');

  // ── diff cap ────────────────────────────────────────────────────────────

  eq(DIFF_TOO_LARGE, 'PR too large for review, split it or add review-override', 'the refusal message is exact');
  eq(checkDiffSize('x'.repeat(config.diffCapBytes), config), { ok: true, bytes: config.diffCapBytes },
    'exactly at the cap is allowed');
  eq(checkDiffSize('x'.repeat(config.diffCapBytes + 1), config), { ok: false, bytes: config.diffCapBytes + 1, error: DIFF_TOO_LARGE },
    'one byte over the cap is refused with the exact message');
  eq(checkDiffSize('é'.repeat(config.diffCapBytes), config).ok, false,
    'the cap is measured in bytes, not characters');
  eq(checkDiffSize('', config), { ok: true, bytes: 0 }, 'an empty diff is under the cap');

  // ── verdict ─────────────────────────────────────────────────────────────

  const f = (severity) => ({ severity, file: 'a.ts', line: 1, claim: 'c', evidence: 'e', fix: 'f' });
  eq(evaluateVerdict({ findings: [f('critical')], labels: [], event: 'synchronize', actor: 'andy' }),
    { pass: false, blocking: 1, overridden: false, skipModel: false, reason: '1 blocking finding (critical/high)', advisory: false },
    'a critical finding without the label fails');
  eq(evaluateVerdict({ findings: [f('high'), f('high')], labels: [], event: 'synchronize', actor: 'andy' }).pass, false,
    'a high finding without the label fails');
  eq(evaluateVerdict({ findings: [f('high'), f('high')], labels: [], event: 'synchronize', actor: 'andy' }).blocking, 2,
    'every blocking finding is counted');
  eq(evaluateVerdict({ findings: [f('medium'), f('low')], labels: [], event: 'synchronize', actor: 'andy' }),
    { pass: true, blocking: 0, overridden: false, skipModel: false, reason: 'no critical or high findings', advisory: false },
    'medium and low never block');
  eq(evaluateVerdict({ findings: [], labels: [], event: 'opened', actor: 'andy' }).pass, true, 'no findings passes');
  eq(evaluateVerdict({ findings: [f('critical')], labels: [OVERRIDE_LABEL], event: 'synchronize', actor: 'andy' }),
    { pass: true, blocking: 1, overridden: true, skipModel: false, reason: 'overridden by @andy', advisory: false },
    'the label turns a red verdict green and records who; the review still ran on synchronize');
  eq(evaluateVerdict({ findings: null, labels: [OVERRIDE_LABEL], event: 'labeled', actor: 'derik' }),
    { pass: true, blocking: 0, overridden: true, skipModel: true, reason: 'overridden by @derik', advisory: false },
    'on the labeled event with the label present the model is not called at all');
  eq(evaluateVerdict({ findings: [f('high')], labels: ['bug'], event: 'labeled', actor: 'derik' }),
    { pass: false, blocking: 1, overridden: false, skipModel: false, reason: '1 blocking finding (critical/high)', advisory: false },
    'a labeled event for some other label still runs the review and can still fail');
  throws(() => evaluateVerdict({ findings: null, labels: ['bug'], event: 'labeled', actor: 'derik' }),
    /no findings/i, 'and without findings that labeled event is an error, not a skip');
  eq(evaluateVerdict({ findings: [f('high')], labels: ['Review-Override'], event: 'synchronize', actor: 'a' }).overridden, true,
    'the label match folds case (GitHub label names are case-insensitive)');
  eq(hasOverride(['bug', 'REVIEW-OVERRIDE']), true, 'hasOverride folds case');
  eq(hasOverride(['review-override-later']), false, 'hasOverride does not prefix-match');
  eq(hasOverride([]), false, 'hasOverride on no labels');
  eq(hasOverride(undefined), false, 'hasOverride on a missing label set');

  // ── labels from the event ───────────────────────────────────────────────

  eq(parseLabels(''), [], 'unset PR_LABELS is no labels');
  eq(parseLabels(undefined), [], 'missing PR_LABELS is no labels');
  eq(parseLabels('["bug","review-override"]'), ['bug', 'review-override'], 'toJSON(labels.*.name) is a string array');
  eq(parseLabels('[{"name":"bug"},{"id":1}]'), ['bug'], 'label objects are accepted, ones without a name are dropped');
  throws(() => parseLabels('{"name":"bug"}'), /array/i, 'a non-array is an error');
  throws(() => parseLabels('not json'), /JSON/, 'malformed JSON is an error, not an empty label set');
  throws(() => evaluateVerdict({ findings: null, labels: [], event: 'synchronize', actor: 'a' }),
    /no findings/i, 'a missing review without the override is an error, never a clean pass');
  throws(() => evaluateVerdict({ findings: [{ severity: 'severe' }], labels: [], event: 'synchronize', actor: 'a' }),
    /severity/i, 'an unknown severity is an error, not silently non-blocking');

  // ── sticky comment ──────────────────────────────────────────────────────

  eq(STICKY_MARKER, '<!-- cross-model-review -->', 'the marker is exact');
  const comments = [
    { id: 1, body: 'looks good' },
    { id: 2, body: '<!-- cross-model-review-v2 --> not ours' },
    { id: 3, body: `${STICKY_MARKER}\n## Cross-model review` },
    { id: 4, body: `${STICKY_MARKER}\nolder duplicate` },
  ];
  eq(findStickyComment(comments), { id: 3, body: `${STICKY_MARKER}\n## Cross-model review` },
    'the first comment carrying the marker is the sticky one');
  eq(findStickyComment([comments[0], comments[1]]), null, 'a marker with a suffix does not match; no comment means create');
  eq(findStickyComment([{ id: 9, body: `intro text ${STICKY_MARKER} tail` }]).id, 9, 'the marker may sit anywhere in the body');
  eq(findStickyComment([{ id: 9 }]), null, 'a comment with no body is skipped, not thrown on');
  eq(renderComment({
    reviewer: { vendor: 'openai', model: 'gpt-6-astra' }, authors: ['human', 'anthropic'],
    findings: [f('high')], wouldDoDifferently: 'nothing', verdict: { pass: false, blocking: 1, overridden: false, reason: 'r' },
  }).startsWith(STICKY_MARKER), true, 'the rendered comment begins with the marker so re-runs find it');
  {
    const body = renderComment({
      reviewer: { vendor: 'openai', model: 'gpt-6-astra' }, authors: ['human', 'anthropic'],
      findings: [f('low'), f('critical'), f('medium'), f('high')], wouldDoDifferently: 'use fewer files',
      verdict: { pass: false, blocking: 2, overridden: false, reason: 'r' },
    });
    const idx = ['critical', 'high', 'medium', 'low'].map((s) => body.indexOf(`### ${s}`));
    eq(idx.every((i) => i >= 0), true, 'each severity present gets its own heading');
    eq(idx.slice(1).every((i, k) => i > idx[k]), true, 'findings are grouped by severity, most severe first');
    eq(body.includes('gpt-6-astra') && body.includes('openai'), true, 'reviewer vendor and model are named');
    eq(body.includes('human, anthropic'), true, 'author vendors are named');
    eq(body.includes('use fewer files'), true, 'the would-do-differently note is included');
  }

  {
    const many = Array.from({ length: 400 }, (_, i) => ({
      severity: i % 4 === 0 ? 'high' : 'low', file: `f${i}.ts`, line: i, claim: `claim ${i}`,
      evidence: 'e'.repeat(400), fix: `fix ${i}`,
    }));
    const body = renderComment({
      reviewer: { vendor: 'xai', model: 'grok-4.6' }, authors: ['human'], findings: many,
      wouldDoDifferently: 'WDD-NOTE', verdict: { pass: false, blocking: 100, overridden: false, reason: 'r' },
    });
    eq(body.length <= COMMENT_LIMIT, true, 'an oversized comment is cut under the GitHub limit');
    eq((body.match(/```/g) || []).length % 2, 0, 'truncation never leaves an open code fence');
    eq(/\(truncated: \d+ of 400 findings shown; the full review JSON is in the workflow log\)/.test(body), true,
      'the truncation note says how many findings were dropped and where the rest are');
    const shown = Number(body.match(/truncated: (\d+) of 400/)[1]);
    eq(shown > 0 && shown < 400, true, 'some findings are shown, not all');
    eq((body.match(/^- \*\*f\d+\.ts(:\d+)?\*\*/gm) || []).length, shown, 'exactly the counted findings are rendered');
    eq(body.includes('### high') && body.indexOf('### high') < (body.indexOf('### low') === -1 ? Infinity : body.indexOf('### low')), true,
      'high findings survive truncation ahead of low ones');
    eq(body.includes('WDD-NOTE'), true, 'the would-do-differently note survives truncation');
  }

  // ── prompt and schema ───────────────────────────────────────────────────

  eq(REVIEW_SCHEMA.additionalProperties, false, 'top level forbids extra keys');
  eq(REVIEW_SCHEMA.required, ['findings', 'would_do_differently'], 'top level requires everything');
  const finding = REVIEW_SCHEMA.properties.findings.items;
  eq(finding.additionalProperties, false, 'finding forbids extra keys');
  eq(finding.required, ['severity', 'file', 'line', 'claim', 'evidence', 'fix'], 'finding requires everything');
  eq(finding.properties.severity.enum, ['critical', 'high', 'medium', 'low'], 'severity is a closed enum');
  eq(finding.properties.line.type, 'integer', 'line is an integer (0 when unknown)');

  {
    const p = buildPrompt({ rules: 'RULES-HERE', title: 'T', body: 'B', diff: 'DIFF-HERE' });
    eq(typeof p.system === 'string' && p.system.length > 0, true, 'a system prompt is produced');
    eq(p.system.includes('RULES-HERE'), true, 'the project rules ride in the system prompt');
    eq(p.user.includes('DIFF-HERE') && p.user.includes('T') && p.user.includes('B'), true,
      'the diff, title and body ride in the user message, never the system prompt');
    eq(p.system.includes('DIFF-HERE'), false, 'the diff is not in the system prompt');
    eq((p.system + p.user).includes(String.fromCharCode(0x2014)), false, 'no em dashes in the prompt');
  }

  // ── vendor response extraction ──────────────────────────────────────────

  const good = JSON.stringify({ findings: [], would_do_differently: 'x' });
  eq(extractText('anthropic', { stop_reason: 'end_turn', content: [{ type: 'text', text: good }] }), good, 'Anthropic: text block');
  throws(() => extractText('anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: good }] }), /max_tokens/, 'Anthropic: max_tokens is a vendor failure');
  throws(() => extractText('anthropic', { stop_reason: 'refusal', content: [] }), /refusal/, 'Anthropic: refusal is a vendor failure');
  eq(extractText('openai', { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: good }] }] }), good, 'OpenAI: output_text');
  throws(() => extractText('openai', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), /incomplete/, 'OpenAI: incomplete is a vendor failure');
  throws(() => extractText('openai', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), /refus/, 'OpenAI: refusal is a vendor failure');
  eq(extractText('xai', { choices: [{ finish_reason: 'stop', message: { content: good } }] }), good, 'xAI: chat completion content');
  throws(() => extractText('xai', { choices: [{ finish_reason: 'length', message: { content: good } }] }), /length/, 'xAI: truncated is a vendor failure');
  throws(() => extractText('xai', { choices: [] }), /no choices/i, 'xAI: empty choices is a vendor failure');

  // ── forge-ci: advisory mode, config path, REPO_ROOT ─────────────────────

  {
    const crit = [{ severity: 'critical', title: 'x' }];
    const v = evaluateVerdict({ findings: crit, labels: [], event: 'opened', actor: 'a', advisory: true });
    eq(v.blocking, 1, 'advisory: critical finding still counted');
    eq(v.pass === true && v.advisory === true, true, 'advisory: verdict passes anyway');
    const v2 = evaluateVerdict({ findings: crit, labels: [], event: 'opened', actor: 'a' });
    eq(v2.pass === false && v2.blocking === 1 && v2.advisory === false, true, 'required: critical finding fails');
    const v3 = evaluateVerdict({ findings: crit, labels: ['review-override'], event: 'synchronize', actor: 'a' });
    eq(v3.pass === true && v3.overridden === true, true, 'required: override still passes');
    const c = renderComment({ reviewer: 'openai', authors: ['anthropic'], findings: crit, wouldDoDifferently: '', verdict: v, note: '' });
    eq(c.includes('Advisory mode: this review does not block the merge.'), true, 'advisory: comment says so');
    const c2 = renderComment({ reviewer: 'openai', authors: ['anthropic'], findings: crit, wouldDoDifferently: '', verdict: v2, note: '' });
    eq(c2.includes('Advisory mode'), false, 'required: comment has no advisory line');
    const cfgPath = path.join(os.tmpdir(), 'cmr-cfg.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ ...loadConfig(), diffCapBytes: 7 }));
    eq(loadConfig(cfgPath).diffCapBytes, 7, '--config: loadConfig reads the given path');
    const args = parseArgs(['--advisory', '--config', cfgPath, '--base', 'origin/main']);
    eq(args.advisory === true && args.config === cfgPath && args.base === 'origin/main', true, 'parseArgs: advisory + config + base');
  }
  {
    // Git must run against the consumer (REPO_ROOT), not against forge-ci's own tree.
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-consumer-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: consumer });
    fs.writeFileSync(path.join(consumer, 'CLAUDE.md'), '# rules\n');
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: consumer });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: consumer });
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--base', 'HEAD'], {
      cwd: os.tmpdir(), env: { ...process.env, REPO_ROOT: consumer }, encoding: 'utf8',
    });
    eq(r.status === 0 && r.stdout.includes('base:            HEAD'), true, 'REPO_ROOT: dry-run runs git in the consumer');
  }

  // ── forge-ci fix round 1: advisory step summary, crash-path exit code ───

  {
    const blockingVerdict = { pass: true, blocking: 1, overridden: false, skipModel: false, reason: '1 blocking finding (critical/high)', advisory: true };
    const s = renderSummary({ verdict: blockingVerdict, authors: ['anthropic'], reviewerUsed: { vendor: 'openai', model: 'gpt' }, note: '' });
    eq(s.includes('ADVISORY (would FAIL): 1 blocking finding (critical/high)'), true, 'advisory summary: blocking findings read as "would FAIL"');
    eq(s.includes('_Advisory mode: this review does not block the merge._'), true, 'advisory summary: carries the advisory note');
    eq(s.includes('PASS:') || s.includes('FAIL:'), false, 'advisory summary: never claims a bare PASS/FAIL');

    const cleanVerdict = { pass: true, blocking: 0, overridden: false, skipModel: false, reason: 'no critical or high findings', advisory: true };
    const s2 = renderSummary({ verdict: cleanVerdict, authors: [], reviewerUsed: null, note: '' });
    eq(s2.includes('ADVISORY (would PASS): no critical or high findings'), true, 'advisory summary: clean review reads as "would PASS"');

    const requiredVerdict = { pass: false, blocking: 1, overridden: false, skipModel: false, reason: '1 blocking finding (critical/high)', advisory: false };
    const s3 = renderSummary({ verdict: requiredVerdict, authors: [], reviewerUsed: null, note: '' });
    eq(s3.includes('FAIL: 1 blocking finding (critical/high)'), true, 'required summary: unchanged FAIL label');
    eq(s3.includes('Advisory mode'), false, 'required summary: no advisory note');
  }
  {
    // Crash path: main() rejects (bad --base ref means the review never
    // runs); the exit code must honour --advisory even though the run
    // failed outright, and not just for a clean review.
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-crash-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: consumer });
    fs.writeFileSync(path.join(consumer, 'CLAUDE.md'), '# rules\n');
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: consumer });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: consumer });
    const runCrash = (extraArgs) => spawnSync(process.execPath, [SCRIPT, '--base', 'no-such-ref', ...extraArgs], {
      cwd: os.tmpdir(), env: { ...process.env, REPO_ROOT: consumer }, encoding: 'utf8',
    });
    const advisoryRun = runCrash(['--advisory']);
    eq(advisoryRun.status, 0, 'crash path: --advisory forces exit 0 even when the run throws');
    const requiredRun = runCrash([]);
    eq(requiredRun.status, 1, 'crash path: without --advisory a crash still exits 1');
  }

  if (fail.length) {
    console.error(`\n${fail.length} FAILED:\n  - ${fail.join('\n  - ')}\n`);
    console.log(`${pass} passed, ${fail.length} failed`);
    process.exit(1);
  }
  console.log(`${pass} passed, 0 failed`);
})().catch((err) => {
  console.error(err);
  console.log(`${pass} passed, 1 failed`);
  process.exit(1);
});
