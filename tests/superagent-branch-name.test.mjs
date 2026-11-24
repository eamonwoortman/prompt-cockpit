import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidBranchName, suggestBranch, ticketFromIdea } from '../src/superagent/branch-name.js';

const IDEA = 'https://dev.azure.com/mediatonic/Fall%20Guys%20Client/_workitems/edit/171558 rolling ball bug';
const TITLE = 'Fix root cause: FallGuyCarryObject is used before Start when the rolling ball begins and ends in one update phase';
const job = (over = {}) => ({
  idea: IDEA,
  title: 'Rolling ball',
  branch: 'superagent/rolling-ball',
  branchTemplate: 'bugfix/{ticket}-{description}',
  tasks: [{ id: 't1', title: TITLE }],
  ...over,
});

test('ticketFromIdea finds work item urls, ADO references and long issue numbers', () => {
  assert.equal(ticketFromIdea(IDEA), '171558');
  assert.equal(ticketFromIdea('Fix ADO #170001 crash'), '170001');
  assert.equal(ticketFromIdea('see #12345'), '12345');
  assert.equal(ticketFromIdea('no ticket'), '');
  assert.equal(ticketFromIdea(null), '');
});

test('suggestBranch fills the template from the ticket and the first task title', () => {
  assert.equal(suggestBranch(job()), 'bugfix/171558-fix-root-cause-fallguycarryobject-is-used');
});

test('suggestBranch without a ticket drops the empty segment', () => {
  assert.equal(suggestBranch(job({ idea: 'no ticket' })), 'bugfix/fix-root-cause-fallguycarryobject-is-used');
});

test('suggestBranch uses the job title when there are no tasks', () => {
  assert.equal(suggestBranch(job({ tasks: null })), 'bugfix/171558-rolling-ball');
  assert.equal(suggestBranch(job({ tasks: [] })), 'bugfix/171558-rolling-ball');
});

test('suggestBranch supports {slug}', () => {
  assert.equal(suggestBranch(job({ branchTemplate: 'x/{slug}', slug: 'add-hello' })), 'x/add-hello');
});

test('suggestBranch returns the job branch without a template', () => {
  assert.equal(suggestBranch(job({ branchTemplate: null })), 'superagent/rolling-ball');
});

test('falls back to the job branch when the filled name is invalid', () => {
  assert.equal(suggestBranch(job({ title: '!!!', tasks: null, branchTemplate: 'bugfix/{description}' })), 'superagent/rolling-ball');
});

test('isValidBranchName', () => {
  assert.equal(isValidBranchName('a/b'), true);
  for (const bad of ['a..b', 'a/', '-a', 'a.lock', 'a b', '', '/a', 'a//b', 'a.', 'a@{b', 'a~b', 'a\u0001b']) {
    assert.equal(isValidBranchName(bad), false, bad);
  }
});
