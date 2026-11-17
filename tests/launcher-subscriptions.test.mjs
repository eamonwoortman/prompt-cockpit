import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createProviderCatalog, supportedEffortsForModel } from '../public/provider-catalog.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function targetValue('), app.indexOf('let resumableGen ='));
const launcherModels = app.slice(app.indexOf('let startModelsRequest ='), app.indexOf('startTargetSelect.addEventListener'));
function selectStub() {
  return {
    children: [], value: '', hidden: false,
    get options() { return this.children; },
    set innerHTML(_) { this.children = []; this.value = ''; },
    append(option) { this.children.push(option); },
  };
}
function setup(remembered = 'claude:gmail', subscriptions = [{ id: 'default', label: 'Default' }, { id: 'gmail', label: 'Gmail' }], subscriptionsError, others = [{ id: 'codex', launch: { accountLimits: true } }]) {
  const target = selectStub();
  target.value = 'claude:';
  const model = selectStub();
  const context = vm.createContext({
    URLSearchParams, encodeURIComponent, supportedEffortsForModel,
    startTargetSelect: target, startSubscriptionError: { hidden: true, textContent: '' },
    startModelSelect: model, startEffortSelect: selectStub(), startClaudeEffortSelect: selectStub(),
    THINKING_BUDGET_PRESETS: [],
    providerCatalog: createProviderCatalog({ providers: [
      { id: 'claude', launch: { dynamicModels: true, accountLimits: true, subscriptions, subscriptionsError } },
      ...others,
    ] }),
    localStorage: { getItem: () => remembered },
    document: { createElement: () => ({}) },
    console,
  });
  context.launchConfig = (id) => context.providerCatalog.get(id)?.launch || {};
  vm.runInContext(source, context);
  return { context, target, model };
}

test('one dropdown lists every provider and account, and restores the remembered target', () => {
  const ui = setup();
  ui.context.fillStartTargets();
  assert.equal(ui.target.hidden, false);
  assert.deepEqual(ui.target.children.map((option) => option.value), ['claude:default', 'claude:gmail', 'codex:']);
  assert.deepEqual(ui.target.children.map((option) => option.textContent), ['Claude - Default', 'Claude - Gmail', 'Codex']);
  assert.equal(ui.target.value, 'claude:gmail');
  assert.equal(ui.context.selectedProvider(), 'claude');
  assert.equal(ui.context.selectedSubscription(), 'gmail');
  ui.target.value = 'codex:';
  assert.equal(ui.context.selectedProvider(), 'codex');
  assert.equal(ui.context.selectedSubscription(), undefined);
  ui.target.value = 'claude:default';
  assert.equal(ui.context.selectedSubscription(), 'default');
});

test('a provider with a single account is listed by its own name, and the choice survives a refill', () => {
  const ui = setup('claude:gmail', [{ id: 'default', label: 'Default' }]);
  ui.context.fillStartTargets();
  assert.deepEqual(ui.target.children.map((option) => option.textContent), ['Claude', 'Codex']);
  assert.equal(ui.target.value, 'claude:default'); // the remembered extra account no longer exists
  assert.equal(ui.context.selectedSubscription(), 'default');
  ui.target.value = 'codex:';
  ui.context.fillStartTargets();
  assert.equal(ui.target.value, 'codex:');
});

test('an obsolete stored target falls back to the first entry', () => {
  const ui = setup('removed:account');
  ui.context.fillStartTargets();
  assert.equal(ui.target.value, 'claude:default');
  assert.equal(ui.context.selectedSubscription(), 'default');
});

test('the dropdown hides when there is only one choice', () => {
  const ui = setup('', [{ id: 'default', label: 'Default' }], undefined, []);
  ui.context.fillStartTargets();
  assert.equal(ui.target.children.length, 1);
  assert.equal(ui.target.hidden, true);
});

test('late model discovery from another account cannot overwrite the selected account catalog', async () => {
  const ui = setup('claude:default');
  const requests = [];
  ui.context.launchConfig = () => ui.context.providerCatalog.get('claude').launch;
  ui.context.launchModels = () => [];
  ui.context.fetch = (url) => new Promise((resolve) => requests.push({ url, resolve }));
  vm.runInContext(launcherModels, ui.context);
  ui.context.fillStartTargets();
  const defaults = ui.context.fillStartModels();
  ui.target.value = 'claude:gmail';
  const gmail = ui.context.fillStartModels();
  assert.equal(requests[0].url, '/api/providers/claude/models?subscription=default');
  assert.equal(requests[1].url, '/api/providers/claude/models?subscription=gmail');
  requests[1].resolve({ ok: true, json: async () => [{ value: 'gmail-model' }] });
  await gmail;
  requests[0].resolve({ ok: true, json: async () => [{ value: 'default-model' }] });
  await defaults;
  assert.equal(ui.model.children[0].value, 'gmail-model');
});

test('an account config error is shown and keeps the selector visible', () => {
  const { context, target } = setup('claude:gmail', [{ id: 'default', label: 'Default' }], 'bad json');
  context.fillStartTargets();
  assert.equal(target.hidden, false);
  assert.equal(context.startSubscriptionError.hidden, false);
  assert.match(context.startSubscriptionError.textContent, /bad json/);
});
