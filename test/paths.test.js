import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { resolveInBook } from '../server/paths.js';
import { tempDir, writeFiles } from './helpers.js';

test('resolveInBook accepts paths inside the book, existing or not', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'manuscript/01-a/01-b.md': 'x' });
  assert.equal(await resolveInBook(root, 'manuscript/01-a/01-b.md'), path.join(root, 'manuscript/01-a/01-b.md'));
  assert.equal(await resolveInBook(root, 'outline/new/new.md'), path.join(root, 'outline/new/new.md'));
});

test('resolveInBook refuses escapes, absolute paths and .git', async () => {
  const root = await tempDir();
  for (const bad of ['../x.md', 'manuscript/../../x.md', '/etc/passwd', '.git/config', 'a/.git/x', '', '.', 'a\0b']) {
    await assert.rejects(resolveInBook(root, bad), { status: 400 }, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('resolveInBook refuses symlinks that point outside the book', async () => {
  const root = await tempDir();
  const outside = await tempDir();
  await writeFiles(outside, { 'secret.md': 'nope' });
  await fs.symlink(outside, path.join(root, 'link'));
  await assert.rejects(resolveInBook(root, 'link/secret.md'), { status: 400 });
  await assert.rejects(resolveInBook(root, 'link/new.md'), { status: 400 });
});
