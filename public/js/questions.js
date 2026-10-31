// Claude often asks the writer questions: a list under a line such as
// "**Questions:**", "### Still open" or "A few questions before I go on:", or
// any list whose items are all questions. Under each question there may be
// suggested answers, as indented sub-bullets (the book's AGENTS.md asks for
// them):
//   1. **The jeweler:** does the crown send for him?
//      - Default: The crown sends; the shop exists.
//      - Option: There's no such jeweler.
// These pick them out and turn the writer's answers into a reply. Lists inside
// fenced code blocks are examples, not questions. Shared by the browser (the
// Claude panel) and the tests.

const ITEM_RE = /^ {0,3}(?:\d+[.)]|[-*+])\s+(.*)$/;
const HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^\s*(```|~~~)/;
const indentOf = (line) => /^\s*/.exec(line)[0].length;

// The text of a line that is only a label ("**Questions:**", "## Open
// questions"), or null.
function labelOf(line) {
  const m = /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?([^*_:#]{1,40}?)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/.exec(line);
  return m ? m[1] : null;
}

// "Questions", "Open questions for you": a few words, not a sentence. Or a
// sentence that introduces them: "I have three questions before I start:".
function isQuestionsLabel(line) {
  if (ITEM_RE.test(line) || /\b(no|none|without)\b/i.test(line)) return false;
  const label = labelOf(line);
  if (label && !label.includes(',') && label.split(/\s+/).length <= 4 && /question|still open/i.test(label)) return true;
  const text = line.replace(/[*_]/g, '').trim();
  return text.endsWith(':') && /\bquestions?\b/i.test(text);
}

// The list that starts at line `from`, allowing blank lines before it:
// { items: [['line', …], …], end } where `end` is the first line after it.
// Items indented deeper than the first are sub-bullets of the one above.
function listFrom(lines, from) {
  const items = [];
  let current = null;
  let blank = false;
  let indent = 0;
  let i = from;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const item = ITEM_RE.exec(line);
    if (!line.trim()) {
      blank = true;
      continue;
    }
    if (FENCE_RE.test(line)) break;
    if (item && current && indentOf(line) > indent) {
      current.push(line.replace(/^\s{2,4}/, ''));
    } else if (item) {
      if (!current) indent = indentOf(line);
      current = [item[1]];
      items.push(current);
    } else if (current && /^\s{2,}\S/.test(line)) {
      current.push(line.replace(/^\s{2,4}/, ''));
    } else if (current && !blank && !HEADING_RE.test(line)) {
      current.push(line.trim()); // a lazy continuation
    } else {
      break;
    }
    blank = false;
  }
  return { items: items.map((l) => l.join('\n').trim()).filter(Boolean), end: i };
}

// The questions in the last list of questions in `markdown`: ['item
// markdown', …], each without its list marker. [] if there's none.
export function questionsIn(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  let found = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_RE.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const labelled = isQuestionsLabel(lines[i]);
    if (!labelled && !ITEM_RE.test(lines[i])) continue;
    const { items, end } = listFrom(lines, labelled ? i + 1 : i);
    if (items.length && (labelled || items.every((q) => q.includes('?')))) found = items;
    if (items.length) i = end - 1;
  }
  return found;
}

// A short name for a question: its bold lead ("**Maria:** how did…" gives
// "Maria"), or its first words.
export function questionLabel(question) {
  const bold = /^\*\*(.+?)\*\*/.exec(question);
  if (bold) return bold[1].replace(/[:.]\s*$/, '');
  const plain = question.replace(/[*_`]/g, '').split('\n')[0];
  return plain.length > 80 ? `${plain.slice(0, 79).replace(/\s+\S*$/, '')}…` : plain;
}

// A question and its suggested answers: { text, suggestions: [{ kind:
// 'Default' | 'Option', text }] }, the default first. "Default: none" means
// there's no default; the options still count.
const SUGGESTION_RE = /^\s*[-*+]\s+(Default|Option):\s*(.*)$/i;

export function parseQuestion(item) {
  const text = [];
  const suggestions = [];
  for (const line of String(item).split('\n')) {
    const m = SUGGESTION_RE.exec(line);
    if (!m) {
      text.push(line);
      continue;
    }
    const kind = m[1].toLowerCase() === 'default' ? 'Default' : 'Option';
    const answer = m[2].trim();
    if (!answer || (kind === 'Default' && /^none\.?$/i.test(answer))) continue;
    if (kind === 'Default') suggestions.unshift({ kind, text: answer });
    else suggestions.push({ kind, text: answer });
  }
  return { text: text.join('\n').trim(), suggestions };
}

// A fresh answer to a parsed question: its default chosen if it has one.
// `choice` is an index into its suggestions, or -1 for the writer's own.
export function initialAnswer(question) {
  return { choice: question.suggestions[0]?.kind === 'Default' ? 0 : -1, note: '' };
}

export const isAnswered = (a) => a.choice >= 0 || Boolean(a.note.trim());

export const ANSWERS_START = 'Answers to your questions:';

// The reply to send, for parsed questions and their answers: each answered
// question by number and name, then the suggestion chosen (word for word, so
// it stands on its own) and any note, or the writer's own answer. Unanswered
// ones are left out. '' when nothing was answered.
export function answersMessage(questions, answers) {
  const indent = (t) => t.replace(/^/gm, '   ');
  const parts = questions
    .map((q, i) => ({ n: i + 1, label: questionLabel(q.text), q, a: answers[i] }))
    .filter(({ a }) => a && isAnswered(a))
    .map(({ n, label, q, a }) => {
      const note = a.note.trim();
      const chosen = q.suggestions[a.choice];
      const body = chosen
        ? [`${chosen.kind}: ${chosen.text}`, note ? `Note: ${note}` : null].filter(Boolean).join('\n')
        : note;
      return `${n}. ${label}\n${indent(body)}`;
    });
  if (!parts.length) return '';
  const skipped = questions.length - parts.length;
  return [
    ANSWERS_START,
    ...parts,
    skipped ? `I haven't answered the other ${skipped === 1 ? 'one' : skipped} yet.` : null,
  ].filter(Boolean).join('\n\n');
}
