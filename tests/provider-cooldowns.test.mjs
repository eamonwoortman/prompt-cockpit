// Durable per-provider cooldowns: survive a restart, keep hit history across a
// clear, and never let an in-flight load clobber a record made meanwhile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProviderCooldowns } from '../src/provider-cooldowns.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'cockpit-provider-cooldowns-'));
  return path.join(dir, 'provider-cooldowns.json');
}

test('record then activeProviders reports the provider until resetsAt passes', async () => {
  const store = createProviderCooldowns({ filePath: tmpFile(), now: () => 1000 });
  await store.record('claude', { resetsAt: 5000, rateLimitType: 'five_hour' });
  assert.deepEqual([...store.activeProviders(4999)], ['claude']);
  assert.deepEqual([...store.activeProviders(5000)], []);
});

test('an unknown resetsAt stays active until cleared or until the TTL passes', async () => {
  const store = createProviderCooldowns({ filePath: tmpFile(), now: () => 1000, unknownResetTtlMs: 10_000 });
  await store.record('claude', { resetsAt: null, rateLimitType: null });
  assert.ok(store.activeProviders(10_999).has('claude'));
  assert.equal(store.activeProviders(11_000).has('claude'), false);
  await store.record('claude', { resetsAt: null, rateLimitType: null });
  await store.clear('claude');
  assert.equal(store.activeProviders(1000).has('claude'), false);
});

test('clear keeps hit history for recentlyHit', async () => {
  let t = 1000;
  const store = createProviderCooldowns({ filePath: tmpFile(), now: () => t });
  await store.record('claude', { resetsAt: 9000, rateLimitType: 'five_hour' });
  t = 1500;
  await store.clear('claude');
  assert.equal(store.activeProviders(1500).size, 0);
  assert.equal(store.recentlyHit('claude', 60_000, 1500 + 59_000), true);
  assert.equal(store.recentlyHit('claude', 60_000, 1000 + 60_001), false);
});

test('record keeps firstSeenAt within an episode and starts a new one after clear', async () => {
  let t = 1000;
  const store = createProviderCooldowns({ filePath: tmpFile(), now: () => t });
  await store.record('claude', { resetsAt: 9000, rateLimitType: 'five_hour' });
  t = 2000;
  await store.record('claude', { resetsAt: 9500, rateLimitType: 'five_hour' });
  assert.deepEqual(store.get('claude'), { resetsAt: 9500, rateLimitType: 'five_hour', firstSeenAt: 1000, lastSeenAt: 2000, clearedAt: null });
  t = 3000; await store.clear('claude');
  t = 4000; await store.record('claude', { resetsAt: 9900, rateLimitType: 'five_hour' });
  assert.equal(store.get('claude').firstSeenAt, 4000);
  assert.equal(store.get('claude').clearedAt, null);
});

test('state and history survive a reload from disk', async () => {
  const filePath = tmpFile();
  const a = createProviderCooldowns({ filePath, now: () => 1000 });
  await a.record('claude', { resetsAt: 9000, rateLimitType: 'seven_day' });
  await a.clear('claude');
  const b = createProviderCooldowns({ filePath, now: () => 1000 });
  await b.load();
  assert.equal(b.get('claude').rateLimitType, 'seven_day');
  assert.equal(b.recentlyHit('claude', 60_000, 1000), true);
});

test('load tolerates a missing or corrupt file', async () => {
  const missing = createProviderCooldowns({ filePath: tmpFile() });
  await missing.load();
  assert.equal(missing.activeProviders().size, 0);
  const filePath = tmpFile();
  fs.writeFileSync(filePath, '{not json');
  const corrupt = createProviderCooldowns({ filePath, now: () => 1000 });
  await corrupt.load();
  assert.equal(corrupt.activeProviders(1000).size, 0);
  await corrupt.record('claude', { resetsAt: 9000, rateLimitType: null });
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).providers.claude.resetsAt, 9000);
});

test('a record made before load finishes is not overwritten by the load', async () => {
  const filePath = tmpFile();
  fs.writeFileSync(filePath, JSON.stringify({ providers: { grok: { resetsAt: 9000, rateLimitType: null, firstSeenAt: 1, lastSeenAt: 1, clearedAt: null } } }));
  const store = createProviderCooldowns({ filePath, now: () => 1000 });
  const loading = store.load();
  const recording = store.record('claude', { resetsAt: 8000, rateLimitType: null });
  await Promise.all([loading, recording]);
  assert.deepEqual([...store.activeProviders(1000)].sort(), ['claude', 'grok']);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')).providers;
  assert.ok(onDisk.claude && onDisk.grok);
});

test('concurrent writes land in call order', async () => {
  const filePath = tmpFile();
  const store = createProviderCooldowns({ filePath, now: () => 1000 });
  store.record('claude', { resetsAt: 9000, rateLimitType: null });
  store.clear('claude');
  await store.flush();
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).providers.claude.clearedAt, 1000);
});

test('flush resolves only after queued writes have landed', async () => {
  const filePath = tmpFile();
  const store = createProviderCooldowns({ filePath, now: () => 1000 });
  store.record('claude', { resetsAt: 9000, rateLimitType: null });
  await store.flush();
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).providers.claude.resetsAt, 9000);
});
