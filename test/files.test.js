import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { hashContent, readBookFile, writeBookFile } from '../server/files.js';
import { tempDir, writeFiles } from './helpers.js';

test('read then write with the loaded hash succeeds', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'manuscript/01-a/01-b.md': 'old' });
  const file = await readBookFile(root, 'manuscript/01-a/01-b.md');
  assert.equal(file.content, 'old');
  assert.equal(file.hash, hashContent('old'));

  const res = await writeBookFile(root, file.path, 'new', { baseHash: file.hash });
  assert.equal(res.hash, hashContent('new'));
  assert.equal(await fs.readFile(path.join(root, file.path), 'utf8'), 'new');
  assert.deepEqual((await fs.readdir(path.join(root, 'manuscript/01-a'))), ['01-b.md'], 'no temp files left behind');
});

test('write refuses when the disk changed, unless forced', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'a.md': 'v1' });
  const { hash } = await readBookFile(root, 'a.md');
  await fs.writeFile(path.join(root, 'a.md'), 'changed elsewhere');

  await assert.rejects(writeBookFile(root, 'a.md', 'mine', { baseHash: hash }), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.extra.diskContent, 'changed elsewhere');
    assert.equal(err.extra.diskHash, hashContent('changed elsewhere'));
    return true;
  });

  await writeBookFile(root, 'a.md', 'mine', { force: true });
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'mine');
});

test('write detects a file deleted on disk, and creates new files with a null hash', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'a.md': 'v1' });
  const { hash } = await readBookFile(root, 'a.md');
  await fs.rm(path.join(root, 'a.md'));
  await assert.rejects(writeBookFile(root, 'a.md', 'mine', { baseHash: hash }), (err) => err.status === 409 && err.extra.diskContent === null);

  await writeBookFile(root, 'outline/01-x/01-y.md', 'fresh', { baseHash: null });
  assert.equal(await fs.readFile(path.join(root, 'outline/01-x/01-y.md'), 'utf8'), 'fresh');
});

test('only Markdown files can be read or written', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'notes.txt': 'x' });
  await assert.rejects(readBookFile(root, 'notes.txt'), { status: 400 });
  await assert.rejects(writeBookFile(root, 'x.js', 'x', { baseHash: null }), { status: 400 });
  await assert.rejects(readBookFile(root, 'missing.md'), { status: 404 });
});
