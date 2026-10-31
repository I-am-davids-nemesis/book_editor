import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixedTraitsPrompt, gatherPrompt, imagePromptFrom, lookPrompt, manuscriptPrompt, refinePrompt,
} from '../public/js/codexprompts.js';

const tor = { path: 'codex/characters/tor.md', title: 'Tor', kind: 'character' };

test('the image prompt comes from the Description section', () => {
  const entry = `# Tor

A washer.

## Description

Tall and stooped, with a pale scar.

### Image prompt

A tall stooped man at a stone well at dawn, pale scar across one cheek.

### From the manuscript

- “his scar pale” (manuscript/01-a/01-b.md)

## Facts

- Born in the yard.
`;
  assert.equal(imagePromptFrom(entry), 'A tall stooped man at a stone well at dawn, pale scar across one cheek.');
  // Without an Image prompt, the description prose stands in.
  assert.equal(imagePromptFrom(entry.replace(/### Image prompt\n\n.*\n\n/, '')), 'Tall and stooped, with a pale scar.');
  assert.equal(imagePromptFrom('# Tor\n\nNo description yet.\n'), null);
  assert.equal(imagePromptFrom('# Tor\n\n## Description\n\n## Facts\n'), null);
});

test('prompts name the files and keep Claude out of the manuscript until asked', () => {
  const gather = gatherPrompt(tor);
  assert.match(gather, /codex\/characters\/tor\.md/);
  assert.match(gather, /## Description/);
  assert.match(gather, /### Image prompt/);
  assert.match(gather, /Don't change anything in manuscript\//);

  const refine = refinePrompt([tor], [{ path: 'lookbook/tor.png', title: 'Tor' }]);
  assert.match(refine, /Read tool/);
  assert.match(refine, /lookbook\/tor\.png/);
  assert.match(refine, /Open questions/);

  assert.match(manuscriptPrompt(tor), /Don't edit any files yet/);
  assert.match(gather, /Don't touch a "## Fixed traits" section/);
  assert.match(refine, /Never edit "## Fixed traits"/);

  const traits = fixedTraitsPrompt(tor);
  assert.match(traits, /codex\/characters\/tor\.md/);
  assert.match(traits, /If the entry already has a "## Fixed traits" section with bullets in it, don't change it/);
  assert.match(traits, /Face, build/);
  assert.match(fixedTraitsPrompt({ ...tor, kind: 'location' }), /Layout, materials/);
});

test('the short look is appearance only, inside the Description', () => {
  const tor = { title: 'Tor', path: 'codex/characters/tor.md', kind: 'character' };
  assert.match(gatherPrompt(tor), /### Look\n\n<Two to four sentences/);
  const look = lookPrompt(tor);
  assert.match(look, /"### Look" subsection inside "## Description"/);
  assert.match(look, /No setting, action, mood, voice or habits/);
  assert.match(look, /usual one/);
  assert.match(look, /nothing in manuscript\/ or outline\//);
});

test('gather leaves the look and image prompt empty when nothing visual is known', () => {
  const p = gatherPrompt({ title: 'Gallaia', path: 'codex/locations/gallaia.md', kind: 'location' });
  assert.match(p, /establish nothing visual about Gallaia/);
  assert.equal(imagePromptFrom('# G\n\n## Description\n\nNothing yet.\n\n### Look\n\n### Image prompt\n\n### From the manuscript\n'), null);
});

test('image prompts leave the style to the visual style note', () => {
  const gather = gatherPrompt(tor);
  assert.match(gather, /read codex\/characters\/tor\.md and the outline files for context, and codex\/visual-style\.md if the book has one/);
  assert.match(gather, /No medium or rendering style/);
  assert.doesNotMatch(gather, /style note if the book's codex has one/);
  assert.match(refinePrompt([tor], [{ path: 'lookbook/tor.png', title: 'Tor' }]), /not the image's medium or style: the editor adds codex\/visual-style\.md itself/);
});

test('gather reads only the scenes the editor found, when it found any', () => {
  const found = {
    names: ['Tor', 'Torrance'],
    scenes: [
      { chapter: 'One', title: 'The Opening', hits: 3, files: ['manuscript/01-one/01-the-opening.camera.md', 'manuscript/01-one/01-the-opening.third.md'] },
      { chapter: 'One', title: 'Later', hits: 0, files: ['manuscript/01-one/02-later.md'] },
    ],
    tooMany: false,
  };
  const p = gatherPrompt(tor, found);
  assert.match(p, /searched the manuscript for “Tor”, “Torrance”/);
  assert.match(p, /- One, “The Opening”: manuscript\/01-one\/01-the-opening\.camera\.md, manuscript\/01-one\/01-the-opening\.third\.md/);
  assert.match(p, /“Later” \(next to a scene that names it\)/);
  assert.match(p, /Don't search the rest of the manuscript/);
  assert.doesNotMatch(p, /every chapter and every narration mode/);
  assert.match(p, /same scene in different narration modes; read them all/);
  const one = gatherPrompt(tor, { ...found, mode: 'third', scenes: [{ ...found.scenes[0], files: [found.scenes[0].files[1]] }] });
  assert.match(one, /\(the third version where a scene has one\)\. Read each file\./);
  for (const none of [null, { names: ['Tor'], scenes: [], tooMany: true }]) {
    assert.match(gatherPrompt(tor, none), /Find every passage in manuscript\/ \(every chapter and every narration mode\)/);
  }
});
