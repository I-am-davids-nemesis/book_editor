import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { addVisualStyle } from '../server/codex.js';
import { prepareHandoff } from '../server/handoff.js';
import {
  fixedTraits, handoffPrompt, missingViews, rankImages, variantsIn, visualStyle, VISUAL_STYLE,
} from '../public/js/worldmodel.js';
import { listFiles, tempDir, writeFiles } from './helpers.js';

const tor = `# Tor

A washer.

## Description

Tall and stooped.

### Variant: winter coat

A grey felt coat to the knee.

### Image prompt

A tall stooped man at a stone well at dawn.

## Fixed traits

<!-- What must look the same in every picture. -->

- Scar across the right cheek, jaw to ear.
- Grey eyes
-

## Facts

- Born in the yard.
`;

const style = `# Visual style

Intro that isn't used.

## Medium

Gouache illustration.

## Palette

<!-- For example: earth tones -->

## Light

Low natural light,
never harsh.

## Avoid

- text or lettering
- glossy armor
`;

const img = (name, extra = {}) => ({ path: `lookbook/${name}.png`, title: name, use: '', view: '', variant: '', ...extra });

test('reads fixed traits, variants and the visual style, skipping template comments', () => {
  assert.deepEqual(fixedTraits(tor), ['Scar across the right cheek, jaw to ear.', 'Grey eyes']);
  assert.deepEqual(fixedTraits('# Tor\n'), []);
  assert.deepEqual(variantsIn(tor), ['winter coat']);
  assert.deepEqual(visualStyle(style), { style: 'Medium: Gouache illustration. Light: Low natural light, never harsh.', avoid: 'text or lettering; glossy armor' });
  assert.deepEqual(visualStyle(''), { style: '', avoid: '' });
});

test('ranks references by view and variant, and names the missing views', () => {
  const images = [
    img('scene'),
    img('full', { use: 'reference', view: 'full' }),
    img('face-coat', { use: 'reference', view: 'face', variant: 'winter coat' }),
    img('face', { use: 'reference', view: 'face' }),
  ];
  assert.deepEqual(rankImages(images, 'character').map((i) => i.title), ['face', 'full', 'face-coat', 'scene']);
  assert.deepEqual(rankImages(images, 'character', { variant: 'winter coat' }).map((i) => i.title), ['face-coat', 'face', 'full', 'scene']);
  assert.deepEqual(rankImages(images, 'character', { variant: 'summer' }).map((i) => i.title), ['face', 'full', 'face-coat', 'scene']);
  assert.deepEqual(missingViews('character', images), []);
  assert.deepEqual(missingViews('character', [images[0], images[2]]), ['full']);
  assert.deepEqual(missingViews('location', []), ['establishing']);
  assert.deepEqual(missingViews('note', []), []);
});

test('the handoff prompt joins the image prompt, traits, numbered references and style', () => {
  const refs = [img('face', { use: 'reference', view: 'face', variant: 'winter coat' }), img('full', { use: 'reference', view: 'full' })];
  assert.equal(handoffPrompt({ kind: 'character', text: tor, styleText: style, refs }), `A tall stooped man at a stone well at dawn.

Must match exactly: Scar across the right cheek, jaw to ear; Grey eyes.

Reference images, attached in this order. Keep the subject consistent with them:
Image 1: this character’s face (winter coat).
Image 2: this character, full length.

Style: Medium: Gouache illustration. Light: Low natural light, never harsh.

Avoid: text or lettering; glossy armor.`);
  assert.equal(handoffPrompt({ kind: 'character', text: '# Tor\n\nA washer.\n' }), null);
  assert.equal(handoffPrompt({ kind: 'location', text: '## Description\n\nA yard.\n' }), 'A yard.');
});

test('the visual style note is created once from the template', async () => {
  const root = await tempDir();
  const first = await addVisualStyle(root);
  assert.deepEqual(first, { path: VISUAL_STYLE, moves: [], created: [VISUAL_STYLE], deleted: [] });
  const text = await fs.readFile(path.join(root, VISUAL_STYLE), 'utf8');
  assert.match(text, /^# Visual style/);
  // The template's guidance is all comments, so a fresh note adds nothing.
  assert.deepEqual(visualStyle(text), { style: '', avoid: '' });
  await fs.writeFile(path.join(root, VISUAL_STYLE), 'mine');
  assert.deepEqual((await addVisualStyle(root)).created, []);
  assert.equal(await fs.readFile(path.join(root, VISUAL_STYLE), 'utf8'), 'mine');
});

test('handoff copies the chosen images in order to a fresh folder and reveals it', async () => {
  const root = await tempDir();
  const base = await tempDir();
  await writeFiles(root, { 'lookbook/face.png': 'F', 'lookbook/full.png': 'B', 'codex/tor.md': '# Tor\n' });
  await writeFiles(base, { 'old-1/x.png': 'x' });
  const old = new Date(Date.now() - 2 * 86400000);
  await fs.utimes(path.join(base, 'old-1'), old, old);

  const revealed = [];
  const res = await prepareHandoff(root, { paths: ['lookbook/full.png', 'lookbook/face.png'], name: 'Tor at dawn' }, { base, reveal: (dir) => revealed.push(dir), now: 1000 + Date.now() });
  const stamp = path.basename(res.dir).replace('tor-at-dawn-', '');
  assert.match(stamp, /^\d+$/);
  assert.deepEqual(res.files, ['1-full.png', '2-face.png']);
  assert.deepEqual(revealed, [res.dir]);
  assert.equal(await fs.readFile(path.join(res.dir, '1-full.png'), 'utf8'), 'B');
  // The day-old folder was pruned.
  assert.deepEqual(await listFiles(base), [`tor-at-dawn-${stamp}/1-full.png`, `tor-at-dawn-${stamp}/2-face.png`]);

  const opts = { base, reveal: () => {} };
  await assert.rejects(prepareHandoff(root, { paths: ['codex/tor.md'] }, opts), /lookbook images/);
  await assert.rejects(prepareHandoff(root, { paths: ['lookbook/../codex/x.png'] }, opts), /lookbook images/);
  await assert.rejects(prepareHandoff(root, { paths: ['lookbook/none.png'] }, opts), /No such file/);
  await assert.rejects(prepareHandoff(root, { paths: [] }, opts), /paths/);
});
