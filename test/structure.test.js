import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  addChapter, addScene, createMissing, deleteChapter, deleteScene,
  renameChapter, renameScene, reorderChapters, reorderScenes,
} from '../server/structure.js';
import { gitBook, gitIn, listFiles, tempDir, writeFiles } from './helpers.js';

const read = (root, rel) => fs.readFile(path.join(root, rel), 'utf8');

// Three chapters; chapter one has three scenes, one with a variant.
const BOOK = {
  'manuscript/01-alpha/01-one.md': 'one',
  'manuscript/01-alpha/02-two.md': 'two',
  'manuscript/01-alpha/02-two.camera.md': 'two camera',
  'manuscript/01-alpha/03-three.md': 'three',
  'outline/01-alpha/_chapter.md': 'alpha summary',
  'outline/01-alpha/01-one.md': 'plot one',
  'outline/01-alpha/02-two.md': 'plot two',
  'outline/01-alpha/03-three.md': 'plot three',
  'manuscript/02-beta/01-b.md': 'b',
  'outline/02-beta/_chapter.md': 'beta summary',
  'outline/02-beta/01-b.md': 'plot b',
  'manuscript/03-gamma/01-g.md': 'g',
  'outline/03-gamma/_chapter.md': 'gamma summary',
};

test('reorderScenes swaps scenes with their plot files and variants', async () => {
  const root = await gitBook(BOOK);
  const res = await reorderScenes(root, '01-alpha', { order: ['03-three.md', '02-two.md', '01-one.md'] });

  assert.equal(await read(root, 'manuscript/01-alpha/01-three.md'), 'three');
  assert.equal(await read(root, 'outline/01-alpha/01-three.md'), 'plot three');
  assert.equal(await read(root, 'manuscript/01-alpha/03-one.md'), 'one');
  assert.equal(await read(root, 'outline/01-alpha/03-one.md'), 'plot one');
  assert.equal(await read(root, 'manuscript/01-alpha/02-two.camera.md'), 'two camera', 'unmoved scene keeps its variant');
  assert.ok(res.moves.some((m) => m.from === 'manuscript/01-alpha/01-one.md' && m.to === 'manuscript/01-alpha/03-one.md'));

  // git sees renames, so history follows the files.
  const status = gitIn(root, 'status', '--porcelain');
  assert.match(status, /^R {2}manuscript\/01-alpha\/01-one\.md -> manuscript\/01-alpha\/03-one\.md$/m);
  assert.doesNotMatch(status, /\.moving-/, 'no temporary names left');
});

test('reorderChapters moves both trees and renames variants along with scenes', async () => {
  const root = await gitBook(BOOK);
  await reorderChapters(root, { order: ['02-beta', '03-gamma', '01-alpha'] });
  const files = await listFiles(root);
  assert.ok(files.includes('manuscript/03-alpha/02-two.camera.md'));
  assert.ok(files.includes('outline/03-alpha/_chapter.md'));
  assert.ok(files.includes('manuscript/01-beta/01-b.md'));
  assert.ok(files.includes('outline/02-gamma/_chapter.md'));
  assert.ok(!files.some((f) => f.includes('01-alpha')));
});

test('reorder validates the order list', async () => {
  const root = await gitBook(BOOK);
  await assert.rejects(reorderChapters(root, { order: ['01-alpha', '02-beta'] }), { status: 400 }, 'missing one');
  await assert.rejects(reorderChapters(root, { order: ['01-alpha', '02-beta', '03-gamma', '../x'] }), { status: 400 }, 'unknown');
  await assert.rejects(reorderChapters(root, { order: ['01-alpha', '01-alpha', '02-beta', '03-gamma'] }), { status: 400 }, 'duplicate');
  await assert.rejects(reorderScenes(root, '09-nope', { order: [] }), { status: 404 });
});

test('addScene inserts at a position and renumbers the rest', async () => {
  const root = await gitBook(BOOK);
  const res = await addScene(root, '01-alpha', { title: 'The New One', position: 2 });
  assert.equal(res.scene, '02-the-new-one.md');
  const ms = (await listFiles(root)).filter((f) => f.startsWith('manuscript/01-alpha/'));
  assert.deepEqual(ms, [
    'manuscript/01-alpha/01-one.md',
    'manuscript/01-alpha/02-the-new-one.md',
    'manuscript/01-alpha/03-two.camera.md',
    'manuscript/01-alpha/03-two.md',
    'manuscript/01-alpha/04-three.md',
  ]);
  assert.equal(await read(root, 'manuscript/01-alpha/02-the-new-one.md'), '');
  assert.match(await read(root, 'outline/01-alpha/02-the-new-one.md'), /^# The New One\n/);
  assert.deepEqual(res.created, ['manuscript/01-alpha/02-the-new-one.md', 'outline/01-alpha/02-the-new-one.md']);
});

test('addScene appends by default and uses the book template when present', async () => {
  const root = await gitBook({ ...BOOK, 'codex/_templates/scene-outline.md': 'Custom: {{scene}} in {{chapter}}\n' });
  const res = await addScene(root, '02-beta', { title: 'Later' });
  assert.equal(res.scene, '02-later.md');
  assert.equal(await read(root, 'outline/02-beta/02-later.md'), 'Custom: Later in Beta\n');
});

test('prefix width grows past 99 and shrinks back', async () => {
  const files = {};
  for (let i = 1; i <= 99; i++) files[`manuscript/01-c/${String(i).padStart(2, '0')}-s${i}.md`] = String(i);
  const root = await gitBook(files);
  await addScene(root, '01-c', { title: 'Hundredth' });
  let names = (await fs.readdir(path.join(root, 'manuscript/01-c'))).sort();
  assert.equal(names[0], '001-s1.md');
  assert.equal(names[99], '100-hundredth.md');

  await deleteScene(root, '01-c', '100-hundredth.md');
  names = (await fs.readdir(path.join(root, 'manuscript/01-c'))).sort();
  assert.equal(names[0], '01-s1.md');
  assert.equal(names.length, 99);
});

test('addChapter creates both folders and a chapter summary', async () => {
  const root = await gitBook(BOOK);
  const res = await addChapter(root, { title: 'Delta', position: 1 });
  assert.equal(res.chapter, '01-delta');
  const files = await listFiles(root);
  assert.ok(files.includes('outline/01-delta/_chapter.md'));
  assert.ok((await fs.stat(path.join(root, 'manuscript/01-delta'))).isDirectory());
  assert.ok(files.includes('manuscript/02-alpha/01-one.md'));
  assert.ok(files.includes('outline/04-gamma/_chapter.md'));
  assert.match(await read(root, 'outline/01-delta/_chapter.md'), /^# Delta\n/);
});

test('rename keeps the number and renames every file of the scene', async () => {
  const root = await gitBook(BOOK);
  const res = await renameScene(root, '01-alpha', '02-two.md', { title: 'Second Thoughts' });
  assert.equal(res.scene, '02-second-thoughts.md');
  const files = await listFiles(root);
  for (const f of ['manuscript/01-alpha/02-second-thoughts.md', 'manuscript/01-alpha/02-second-thoughts.camera.md', 'outline/01-alpha/02-second-thoughts.md']) {
    assert.ok(files.includes(f), f);
  }
  assert.ok(!files.some((f) => f.includes('02-two')));

  const ch = await renameChapter(root, '02-beta', { title: 'Bravo' });
  assert.equal(ch.chapter, '02-bravo');
  assert.ok((await listFiles(root)).includes('outline/02-bravo/01-b.md'));

  await assert.rejects(renameChapter(root, '03-gamma', { title: '!!!' }), { status: 400 });
});

test('deleting a chapter or scene removes both sides and closes the gap', async () => {
  const root = await gitBook(BOOK);
  const res = await deleteScene(root, '01-alpha', '02-two.md');
  assert.deepEqual(res.deleted.sort(), ['manuscript/01-alpha/02-two.camera.md', 'manuscript/01-alpha/02-two.md', 'outline/01-alpha/02-two.md']);
  assert.ok((await listFiles(root)).includes('outline/01-alpha/02-three.md'));

  await deleteChapter(root, '01-alpha');
  const files = await listFiles(root);
  assert.ok(!files.some((f) => f.includes('alpha')));
  assert.ok(files.includes('manuscript/01-beta/01-b.md'));
  assert.ok(files.includes('outline/02-gamma/_chapter.md'));
});

test('untracked files and books without git can be reordered', async () => {
  const root = await gitBook(BOOK);
  await writeFiles(root, { 'manuscript/01-alpha/04-new.md': 'untracked' });
  await reorderScenes(root, '01-alpha', { order: ['04-new.md', '01-one.md', '02-two.md', '03-three.md'] });
  assert.equal(await read(root, 'manuscript/01-alpha/01-new.md'), 'untracked');
  assert.equal(await read(root, 'manuscript/01-alpha/02-one.md'), 'one');

  const plain = await tempDir();
  await writeFiles(plain, BOOK);
  await reorderChapters(plain, { order: ['03-gamma', '02-beta', '01-alpha'] });
  assert.ok((await listFiles(plain)).includes('manuscript/03-alpha/01-one.md'));
});

test('unnumbered entries are left alone unless a reorder includes them', async () => {
  const root = await gitBook({ ...BOOK, 'manuscript/01-alpha/ideas.md': 'loose' });
  await addScene(root, '01-alpha', { title: 'Four' });
  assert.ok((await listFiles(root)).includes('manuscript/01-alpha/ideas.md'));

  await reorderScenes(root, '01-alpha', { order: ['01-one.md', 'ideas.md', '02-two.md', '03-three.md', '04-four.md'] });
  assert.equal(await read(root, 'manuscript/01-alpha/02-ideas.md'), 'loose');
});

test('createMissing fills in the other half of the mirror', async () => {
  const root = await gitBook({
    'manuscript/01-a/01-only-scene.md': 'x',
    'outline/01-a/02-only-plot.md': 'y',
  });
  await createMissing(root, 'outline/01-a/01-only-scene.md');
  assert.match(await read(root, 'outline/01-a/01-only-scene.md'), /^# Only Scene/);
  await createMissing(root, 'manuscript/01-a/02-only-plot.md');
  assert.equal(await read(root, 'manuscript/01-a/02-only-plot.md'), '');
  await createMissing(root, 'outline/01-a/_chapter.md');
  assert.match(await read(root, 'outline/01-a/_chapter.md'), /^# A\n/);

  await assert.rejects(createMissing(root, 'outline/01-a/01-only-scene.md'), { status: 409 });
  await assert.rejects(createMissing(root, 'outline/01-a/09-unknown.md'), { status: 404 });
  await assert.rejects(createMissing(root, 'outline/../../x.md'), { status: 400 });
  await assert.rejects(createMissing(root, 'codex/x.md'), { status: 400 });
});

test('structure operations refuse names that are not in the book', async () => {
  const root = await gitBook(BOOK);
  await assert.rejects(addScene(root, '..', { title: 'x' }), { status: 404 });
  await assert.rejects(deleteChapter(root, '../../etc'), { status: 404 });
  await assert.rejects(deleteScene(root, '01-alpha', '../02-beta'), { status: 404 });
  await assert.rejects(renameScene(root, '01-alpha', '_chapter.md', { title: 'x' }), { status: 404 });
});
