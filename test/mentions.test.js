import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryNames, entryScenes, namePattern } from '../server/mentions.js';
import { tempDir, writeFiles } from './helpers.js';

test('an entry goes by its title, heading, first name and aliases', () => {
  const md = '---\naliases: [Master Sorvey, X]\n---\n# Dorgal Sorvey (canon)\n';
  assert.deepEqual(entryNames({ title: 'Dorgal Sorvey', kind: 'character' }, md), ['Dorgal Sorvey', 'Dorgal', 'Master Sorvey']);
  assert.deepEqual(entryNames({ title: 'Tor and Rolphs Room', kind: 'location' }, "# Tor and Rolph's room (canon)\n"),
    ['Tor and Rolphs Room', "Tor and Rolph's room"]);
});

test('names match whole words, in case except for the first letter', () => {
  const count = (name, text) => text.match(namePattern(name))?.length ?? 0;
  assert.equal(count('the Count', 'The Count bowed. the Count left. the count of coins.'), 2);
  assert.equal(count('The Practice Yard', 'in the practice yard'), 0);
  assert.equal('in the practice yard'.match(namePattern('The Practice Yard', { anyCase: true })).length, 1);
  assert.equal(count('Tor', 'Tor. Torrance. Torn.'), 1);
  assert.equal(count("Rolph's room", 'Rolph’s room'), 1);
});

test('finds the scenes that name an entry, with their neighbors', async () => {
  const root = await tempDir();
  await writeFiles(root, {
    'codex/locations/the-yard.md': '---\naliases: [practice yard]\n---\n# The yard\n',
    'manuscript/01-one/01-a.camera.md': 'Nothing.\n',
    'manuscript/01-one/01-a.third.md': 'Nothing.\n',
    'manuscript/01-one/02-b.camera.md': 'Before.\n',
    'manuscript/01-one/02-b.third.md': 'Before.\n',
    'manuscript/02-two/01-c.camera.md': 'The practice yard was empty.\n',
    'manuscript/02-two/01-c.third.md': 'Dust.\n',
    'manuscript/02-two/02-d.camera.md': 'After.\n',
    'manuscript/02-two/02-d.third.md': 'After.\n',
    'manuscript/02-two/03-e.camera.md': 'Far away.\n',
  });
  const r = await entryScenes(root, 'codex/locations/the-yard.md');
  assert.deepEqual(r.names, ['The Yard', 'The yard', 'practice yard']);
  assert.equal(r.tooMany, false);
  assert.deepEqual(r.scenes.map((s) => [s.chapter, s.title, s.hits, s.files.length]), [
    ['One', 'B', 0, 2],
    ['Two', 'C', 1, 2],
    ['Two', 'D', 0, 2],
  ]);
  assert.deepEqual(r.scenes[1].files, ['manuscript/02-two/01-c.camera.md', 'manuscript/02-two/01-c.third.md']);
  await assert.rejects(entryScenes(root, 'codex/locations/nope.md'), /No such codex entry/);
  await assert.rejects(entryScenes(root, 'manuscript/02-two/01-c.camera.md'), /Not a codex entry/);
});

test('the book\'s gather mode keeps one file per scene, but every mode is searched', async () => {
  const root = await tempDir();
  await writeFiles(root, {
    'book.json': '{"gather": {"mode": "third"}}',
    'codex/characters/tor.md': '# Tor\n',
    'manuscript/01-one/01-a.camera.md': 'Tor waits.\n',
    'manuscript/01-one/01-a.third.md': 'He waits.\n',
    'manuscript/01-one/02-b.md': 'Plain.\n',
  });
  const r = await entryScenes(root, 'codex/characters/tor.md');
  assert.equal(r.mode, 'third');
  assert.deepEqual(r.scenes.map((s) => [s.hits, s.files]), [
    [1, ['manuscript/01-one/01-a.third.md']],
    [0, ['manuscript/01-one/02-b.md']],
  ]);
});
