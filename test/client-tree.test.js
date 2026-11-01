import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTree } from '../server/tree.js';
import { companionOf, isNewWork, setFileWords, workOf } from '../public/js/tree.js';
import { tempDir, writeFiles } from './helpers.js';

async function modesBook() {
  const root = await tempDir();
  await writeFiles(root, {
    'manuscript/01-a/01-one.camera.md': 'one two',
    'manuscript/01-a/01-one.rotating-third.md': 'one two three',
    'manuscript/01-a/02-two.camera.md': 'four',
    'manuscript/02-b/01-plain.md': 'five six',
    'outline/01-a/01-one.md': 'plot',
    'outline/01-a/02-two.md': 'plot',
    'outline/01-a/_chapter.md': 'chapter',
  });
  return buildTree(root);
}

test('companionOf pairs scenes with plot files, per mode', async () => {
  const tree = await modesBook();
  assert.deepEqual(
    (({ kind, path, exists }) => ({ kind, path, exists }))(companionOf(tree, 'manuscript/01-a/01-one.rotating-third.md', 'camera')),
    { kind: 'plot', path: 'outline/01-a/01-one.md', exists: true },
  );
  assert.equal(companionOf(tree, 'outline/01-a/01-one.md', 'rotating-third').path, 'manuscript/01-a/01-one.rotating-third.md');
  const missing = companionOf(tree, 'outline/01-a/02-two.md', 'rotating-third');
  assert.deepEqual([missing.path, missing.exists], ['manuscript/01-a/02-two.rotating-third.md', false]);
  assert.equal(companionOf(tree, 'manuscript/02-b/01-plain.md', '').exists, false);
  assert.equal(companionOf(tree, 'outline/01-a/_chapter.md', 'camera'), null);
  assert.equal(companionOf(tree, 'codex/x.md', 'camera'), null);
});

test('setFileWords matches what the server would count', async () => {
  const tree = await modesBook();
  setFileWords(tree, 'manuscript/01-a/01-one.camera.md', 10);
  setFileWords(tree, 'manuscript/02-b/01-plain.md', 3);
  assert.equal(setFileWords(tree, 'outline/01-a/01-one.md', 99), null);

  const root = await tempDir();
  await writeFiles(root, {
    'manuscript/01-a/01-one.camera.md': 'w '.repeat(10),
    'manuscript/01-a/01-one.rotating-third.md': 'one two three',
    'manuscript/01-a/02-two.camera.md': 'four',
    'manuscript/02-b/01-plain.md': 'a b c',
    'outline/01-a/01-one.md': 'plot',
    'outline/01-a/02-two.md': 'plot',
    'outline/01-a/_chapter.md': 'chapter',
  });
  const expected = await buildTree(root);
  assert.deepEqual(tree.wordsByMode, expected.wordsByMode);
  assert.equal(tree.words, expected.words);
  assert.deepEqual(tree.chapters.map((c) => [c.words, c.wordsByMode]), expected.chapters.map((c) => [c.words, c.wordsByMode]));
  assert.deepEqual(tree.chapters[0].scenes[0].variants, expected.chapters[0].scenes[0].variants);
});

test('workOf and isNewWork tell when the Claude panel moves to a new scene or chapter', () => {
  assert.deepEqual(workOf('manuscript/01-a/02-two.camera.md'), { chapter: '01-a', scene: '02-two' });
  assert.deepEqual(workOf('outline/01-a/02-two.md'), { chapter: '01-a', scene: '02-two' });
  assert.deepEqual(workOf('outline/01-a/_chapter.md'), { chapter: '01-a', scene: '' });
  assert.equal(workOf('codex/characters/tor.md'), null);
  assert.equal(workOf(null), null);
  const at = (p) => workOf(p);
  assert.equal(isNewWork(at('manuscript/01-a/01-one.md'), at('outline/01-a/01-one.md')), false);
  assert.equal(isNewWork(at('manuscript/01-a/01-one.camera.md'), at('manuscript/01-a/01-one.rotating-third.md')), false);
  assert.equal(isNewWork(at('manuscript/01-a/01-one.md'), at('manuscript/01-a/02-two.md')), true);
  assert.equal(isNewWork(at('outline/01-a/_chapter.md'), at('manuscript/01-a/02-two.md')), false);
  assert.equal(isNewWork(at('manuscript/01-a/02-two.md'), at('outline/01-a/_chapter.md')), false);
  assert.equal(isNewWork(at('outline/01-a/_chapter.md'), at('outline/02-b/_chapter.md')), true);
  assert.equal(isNewWork(at('manuscript/01-a/01-one.md'), at('codex/characters/tor.md')), false);
  assert.equal(isNewWork(null, at('manuscript/01-a/01-one.md')), false);
});
