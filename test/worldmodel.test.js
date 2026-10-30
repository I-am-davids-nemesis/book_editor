import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { addVisualStyle } from '../server/codex.js';
import { prepareHandoff } from '../server/handoff.js';
import { briefPrompt } from '../public/js/codexprompts.js';
import {
  assembleShot, entryLook, fixedTraits, handoffPrompt, lookOf, mentionedEntries, missingViews, pickReferences, rankImages,
  shotImages, variantsIn, visualStyle, VISUAL_STYLE,
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

const well = `# Washing House

The yard where the washers work.

## Description

A cobbled yard around a stone well, with long wooden troughs under a lean-to.

## Fixed traits

- Round stone well with an iron winch
`;

const dorgal = '# Dorgal\n\nThe overseer.\n\n## Description\n\nThe overseer, a heavy man in a leather apron.\n';

const entries = new Map([
  ['codex/characters/tor.md', { title: 'Tor', kind: 'character', text: tor }],
  ['codex/characters/dorgal.md', { title: 'Dorgal', kind: 'character', text: dorgal }],
  ['codex/locations/washing-house.md', { title: 'Washing House', kind: 'location', text: well }],
]);

const shotImage = (name, of, extra = {}) => img(name, { of, ...extra });
const lookbook = [
  shotImage('tor-face', ['codex/characters/tor.md'], { use: 'reference', view: 'face' }),
  shotImage('tor-full', ['codex/characters/tor.md'], { use: 'reference', view: 'full' }),
  shotImage('tor-coat', ['codex/characters/tor.md'], { use: 'reference', view: 'full', variant: 'winter coat' }),
  shotImage('dorgal-face', ['codex/characters/dorgal.md'], { use: 'reference', view: 'face' }),
  shotImage('yard', ['codex/locations/washing-house.md'], { use: 'reference', view: 'establishing' }),
  shotImage('both', ['codex/characters/tor.md', 'codex/characters/dorgal.md']),
];

test('an entry’s look is its description prose, plus a chosen variant', () => {
  assert.equal(entryLook(tor), 'Tall and stooped.');
  assert.equal(entryLook(tor, 'winter coat'), 'Tall and stooped. A grey felt coat to the knee.');
  assert.equal(entryLook(dorgal), 'The overseer, a heavy man in a leather apron.');
});

test('an entry without a Description has no look: its opening lines are a pitch or notes', () => {
  assert.equal(entryLook('# Wash house\n\n- **What it pressures:** a low room. (invented)\n\nWhere Tor tests things.\n'), '');
});

test('a "### Look" wins over the Description, and a long Description is cut at a sentence', () => {
  const looked = '# Tor\n\n## Description\n\nPages about him.\n\n### Look\n\nSmall, in a brown tunic.\n\n### Image prompt\n\nTor in a workshop.\n';
  assert.deepEqual(lookOf(looked), { text: 'Small, in a brown tunic.', cut: false });
  const sentence = 'He is small and quick and always tidy at the start of the day. ';
  const long = `# Tor\n\n## Description\n\n${sentence.repeat(8)}\n\n${sentence.repeat(8)}\n`;
  const { text, cut } = lookOf(long);
  assert.equal(cut, true);
  assert.ok(text.length <= 700 && text.endsWith('day.'), text);
  assert.equal(lookOf(tor).cut, false);
});

test('a shot’s references take each person’s best image first, then the setting’s', () => {
  const shot = { location: 'codex/locations/washing-house.md', characters: [{ path: 'codex/characters/tor.md', variant: 'winter coat' }, { path: 'codex/characters/dorgal.md' }] };
  const candidates = shotImages({ shot, entries, images: lookbook });
  assert.deepEqual(candidates.map((c) => [c.img.title, c.entry.split('/').pop()]), [
    ['tor-coat', 'tor.md'], ['tor-face', 'tor.md'], ['tor-full', 'tor.md'], ['both', 'tor.md'],
    ['dorgal-face', 'dorgal.md'],
    ['yard', 'washing-house.md'],
  ]);
  assert.deepEqual(pickReferences(candidates, 4).map((c) => c.img.title), ['tor-coat', 'dorgal-face', 'yard', 'tor-face']);
  assert.deepEqual(pickReferences(candidates, 10).map((c) => c.img.title), ['tor-coat', 'dorgal-face', 'yard', 'tor-face', 'tor-full']);
});

test('a shot’s prompt has the moment, framing, each entry’s look and traits, the references and the style', () => {
  const shot = {
    location: 'codex/locations/washing-house.md',
    characters: [{ path: 'codex/characters/tor.md', variant: 'winter coat' }, { path: 'codex/characters/dorgal.md', variant: '' }],
    moment: { text: 'Tor set the bucket down.\nDorgal watched.', source: 'manuscript/01-a/01-b.md' },
    brief: '',
    framing: { shot: 'wide', time: 'dawn', notes: '' },
  };
  const refs = pickReferences(shotImages({ shot, entries, images: lookbook }), 3);
  assert.equal(assembleShot({ shot, entries, styleText: style, refs }), `Tor set the bucket down. Dorgal watched.

Wide shot. Time: dawn.

Setting, Washing House: A cobbled yard around a stone well, with long wooden troughs under a lean-to. Must match exactly: Round stone well with an iron winch.

Tor (winter coat): Tall and stooped. A grey felt coat to the knee. Must match exactly: Scar across the right cheek, jaw to ear; Grey eyes.

Dorgal: The overseer, a heavy man in a leather apron.

There are 2 distinct people in the picture: Tor and Dorgal. Each keeps their own face, hair and build as described; don't make them look alike.

Reference images, attached in this order. Keep each person and place consistent with their images:
Image 1: Tor, full length (winter coat). Use it only for Tor.
Image 2: Dorgal’s face. Use it only for Dorgal.
Image 3: Washing House, establishing view.

Style: Medium: Gouache illustration. Light: Low natural light, never harsh.

Avoid: text or lettering; glossy armor.`);
  // An entry with nothing known is left out rather than named bare.
  const bare = new Map([...entries, ['codex/characters/dorgal.md', { title: 'Dorgal', kind: 'character', text: '# Dorgal\n' }]]);
  assert.doesNotMatch(assembleShot({ shot, entries: bare }), /Dorgal:|^Dorgal\.$/m);
  // A brief replaces the moment.
  assert.match(assembleShot({ shot: { ...shot, brief: 'Tor kneels by the well.' }, entries }), /^Tor kneels by the well\.\n\nWide shot/);
});

test('names in a passage suggest entries, matching case', () => {
  const list = [...entries].map(([path, e]) => ({ path, ...e }));
  assert.deepEqual(mentionedEntries('At the Washing House, Tor looked up. dorgal was late.', list), ['codex/characters/tor.md', 'codex/locations/washing-house.md']);
  assert.deepEqual(mentionedEntries('Tormund came.', list), []);
});

test('the brief prompt names the moment, the cast and the rules', () => {
  const prompt = briefPrompt(
    { moment: { text: 'Tor set the bucket down.', source: 'manuscript/01-a/01-b.md' }, framing: { shot: 'wide', time: 'dawn' } },
    { people: [{ title: 'Tor', path: 'codex/characters/tor.md' }], setting: { title: 'Washing House', path: 'codex/locations/washing-house.md' } },
  );
  assert.match(prompt, /from manuscript\/01-a\/01-b\.md/);
  assert.match(prompt, /In the picture: Tor \(codex\/characters\/tor\.md\)\. Setting: Washing House/);
  assert.match(prompt, /Framing asked for: wide shot; time: dawn\./);
  assert.match(prompt, /Don't describe how people or places look/);
});
