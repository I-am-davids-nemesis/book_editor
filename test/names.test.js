import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareOrdered, parseChapterName, parseSceneName, slugify, titleize } from '../server/names.js';

test('titleize keeps small words lowercase except the first', () => {
  assert.equal(titleize('the-washing-house'), 'The Washing House');
  assert.equal(titleize('lord-of-the-rings'), 'Lord of the Rings');
  assert.equal(titleize('a_night_build'), 'A Night Build');
});

test('slugify makes ASCII hyphenated slugs', () => {
  assert.equal(slugify('The Washing House'), 'the-washing-house');
  assert.equal(slugify("Tor's Café — Night!"), 'tors-cafe-night');
  assert.equal(slugify('  --  '), '');
});

test('parseChapterName reads prefixes and tolerates unprefixed folders', () => {
  assert.deepEqual(parseChapterName('03-the-courtyard'), { name: '03-the-courtyard', prefix: 3, slug: 'the-courtyard', title: 'The Courtyard' });
  assert.equal(parseChapterName('drafts').prefix, null);
  assert.equal(parseChapterName('drafts').title, 'Drafts');
});

test('parseSceneName separates the reserved variant segment', () => {
  const plain = parseSceneName('02-dorgal-arrives.md');
  assert.equal(plain.prefix, 2);
  assert.equal(plain.slug, 'dorgal-arrives');
  assert.equal(plain.variant, null);
  assert.equal(plain.base, '02-dorgal-arrives.md');

  const variant = parseSceneName('02-dorgal-arrives.camera.md');
  assert.equal(variant.variant, 'camera');
  assert.equal(variant.base, '02-dorgal-arrives.md');

  const loose = parseSceneName('ideas.md');
  assert.equal(loose.prefix, null);
  assert.equal(loose.base, 'ideas.md');

  assert.equal(parseSceneName('picture.png'), null);
});

test('compareOrdered sorts numerically, unprefixed last', () => {
  const names = ['10-ten', 'zeta', '02-two', 'alpha', '01-one'];
  const sorted = names.map((n) => parseChapterName(n)).sort(compareOrdered).map((c) => c.name);
  assert.deepEqual(sorted, ['01-one', '02-two', '10-ten', 'alpha', 'zeta']);
});
