import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answersMessage, initialAnswer, parseQuestion, questionLabel, questionsIn } from '../public/js/questions.js';

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

test('any list of questions counts, with or without a label, wherever it is in the reply', () => {
  assert.deepEqual(questionsIn('I drafted the scene.\n\n1. Should Ward know about the letter?\n2. Is Maria at the dinner?\n\nI\'ll wait for your answers before the next scene.'),
    ['Should Ward know about the letter?', 'Is Maria at the dinner?']);
  assert.deepEqual(questionsIn('Before I go on, I have a few questions about the dinner:\n\n- Who sits next to Ward.\n- What is served.'),
    ['Who sits next to Ward.', 'What is served.']);
  assert.deepEqual(questionsIn('What the change needs:\n- Detect lists.\n- Show the button?'), []);
  assert.deepEqual(questionsIn('I have no questions:\n- a\n- b'), []);
  assert.deepEqual(questionsIn('**Questions:**\n\nNone right now.\n\nNext steps:\n- a\n- b'), []);
  assert.deepEqual(questionsIn('Questions:\n- Is it night?\n\nChanges made:\n- Fixed the date.'), ['Is it night?']);
});

test('answers are numbered and named after their questions; skipped ones are left out', () => {
  const qs = ['**Maria:** how did she marry Ward?', 'Her age is never given, so I assumed late forties for the picture and the description.', 'Height?'].map(parseQuestion);
  assert.equal(questionLabel(qs[0].text), 'Maria');
  assert.equal(questionLabel(qs[1].text), 'Her age is never given, so I assumed late forties for the picture and the…');
  const own = (note) => ({ choice: -1, note });
  assert.equal(answersMessage(qs, [own('They met at court.\nHe knows nothing.'), own(''), own('Short.')]),
    'Answers to your questions:\n\n1. Maria\n   They met at court.\n   He knows nothing.\n\n3. Height?\n   Short.\n\nI haven\'t answered the other one yet.');
  assert.equal(answersMessage(qs, [own('  '), own('')]), '');
});

const WITH_SUGGESTIONS = `Done.

\`\`\`
**Questions:**

1. **Example:** not a real question?
   - Default: no.
\`\`\`

**Questions:**

1. **Maria's role:** is she knowingly working for Austra,
   or being used herself?
   - Default: She knows; she arranged the brooch.
   - Option: She's being used too.
   - Option: Leave it open for book 2.
2. **The name:** what is the jeweler called?
   - Default: none
   - Option: Pell.
3. **Ward's field:** what does it do?

Changes made:
- Fixed the date.`;

test('suggested answers stay with their question; lists in code blocks are examples', () => {
  const items = questionsIn(WITH_SUGGESTIONS);
  assert.equal(items.length, 3);
  const qs = items.map(parseQuestion);
  assert.deepEqual(qs[0], {
    text: '**Maria\'s role:** is she knowingly working for Austra,\nor being used herself?',
    suggestions: [
      { kind: 'Default', text: 'She knows; she arranged the brooch.' },
      { kind: 'Option', text: 'She\'s being used too.' },
      { kind: 'Option', text: 'Leave it open for book 2.' },
    ],
  });
  assert.deepEqual(qs[1].suggestions, [{ kind: 'Option', text: 'Pell.' }]);
  assert.deepEqual(qs[2], { text: '**Ward\'s field:** what does it do?', suggestions: [] });
  assert.deepEqual(qs.map(initialAnswer), [{ choice: 0, note: '' }, { choice: -1, note: '' }, { choice: -1, note: '' }]);
  assert.deepEqual(questionsIn('```\n**Questions:**\n1. Real?\n```'), []);
});

test('a chosen suggestion is sent word for word, with any note', () => {
  const qs = questionsIn(WITH_SUGGESTIONS).map(parseQuestion);
  assert.equal(answersMessage(qs, [{ choice: 2, note: 'But hint at it.' }, { choice: 0, note: '' }, { choice: -1, note: 'Confusion.' }]),
    'Answers to your questions:\n\n1. Maria\'s role\n   Option: Leave it open for book 2.\n   Note: But hint at it.\n\n2. The name\n   Option: Pell.\n\n3. Ward\'s field\n   Confusion.');
  assert.equal(answersMessage(qs, qs.map(initialAnswer)),
    'Answers to your questions:\n\n1. Maria\'s role\n   Default: She knows; she arranged the brooch.\n\nI haven\'t answered the other 2 yet.');
});
