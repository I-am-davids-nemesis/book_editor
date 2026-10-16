import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTree } from '../server/tree.js';
import { SAMPLE_BOOK, tempDir, writeFiles } from './helpers.js';

test('buildTree merges manuscript and outline and flags mismatches', async () => {
  const root = await tempDir();
  await writeFiles(root, SAMPLE_BOOK);
  const tree = await buildTree(root);

  assert.deepEqual(tree.chapters.map((c) => c.name), ['01-the-washing-house', '02-the-courtyard', '03-planned-chapter']);

  const [ch1, ch2, ch3] = tree.chapters;
  assert.equal(ch1.title, 'The Washing House');
  assert.equal(ch1.hasSummary, true);
  assert.equal(ch2.hasSummary, false);
  assert.equal(ch2.inOutline, false);
  assert.equal(ch3.inManuscript, false);

  const scenes = Object.fromEntries(ch1.scenes.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(scenes), ['01-opening.md', '02-dorgal-arrives.md', '03-only-in-manuscript.md', '04-only-in-outline.md']);
  assert.equal(scenes['01-opening.md'].inOutline, true);
  assert.equal(scenes['03-only-in-manuscript.md'].inOutline, false);
  assert.equal(scenes['04-only-in-outline.md'].inManuscript, false);
  assert.equal(scenes['04-only-in-outline.md'].manuscriptPath, 'manuscript/01-the-washing-house/04-only-in-outline.md');

  // The variant hangs off its base scene and doesn't count toward words.
  assert.deepEqual(scenes['02-dorgal-arrives.md'].variants.map((v) => v.variant), ['camera']);
  assert.equal(scenes['02-dorgal-arrives.md'].words, 6);

  assert.equal(ch1.words, 4 + 6 + 4);
  assert.equal(tree.words, 14 + 5);
});

test('buildTree groups the codex and lists loose and root files', async () => {
  const root = await tempDir();
  await writeFiles(root, SAMPLE_BOOK);
  const tree = await buildTree(root);

  assert.deepEqual(tree.codex.characters.map((c) => [c.folder, c.name]), [['', 'tor.md'], ['supporting', 'davie.md']]);
  assert.deepEqual(tree.codex.locations.map((c) => c.path), ['codex/locations/washing-house.md']);
  assert.deepEqual(tree.codex.notes.map((c) => c.path), ['codex/canon-notes.md']);
  assert.deepEqual(tree.codex.templates.map((c) => c.path), ['codex/_templates/character.md']);
  assert.deepEqual(tree.looseManuscript.map((f) => f.path), ['manuscript/notes-to-self.md']);
  assert.deepEqual(tree.rootFiles.map((f) => f.name), ['AGENTS.md', 'README.md']);
});

test('buildTree handles an empty folder', async () => {
  const root = await tempDir();
  const tree = await buildTree(root);
  assert.deepEqual(tree.chapters, []);
  assert.equal(tree.words, 0);
  assert.deepEqual(tree.codex.characters, []);
});

test('buildTree reports modes and per-mode word counts', async () => {
  const root = await tempDir();
  await writeFiles(root, {
    'manuscript/01-a/01-one.camera.md': 'one two',
    'manuscript/01-a/01-one.rotating-third.md': 'one two three',
    'manuscript/01-a/02-two.camera.md': 'four',
    'outline/01-a/01-one.md': 'plot',
  });
  const tree = await buildTree(root);
  assert.deepEqual(tree.modes, ['camera', 'rotating-third']);
  assert.equal(tree.hasBaseScenes, false);
  const [one, two] = tree.chapters[0].scenes;
  assert.equal(one.inManuscript, true);
  assert.equal(one.hasBase, false);
  assert.deepEqual(one.variants.map((v) => [v.variant, v.words]), [['camera', 2], ['rotating-third', 3]]);
  assert.deepEqual(two.wordsByMode, { camera: 1 });
  assert.deepEqual(tree.chapters[0].wordsByMode, { camera: 3, 'rotating-third': 3 });
  assert.deepEqual(tree.wordsByMode, { camera: 3, 'rotating-third': 3 });
});
