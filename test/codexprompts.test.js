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
