import { api } from './api.js';
import { renderMarkdown } from './pane.js';
import { formatCount, h, toast } from './ui.js';

// The Compile dialog: choose the whole book or one chapter, the narration
// mode, and the scene separator; compile; then preview, download or copy.
//   chapters: [{ name, title }]   modes: [{ value, label }]
export function openCompileDialog({ bookId, bookTitle, chapters, modes, mode = '', chapter = null }) {
  return new Promise((resolve) => {
    const scope = h('select', { name: 'scope' },
      h('option', { value: '' }, 'Whole book'),
      chapters.map((c) => h('option', { value: c.name, selected: c.name === chapter || null }, `Chapter: ${c.title}`)));
    const modeSel = h('select', { name: 'mode' },
      modes.map((m) => h('option', { value: m.value, selected: m.value === mode || null }, m.label)));
    const sep = h('input', { type: 'text', name: 'separator', autocomplete: 'off', spellcheck: 'false', placeholder: '* * *' });
    const remember = h('input', { type: 'checkbox', name: 'remember' });
    const error = h('div', { class: 'error', role: 'alert' });
    const result = h('div', { class: 'compile-result', hidden: true });
    const go = h('button', { type: 'submit', class: 'primary' }, 'Compile');
    const close = h('button', { type: 'button' }, 'Close');
    let saved = '';

    sep.addEventListener('input', () => { remember.checked = sep.value.trim() !== saved; });
    // Once compiled, the Compile button hides until a setting changes, when
    // it comes back as Compile again.
    for (const el of [scope, modeSel, sep]) {
      el.addEventListener('input', () => { if (!result.hidden) go.hidden = false; });
    }

    const form = h('form', { method: 'dialog', class: 'compile-panel' },
      h('h2', {}, 'Compile'),
      h('p', { class: 'dialog-message' }, 'Joins scenes into one Markdown file, with each chapter’s title as a heading. The file is written to compiled/ in the book folder, and you can download it here.'),
      h('div', { class: 'field-row' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'What'), scope),
        modes.length > 1 ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Narration mode'), modeSel) : null),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Between scenes'), sep,
        h('span', { class: 'field-hint' }, h('label', { class: 'check' }, remember, ' Remember for this book (saved in book.json)'))),
      error,
      result,
      h('div', { class: 'dialog-buttons' }, close, go));
    const dialog = h('dialog', { class: 'dialog dialog-wide' }, form);

    api.getCompileSettings(bookId).then((s) => {
      saved = s.separator;
      if (!sep.value) sep.value = s.separator;
    }).catch(() => {});

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      go.disabled = true;
      go.textContent = 'Compiling…';
      try {
        const res = await api.compile(bookId, {
          scope: scope.value ? 'chapter' : 'book',
          chapter: scope.value || undefined,
          mode: modes.length ? modeSel.value : '',
          separator: sep.value.trim() || undefined,
          remember: remember.checked,
        });
        if (remember.checked) {
          saved = res.separator;
          remember.checked = false;
        }
        showResult(res);
        go.hidden = true;
      } catch (err) {
        error.textContent = err.message;
      } finally {
        go.disabled = false;
        go.textContent = result.hidden ? 'Compile' : 'Compile again';
      }
    });

    function showResult(res) {
      const fileName = `${slug(bookTitle)}-${res.path.replace(/^compiled\//, '')}`;
      const download = h('a', { class: 'button primary', download: fileName, href: '#' }, 'Download .md');
      download.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([res.content], { type: 'text/markdown;charset=utf-8' }));
        download.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      });
      const copy = h('button', {
        type: 'button',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(res.content);
            toast('Copied to the clipboard');
          } catch {
            toast('Copying was blocked by the browser; use Download instead', { error: true });
          }
        },
      }, 'Copy');
      // replaceChildren, unlike h(), writes a null child as the text "null".
      result.replaceChildren(...[
        h('p', { class: 'compile-summary' },
          h('strong', {}, res.path), ` · ${formatCount(res.words)} words · ${res.chapters} chapter${res.chapters === 1 ? '' : 's'}, ${res.scenes} scene${res.scenes === 1 ? '' : 's'}`),
        res.warnings.length ? h('ul', { class: 'compile-warnings' }, res.warnings.map((w) => h('li', {}, w))) : null,
        h('div', { class: 'compile-actions' }, download, copy),
        h('div', { class: 'compile-preview' }, renderMarkdown(res.content)),
      ].filter(Boolean));
      result.hidden = false;
    }

    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.showModal();
    go.focus();
  });
}

function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'book';
}
