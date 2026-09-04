// AskUserQuestion is deliberately excluded from every auto-allow permission
// mode (src/session.js:272-291) because passing `input` back unmodified reads
// as "the user did not answer" - the tool's `answers` field stays empty. So
// auto-answering cannot be a mode change; it has to construct a real answer,
// in exactly the shape the cockpit's own client already sends
// (public/approval-panel.js:184-190).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoAnswer, RECOMMENDED_RE } from '../src/autopilot-answer.js';

function question(over = {}) {
  return {
    question: 'Which library should we use for date formatting?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'date-fns', description: 'Tree-shakeable' },
      { label: 'Luxon (Recommended)', description: 'Best DST handling' },
    ],
    ...over,
  };
}

test('it picks the option whose label matches (Recommended), case-insensitively', () => {
  const result = buildAutoAnswer({ questions: [question()] });
  assert.deepEqual(result.decision, {
    behavior: 'allow',
    updatedInput: {
      questions: [question()],
      answers: { 'Which library should we use for date formatting?': 'Luxon (Recommended)' },
    },
  });
  assert.deepEqual(result.chosen, [
    { question: 'Which library should we use for date formatting?', chosenLabel: 'Luxon (Recommended)' },
  ]);

  const lower = buildAutoAnswer({
    questions: [question({ options: [{ label: 'a' }, { label: 'b (recommended)' }] })],
  });
  assert.equal(Object.values(lower.decision.updatedInput.answers)[0], 'b (recommended)');

  assert.equal(RECOMMENDED_RE.test('Thing (RECOMMENDED)'), true);
  assert.equal(RECOMMENDED_RE.test('Recommended without parens'), false);
});

test('with no (Recommended) marker it falls back to the first option', () => {
  const result = buildAutoAnswer({
    questions: [question({ options: [{ label: 'first' }, { label: 'second' }] })],
  });
  assert.equal(Object.values(result.decision.updatedInput.answers)[0], 'first');
});

test('multiSelect: true still chooses a SINGLE option', () => {
  const result = buildAutoAnswer({
    questions: [question({
      multiSelect: true,
      options: [{ label: 'auth' }, { label: 'billing (Recommended)' }, { label: 'search' }],
    })],
  });
  // The client joins multiple selections with ', ' (approval-panel.js:188);
  // one selection needs no join, and picking everything is not what
  // "recommended" means.
  assert.equal(Object.values(result.decision.updatedInput.answers)[0], 'billing (Recommended)');
});

test('answers are keyed by the EXACT question text, for every question', () => {
  const qs = [
    question({ question: 'First question?', options: [{ label: 'one' }] }),
    question({ question: 'Second question?', options: [{ label: 'two' }, { label: 'three (Recommended)' }] }),
  ];
  const result = buildAutoAnswer({ questions: qs });
  assert.deepEqual(result.decision.updatedInput.answers, {
    'First question?': 'one',
    'Second question?': 'three (Recommended)',
  });
  assert.equal(result.chosen.length, 2);
});

test('the original questions array is passed back untouched alongside the answers', () => {
  const qs = [question()];
  const result = buildAutoAnswer({ questions: qs });
  assert.equal(result.decision.updatedInput.questions, qs);
});

test('an unusable input shape returns null so the question falls through to a human', () => {
  assert.equal(buildAutoAnswer(null), null);
  assert.equal(buildAutoAnswer({}), null);
  assert.equal(buildAutoAnswer({ questions: [] }), null);
  assert.equal(buildAutoAnswer({ questions: [{ question: 'q?', options: [] }] }), null);
  assert.equal(buildAutoAnswer({ questions: [{ question: '', options: [{ label: 'a' }] }] }), null);
  assert.equal(buildAutoAnswer({ questions: [{ question: 'q?', options: [{ label: '' }] }] }), null);
});

test('fix round 1, M-4a: two questions with identical text are refused rather than silently collapsed to one answer', () => {
  const qs = [
    question({ question: 'Dup?', options: [{ label: 'one' }] }),
    question({ question: 'Dup?', options: [{ label: 'two (Recommended)' }] }),
  ];
  assert.equal(buildAutoAnswer({ questions: qs }), null);
});

test('fix round 1, M-4b: a question literally named "__proto__" is answered as a real key, not silently dropped by the prototype setter', () => {
  const result = buildAutoAnswer({
    questions: [question({ question: '__proto__', options: [{ label: 'yes (Recommended)' }] })],
  });
  assert.notEqual(result, null);
  const { answers } = result.decision.updatedInput;
  assert.equal(Object.prototype.hasOwnProperty.call(answers, '__proto__'), true);
  assert.equal(answers.__proto__, 'yes (Recommended)');
  assert.equal(Object.getPrototypeOf(answers), Object.prototype, 'the answers object itself is still an ordinary object');
  assert.deepEqual(result.chosen, [{ question: '__proto__', chosenLabel: 'yes (Recommended)' }]);
});
