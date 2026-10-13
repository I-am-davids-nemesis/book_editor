import { api } from './api.js';
import { bookHref, h } from './ui.js';

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

  return h('a', { class: `book-card${book.exists ? '' : ' missing'}`, href: book.exists ? bookHref(book.id) : null },
    h('h2', {}, book.title),
    h('div', { class: 'path' }, book.path),
    h('div', { class: 'tags' }, tags, forget));
}

export async function renderLibrary(root) {
  const grid = h('div', { class: 'book-grid' });
  const sub = h('p', { class: 'sub' });
  const input = h('input', { type: 'text', placeholder: '/path/to/a/book/folder', 'aria-label': 'Book folder path' });
  const error = h('div', { class: 'error', role: 'alert' });

  async function refresh() {
    const { libraryRoot, books } = await api.listBooks();
    sub.textContent = `Library folder: ${libraryRoot}`;
    grid.replaceChildren(...books.map((b) => bookCard(b, forget)));
    if (!books.length) grid.replaceChildren(h('div', { class: 'empty' }, 'No books yet. Open an existing folder below.'));
  }

  async function forget(book) {
    if (!confirm(`Remove “${book.title}” from the list? The folder on disk is not touched.`)) return;
    await api.forgetBook(book.id);
    await refresh();
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
    h('h1', {}, 'Books'),
    sub,
    grid,
    h('form', { class: 'open-folder', onsubmit: open },
      input,
      h('button', { type: 'submit' }, 'Open folder')),
    error)));

  await refresh();
}
