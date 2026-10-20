import { h } from './ui.js';

// Every file worth jumping to, with a label to search on.
//   [{ path, label, detail, kind }]
export function quickOpenItems(tree, { sceneFileFor }) {
  const items = [];
  for (const ch of tree.chapters) {
    for (const s of ch.scenes) {
      const file = sceneFileFor(s);
      if (file) items.push({ path: file, label: s.title, detail: `${ch.title} · scene`, kind: 'scene' });
      if (s.inOutline) items.push({ path: s.outlinePath, label: s.title, detail: `${ch.title} · plot`, kind: 'plot' });
    }
    if (ch.hasSummary) items.push({ path: ch.summaryPath, label: ch.title, detail: 'chapter summary', kind: 'plot' });
  }
  const { codex } = tree;
  for (const [group, kind] of [['characters', 'character'], ['locations', 'location'], ['notes', 'note']]) {
    for (const e of codex[group]) items.push({ path: e.path, label: e.title, detail: kind, kind: 'codex' });
  }
  for (const f of tree.rootFiles) items.push({ path: f.path, label: f.name, detail: 'book file', kind: 'codex' });
  return items;
}

// Fuzzy match: every query character appears in order. Lower score is
// better: matches at word starts and close together win.
export function fuzzyScore(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (!q) return 0;
  // First try matching letters at word starts ("wh" → Washing House), then
  // fall back to the first occurrence of each letter.
  return Math.min(scan(q, t, true), scan(q, t, false));
}

const isWordStart = (t, i) => i === 0 || /[\s/·._-]/.test(t[i - 1]);

function scan(q, t, preferStarts) {
  let score = 0;
  let last = -1;
  for (const c of q) {
    let i = t.indexOf(c, last + 1);
    // Unless the letter follows the previous one directly, jump to the next
    // occurrence that starts a word, if there is one.
    if (preferStarts && i !== last + 1) {
      let j = i;
      while (j !== -1 && !isWordStart(t, j)) j = t.indexOf(c, j + 1);
      if (j !== -1) i = j;
    }
    if (i === -1) return Infinity;
    const gap = i - last - 1;
    score += (gap && !isWordStart(t, i) ? gap : 0) + (isWordStart(t, i) || gap === 0 ? 0 : 2);
    last = i;
  }
  return score;
}

export function rankItems(items, query, limit = 50) {
  return items
    .map((item) => ({ item, score: Math.min(fuzzyScore(query, item.label) * 0.5, fuzzyScore(query, `${item.label} ${item.detail} ${item.path}`)) }))
    .filter((r) => r.score !== Infinity)
    .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label))
    .slice(0, limit)
    .map((r) => r.item);
}

// The ⌘P dialog. Resolves with the chosen path, or null.
export function quickOpen(items) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', placeholder: 'Find a scene, plot file or codex entry', 'aria-label': 'File name', autocomplete: 'off', spellcheck: 'false' });
    const list = h('ul', { class: 'quick-list', role: 'listbox' });
    const dialog = h('dialog', { class: 'dialog quick-open' }, h('div', { class: 'quick-inner' }, input, list));
    let shown = [];
    let index = 0;
    let result = null;

    const render = () => {
      shown = rankItems(items, input.value);
      index = Math.min(index, Math.max(0, shown.length - 1));
      list.replaceChildren(...(shown.length ? shown.map((it, i) => h('li', {
        role: 'option',
        class: `kind-${it.kind}${i === index ? ' active' : ''}`,
        'aria-selected': String(i === index),
        onmousedown: (e) => { e.preventDefault(); choose(i); },
      }, h('span', { class: 'quick-label' }, it.label), h('span', { class: 'quick-detail' }, it.detail))) : [h('li', { class: 'muted' }, 'Nothing matches.')]));
      list.querySelector('.active')?.scrollIntoView?.({ block: 'nearest' });
    };
    const choose = (i) => {
      if (!shown[i]) return;
      result = shown[i].path;
      dialog.close();
    };

    input.addEventListener('input', () => { index = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(shown.length - 1, index + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(index); }
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    document.body.append(dialog);
    dialog.showModal();
    render();
    input.focus();
  });
}
