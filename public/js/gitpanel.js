import { api } from './api.js';
import { formatCount, h, toast } from './ui.js';

const STATUS_LABELS = { A: 'new', M: 'edited', D: 'deleted', R: 'renamed' };
const AREA_LABELS = { manuscript: 'Manuscript', outline: 'Outline', codex: 'Codex' };

// Groups files by Manuscript / Outline / Codex / Other, in that order.
export function groupFiles(files) {
  const groups = new Map(Object.values(AREA_LABELS).map((label) => [label, []]));
  groups.set('Other', []);
  for (const f of files) {
    const top = f.path.split('/')[0];
    groups.get(AREA_LABELS[top] ?? 'Other').push(f);
  }
  return [...groups].filter(([, list]) => list.length);
}

export function fileRow(f, { onOpen, allowDeleted = false, openTitle } = {}) {
  const words = [
    f.added ? h('span', { class: 'words-added', title: 'Words added' }, `+${formatCount(f.added)}`) : null,
    f.removed ? h('span', { class: 'words-removed', title: 'Words removed' }, `−${formatCount(f.removed)}`) : null,
  ];
  const name = f.from ? `${f.from} → ${f.path}` : f.path;
  return h('li', { class: 'change' },
    h('span', { class: `status-letter s-${f.status}`, title: STATUS_LABELS[f.status] || f.status }, f.status),
    onOpen && (allowDeleted || f.status !== 'D')
      ? h('a', { href: '#', class: 'change-path', title: openTitle ?? `Open ${f.path}`, onclick: (e) => { e.preventDefault(); onOpen(f.path); } }, name)
      : h('span', { class: 'change-path' }, name),
    h('span', { class: 'change-words' }, words));
}

// The Save revision panel: what changed since the last commit, a message box,
// Save revision, and Push when the book has a remote. Resolves when closed.
export function openRevisionPanel({ bookId, onCommitted = () => {}, onOpenFile = () => {} }) {
  return new Promise((resolve) => {
    const list = h('div', { class: 'changes' }, h('p', { class: 'muted' }, 'Looking for changes…'));
    const branchEl = h('p', { class: 'dialog-message' });
    const message = h('textarea', {
      name: 'message',
      rows: '3',
      placeholder: 'What this revision is, e.g. “Editor pass: softer cadence in chapter 2”',
      spellcheck: 'true',
    });
    const error = h('div', { class: 'error', role: 'alert' });
    const pushNote = h('span', { class: 'push-note muted' });
    const cancel = h('button', { type: 'button' }, 'Close');
    const pushBtn = h('button', { type: 'button', hidden: true }, 'Push');
    const save = h('button', { type: 'submit', class: 'primary', disabled: true }, 'Save revision');
    const form = h('form', { method: 'dialog', class: 'revision-panel' },
      h('h2', {}, 'Save revision'),
      branchEl,
      list,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Description'), message,
        h('span', { class: 'field-hint' }, 'Autosaves already keep every change; a revision is a named point you can find again in History.')),
      error,
      h('div', { class: 'dialog-buttons' }, pushNote, pushBtn, h('span', { class: 'spacer' }), cancel, save));
    const dialog = h('dialog', { class: 'dialog dialog-wide' }, form);
    let busy = false;
    let changed = false;
    const state = {};

    const setBusy = (on) => {
      busy = on;
      for (const b of [save, pushBtn, cancel]) b.disabled = on;
      if (!on) save.disabled = !state.files?.length;
    };

    async function refresh() {
      try {
        const [st, cmp] = await Promise.all([api.gitStatus(bookId), api.gitCompare(bookId, { to: 'worktree' }).catch(() => null)]);
        Object.assign(state, st, { files: cmp?.files ?? st.files });
        if (!st.repo) {
          branchEl.textContent = 'This book is not a git repository, so there is nothing to save a revision of.';
          list.replaceChildren();
          save.disabled = true;
          return;
        }
        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const sync = !st.upstream ? ''
          : st.ahead ? ` · ${plural(st.ahead, 'commit')} not pushed to ${st.upstream}`
          : ` · up to date with ${st.upstream}`;
        branchEl.replaceChildren('Draft ', h('strong', {}, st.branch || '(detached)'), sync,
          st.behind ? ` · ${plural(st.behind, 'commit')} behind` : '');
        const files = state.files;
        if (!files.length) {
          list.replaceChildren(h('p', { class: 'muted' }, 'No changes since the last commit.'));
        } else {
          list.replaceChildren(...groupFiles(files).map(([label, group]) => h('div', { class: 'change-group' },
            h('div', { class: 'group-label' }, `${label} · ${group.length}`),
            h('ul', {}, group.map((f) => fileRow(f, { onOpen: (p) => { dialog.close(); onOpenFile(p); } }))))));
        }
        save.disabled = busy || !files.length;
        pushBtn.hidden = !st.remotes.length;
        pushBtn.disabled = busy;
        pushNote.textContent = st.remotes.length && !st.upstream ? `Not pushed to ${st.remotes.includes('origin') ? 'origin' : st.remotes[0]} yet` : '';
      } catch (err) {
        error.textContent = err.message;
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      if (!message.value.trim()) {
        error.textContent = 'Write a short description of this revision.';
        message.focus();
        return;
      }
      error.textContent = '';
      setBusy(true);
      try {
        const res = await api.gitCommit(bookId, message.value.trim());
        changed = true;
        message.value = '';
        toast(`Saved revision ${res.commit}`);
        onCommitted(res);
      } catch (err) {
        error.textContent = err.message;
      } finally {
        setBusy(false);
        await refresh();
      }
    });

    pushBtn.addEventListener('click', async () => {
      error.textContent = '';
      setBusy(true);
      pushBtn.textContent = 'Pushing…';
      try {
        const res = await api.gitPush(bookId);
        changed = true;
        toast(`Pushed ${res.branch} to ${res.remote}`);
      } catch (err) {
        error.textContent = err.message;
      } finally {
        pushBtn.textContent = 'Push';
        setBusy(false);
        await refresh();
      }
    });

    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(changed);
    });
    document.body.append(dialog);
    dialog.showModal();
    message.focus();
    refresh();
  });
}
