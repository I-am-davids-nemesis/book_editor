import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuzzyScore, rankItems } from '../public/js/quickopen.js';

const items = [
  { path: 'manuscript/01-a/01-the-opening.md', label: 'The Opening', detail: 'Chapter One · scene', kind: 'scene' },
  { path: 'outline/01-a/01-the-opening.md', label: 'The Opening', detail: 'Chapter One · plot', kind: 'plot' },
  { path: 'manuscript/02-b/03-dorgal-arrives.md', label: 'Dorgal Arrives', detail: 'Chapter Two · scene', kind: 'scene' },
  { path: 'codex/characters/dorgal.md', label: 'Dorgal', detail: 'character', kind: 'codex' },
  { path: 'codex/locations/washing-house.md', label: 'Washing House', detail: 'location', kind: 'codex' },
];

test('fuzzy matching needs every letter in order', () => {
  assert.equal(fuzzyScore('wh', 'Washing House'), 0); // both at word starts
  assert.ok(fuzzyScore('wsh', 'Washing House') < Infinity);
  assert.equal(fuzzyScore('xyz', 'Washing House'), Infinity);
});

test('ranking prefers tight matches on the label', () => {
  assert.deepEqual(rankItems(items, 'dorgal').map((i) => i.path).slice(0, 2), ['codex/characters/dorgal.md', 'manuscript/02-b/03-dorgal-arrives.md']);
  assert.deepEqual(rankItems(items, 'open plot').map((i) => i.kind), ['plot']);
  assert.equal(rankItems(items, '').length, items.length);
});
