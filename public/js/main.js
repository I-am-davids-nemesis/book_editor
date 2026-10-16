import { api } from './api.js';
import { confirmDialog, formDialog, promptDialog } from './dialogs.js';
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
    renderTree(this.treeEl, this.tree, { id: this.id, tab: this.tab, activePath: this.file?.path, actions: this.actions });
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
    this.showFileHeader();
    this.updateStatus();
    this.editor.focus();
  }

  showFileHeader() {
    const path = this.file?.path ?? '';
    this.titleEl.textContent = path.split('/').pop().replace(/\.md$/i, '');
    this.pathEl.textContent = path;
  }

  closeFile() {
    this.file = null;
    this.editor.load('');
    this.hideBanner();
    this.hostEl.hidden = true;
    this.placeholderEl.hidden = false;
    this.showFileHeader();
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

  // --- structure changes ------------------------------------------------------

  // Saves the open file, runs a structure change, then follows the open file
  // if it moved (or closes it if it was deleted) and refreshes the tree.
  async runOp(fn) {
    if (this.dirty && !(await this.save())) return null;
    let res;
    try {
      res = await fn();
    } catch (err) {
      toast(err.message, { error: true });
      await this.refreshTree().catch(() => {});
      return null;
    }
    this.followChanges(res);
    await this.refreshTree();
    return res;
  }

  followChanges({ moves = [], deleted = [] }) {
    const p = this.file?.path;
    if (!p) return;
    const under = (base) => p === base || p.startsWith(`${base}/`);
    if (deleted.some(under)) {
      this.closeFile();
      history.replaceState(null, '', bookHref(this.id, this.tab));
      return;
    }
    const m = moves.find((mv) => under(mv.from));
    if (m) {
      this.file.path = m.to + p.slice(m.from.length);
      this.showFileHeader();
      history.replaceState(null, '', bookHref(this.id, this.tab, this.file.path));
    }
  }

  open(tab, path) {
    location.hash = bookHref(this.id, tab, path);
  }

  get actions() {
    const id = this.id;
    const positionField = (entries, noun) => ({
      name: 'position',
      label: 'Position',
      type: 'select',
      value: '',
      options: [
        { value: '', label: 'At the end' },
        ...(entries.length ? [{ value: '1', label: 'At the start' }] : []),
        ...entries.slice(0, -1).map((e, i) => ({ value: String(i + 2), label: `After “${e.title}”` })),
      ],
      hint: `Later ${noun} are renumbered to make room.`,
    });

    return {
      addChapter: async () => {
        const v = await formDialog({
          title: 'New chapter',
          okLabel: 'Add chapter',
          fields: [
            { name: 'title', label: 'Title', required: true, placeholder: 'The Washing House' },
            positionField(this.tree.chapters, 'chapters'),
          ],
        });
        if (!v) return;
        const res = await this.runOp(() => api.addChapter(id, v.title, v.position || undefined));
        if (res && this.tab === 'outline') this.open('outline', `outline/${res.chapter}/_chapter.md`);
        else if (res) toast(`Added ${res.chapter}`);
      },

      addScene: async (ch) => {
        const v = await formDialog({
          title: `New scene in “${ch.title}”`,
          message: 'Creates the scene file and its plot file in outline/.',
          okLabel: 'Add scene',
          fields: [
            { name: 'title', label: 'Title', required: true, placeholder: 'Dorgal arrives' },
            positionField(ch.scenes, 'scenes'),
          ],
        });
        if (!v) return;
        const res = await this.runOp(() => api.addScene(id, ch.name, v.title, v.position || undefined));
        if (!res) return;
        const tab = this.tab === 'outline' ? 'outline' : 'manuscript';
        this.open(tab, `${tab}/${ch.name}/${res.scene}`);
      },

      renameChapter: async (ch) => {
        const title = await promptDialog({ title: 'Rename chapter', label: 'Title', value: ch.title, okLabel: 'Rename', hint: 'The folder keeps its number; only the name changes.' });
        if (title) await this.runOp(() => api.renameChapter(id, ch.name, title));
      },

      deleteChapter: async (ch) => {
        const n = ch.scenes.length;
        const ok = await confirmDialog({
          title: `Delete “${ch.title}”?`,
          message: `This deletes manuscript/${ch.name} and outline/${ch.name}, with ${n} scene${n === 1 ? '' : 's'} and their plot files. Later chapters are renumbered. Anything already committed can be restored from git history.`,
          okLabel: 'Delete chapter',
          danger: true,
        });
        if (ok) await this.runOp(() => api.deleteChapter(id, ch.name));
      },

      renameScene: async (ch, s) => {
        const title = await promptDialog({ title: 'Rename scene', label: 'Title', value: s.title, okLabel: 'Rename', hint: 'Renames the scene file, its plot file and any variants. The number stays.' });
        if (title) await this.runOp(() => api.renameScene(id, ch.name, s.name, title));
      },

      deleteScene: async (ch, s) => {
        const extra = s.variants.length ? `, its ${s.variants.length} variant${s.variants.length === 1 ? '' : 's'}` : '';
        const ok = await confirmDialog({
          title: `Delete “${s.title}”?`,
          message: `This deletes the scene file, its plot file${extra}. Later scenes are renumbered. Anything already committed can be restored from git history.`,
          okLabel: 'Delete scene',
          danger: true,
        });
        if (ok) await this.runOp(() => api.deleteScene(id, ch.name, s.name));
      },

      reorder: (chapter, order) => this.runOp(() => api.reorder(id, chapter || undefined, order)),

      createMissing: async (path) => {
        const res = await this.runOp(() => api.createMissing(id, path));
        if (res) this.open(path.startsWith('outline/') ? 'outline' : 'manuscript', path);
      },

      addCodex: async (kind) => {
        const labels = { character: 'character', location: 'location', note: 'note' };
        const name = await promptDialog({ title: `New ${labels[kind]}`, label: 'Name', okLabel: 'Add', hint: kind === 'note' ? 'Created as a free-form note in codex/.' : 'Created from the template in codex/_templates/.' });
        if (!name) return;
        const res = await this.runOp(() => api.addCodex(id, kind, name));
        if (res) this.open('codex', res.path);
      },

      renameCodex: async (entry) => {
        const name = await promptDialog({ title: 'Rename', label: 'Name', value: entry.title, okLabel: 'Rename', hint: 'Renames the file. Update the heading inside yourself.' });
        if (name) await this.runOp(() => api.renameCodex(id, entry.path, name));
      },

      deleteCodex: async (entry) => {
        const ok = await confirmDialog({ title: `Delete “${entry.title}”?`, message: `This deletes ${entry.path}. If it was committed, it can be restored from git history.`, okLabel: 'Delete', danger: true });
        if (ok) await this.runOp(() => api.deleteCodex(id, entry.path));
      },
    };
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
