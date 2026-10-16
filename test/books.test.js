import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { createBook, forgetBook, getBookRoot, listBooks, registerBook } from '../server/books.js';
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

test('createBook scaffolds the layout, inits git and commits', async () => {
  const { gitIn, listFiles } = await import('./helpers.js');
  const book = await createBook(config, { title: 'The Builder', remote: 'git@example.com:me/the-builder.git' });
  assert.equal(book.id, 'the-builder');
  assert.equal(book.title, 'The Builder');
  assert.deepEqual(book.warnings, []);
  assert.equal(book.isGit, true);

  const root = path.join(library, 'the-builder');
  const files = await listFiles(root);
  for (const f of ['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'codex/_templates/character.md', 'codex/_templates/scene-outline.md']) {
    assert.ok(files.includes(f), `${f} exists`);
  }
  assert.ok(!files.some((f) => f.endsWith('_gitignore')));
  for (const d of ['manuscript', 'outline', 'codex/characters', 'codex/locations']) {
    assert.ok((await fs.stat(path.join(root, d))).isDirectory(), `${d}/ exists`);
  }
  assert.match(await fs.readFile(path.join(root, 'README.md'), 'utf8'), /^# The Builder\n\nCreated \d{4}-\d\d-\d\d\./);
  assert.match(await fs.readFile(path.join(root, 'codex/_templates/character.md'), 'utf8'), /\{\{name\}\}/, 'templates keep placeholders');

  assert.match(gitIn(root, 'log', '--format=%s'), /^Create book: The Builder$/m);
  assert.equal(gitIn(root, 'status', '--porcelain'), '');
  assert.equal(gitIn(root, 'remote', 'get-url', 'origin').trim(), 'git@example.com:me/the-builder.git');

  await assert.rejects(createBook(config, { title: 'the builder' }), { status: 409 });
  await assert.rejects(createBook(config, { title: '' }), { status: 400 });
  await assert.rejects(createBook(config, { title: 'X', remote: '--upload-pack=evil' }), { status: 400 });
});

test('createBook reports a git failure as a warning but keeps the book', async () => {
  const saved = { ...process.env };
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k];
  // Without this git would invent an identity from the hostname.
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' });
  try {
    const book = await createBook(config, { title: 'No Identity' });
    assert.equal(book.id, 'no-identity');
    assert.equal(book.warnings.length, 1);
    assert.match(book.warnings[0], /git reported a problem/);
  } finally {
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
