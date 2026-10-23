import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryPattern, searchBook } from '../server/search.js';
import { tempDir, writeFiles } from './helpers.js';

async function book() {
  const root = await tempDir();
  await writeFiles(root, {
    'manuscript/02-later/01-x.md': 'The bell again.\n',
    'manuscript/01-first/01-opening.md': 'The bell struck one.\nNobody heard the Bell, or the bells.\n',
    'manuscript/01-first/10-tenth.md': 'bell\n',
    'manuscript/01-first/02-second.md': 'Don’t ring the bell.\n',
    'outline/01-first/01-opening.md': 'Summary: the bell.\n',
    'codex/characters/tor.md': '# Tor\nHates the bell.\n',
    'compiled/book.md': 'The bell struck one.\n',
    '.obsidian/notes.md': 'bell\n',
    'manuscript/01-first/.01-opening.md.123.tmp': 'bell\n',
    'notes.txt': 'bell\n',
  });
  return root;
}

test('finds every match with its line, column and snippet, in book order', async () => {
  const root = await book();
  const r = await searchBook(root, { query: 'bell' });
  assert.deepEqual(r.files.map((f) => f.path), [
    'manuscript/01-first/01-opening.md',
    'manuscript/01-first/02-second.md',
    'manuscript/01-first/10-tenth.md',
    'manuscript/02-later/01-x.md',
    'outline/01-first/01-opening.md',
    'codex/characters/tor.md',
  ]);
  const opening = r.files[0].matches;
  assert.deepEqual(opening.map((m) => [m.line, m.col, m.length]), [[1, 4, 4], [2, 17, 4], [2, 30, 4]]);
  assert.deepEqual([opening[1].before, opening[1].text, opening[1].after], ['Nobody heard the ', 'Bell', ', or the bells.']);
  assert.equal(r.total, 8);
  assert.equal(r.truncated, false);
});

test('match case, whole words and scope narrow the search', async () => {
  const root = await book();
  const cased = await searchBook(root, { query: 'Bell', caseSensitive: true });
  assert.equal(cased.total, 1);
  const words = await searchBook(root, { query: 'bell', wholeWord: true, scope: 'manuscript' });
  assert.equal(words.files[0].matches.length, 2); // not "bells"
  assert.ok(words.files.every((f) => f.path.startsWith('manuscript/')));
  const codex = await searchBook(root, { query: 'bell', scope: 'codex' });
  assert.deepEqual(codex.files.map((f) => f.path), ['codex/characters/tor.md']);
});

test('straight and curly quotes match each other, and the text is not a pattern', async () => {
  const root = await book();
  assert.equal((await searchBook(root, { query: "don't" })).total, 1);
  assert.equal((await searchBook(root, { query: 'b.ll' })).total, 0);
  assert.ok(queryPattern('a(b)[c]*?-/').test('a(b)[c]*?-/'));
});

test('long lines are cut around the match', async () => {
  const root = await tempDir();
  const line = `${'word '.repeat(40)}needle${' word'.repeat(40)}`;
  await writeFiles(root, { 'manuscript/01-a/01-b.md': `${line}\n` });
  const [m] = (await searchBook(root, { query: 'needle' })).files[0].matches;
  assert.ok(m.before.startsWith('…') && m.after.endsWith('…'));
  assert.ok(m.before.length <= 42 && m.after.length <= 82);
  assert.equal(m.col, line.indexOf('needle'));
});

test('stops at the match limit and says so', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'manuscript/01-a/01-b.md': 'a '.repeat(2500) });
  const r = await searchBook(root, { query: 'a' });
  assert.equal(r.total, 2000);
  assert.equal(r.truncated, true);
});

test('refuses empty, overlong or badly scoped searches', async () => {
  const root = await book();
  await assert.rejects(searchBook(root, { query: '  ' }), /Missing search text/);
  await assert.rejects(searchBook(root, { query: 'x'.repeat(201) }), /too long/);
  await assert.rejects(searchBook(root, { query: 'bell', scope: 'elsewhere' }), /Unknown search scope/);
});
