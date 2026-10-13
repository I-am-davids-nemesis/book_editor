import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countWords } from '../public/js/wordcount.js';

test('countWords counts prose words', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('The bell struck one.'), 4);
  assert.equal(countWords("Don't stop—Tor's well-made shield."), 5);
  assert.equal(countWords('Café naïve façade'), 3);
});

test('countWords ignores Markdown syntax', () => {
  const md = [
    '# Chapter One',
    '',
    '*Draft.* **Bold** and _soft_ words.',
    '',
    '> A quoted line',
    '',
    '- one item',
    '1. two item',
    '',
    'See [the codex](codex/tor.md) and [[tor|Tor Baker]].',
    '',
    '* * *',
    '',
    '<!-- a comment that should not count -->',
    '```',
    'code is not prose',
    '```',
  ].join('\n');
  // Chapter One (2) + Draft Bold and soft words (5) + A quoted line (3)
  // + one item (2) + two item (2) + See the codex and Tor Baker (6)
  assert.equal(countWords(md), 20);
});
