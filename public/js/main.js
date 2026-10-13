import { api } from './api.js';
import { Editor } from './editor.js';
import { renderLibrary } from './library.js';
import { renderTree, tabForPath } from './tree.js';
import { bookHref, formatCount, h, parseHash, toast } from './ui.js';
import { countWords } from './wordcount.js';

const view = document.getElementById('view');
const crumb = document.getElementById('crumb');

const TAB_LABELS = { manuscript: 'Manuscript', outline: 'Outline', codex: 'Codex' };

// The book screen is built once per book and updated as the route changes.
class BookView {
  constructor(id) {
    this.id = id;
    this.book = null;
    this.tree = null;
    this.tab = 'manuscript';
    this.file = null; // { path, hash }
    this.saving = null;

    this.tabButtons = Object.entries(TAB_LABELS).map(([tab, label]) =>
      h('button', { type: 'button', role: 'tab', 'data-tab': tab, onclick: () => this.showTab(tab) }, label));
    this.treeEl = h('nav', { class: 'tree', 'aria-label': 'Book contents' });
    this.totalEl = h('div', { class: 'sidebar-foot' });

    this.titleEl = h('span', { class: 'file-title' });
    this.pathEl = h('span', { class: 'file-path' });
    this.dirtyEl = h('span', { class: 'dirty-dot', title: 'Unsaved changes', hidden: true });
    this.saveBtn = h('button', { type: 'button', onclick: () => this.save(), disabled: true, title: 'Save (⌘S)' }, 'Save');
    this.bannerEl = h('div', { class: 'banner', hidden: true });
    this.hostEl = h('div', { class: 'editor-host', hidden: true });
    this.placeholderEl = h('div', { class: 'placeholder' }, 'Choose a scene, plot file or codex entry on the left.');
    this.wordsEl = h('span');
    this.stateEl = h('span');

    this.el = h('div', { class: 'book' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'tabs', role: 'tablist' }, this.tabButtons),
        this.treeEl,
        this.totalEl),
      h('section', { class: 'editor-area' },
        h('div', { class: 'editor-head' }, this.dirtyEl, this.titleEl, this.pathEl, this.saveBtn),
        this.bannerEl,
        this.hostEl,
        this.placeholderEl,
        h('div', { class: 'statusbar' }, this.wordsEl, h('span', { class: 'spacer' }), this.stateEl)));

    this.editor = new Editor(this.hostEl, {
      onChange: () => this.updateStatus(),
      onSave: () => this.save(),
    });
  }

  async init() {
    [this.book, this.tree] = await Promise.all([api.getBook(this.id), api.getTree(this.id)]);
    crumb.textContent = this.book.title;
    document.title = `${this.book.title} · Book Editor`;
  }

  get dirty() {
    return Boolean(this.file) && this.editor.dirty;
  }

  async route({ tab, path }) {
    const nextTab = tab && TAB_LABELS[tab] ? tab : (path ? tabForPath(path) : this.tab);
    if (path !== (this.file?.path ?? null)) {
      if (path) await this.openFile(path);
      else this.closeFile();
    }
    this.showTab(nextTab, { updateHash: false });
  }

  showTab(tab, { updateHash = true } = {}) {
    this.tab = tab;
    for (const b of this.tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    this.renderTree();
    if (updateHash) history.replaceState(null, '', bookHref(this.id, tab, this.file?.path));
  }

  renderTree() {
    renderTree(this.treeEl, this.tree, { id: this.id, tab: this.tab, activePath: this.file?.path });
    this.totalEl.textContent = `${formatCount(this.tree.words)} words in the manuscript`;
  }

  async refreshTree() {
    this.tree = await api.getTree(this.id);
    this.renderTree();
  }

  async openFile(path) {
    const file = await api.readFile(this.id, path);
    this.file = { path: file.path, hash: file.hash };
    this.editor.load(file.content);
    this.hideBanner();
    this.hostEl.hidden = false;
    this.placeholderEl.hidden = true;
    this.titleEl.textContent = file.path.split('/').pop().replace(/\.md$/i, '');
    this.pathEl.textContent = file.path;
    this.updateStatus();
    this.editor.focus();
  }

  closeFile() {
    this.file = null;
    this.editor.load('');
    this.hideBanner();
    this.hostEl.hidden = true;
    this.placeholderEl.hidden = false;
    this.titleEl.textContent = '';
    this.pathEl.textContent = '';
    this.updateStatus();
  }

  updateStatus() {
    const dirty = this.dirty;
    this.dirtyEl.hidden = !dirty;
    this.saveBtn.disabled = !dirty;
    if (!this.file) {
      this.wordsEl.textContent = '';
      this.stateEl.textContent = '';
      return;
    }
    clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => {
      this.wordsEl.textContent = `${formatCount(countWords(this.editor.content))} words`;
    }, 150);
    this.stateEl.textContent = this.saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved';
  }

  // Resolves true when the file is saved (or there was nothing to save).
  async save({ force = false } = {}) {
    if (!this.file || (!this.dirty && !force)) return true;
    if (this.saving) return this.saving;
    const { path, hash } = this.file;
    const content = this.editor.content;
    this.saving = (async () => {
      this.updateStatus();
      try {
        const res = await api.writeFile(this.id, path, content, hash, force);
        if (this.file?.path === path) {
          this.file.hash = res.hash;
          this.editor.markSaved(content);
          this.hideBanner();
        }
        this.refreshTree().catch(() => {});
        return true;
      } catch (err) {
        if (err.status === 409) this.showConflict(err.data);
        else toast(`Could not save: ${err.message}`, { error: true });
        return false;
      } finally {
        this.saving = null;
        this.updateStatus();
      }
    })();
    return this.saving;
  }

  showConflict(data) {
    const gone = data.diskContent === null;
    this.showBanner(
      gone
        ? 'This file was deleted or moved on disk since you opened it.'
        : 'This file changed on disk since you opened it. Your edits are still here.',
      [
        !gone && h('button', { type: 'button', onclick: () => this.reloadFromDisk(data) }, 'Discard mine, load disk version'),
        h('button', { type: 'button', class: 'primary', onclick: () => this.save({ force: true }) },
          gone ? 'Save mine again' : 'Overwrite with mine'),
      ],
    );
  }

  reloadFromDisk({ diskContent, diskHash }) {
    this.file.hash = diskHash;
    this.editor.load(diskContent, { keepSelection: true });
    this.hideBanner();
    this.updateStatus();
  }

  showBanner(message, buttons) {
    this.bannerEl.replaceChildren(h('span', { class: 'msg' }, message), ...buttons.filter(Boolean));
    this.bannerEl.hidden = false;
  }

  hideBanner() {
    this.bannerEl.hidden = true;
    this.bannerEl.replaceChildren();
  }
}

let bookView = null;
let currentHash = location.hash;

async function handleRoute() {
  const route = parseHash();
  try {
    if (route.view === 'library') {
      if (bookView?.dirty && !(await bookView.save())) return revert();
      bookView = null;
      crumb.textContent = '';
      document.title = 'Book Editor';
      await renderLibrary(view);
    } else {
      if (bookView?.id !== route.id) {
        if (bookView?.dirty && !(await bookView.save())) return revert();
        bookView = new BookView(route.id);
        await bookView.init();
        view.replaceChildren(bookView.el);
      } else if (bookView.dirty && route.path !== bookView.file?.path) {
        // Leaving a file with edits: save first, and stay put if that fails.
        if (!(await bookView.save())) return revert();
      }
      await bookView.route(route);
    }
    currentHash = location.hash;
  } catch (err) {
    if (route.view === 'book' && err.status === 404 && bookView?.id === route.id && route.path) {
      toast(err.message, { error: true });
      return revert();
    }
    bookView = null;
    view.replaceChildren(h('div', { class: 'placeholder' },
      h('div', {}, h('p', {}, err.message), h('a', { href: '#/' }, 'Back to books'))));
  }
}

// Put the address bar back to what's actually on screen.
function revert() {
  const hash = bookView ? bookHref(bookView.id, bookView.tab, bookView.file?.path) : currentHash || '#/';
  history.replaceState(null, '', hash);
  currentHash = hash;
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('beforeunload', (e) => {
  if (bookView?.dirty) e.preventDefault();
});

handleRoute();
