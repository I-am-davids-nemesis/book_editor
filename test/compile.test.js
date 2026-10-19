import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { compile, readSettings } from '../server/compile.js';
import { gitBook, tempDir, writeFiles } from './helpers.js';

const BOOK = {
  '.gitignore': 'compiled/\n',
  'manuscript/01-the-washing-house/01-opening.md': 'The bell struck one.\n\n* * *\n\nLater.\n',
  'manuscript/01-the-washing-house/02-dorgal-arrives.md': '\nDorgal came in.\n\n',
  'manuscript/01-the-washing-house/02-dorgal-arrives.camera.md': 'CAMERA: Dorgal came in.\n',
  'manuscript/02-the-courtyard/01-sparring.camera.md': 'Steel rang.\n',
  'outline/03-planned/_chapter.md': 'later\n',
  'outline/01-the-washing-house/03-only-planned.md': 'plot only\n',
};

test('compiles the book in the plain mode with default separators', async () => {
  const root = await gitBook(BOOK);
  const r = await compile(root, { scope: 'book', mode: '' });
  assert.equal(r.path, 'compiled/book.md');
  assert.equal(r.content, [
    '# The Washing House\n\nThe bell struck one.\n\n* * *\n\nLater.\n\n* * *\n\nDorgal came in.\n',
    '',
  ].join(''));
  assert.equal(r.chapters, 1);
  assert.equal(r.scenes, 2);
  assert.deepEqual(r.warnings, ['02-the-courtyard: “Sparring” has no main version']);
  assert.equal(await fs.readFile(path.join(root, r.path), 'utf8'), r.content);
});

test('a mode uses its variants, and plain files fill in for scenes without one', async () => {
  const root = await gitBook(BOOK);
  const r = await compile(root, { scope: 'book', mode: 'camera', separator: '⁂' });
  assert.equal(r.path, 'compiled/book.camera.md');
  assert.equal(r.content, '# The Washing House\n\nThe bell struck one.\n\n* * *\n\nLater.\n\n⁂\n\nCAMERA: Dorgal came in.\n\n# The Courtyard\n\nSteel rang.\n');
  assert.deepEqual(r.warnings, []);
});

test('one chapter, and a remembered separator', async () => {
  const root = await gitBook(BOOK);
  const r = await compile(root, { scope: 'chapter', chapter: '02-the-courtyard', mode: 'camera', separator: '⁂', remember: true });
  assert.equal(r.path, 'compiled/02-the-courtyard.camera.md');
  assert.deepEqual(await readSettings(root), { compile: { sceneSeparator: '⁂' } });
  const again = await compile(root, { scope: 'book', mode: 'camera' });
  assert.equal(again.separator, '⁂');
});

test('refuses bad input and warns when compiled/ would be committed', async () => {
  const root = await gitBook({ ...BOOK, '.gitignore': '' });
  await assert.rejects(compile(root, { scope: 'chapter', chapter: '09-nope' }), /No chapter/);
  await assert.rejects(compile(root, { mode: '../x' }), /Invalid mode/);
  await assert.rejects(compile(root, { mode: 'stormy' }), /no stormy mode/);
  await assert.rejects(compile(root, { separator: 'a\nb' }), /one short line/);
  const r = await compile(root, { mode: 'camera' });
  assert.ok(r.warnings.some((w) => w.includes('not in .gitignore')));

  const empty = await tempDir();
  await writeFiles(empty, { 'manuscript/01-a/01-x.md': '   \n' });
  await assert.rejects(compile(empty, {}), /Nothing to compile/);
});

test('bin/compile.mjs compiles every chapter and mode, or one chapter', async () => {
  const { execFileSync } = await import('node:child_process');
  const cli = path.resolve(import.meta.dirname, '../bin/compile.mjs');
  const root = await gitBook({ ...BOOK, 'book.json': '{"compile":{"sceneSeparator":"⁂"}}' });
  const out = execFileSync(process.execPath, [cli], { cwd: root, encoding: 'utf8' });
  assert.match(out, /compiled\/book\.camera\.md {2}2 chapters/);
  assert.match(out, /compiled\/book\.md {2}1 chapters/);
  const camera = await fs.readFile(path.join(root, 'compiled/book.camera.md'), 'utf8');
  assert.ok(camera.includes('\n\n⁂\n\n'));
  const one = execFileSync(process.execPath, [cli, root, '2', '--mode', 'camera'], { encoding: 'utf8' });
  assert.equal(one.trim(), 'compiled/02-the-courtyard.camera.md  1 scenes, 4 words'); // heading + "Steel rang."
});
