import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeService } from '../server/claude.js';
import { batches, findPassages, normalize, parsePassages, quoteIn } from '../server/passages.js';
import { gatherPrompt, manuscriptPrompt } from '../public/js/codexprompts.js';
import { tempDir, writeFiles } from './helpers.js';

test('quotes match despite typographic quotes, emphasis, line breaks and elisions', () => {
  const text = 'He was *tall*, taller than Davie—and his hair\nwas black. “Move,” he said.';
  assert.equal(normalize('“a”  —\n‘b’'), '"a" - \'b\'');
  assert.ok(quoteIn('He was tall, taller than Davie-and his hair was black.', text));
  assert.ok(quoteIn('He was tall … his hair was black.', text));
  assert.ok(quoteIn('"Move," he said.', text));
  assert.ok(!quoteIn('He was short.', text));
  assert.ok(!quoteIn('...', text));
});

test('the passage list is read out of the answer, whatever surrounds it', () => {
  assert.deepEqual(parsePassages('Here:\n```json\n[{"file": "a.md", "quote": "x", "note": "n"}, {"file": "b.md"}, {"file": "c.md", "quote": " "}]\n```'),
    [{ file: 'a.md', quote: 'x', note: 'n' }]);
  assert.deepEqual(parsePassages('Nothing here.'), []);
  assert.deepEqual(parsePassages('[not json]'), []);
});

test('scenes go in batches of about the given size', () => {
  const f = (n) => ({ text: 'x'.repeat(n) });
  assert.deepEqual(batches([f(4), f(4), f(4), f(20), f(1)], 10).map((b) => b.map((x) => x.text.length)), [[4, 4], [4], [20], [1]]);
});

test('the first reader copies passages out of the found scenes, and the editor checks them', async () => {
  const root = await tempDir();
  await writeFiles(root, {
    'codex/characters/tor.md': '# Tor\n',
    'manuscript/01-one/01-a.md': 'Rain fell.\n',
    'manuscript/01-one/02-b.md': 'Tor was tall, with black hair.\nHe smiled.\n',
    'manuscript/01-one/03-c.md': 'Nothing about anyone.\n',
    'manuscript/01-one/04-d.md': 'Far away.\n',
  });
  const prompts = [];
  const claude = new ClaudeService({ storeDir: await tempDir(), log: { error() {} } });
  claude.complete = async (r, prompt, opts) => {
    prompts.push({ prompt, opts });
    return JSON.stringify([
      { file: 'manuscript/01-one/02-b.md', quote: 'Tor was tall, with black hair.', note: 'build, hair' },
      { file: 'manuscript/01-one/02-b.md', quote: 'Tor was tall, with  black hair.', note: 'a repeat' },
      { file: 'manuscript/01-one/02-b.md', quote: 'Tor had a scar.', note: 'made up' },
      { file: 'manuscript/01-one/04-d.md', quote: 'Far away.', note: 'not a scene it was given' },
    ]);
  };
  const r = await findPassages(claude, root, 'codex/characters/tor.md', { model: 'claude-small' });
  assert.equal(r.count, 1);
  assert.equal(r.dropped, 2);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.found.scenes.map((s) => s.title), ['A', 'B', 'C']);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].opts.model, 'claude-small');
  assert.match(prompts[0].prompt, /<scene file="manuscript\/01-one\/02-b.md">\nTor was tall/);
  assert.doesNotMatch(prompts[0].prompt, /Far away/);
  assert.ok(r.file.startsWith(claude.scratchDir(root)));
  const md = await fs.readFile(r.file, 'utf8');
  assert.match(md, /## One, “B” \(manuscript\/01-one\/02-b.md\)\n\n- “Tor was tall, with black hair.” \(build, hair\)/);
  assert.match(md, /## Read, with nothing found\n\n- manuscript\/01-one\/01-a.md\n- manuscript\/01-one\/03-c.md/);
  assert.doesNotMatch(md, /scar/);
  assert.equal(path.dirname(r.file), claude.scratchDir(root));

  // A batch that fails is listed as unread, not lost.
  claude.complete = async () => { throw new Error('overloaded'); };
  const failed = await findPassages(claude, root, 'codex/characters/tor.md');
  assert.equal(failed.failed, 1);
  assert.match(await fs.readFile(failed.file, 'utf8'), /## Not read \(the first reader failed on these\)\n\n- manuscript\/01-one\/01-a.md/);

  // No scenes name the entry: nothing to read, and Gather searches on its own.
  await writeFiles(root, { 'codex/characters/nobody.md': '# Nobody\n' });
  const none = await findPassages(claude, root, 'codex/characters/nobody.md');
  assert.equal(none.file, null);
});

test('Gather works from the passages file when there is one', () => {
  const tor = { path: 'codex/characters/tor.md', title: 'Tor', kind: 'character' };
  const found = { names: ['Tor'], mode: null, scenes: [{ chapter: 'One', title: 'B', files: ['manuscript/01-one/02-b.md'], hits: 1 }] };
  const p = gatherPrompt(tor, found, { found, file: '/cfg/scratch/passages-tor.md', count: 7 });
  assert.match(p, /copied out 7 passages that describe it/);
  assert.match(p, /\/cfg\/scratch\/passages-tor\.md/);
  assert.match(p, /Don't search the manuscript again/);
  assert.doesNotMatch(p, /The editor searched the manuscript/);
  // With no passages, Claude reads the scenes itself.
  assert.match(gatherPrompt(tor, found, { found, file: '/x.md', count: 0 }), /The editor searched the manuscript for “Tor”/);
});

test('for manuscript suggestions, the first reader copies out every place the entry appears', async () => {
  const root = await tempDir();
  await writeFiles(root, {
    'codex/characters/tor.md': '# Tor\n',
    'manuscript/01-one/01-a.md': 'Tor came in. He sat.\n',
  });
  const claude = new ClaudeService({ storeDir: await tempDir(), log: { error() {} } });
  const prompts = [];
  claude.complete = async (r, prompt) => {
    prompts.push(prompt);
    return JSON.stringify([{ file: 'manuscript/01-one/01-a.md', quote: 'Tor came in.', note: 'first, no detail' }]);
  };
  const r = await findPassages(claude, root, 'codex/characters/tor.md', { purpose: 'appear' });
  assert.match(prompts[0], /Copy out every place where Tor appears: the first time in each scene/);
  assert.doesNotMatch(prompts[0], /Leave out passages that only name/);
  assert.equal(path.basename(r.file), 'appearances-codex-characters-tor.md');
  assert.match(await fs.readFile(r.file, 'utf8'), /^# Where Tor appears\n[\s\S]*for manuscript suggestions[\s\S]*- “Tor came in.” \(first, no detail\)/);
  await assert.rejects(findPassages(claude, root, 'codex/characters/tor.md', { purpose: 'other' }), /Unknown purpose/);

  const tor = { path: 'codex/characters/tor.md', title: 'Tor', kind: 'character' };
  const p = manuscriptPrompt(tor, { ...r, file: '/cfg/scratch/appearances-tor.md' });
  assert.match(p, /copied out 1 places where Tor appears/);
  assert.match(p, /\/cfg\/scratch\/appearances-tor\.md/);
  assert.match(p, /open it and read around the sentence/);
  // Without the file, Claude searches the manuscript itself.
  assert.match(manuscriptPrompt(tor), /Find the passages in manuscript\//);
});
