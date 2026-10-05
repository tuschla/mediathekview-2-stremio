import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OverloadedError, Upstream, UpstreamError } from '../src/upstream.ts';

const create = (concurrency: number, queueTimeoutMs = 60_000) => new Upstream({ concurrency, queueTimeoutMs, requestTimeoutMs: 60_000 });

test('runs at most `concurrency` tasks at once and runs every queued task', async () => {
  const upstream = create(2);
  const gate = Promise.withResolvers<void>();
  const twoStarted = Promise.withResolvers<void>();
  let active = 0;
  let peak = 0;
  let finished = 0;
  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    if (active === 2) twoStarted.resolve();
    await gate.promise;
    active--;
    finished++;
  };
  const all = Promise.all(Array.from({ length: 6 }, () => upstream.run(task)));
  await twoStarted.promise;
  gate.resolve();
  await all;
  assert.equal(peak, 2);
  assert.equal(finished, 6);
});

test('rejects instead of queueing more than 100 tasks', async () => {
  const upstream = create(1);
  const gate = Promise.withResolvers<void>();
  const running = upstream.run(() => gate.promise);
  const queued = Array.from({ length: 100 }, () => upstream.run(async () => 'queued'));
  await assert.rejects(upstream.run(async () => 'overflow'), OverloadedError);
  gate.resolve();
  await running;
  assert.equal((await Promise.all(queued)).length, 100);
});

test('a task that waits too long leaves the queue without taking a slot', async () => {
  const upstream = create(1, 10);
  const gate = Promise.withResolvers<void>();
  const running = upstream.run(() => gate.promise);
  let ran = false;
  await assert.rejects(
    upstream.run(async () => {
      ran = true;
    }),
    OverloadedError,
  );
  gate.resolve();
  await running;
  assert.equal(await upstream.run(async () => 'next'), 'next');
  assert.equal(ran, false);
});

test('a failing task releases its slot', async () => {
  const upstream = create(1);
  await assert.rejects(upstream.run(() => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await upstream.run(async () => 'next'), 'next');
});

test('fetch rejects with UpstreamError on 429, 5xx, network errors and failed reads; other statuses reach `read`', async (t) => {
  const server = createServer((req, res) => res.writeHead(Number(req.url!.slice(1))).end('body'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const upstream = create(2);
  const status = (res: Response) => Promise.resolve(res.status);
  assert.equal(await upstream.fetch(`${base}/404`, {}, status), 404);
  await assert.rejects(upstream.fetch(`${base}/429`, {}, status), UpstreamError);
  await assert.rejects(upstream.fetch(`${base}/503`, {}, status), UpstreamError);
  await assert.rejects(upstream.fetch(`${base}/200`, {}, (res) => res.json()), UpstreamError);
  await assert.rejects(upstream.fetch('http://127.0.0.1:1/', {}, status), UpstreamError);
});
