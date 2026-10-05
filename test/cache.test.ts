import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TtlCache } from '../src/cache.ts';

const fail = () => Promise.reject(new Error('API down'));

function counting(result: () => Promise<string>) {
  const load = () => {
    load.calls++;
    return result();
  };
  load.calls = 0;
  return load;
}

test('concurrent lookups of a key share one load', async () => {
  const cache = new TtlCache<number>({ ttlMs: 60_000, failureTtlMs: 0, maxEntries: 10 });
  let loads = 0;
  const load = async () => ++loads;
  assert.deepEqual(await Promise.all([cache.get('k', load), cache.get('k', load)]), [1, 1]);
  assert.equal(loads, 1);
});

test('a failed reload serves the previous value and retries after the failure TTL', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'] });
  const cache = new TtlCache<string>({ ttlMs: 1000, failureTtlMs: 100, maxEntries: 10 });
  assert.equal(await cache.get('k', async () => 'old'), 'old');
  t.mock.timers.tick(1001);
  const failing = counting(fail);
  assert.equal(await cache.get('k', failing), 'old');
  assert.equal(await cache.get('k', failing), 'old');
  assert.equal(failing.calls, 1);
  t.mock.timers.tick(101);
  assert.equal(await cache.get('k', async () => 'new'), 'new');
});

test('a failure is remembered for the failure TTL, a transient one not at all', async () => {
  const remembering = new TtlCache<string>({ ttlMs: 60_000, failureTtlMs: 60_000, maxEntries: 10 });
  const failing = counting(fail);
  await assert.rejects(remembering.get('k', failing), /API down/);
  await assert.rejects(remembering.get('k', failing), /API down/);
  assert.equal(failing.calls, 1);

  const transient = new TtlCache<string>({ ttlMs: 60_000, failureTtlMs: 60_000, maxEntries: 10, isTransient: () => true });
  await assert.rejects(transient.get('k', fail), /API down/);
  assert.equal(await transient.get('k', async () => 'fresh'), 'fresh');
});

test('eviction drops the least recently used entries, by count and by weight', async () => {
  const byCount = new TtlCache<string>({ ttlMs: 60_000, failureTtlMs: 0, maxEntries: 2 });
  await byCount.get('a', async () => 'a');
  await byCount.get('b', async () => 'b');
  await byCount.get('a', fail); // hit, marks "a" as recently used
  await byCount.get('c', async () => 'c');
  assert.equal(await byCount.get('a', fail), 'a');
  assert.equal(await byCount.get('b', async () => 'reloaded'), 'reloaded');

  const byWeight = new TtlCache<string>({ ttlMs: 60_000, failureTtlMs: 0, maxEntries: 10, weigh: (v) => v.length, maxWeight: 5 });
  await byWeight.get('a', async () => 'aaa');
  await byWeight.get('b', async () => 'bbb');
  assert.equal(await byWeight.get('b', fail), 'bbb');
  assert.equal(await byWeight.get('a', async () => 'reloaded'), 'reloaded');
});

test('values kept for serving stale still count towards the weight bound', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'] });
  const cache = new TtlCache<string>({ ttlMs: 1000, failureTtlMs: 60_000, maxEntries: 10, weigh: (v) => v.length, maxWeight: 5 });
  await cache.get('a', async () => 'aaa');
  t.mock.timers.tick(1001);
  assert.equal(await cache.get('a', fail), 'aaa');
  await cache.get('b', async () => 'bbb');
  assert.equal(await cache.get('a', async () => 'reloaded'), 'reloaded');
});
