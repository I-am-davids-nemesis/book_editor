import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { forgetBook, getBookRoot, listBooks, registerBook } from '../server/books.js';
import { loadConfig } from '../server/config.js';
import { tempDir, writeFiles } from './helpers.js';

let library;
let config;

beforeEach(async () => {
  const configDir = await tempDir();
  process.env.BOOK_EDITOR_CONFIG = path.join(configDir, 'config.json');
  library = await tempDir();
  config = { ...(await loadConfig()), libraryRoot: library };
});

test('listBooks finds library folders and reads titles from README', async () => {
  await writeFiles(library, {
    'my-book/README.md': '# My Great Book\n',
    'my-book/manuscript/': null,
    'other-book/': null,
    '.hidden/': null,
  });
  await fs.mkdir(path.join(library, 'my-book/.git'));
  const books = await listBooks(config);
  assert.deepEqual(books.map((b) => [b.id, b.title, b.isGit, b.hasManuscript]), [
    ['my-book', 'My Great Book', true, true],
    ['other-book', 'Other Book', false, false],
  ]);
});

test('listBooks tolerates a missing library folder', async () => {
  config.libraryRoot = path.join(library, 'does-not-exist');
  assert.deepEqual(await listBooks(config), []);
});

test('registerBook stores outside folders and reuses ids', async () => {
  const outside = await tempDir();
  const id = await registerBook(config, outside);
  assert.match(id, /^~/);
  assert.equal(await getBookRoot(config, id), outside);
  assert.equal(await registerBook(config, outside), id, 'registering twice returns the same id');

  const saved = await loadConfig();
  assert.equal(saved.registered[id], outside, 'persisted to the config file');

  const books = await listBooks(config);
  assert.equal(books.find((b) => b.id === id).source, 'registered');

  await forgetBook(config, id);
  await assert.rejects(getBookRoot(config, id), { status: 404 });
});

test('registerBook maps a library folder to its library id', async () => {
  await writeFiles(library, { 'lib-book/': null });
  assert.equal(await registerBook(config, path.join(library, 'lib-book')), 'lib-book');
  assert.deepEqual(config.registered, {});
});

test('registerBook rejects bad input', async () => {
  await assert.rejects(registerBook(config, ''), { status: 400 });
  await assert.rejects(registerBook(config, 'relative/path'), { status: 400 });
  await assert.rejects(registerBook(config, path.join(library, 'nope')), { status: 400 });
});

test('getBookRoot refuses ids that try to leave the library', async () => {
  for (const bad of ['..', '.', '../etc', 'a/b', '.git', '~unknown']) {
    await assert.rejects(getBookRoot(config, bad), { status: 404 }, `should refuse ${bad}`);
  }
});
