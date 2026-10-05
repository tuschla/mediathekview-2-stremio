import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryText } from '../src/mvw.ts';

test('query text is spelled the way the API indexes it', () => {
  assert.equal(queryText('Janáček, Händel, Wałęsa, Þór'), 'Janacek, Haendel, Walesa, Thor');
  assert.equal(queryText('Verbraucherschutzministerin'), 'Verbraucherschutzminister');
  assert.equal(queryText('Gebärdensprachdolmetscherin'), 'Gebaerdensprachdolmetsche');
});
