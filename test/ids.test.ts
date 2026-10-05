import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeId, encodeId, ID_PREFIX } from '../src/ids.ts';

const raw = (value: unknown) => ID_PREFIX + Buffer.from(JSON.stringify(value)).toString('base64url');

test('issued IDs round-trip', () => {
  const ids = [
    { kind: 'show', channel: 'ARD', source: 'topic', name: 'Tatort' },
    { kind: 'episode', channel: 'ARTE.DE', source: 'title', name: 'Die Revoluzzer', key: '[1,4,"Die Revoluzzer (4/8)"]' },
    { kind: 'movie', channel: 'ZDF', topic: 'Filme', timestamp: 1_790_000_000, baseTitle: 'Erwartung…' },
  ] as const;
  for (const id of ids) assert.deepEqual(decodeId(encodeId(id)), id);
});

test('IDs of a shape this add-on never issues are rejected', () => {
  // Title-sourced shows exist only on ARTE, topic-sourced ones only elsewhere.
  assert.equal(decodeId(raw({ kind: 'show', channel: 'ARD', source: 'title', name: 'Tatort' })), undefined);
  assert.equal(decodeId(raw({ kind: 'show', channel: 'ARD', source: 'topic', name: '' })), undefined);
  assert.equal(decodeId(raw({ kind: 'show', channel: 'ARD', source: 'topic', name: 'x'.repeat(301) })), undefined);
  assert.equal(decodeId(raw({ kind: 'movie', channel: 'ZDF', topic: 'Filme', timestamp: 1.5, baseTitle: 'X' })), undefined);
  assert.equal(decodeId(`${ID_PREFIX}not-json`), undefined);
});
