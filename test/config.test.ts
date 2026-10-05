import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

test('invalid settings fail at startup and name the variable', () => {
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
  assert.throws(() => loadConfig({ CATALOG_DEPTH: '1.5' }), /CATALOG_DEPTH/);
  assert.throws(() => loadConfig({ MAX_SHOW_FILMS: '10001' }), /MAX_SHOW_FILMS/);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'ftp://example.com' }), /PUBLIC_URL/);
  assert.throws(() => loadConfig({ CHANNELS: ' , ' }), /CHANNELS/);
});

test('PUBLIC_URL loses trailing slashes, so image links get no double slash', () => {
  assert.equal(loadConfig({ PUBLIC_URL: 'https://example.com/mediathek/' }).publicUrl, 'https://example.com/mediathek');
});
