// Claude often ends a reply with questions for the writer: a list under a
// short line such as "**Questions:**", "Open questions:" or "### Still open".
// These pick them out and turn the writer's answers into a reply. Shared by
// the browser (the Claude panel) and the tests.

const ITEM_RE = /^ {0,3}(?:\d+[.)]|[-*+])\s+(.*)$/;
const HEADING_RE = /^#{1,6}\s/;

// The text of a line that is only a label ("**Questions:**", "## Open
// questions"), or null.
function labelOf(line) {
  const m = /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?([^*_:#]{1,40}?)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/.exec(line);
  return m ? m[1] : null;
}

// "Questions", "Open questions for you": a few words, not a sentence.
function isQuestionsLabel(line) {
  const label = ITEM_RE.test(line) ? null : labelOf(line);
  return Boolean(label) && !label.includes(',') && label.split(/\s+/).length <= 4 && /question|still open/i.test(label);
}

// The questions in the last such list of `markdown`: ['item markdown', …],
// each without its list marker. [] if there's none.
export function questionsIn(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isQuestionsLabel(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return [];
  const items = [];
  let current = null;
  let blank = false;
  for (const line of lines.slice(start + 1)) {
    const item = ITEM_RE.exec(line);
    if (!line.trim()) {
      blank = true;
      continue;
    }
    if (item) {
      current = [item[1]];
      items.push(current);
    } else if (current && /^\s{2,}\S/.test(line)) {
      current.push(line.replace(/^\s{2,4}/, ''));
    } else if (current && !blank && !HEADING_RE.test(line)) {
      current.push(line.trim()); // a lazy continuation
    } else if (current || HEADING_RE.test(line)) {
      break;
    }
    blank = false;
  }
  return items.map((l) => l.join('\n').trim()).filter(Boolean);
}

// A short name for a question: its bold lead ("**Maria:** how did…" gives
// "Maria"), or its first words.
export function questionLabel(question) {
  const bold = /^\*\*(.+?)\*\*/.exec(question);
  if (bold) return bold[1].replace(/[:.]\s*$/, '');
  const plain = question.replace(/[*_`]/g, '').split('\n')[0];
  return plain.length > 80 ? `${plain.slice(0, 79).replace(/\s+\S*$/, '')}…` : plain;
}

export const ANSWERS_START = 'Answers to your questions:';

// The reply to send: each answered question by number and name, then its
// answer. Unanswered ones are left out. '' when nothing was answered.
export function answersMessage(questions, answers) {
  const parts = questions
    .map((q, i) => ({ n: i + 1, label: questionLabel(q), answer: (answers[i] ?? '').trim() }))
    .filter((a) => a.answer);
  if (!parts.length) return '';
  const skipped = questions.length - parts.length;
  return [
    ANSWERS_START,
    ...parts.map((a) => `${a.n}. ${a.label}\n${a.answer.replace(/^/gm, '   ')}`),
    skipped ? `I haven't answered the other ${skipped === 1 ? 'one' : skipped} yet.` : null,
  ].filter(Boolean).join('\n\n');
}
