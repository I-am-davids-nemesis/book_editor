import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { deleteCodexEntry, renameCodexEntry } from '../server/codex.js';
import {
  addImage, deleteImage, listLookbook, parseNote, sniffImage, updateImage, writeNote,
} from '../server/lookbook.js';
import { buildTree } from '../server/tree.js';
import { listFiles, tempDir, writeFiles } from './helpers.js';

// The smallest valid PNG: a 1×1 transparent pixel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

async function book() {
  const root = await tempDir();
  await writeFiles(root, {
    'codex/characters/tor.md': '# Tor\n',
    'codex/locations/washing-house.md': '# Washing house\n',
  });
  return root;
}

const read = (root, rel) => fs.readFile(path.join(root, rel), 'utf8');
const linksOf = (text, name) => { const { of, caption } = parseNote(text, name); return { of, caption }; };

test('recognizes image formats by their first bytes', () => {
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(JPEG), 'jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'gif');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(sniffImage(Buffer.from('\0\0\0\x1cftypavif')), 'avif');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test('notes read block, inline and single links, and keep other front matter', () => {
  assert.deepEqual(linksOf('---\nof:\n  - codex/a.md\n  - "codex/b c.md"\ntags: [x]\n---\n![A](a.png)\n\nHello.\n', 'a.png'),
    { of: ['codex/a.md', 'codex/b c.md'], caption: 'Hello.' });
  assert.deepEqual(linksOf('---\nof: [codex/a.md, \'codex/b.md\']\n---\nJust text', 'a.png'), { of: ['codex/a.md', 'codex/b.md'], caption: 'Just text' });
  assert.deepEqual(linksOf('---\nof: codex/a.md\n---\n', 'a.png'), { of: ['codex/a.md'], caption: '' });
  assert.deepEqual(linksOf('No front matter.', 'a.png'), { of: [], caption: 'No front matter.' });

  const text = writeNote('---\ntags: [x]\nof:\n  - codex/old.md\nsource: me\n---\nold\n', { of: ['codex/a.md', 'codex/b c.md'], caption: 'New.', imageName: 'a b.png', title: 'A B' });
  assert.equal(text, '---\ntags: [x]\nof:\n  - codex/a.md\n  - codex/b c.md\nsource: me\n---\n\n![A B](<a b.png>)\n\nNew.\n');
  assert.deepEqual(linksOf(text, 'a b.png'), { of: ['codex/a.md', 'codex/b c.md'], caption: 'New.' });
  assert.equal(writeNote('', { of: [], caption: '', imageName: 'a.png', title: 'A' }), '');
});

test('notes read and write reference keys, and leave the rest alone', () => {
  const base = '---\nof:\n  - codex/characters/tor.md\ntags: [x]\n---\n![Tor](tor.png)\n\nAt dawn.\n';
  assert.deepEqual(parseNote(base, 'tor.png'), { of: ['codex/characters/tor.md'], caption: 'At dawn.', use: '', view: '', variant: '' });
  const meta = { use: 'reference', view: 'face', variant: 'winter coat: torn' };
  const marked = writeNote(base, { of: ['codex/characters/tor.md'], caption: 'At dawn.', imageName: 'tor.png', title: 'Tor', meta });
  assert.equal(marked, '---\nof:\n  - codex/characters/tor.md\ntags: [x]\nuse: reference\nview: face\nvariant: "winter coat: torn"\n---\n\n![Tor](tor.png)\n\nAt dawn.\n');
  assert.deepEqual(parseNote(marked, 'tor.png'), { of: ['codex/characters/tor.md'], caption: 'At dawn.', ...meta });
  // Undefined keys stay; empty ones go.
  const cleared = writeNote(marked, { of: ['codex/characters/tor.md'], caption: 'At dawn.', imageName: 'tor.png', title: 'Tor', meta: { view: '', variant: undefined } });
  assert.match(cleared, /use: reference\nvariant: "winter coat: torn"\n---/);
});

test('updating an image marks it as a reference, and checks the values', async () => {
  const root = await book();
  const { path: img } = await addImage(root, { filename: 'tor.png', data: PNG.toString('base64'), of: ['codex/characters/tor.md'] });
  await updateImage(root, img, { use: 'reference', view: 'face', variant: ' winter coat ' });
  const [item] = await listLookbook(root);
  assert.deepEqual([item.use, item.view, item.variant], ['reference', 'face', 'winter coat']);
  // A rename and a codex rename keep the keys.
  await renameCodexEntry(root, 'codex/characters/tor.md', { name: 'Tormund' });
  const { path: renamed } = await updateImage(root, img, { name: 'Tormund face' });
  const [after] = await listLookbook(root);
  assert.deepEqual([after.path, after.of, after.use, after.view], [renamed, ['codex/characters/tormund.md'], 'reference', 'face']);
  await updateImage(root, renamed, { use: '', view: '' });
  const [plain] = await listLookbook(root);
  assert.deepEqual([plain.use, plain.view, plain.variant], ['', '', 'winter coat']);

  await assert.rejects(updateImage(root, renamed, { use: 'yes' }), /use/);
  await assert.rejects(updateImage(root, renamed, { view: 'side' }), /view/);
  await assert.rejects(updateImage(root, renamed, { variant: 'a\nb' }), /variant/);
});

test('adding an image names it from the file, sniffs its type and writes its note', async () => {
  const root = await book();
  const res = await addImage(root, { filename: 'Tor at the Well.jpeg', data: PNG.toString('base64'), of: ['codex/characters/tor.md'], caption: 'Dawn.' });
  assert.equal(res.path, 'lookbook/tor-at-the-well.png'); // it's really a PNG
  assert.deepEqual(res.created, ['lookbook/tor-at-the-well.png', 'lookbook/tor-at-the-well.md']);
  assert.equal(await read(root, 'lookbook/tor-at-the-well.md'),
    '---\nof:\n  - codex/characters/tor.md\n---\n\n![Tor at the Well](tor-at-the-well.png)\n\nDawn.\n');

  // Same name again: a new number, and no note when there's nothing to say.
  const again = await addImage(root, { filename: 'tor at the well.jpg', data: JPEG.toString('base64') });
  assert.equal(again.path, 'lookbook/tor-at-the-well-2.jpg');
  assert.deepEqual(again.created, ['lookbook/tor-at-the-well-2.jpg']);

  const [first, second] = await listLookbook(root);
  assert.deepEqual([first.path, first.of, first.caption, first.hasNote], ['lookbook/tor-at-the-well.png', ['codex/characters/tor.md'], 'Dawn.', true]);
  assert.deepEqual([second.of, second.hasNote], [[], false]);
  assert.equal((await buildTree(root)).lookbook.length, 2);
});

test('refuses non-images, oversize files and links outside the codex', async () => {
  const root = await book();
  await assert.rejects(addImage(root, { filename: 'x.png', data: Buffer.from('<svg/>').toString('base64') }), /isn’t a PNG/);
  await assert.rejects(addImage(root, { filename: 'x.png', data: PNG.toString('base64'), of: ['manuscript/01-a/01-b.md'] }), /only be linked to codex/);
  await assert.rejects(addImage(root, { filename: 'x.png', data: PNG.toString('base64'), of: ['codex/characters/nobody.md'] }), /No such file/);
  await assert.rejects(addImage(root, { filename: 'x.png', data: Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024)]).toString('base64') }), /at most 14 MB/);
  await assert.rejects(updateImage(root, 'manuscript/x.png', { caption: 'x' }), /Only images in lookbook/);
  await assert.rejects(deleteImage(root, '../outside.png'), /Only images in lookbook/);
  assert.deepEqual(await listFiles(root), ['codex/characters/tor.md', 'codex/locations/washing-house.md']);
});

test('linking, captions and renaming keep the note beside its image', async () => {
  const root = await book();
  const { path: rel } = await addImage(root, { filename: 'well.png', data: PNG.toString('base64') });
  await updateImage(root, rel, { of: ['codex/characters/tor.md', 'codex/locations/washing-house.md'], caption: 'At the well.' });
  const renamed = await updateImage(root, rel, { name: 'Morning Well' });
  assert.equal(renamed.path, 'lookbook/morning-well.png');
  assert.deepEqual(renamed.moves.map((m) => m.to), ['lookbook/morning-well.png', 'lookbook/morning-well.md']);
  const [item] = await listLookbook(root);
  assert.deepEqual(item.of, ['codex/characters/tor.md', 'codex/locations/washing-house.md']);
  assert.match(await read(root, 'lookbook/morning-well.md'), /!\[Morning Well\]\(morning-well\.png\)/);

  // Removing every link and the caption removes the note.
  await updateImage(root, 'lookbook/morning-well.png', { of: [], caption: '' });
  assert.deepEqual(await listFiles(root), ['codex/characters/tor.md', 'codex/locations/washing-house.md', 'lookbook/morning-well.png']);

  await addImage(root, { filename: 'other.jpg', data: JPEG.toString('base64') });
  await assert.rejects(updateImage(root, 'lookbook/morning-well.png', { name: 'other' }), /already uses that name/);
});

test('renaming or deleting a codex entry follows it in the lookbook', async () => {
  const root = await book();
  await addImage(root, { filename: 'a.png', data: PNG.toString('base64'), of: ['codex/characters/tor.md', 'codex/locations/washing-house.md'] });
  await addImage(root, { filename: 'b.png', data: PNG.toString('base64'), of: ['codex/characters/tor.md'] });
  await renameCodexEntry(root, 'codex/characters/tor.md', { name: 'Tor Halvard' });
  assert.deepEqual((await listLookbook(root)).map((i) => i.of), [
    ['codex/characters/tor-halvard.md', 'codex/locations/washing-house.md'],
    ['codex/characters/tor-halvard.md'],
  ]);
  await deleteCodexEntry(root, 'codex/characters/tor-halvard.md');
  assert.deepEqual((await listLookbook(root)).map((i) => i.of), [['codex/locations/washing-house.md'], []]);
  // b.png had nothing else to say, so its note is gone; the image stays.
  assert.ok((await listFiles(root)).includes('lookbook/b.png'));
  assert.ok(!(await listFiles(root)).includes('lookbook/b.md'));
});

test('deleting an image deletes its note', async () => {
  const root = await book();
  const { path: rel } = await addImage(root, { filename: 'a.png', data: PNG.toString('base64'), caption: 'x' });
  assert.deepEqual((await deleteImage(root, rel)).deleted, ['lookbook/a.png', 'lookbook/a.md']);
  await assert.rejects(deleteImage(root, rel), /No such file/);
});

test('history handles committed images', async () => {
  const { gitIn } = await import('./helpers.js');
  const { compare, fileDiff, graph, imageAt, restoreFile, status } = await import('../server/history.js');
  const root = await book();
  gitIn(root, 'init', '-q', '-b', 'main');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'init');
  await addImage(root, { filename: 'a.png', data: PNG.toString('base64'), of: ['codex/characters/tor.md'] });
  assert.ok((await status(root)).files.some((f) => f.path === 'lookbook/a.png'));
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'image');
  const g = await graph(root, {});
  assert.ok(g.commits.length >= 2);
  const head = gitIn(root, 'rev-parse', 'HEAD').trim();
  const c = await compare(root, { to: head });
  assert.ok(c.files.some((f) => f.path === 'lookbook/a.png'));
  const d = await fileDiff(root, { to: head, path: 'lookbook/a.png' });
  assert.deepEqual([d.image, d.hasBefore, d.hasAfter], [true, false, true]);
  assert.deepEqual(await imageAt(root, { rev: head, path: 'lookbook/a.png' }), PNG);

  // Restoring an image brings back its exact bytes.
  await fs.writeFile(path.join(root, 'lookbook/a.png'), JPEG);
  await restoreFile(root, { rev: head, path: 'lookbook/a.png' });
  assert.deepEqual(await fs.readFile(path.join(root, 'lookbook/a.png')), PNG);
});
