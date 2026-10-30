import { api } from './api.js';
import { availableModes, modeLabel, sceneFiles } from './tree.js';
import { formatCount, h } from './ui.js';

const SEARCH_DELAY_MS = 200;
const SCOPES = { all: 'Whole book', manuscript: 'Manuscript', outline: 'Outline', codex: 'Codex' };

// What the dialog showed last, so reopening it picks up where you left off.
const last = { query: '', caseSensitive: false, wholeWord: false, scope: 'all' };

// A readable name for each file in the tree, for the result headings.
//   Map(path → { label, detail })
export function searchLabels(tree) {
  const labels = new Map();
  const withModes = availableModes(tree).length > 1;
  for (const ch of tree.chapters) {
    for (const s of ch.scenes) {
      for (const file of sceneFiles(s)) {
        const variant = s.variants.find((v) => v.path === file)?.variant ?? '';
        labels.set(file, { label: s.title, detail: `${ch.title} · scene${withModes ? ` · ${modeLabel(variant)}` : ''}` });
      }
      if (s.inOutline) labels.set(s.outlinePath, { label: s.title, detail: `${ch.title} · plot` });
    }
    if (ch.hasSummary) labels.set(ch.summaryPath, { label: ch.title, detail: 'chapter summary' });
  }
  for (const [group, kind] of [['characters', 'character'], ['locations', 'location'], ['notes', 'note']]) {
    for (const e of tree.codex[group]) labels.set(e.path, { label: e.title, detail: kind });
  }
  for (const img of tree.lookbook ?? []) {
    if (img.hasNote) labels.set(img.notePath, { label: img.title, detail: 'lookbook note' });
  }
  return labels;
}

function labelFor(labels, path) {
  return labels.get(path) ?? { label: path.split('/').pop().replace(/\.md$/i, ''), detail: path };
}

// The ⌘⇧F dialog. Resolves with the chosen match, { path, line, col, length },
// or null.
export function searchDialog({ bookId, tree }) {
  const labels = searchLabels(tree);
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', placeholder: 'Search the book', 'aria-label': 'Search text', autocomplete: 'off', spellcheck: 'false', value: last.query });
    const caseBox = h('input', { type: 'checkbox', checked: last.caseSensitive });
    const wordBox = h('input', { type: 'checkbox', checked: last.wholeWord });
    const scopeSel = h('select', { 'aria-label': 'Where to search' },
      Object.entries(SCOPES).map(([v, label]) => h('option', { value: v, selected: v === last.scope }, label)));
    const summary = h('span', { class: 'search-summary muted' });
    const list = h('ul', { class: 'quick-list search-results', role: 'listbox' });
    const dialog = h('dialog', { class: 'dialog quick-open search-dialog' },
      h('div', { class: 'quick-inner' },
        input,
        h('div', { class: 'search-options' },
          h('label', {}, caseBox, 'Match case'),
          h('label', {}, wordBox, 'Whole words'),
          scopeSel,
          h('span', { class: 'spacer' }),
          summary),
        list));
    let rows = []; // { match, path, el }, in display order
    let index = 0;
    let result = null;
    let timer = null;
    let seq = 0;

    const setActive = (i) => {
      rows[index]?.el.classList.remove('active');
      rows[index]?.el.setAttribute('aria-selected', 'false');
      index = i;
      rows[index]?.el.classList.add('active');
      rows[index]?.el.setAttribute('aria-selected', 'true');
      rows[index]?.el.scrollIntoView?.({ block: 'nearest' });
    };

    const render = (data) => {
      rows = [];
      index = 0;
      const items = [];
      for (const file of data.files) {
        const { label, detail } = labelFor(labels, file.path);
        items.push(h('li', { class: 'search-file', role: 'presentation' },
          h('span', { class: 'quick-label' }, label),
          h('span', { class: 'quick-detail' }, detail),
          h('span', { class: 'search-count muted' }, String(file.matches.length))));
        for (const m of file.matches) {
          const i = rows.length;
          const el = h('li', {
            role: 'option',
            class: 'search-match',
            'aria-selected': 'false',
            onmousedown: (e) => { e.preventDefault(); choose(i); },
          }, m.before, h('mark', {}, m.text), m.after);
          rows.push({ match: m, path: file.path, el });
          items.push(el);
        }
      }
      list.replaceChildren(...(items.length ? items : [h('li', { class: 'muted' }, 'Nothing found.')]));
      const files = data.files.length;
      summary.textContent = data.truncated
        ? `First ${formatCount(data.total)} matches`
        : `${formatCount(data.total)} match${data.total === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}`;
      setActive(0);
    };

    const run = async () => {
      Object.assign(last, { query: input.value, caseSensitive: caseBox.checked, wholeWord: wordBox.checked, scope: scopeSel.value });
      const mine = ++seq;
      if (!last.query.trim()) {
        rows = [];
        summary.textContent = '';
        list.replaceChildren();
        return;
      }
      try {
        const data = await api.search(bookId, last);
        if (mine === seq) render(data);
      } catch (err) {
        if (mine !== seq) return;
        rows = [];
        summary.textContent = '';
        list.replaceChildren(h('li', { class: 'error' }, err.message));
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(run, SEARCH_DELAY_MS);
    };
    const choose = (i) => {
      const row = rows[i];
      if (!row) return;
      result = { path: row.path, line: row.match.line, col: row.match.col, length: row.match.length };
      dialog.close();
    };

    input.addEventListener('input', schedule);
    for (const el of [caseBox, wordBox, scopeSel]) el.addEventListener('change', () => { run(); input.focus(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(rows.length - 1, index + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, index - 1)); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(index); }
    });
    dialog.addEventListener('close', () => {
      clearTimeout(timer);
      dialog.remove();
      resolve(result);
    });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    input.select();
    if (input.value) run();
  });
}
