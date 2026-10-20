import { api } from './api.js';
import { confirmDialog, formDialog } from './dialogs.js';
import { formatWhen } from './history.js';
import { modeLabel } from './tree.js';
import { bookHref, formatCount, h, toast } from './ui.js';

function bookCard(book, onForget) {
  const tags = [];
  if (!book.exists) tags.push(h('span', { class: 'tag warn' }, 'folder missing'));
  else {
    if (!book.isGit) tags.push(h('span', { class: 'tag warn' }, 'not a git repo'));
    if (!book.hasManuscript) tags.push(h('span', { class: 'tag warn' }, 'no manuscript/'));
  }
  if (book.source === 'registered') tags.push(h('span', { class: 'tag' }, 'outside library'));

  const forget = book.source === 'registered'
    ? h('button', {
      type: 'button',
      title: 'Remove from this list (the folder is not touched)',
      onclick: (e) => { e.preventDefault(); onForget(book); },
    }, 'Remove from list')
    : null;

  const stats = [];
  if (book.words !== undefined) {
    stats.push(`${formatCount(book.words)} words${book.wordsMode ? ` (${modeLabel(book.wordsMode)})` : ''}`);
    stats.push(`${book.chapters} chapter${book.chapters === 1 ? '' : 's'}`);
  }
  return h('a', { class: `book-card${book.exists ? '' : ' missing'}`, href: book.exists ? bookHref(book.id) : null },
    h('h2', {}, book.title),
    stats.length ? h('div', { class: 'stats' }, stats.join(' · ')) : null,
    book.lastCommit ? h('div', { class: 'stats muted', title: book.lastCommit.subject }, `Last commit ${formatWhen(book.lastCommit.date)}`) : null,
    h('div', { class: 'path' }, book.path),
    h('div', { class: 'tags' }, tags, forget));
}

export async function renderLibrary(root) {
  const grid = h('div', { class: 'book-grid' });
  const sub = h('p', { class: 'sub' });
  const input = h('input', { type: 'text', placeholder: '/path/to/a/book/folder', 'aria-label': 'Book folder path' });
  const error = h('div', { class: 'error', role: 'alert' });

  async function refresh() {
    const { libraryRoot, libraryExists, books } = await api.listBooks();
    sub.textContent = `Library folder: ${libraryRoot}${libraryExists ? '' : ' (not created yet; your first new book creates it)'}`;
    grid.replaceChildren(...books.map((b) => bookCard(b, forget)));
    if (!books.length) {
      grid.replaceChildren(h('div', { class: 'empty' },
        h('p', {}, 'No books yet.'),
        h('p', {}, 'Use “+ New book” to start one: it gets manuscript/, outline/ and codex/ folders and its own git repository. Or open a folder you already have, below.')));
    }
  }

  async function forget(book) {
    const ok = await confirmDialog({
      title: `Remove “${book.title}” from the list?`,
      message: `The folder ${book.path} is not touched; you can open it again later.`,
      okLabel: 'Remove',
    });
    if (!ok) return;
    await api.forgetBook(book.id);
    await refresh();
  }

  async function newBook() {
    const v = await formDialog({
      title: 'New book',
      message: 'Creates a folder in your library with manuscript/, outline/ and codex/, starts a git repository and makes the first commit.',
      okLabel: 'Create book',
      fields: [
        { name: 'title', label: 'Title', required: true, placeholder: 'The Builder' },
        { name: 'remote', label: 'Git remote (optional)', placeholder: 'git@github.com:you/book.git', hint: 'Added as “origin”. Nothing is pushed.' },
      ],
    });
    if (!v) return;
    try {
      const book = await api.createBook(v.title, v.remote);
      for (const w of book.warnings || []) toast(w, { error: true, ms: 8000 });
      location.hash = bookHref(book.id);
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async function open(e) {
    e.preventDefault();
    error.textContent = '';
    try {
      const book = await api.registerBook(input.value);
      location.hash = bookHref(book.id);
    } catch (err) {
      error.textContent = err.message;
    }
  }

  root.replaceChildren(h('div', { class: 'library' }, h('div', { class: 'library-inner' },
    h('div', { class: 'library-head' },
      h('h1', {}, 'Books'),
      h('button', { type: 'button', class: 'primary', onclick: newBook }, '+ New book')),
    sub,
    grid,
    h('form', { class: 'open-folder', onsubmit: open },
      input,
      h('button', { type: 'submit' }, 'Open folder')),
    error)));

  await refresh();
}
