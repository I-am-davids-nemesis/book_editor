import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createBook } from '../server/books.js';
import { addChapter, addScene } from '../server/structure.js';
import { addCodexEntry } from '../server/codex.js';
import { gitIn, listFiles, tempDir } from './helpers.js';

// What Obsidian needs from a vault, checked statically (Obsidian itself
// can't run in tests): names it accepts, only Markdown content, its own
// per-device state kept out of git, and links that resolve.
const OBSIDIAN_FORBIDDEN = /[\\:*?"<>|#^[\]]/;

test('a scaffolded book is a clean Obsidian vault', async () => {
  const library = await tempDir();
  const config = { libraryRoot: library, registered: {} };
  const book = await createBook(config, { title: 'The Washing-House: A Novel?' });
  const root = book.path;
  await addChapter(root, { title: 'The Courtyard: Part #1' });
  const [chapter] = (await fs.readdir(path.join(root, 'manuscript')));
  await addScene(root, chapter, { title: 'Dorgal "arrives" | late' });
  await addCodexEntry(root, { kind: 'character', name: 'Tor [the builder]' });
  await addCodexEntry(root, { kind: 'location', name: 'The Washing House' });

  const files = await listFiles(root);
  for (const f of files) {
    for (const part of f.split('/')) assert.doesNotMatch(part, OBSIDIAN_FORBIDDEN, `${f} has a character Obsidian rejects`);
    assert.ok(f.endsWith('.md') || f === '.gitignore', `${f} is not Markdown`);
  }

  // Obsidian writes .obsidian/ when the folder is opened as a vault; it must
  // not show up as a change (autosave would commit it every few seconds).
  await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(root, '.obsidian/workspace.json'), '{}');
  assert.equal(gitIn(root, 'status', '--porcelain', '--', '.obsidian'), '');

  // Markdown links in the scaffold point at files that exist.
  for (const f of files.filter((x) => x.endsWith('.md'))) {
    const text = await fs.readFile(path.join(root, f), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue; // external
      const abs = path.resolve(path.dirname(path.join(root, f)), decodeURIComponent(target));
      await assert.doesNotReject(fs.access(abs), `${f} links to missing ${target}`);
    }
  }
});
