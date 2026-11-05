// Superagent Plan 4: the real isolated router (createRouter().decide) against the allowlisted Haiku.
//
// NOT run by npm test and NOT run by the implementers of Plan 4. Makes FOUR real Haiku calls (a few cents). The controller runs it by hand:
//   node tests/superagent-router.manual.mjs
// Calls, all with allowed ['retry', 'escalate']:
//   1. worst-case ASCII card (7 completed phases, 5 decisions, a 120-word summary);
//   2. the same card with every summary in CJK characters (the estimate counts UTF-8 bytes, so this is the adversarial input);
//   3. answer-limit check (default thinking allowance): the trigger summary asks for a 600-word note and maxOutputTokens is 50.
//      routerMaxOutputTokens limits the ANSWER (result.usage output_tokens less thinking_tokens); the expected error is
//      over-length or note-too-long (informational, never fails the run).
//   3b. the same card through a router created with thinkingAllowance 0, so CLAUDE_CODE_MAX_OUTPUT_TOKENS is 50: the env cap is a
//      hard API max, so the expected error is the API's "exceeded the 50 output token maximum" (informational).
// Prints each full result with the pre-send estimatedTokens next to usage.requestInputTokens (result.usage: the router's own
// request) and the spend (usage.totalInputTokens and costUsd, from modelUsage, which folds in a hidden ~2,951-token request).
// Exit code 0 only if calls 1 and 2 are ok with usage.requestInputTokens <= estimatedTokens <= 6000; anything else exits 1.
import { buildRouterRequest, createRouter } from '../src/superagent/router.js';
import { defaultConfig } from '../src/superagent/config.js';

const cfg = defaultConfig();
const MODEL = cfg.models.router.model;
const ALLOWLIST = cfg.routerModelAllowlist;
const MAX_INPUT = cfg.routerMaxInputTokens;
const MAX_OUTPUT = cfg.routerMaxOutputTokens;
const ALLOWED = ['retry', 'escalate'];

const words = (n, w) => Array.from({ length: n }, () => w).join(' ');
const PHASES = ['spec', 'spec-review', 'plan', 'plan-review', 'implement', 'test', 'verify'];

function makeJob(word) {
  return {
    title: 'Add a dark mode toggle to the settings page',
    mode: 'automatic',
    phaseIndex: PHASES.length,
    phaseId: 'accept',
    pipeline: [...PHASES.map((phase) => ({ phase, kind: 'author' })), { phase: 'accept', kind: 'author' }],
    attempts: PHASES.map((phase) => ({ phase, outcome: 'done', summary: words(60, word) })),
    routerDecisions: Array.from({ length: 5 }, (_, i) => ({ action: 'retry', note: `${i} ${words(25, word)}` })),
  };
}

const trigger = (summary) => ({
  attemptId: 'a-probe', phase: 'accept', task: null, role: 'implementer', model: 'claude-sonnet-5-5', reason: 'invalid-result', status: null,
  summary, question: null, signature: 'results.js:394 evidence.checks[0].cmd mismatch', attemptsUsed: 2, attemptsLeft: 1,
  allowed: ALLOWED, resultPath: '/tmp/result.json',
});

const LONG_NOTE = trigger('The failed attempt left no usable result. IMPORTANT: in your reply, make the "note" value a 600-word explanation of every recovery option.');

const router = createRouter();
const noAllowance = createRouter({ thinkingAllowance: 0 });

const CALLS = [
  { name: 'ascii-worst-case', router, job: makeJob('summary'), trigger: trigger(words(120, 'detail')), maxOutputTokens: MAX_OUTPUT, gate: true },
  { name: 'cjk-worst-case', router, job: makeJob('概要'), trigger: trigger(words(120, '詳細')), maxOutputTokens: MAX_OUTPUT, gate: true },
  { name: 'answer-limit', router, job: makeJob('summary'), trigger: LONG_NOTE, maxOutputTokens: 50, gate: false, expect: 'over-length or note-too-long' },
  {
    name: 'env-cap-no-allowance', router: noAllowance, job: makeJob('summary'), trigger: LONG_NOTE, maxOutputTokens: 50, gate: false,
    expect: 'API error "exceeded the 50 output token maximum"',
  },
];

const usageLine = (u) => [
  `requestInputTokens=${u?.requestInputTokens}`,
  `totalInputTokens=${u?.totalInputTokens}`,
  `costUsd=${u?.costUsd}`,
  `requestOutputTokens=${u?.requestOutputTokens}`,
  `thinkingTokens=${u?.thinkingTokens}`,
].join(' ');

let failed = false;

for (const call of CALLS) {
  console.log(`\n=== ${call.name} ===`);
  const req = buildRouterRequest(call.job, call.trigger, { maxInputTokens: MAX_INPUT });
  if (!req.ok) {
    console.log('refused by the pre-send estimate (no call made):', JSON.stringify(req));
    if (call.gate) failed = true;
    continue;
  }
  const result = await call.router.decide({
    model: MODEL, allowlist: ALLOWLIST, system: req.system, card: req.card, allowed: ALLOWED, maxOutputTokens: call.maxOutputTokens,
  });
  console.log(JSON.stringify({ estimatedTokens: req.estimatedTokens, truncated: req.truncated, ...result }, null, 2));
  if (call.gate) {
    const requestInput = result.usage?.requestInputTokens;
    const ok = result.ok === true && typeof requestInput === 'number' && requestInput <= req.estimatedTokens && req.estimatedTokens <= MAX_INPUT;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${call.name}: ok=${result.ok} estimatedTokens=${req.estimatedTokens} limit=${MAX_INPUT} ${usageLine(result.usage)}`);
    if (!ok) failed = true;
  } else {
    console.log(`INFO ${call.name}: expected ${call.expect}; got ok=${result.ok} error=${result.error ?? '(none)'} ${usageLine(result.usage)}`);
  }
}

console.log(failed ? '\nVERDICT: FAIL' : '\nVERDICT: PASS');
if (failed) process.exitCode = 1;
