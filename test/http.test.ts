import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, mock, test } from 'node:test';
import { NotFoundError, type Addon } from '../src/addon.ts';
import { createHandler } from '../src/http.ts';
import { OverloadedError, UpstreamError } from '../src/upstream.ts';

const calls: unknown[][] = [];
const stub = {
  manifest: () => ({}),
  catalog: async (type: string, id: string, extra: URLSearchParams, baseUrl: string) => {
    calls.push([type, id, Object.fromEntries(extra), baseUrl]);
    return { metas: [], cacheMaxAge: 60 };
  },
  meta: async (_type: string, id: string) => {
    if (id === 'upstream') throw new UpstreamError('down');
    if (id === 'busy') throw new OverloadedError('too many queued requests');
    if (id === 'bug') throw new TypeError('secret detail');
    throw new NotFoundError('nope');
  },
  stream: async () => ({ streams: [], cacheMaxAge: 0 }),
  image: async () => undefined,
} as unknown as Addon;

const server = createServer(createHandler(stub, undefined));
let port: number;

before(async () => {
  for (const method of ['log', 'warn', 'error'] as const) mock.method(console, method, () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(path: string, { host = `127.0.0.1:${port}` } = {}): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
  })
    .on('error', reject)
    .end();
  return promise;
}

test('catalog routes decode dotted ids and urlencoded extras', async () => {
  calls.length = 0;
  assert.equal((await send('/catalog/series/arte.de.series.json')).status, 200);
  assert.equal((await send('/catalog/series/search.series/search=a%20b%2Fc&skip=100.json', { host: 'mediathek_addon:7000' })).status, 200);
  assert.deepEqual(calls, [
    ['series', 'arte.de.series', {}, `http://127.0.0.1:${port}`],
    ['series', 'search.series', { search: 'a b/c', skip: '100' }, 'http://mediathek_addon:7000'],
  ]);
});

test('catalog routes accept unencoded extras', async () => {
  const searched = async (path: string) => {
    calls.length = 0;
    assert.equal((await send(path)).status, 200, path);
    return calls[0]![2];
  };
  assert.deepEqual(await searched('/catalog/series/search.series/search=AC/DC.json'), { search: 'AC/DC' });
  assert.deepEqual(await searched('/catalog/series/search.series/search=Wer%20wei%C3%9F%20denn%20sowas?.json'), {
    search: 'Wer weiß denn sowas?',
  });
  assert.deepEqual(await searched('/catalog/series/search.series/skip=100&search=Tom%20&%20Jerry.json'), { skip: '100', search: 'Tom & Jerry' });
  assert.deepEqual(await searched('/catalog/series/search.series/search=C++.json'), { search: 'C++' });
  // A query string after the resource path is not part of it.
  assert.deepEqual(await searched('/catalog/series/ard.series.json?x=1'), {});
});

test('client mistakes are 4xx, upstream failures 502, overload 503, bugs 500 without details', async () => {
  assert.equal((await send('/meta/series/%E0%A4%A.json')).status, 400);
  assert.equal((await send('/nope')).status, 404);
  assert.equal((await send('/meta/series/upstream.json')).status, 502);
  const busy = await send('/meta/series/busy.json');
  assert.deepEqual([busy.status, busy.headers['retry-after']], [503, '10']);
  const bug = await send('/meta/series/bug.json');
  assert.equal(bug.status, 500);
  assert.doesNotMatch(bug.body, /secret/);
});
