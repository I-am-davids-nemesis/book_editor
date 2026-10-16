import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { addCodexEntry, deleteCodexEntry, renameCodexEntry } from '../server/codex.js';
import { gitBook, listFiles } from './helpers.js';

test('addCodexEntry creates characters, locations and notes from templates', async () => {
  const root = await gitBook({ 'codex/_templates/character.md': 'Character: {{name}}\n' });

  const c = await addCodexEntry(root, { kind: 'character', name: 'Bet Haskins' });
  assert.equal(c.path, 'codex/characters/bet-haskins.md');
  assert.equal(await fs.readFile(path.join(root, c.path), 'utf8'), 'Character: Bet Haskins\n', 'book template wins');

  const l = await addCodexEntry(root, { kind: 'location', name: 'The Washing House' });
  assert.equal(l.path, 'codex/locations/the-washing-house.md');
  assert.match(await fs.readFile(path.join(root, l.path), 'utf8'), /^# The Washing House\n[\s\S]*What it pressures/, 'built-in template as fallback');

  const n = await addCodexEntry(root, { kind: 'note', name: 'Canon notes' });
  assert.equal(n.path, 'codex/canon-notes.md');

  await assert.rejects(addCodexEntry(root, { kind: 'character', name: 'bet haskins' }), { status: 409 });
  await assert.rejects(addCodexEntry(root, { kind: 'spell', name: 'x' }), { status: 400 });
  await assert.rejects(addCodexEntry(root, { kind: 'note', name: '***' }), { status: 400 });
});

test('rename and delete codex entries, only inside codex/', async () => {
  const root = await gitBook({ 'codex/characters/supporting/davie.md': 'D', 'manuscript/01-a/01-b.md': 'x' });
  const r = await renameCodexEntry(root, 'codex/characters/supporting/davie.md', { name: 'Davie Bell' });
  assert.equal(r.path, 'codex/characters/supporting/davie-bell.md');
  assert.ok((await listFiles(root)).includes(r.path));

  await deleteCodexEntry(root, r.path);
  assert.ok(!(await listFiles(root)).includes(r.path));

  await assert.rejects(deleteCodexEntry(root, 'manuscript/01-a/01-b.md'), { status: 400 });
  await assert.rejects(deleteCodexEntry(root, 'codex/../manuscript/01-a/01-b.md'), { status: 400 });
  await assert.rejects(renameCodexEntry(root, 'codex/missing.md', { name: 'x' }), { status: 404 });
});
