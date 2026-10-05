import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { findImage } from '../src/images.ts';

const pages: Record<string, (res: ServerResponse) => void> = {
  '/split': (res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const head = `<html><head>${'<link rel="preload">'.repeat(300)}<meta content="/img/a.jpg?w=1&amp;h=2" prop`;
    res.write(head, () => res.end('erty="og:image"></head><body></body></html>'));
  },
  // Never ends: the lookup must stop at </head> rather than wait for the body.
  '/endless': (res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<html><head><title>No artwork</title></head><body>');
  },
  '/json': (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"og:image": "https://cdn.example/a.jpg"}');
  },
};

const server = createServer((req, res) => (pages[req.url!] ?? ((r: ServerResponse) => r.writeHead(404).end()))(res));
let base: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('finds og:image split across chunks, in either attribute order, resolved against the page', async () => {
  assert.equal(await findImage(`${base}/split`), `${base}/img/a.jpg?w=1&h=2`);
});

test('pages without og:image, non-HTML responses and missing pages have no image', async () => {
  assert.equal(await findImage(`${base}/endless`), undefined);
  assert.equal(await findImage(`${base}/json`), undefined);
  assert.equal(await findImage(`${base}/gone`), undefined);
});
