import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answersMessage, questionLabel, questionsIn } from '../public/js/questions.js';

test('the questions are the list under the last questions label', () => {
  const reply = `I've filled in the outline.

**Main choices:**
- **Viewpoint:** Quavel, then Rolph.
- **Questions:** the answered ones are recorded.

**Questions:**
1. **"Master Wizard":** is that a real title, a courtesy for builders, or just Ursula's flourish?
2. **The amulet count:** Tor made twenty.
   Does he make another ten?
3. **Maria:** how did she come to marry Count Ward?`;
  assert.deepEqual(questionsIn(reply), [
    '**"Master Wizard":** is that a real title, a courtesy for builders, or just Ursula\'s flourish?',
    '**The amulet count:** Tor made twenty.\nDoes he make another ten?',
    '**Maria:** how did she come to marry Count Ward?',
  ]);
});

test('open questions as bullets, headings and plain labels count; text after the list doesn\'t', () => {
  assert.deepEqual(questionsIn('Done.\n\nOpen questions:\n- Her age is never given.\n- Her height is only "small."\n\nThat\'s all.'),
    ['Her age is never given.', 'Her height is only "small."']);
  assert.deepEqual(questionsIn('### Still open\n\n1. How the queen is related.\n\n2. Maria and Ward.\n\n## Next\n- not a question'),
    ['How the queen is related.', 'Maria and Ward.']);
  assert.deepEqual(questionsIn('No questions here, just a list:\n- a\n- b'), []);
  assert.deepEqual(questionsIn('**Questions:**\n\nNone right now.'), []);
  assert.deepEqual(questionsIn(''), []);
});

test('answers are numbered and named after their questions; skipped ones are left out', () => {
  const qs = ['**Maria:** how did she marry Ward?', 'Her age is never given, so I assumed late forties for the picture and the description.', 'Height?'];
  assert.equal(questionLabel(qs[0]), 'Maria');
  assert.equal(questionLabel(qs[1]), 'Her age is never given, so I assumed late forties for the picture and the…');
  assert.equal(answersMessage(qs, ['They met at court.\nHe knows nothing.', '', 'Short.']),
    'Answers to your questions:\n\n1. Maria\n   They met at court.\n   He knows nothing.\n\n3. Height?\n   Short.\n\nI haven\'t answered the other one yet.');
  assert.equal(answersMessage(qs, ['  ', '']), '');
});
