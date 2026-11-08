import test from 'node:test';
import assert from 'node:assert/strict';
import { combineAngles, diversifyAngles } from './or-search.mjs';

test('OR joins distinct complete branches within the API bound without truncating them', () => {
  assert.deepEqual(combineAngles(['Chateau Heartiste', 'chateau heartiste', 'Roissy blogger']), {
    query: 'Chateau Heartiste | Roissy blogger', angles: ['Chateau Heartiste', 'Roissy blogger'],
  });
  assert.equal(combineAngles(['a'.repeat(150), 'b'.repeat(150)]).query, 'a'.repeat(150));
});

test('angle evaluation balances metadata matches without deleting translated/unknown matches', () => {
  const rows = diversifyAngles([{ title: 'Genetics lecture' }, { title: 'Genetics history' },
    { title: 'Ocean navigation' }, { title: 'Unknown translated title' }], ['Genetics', 'Ocean navigation']);
  assert.deepEqual(rows.map(v => v.title), ['Genetics lecture', 'Ocean navigation', 'Genetics history', 'Unknown translated title']);
});
