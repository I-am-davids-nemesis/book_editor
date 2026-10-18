import { marked } from 'marked';
import { api } from './api.js';
import { Editor } from './editor.js';
import { h, toast } from './ui.js';
import { countWords } from './wordcount.js';

// Edits are written to disk after a short pause in typing, and at least this
// often while typing continues. Commits happen on the server: when you switch
// files, and 30 minutes after the first uncommitted change at the latest.
const AUTOSAVE_IDLE_MS = 1000;
const AUTOSAVE_MAX_WAIT_MS = 5000;
const AUTOSAVE_RETRY_MS = 10000;
const PREVIEW_DELAY_MS = 200;

const VIEWS = { edit: 'Edit', split: 'Split', preview: 'Preview' };

// One open file: header, conflict banner, CodeMirror editor and rendered
// preview. The book screen has two: the main pane (the file in the address
// bar) and the side pane (its plot file or scene).
export class Pane {
  constructor({ bookId, role, view = 'edit', headExtras = [], onChange = () => {}, onView = () => {} }) {
    this.bookId = bookId;
    this.role = role;
    this.onChange = onChange;
    this.onView = onView;
    this.file = null; // { path, hash }
    this.saving = null;
    this.conflicted = false; // a save hit a conflict; autosave waits for the banner
    this.saveFailed = false; // retry slowly, and toast once, while saves fail
    this.autosaveTimer = null;
    this.firstUnsavedAt = 0;

    this.labelEl = h('span', { class: 'pane-label', hidden: true });
    this.titleEl = h('span', { class: 'file-title' });
    this.pathEl = h('span', { class: 'file-path' });
    this.dirtyEl = h('span', { class: 'dirty-dot', title: 'Unsaved changes', hidden: true });
    this.stateEl = h('span', { class: 'save-state' });
    this.viewButtons = Object.entries(VIEWS).map(([v, label]) =>
      h('button', { type: 'button', 'data-view': v, onclick: () => this.setView(v), title: `${label} view` }, label));
    this.saveBtn = h('button', { type: 'button', class: 'save', onclick: () => this.save(), disabled: true, title: 'Save now (⌘S). Edits also save by themselves after a second.' }, 'Save');
    this.headEl = h('div', { class: 'editor-head' },
      this.dirtyEl, this.labelEl, this.titleEl, headExtras, this.pathEl, this.stateEl,
      h('span', { class: 'segmented view-switch', role: 'group', 'aria-label': 'View' }, this.viewButtons),
      this.saveBtn);
    this.bannerEl = h('div', { class: 'banner', hidden: true });
    this.hostEl = h('div', { class: 'editor-host' });
    this.previewEl = h('div', { class: 'preview', tabindex: '0', 'aria-label': 'Preview' });
    this.bodyEl = h('div', { class: 'pane-body', hidden: true }, this.hostEl, this.previewEl);
    this.emptyEl = h('div', { class: 'placeholder' });
    this.el = h('section', { class: `pane pane-${role}`, 'data-role': role },
      this.headEl, this.bannerEl, this.bodyEl, this.emptyEl);

    this.editor = new Editor(this.hostEl, {
      onChange: () => {
        this.updateStatus();
        this.scheduleAutosave();
        this.schedulePreview();
        this.onChange(this);
      },
      onSave: () => this.save(),
    });
    this.setView(view, { notify: false });
    this.close();
  }

  get dirty() {
    return Boolean(this.file) && this.editor.dirty;
  }

  get content() {
    return this.editor.content;
  }

  get words() {
    return this.file ? countWords(this.editor.content) : 0;
  }

  // --- opening and closing ---------------------------------------------------

  async open(path) {
    const file = await api.readFile(this.bookId, path);
    this.load(file);
  }

  load(file) {
    this.cancelAutosave();
    this.file = { path: file.path, hash: file.hash };
    this.editor.load(file.content);
    this.hideBanner();
    this.saveFailed = false;
    this.bodyEl.hidden = false;
    this.emptyEl.hidden = true;
    this.showHeader();
    this.renderPreview();
    this.updateStatus();
  }

  // Shows a message (and optional buttons) instead of a file.
  close(message = '', buttons = []) {
    this.cancelAutosave();
    this.file = null;
    this.editor.load('');
    this.hideBanner();
    this.bodyEl.hidden = true;
    this.emptyEl.hidden = false;
    this.emptyEl.replaceChildren(h('div', {}, h('p', {}, message), buttons.filter(Boolean)));
    this.showHeader();
    this.updateStatus();
  }

  setLabel(text) {
    this.labelEl.textContent = text || '';
    this.labelEl.hidden = !text;
  }

  showHeader() {
    const path = this.file?.path ?? '';
    this.titleEl.textContent = path.split('/').pop().replace(/\.md$/i, '');
    this.pathEl.textContent = path;
    this.pathEl.title = path;
    this.el.classList.toggle('no-file', !this.file);
  }

  focus() {
    if (this.view === 'preview') this.previewEl.focus();
    else this.editor.focus();
  }

  // Follows a structure change: the file moved, or was deleted.
  follow({ moves = [], deleted = [] }) {
    const p = this.file?.path;
    if (!p) return null;
    const under = (base) => p === base || p.startsWith(`${base}/`);
    if (deleted.some(under)) {
      this.close();
      return 'deleted';
    }
    const m = moves.find((mv) => under(mv.from));
    if (!m) return null;
    this.file.path = m.to + p.slice(m.from.length);
    this.showHeader();
    return 'moved';
  }

  // --- edit / split / preview -----------------------------------------------

  setView(view, { notify = true } = {}) {
    this.view = VIEWS[view] ? view : 'edit';
    this.bodyEl.dataset.view = this.view;
    for (const b of this.viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === this.view));
    this.renderPreview();
    if (notify) this.onView(this.view);
  }

  schedulePreview() {
    if (this.view === 'edit') return;
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.renderPreview(), PREVIEW_DELAY_MS);
  }

  renderPreview() {
    clearTimeout(this.previewTimer);
    if (this.view === 'edit' || !this.file) {
      this.previewEl.replaceChildren();
      return;
    }
    const scroll = this.previewEl.scrollTop;
    this.previewEl.replaceChildren(renderMarkdown(this.editor.content));
    this.previewEl.scrollTop = scroll;
  }

  // --- saving ----------------------------------------------------------------

  updateStatus() {
    const dirty = this.dirty;
    this.dirtyEl.hidden = !dirty;
    this.saveBtn.disabled = !dirty;
    this.stateEl.textContent = !this.file ? ''
      : this.saving ? 'Saving…'
      : !dirty ? 'Saved'
      : this.conflicted ? 'Not saved: changed on disk'
      : this.saveFailed ? 'Not saved: retrying'
      : 'Unsaved';
    this.stateEl.classList.toggle('warn', Boolean(dirty && (this.conflicted || this.saveFailed)));
  }

  cancelAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    this.firstUnsavedAt = 0;
  }

  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    if (!this.dirty || this.conflicted) {
      this.firstUnsavedAt = 0;
      return;
    }
    const now = Date.now();
    this.firstUnsavedAt ||= now;
    const delay = this.saveFailed
      ? AUTOSAVE_RETRY_MS
      : Math.max(0, Math.min(AUTOSAVE_IDLE_MS, this.firstUnsavedAt + AUTOSAVE_MAX_WAIT_MS - now));
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      this.save();
    }, delay);
  }

  // Last-chance write when the page goes away; the server's timer (or its
  // shutdown) commits it later.
  saveOnExit() {
    if (!this.dirty) return;
    api.writeFile(this.bookId, this.file.path, this.editor.content, this.file.hash, false, { keepalive: true }).catch(() => {});
  }

  // Resolves true when the file is saved (or there was nothing to save).
  async save({ force = false } = {}) {
    if (!this.file || (!this.dirty && !force)) return true;
    if (this.saving) {
      // Typing may have continued while that save was in flight.
      if (!(await this.saving)) return false;
      return this.save({ force });
    }
    this.cancelAutosave();
    const { path, hash } = this.file;
    const content = this.editor.content;
    this.saving = (async () => {
      this.updateStatus();
      try {
        const res = await api.writeFile(this.bookId, path, content, hash, force);
        if (this.file?.path === path) {
          this.file.hash = res.hash;
          this.editor.markSaved(content);
          this.hideBanner();
        }
        this.saveFailed = false;
        return true;
      } catch (err) {
        if (err.status === 409) {
          this.conflicted = true;
          this.showConflict(err.data);
        } else {
          if (!this.saveFailed) toast(`Could not save: ${err.message}`, { error: true });
          this.saveFailed = true;
        }
        return false;
      } finally {
        this.saving = null;
        this.updateStatus();
        this.scheduleAutosave();
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
    this.renderPreview();
    this.updateStatus();
    this.onChange(this);
  }

  showBanner(message, buttons) {
    this.bannerEl.replaceChildren(h('span', { class: 'msg' }, message), ...buttons.filter(Boolean));
    this.bannerEl.hidden = false;
  }

  hideBanner() {
    this.conflicted = false;
    this.bannerEl.hidden = true;
    this.bannerEl.replaceChildren();
  }
}

// --- markdown preview ----------------------------------------------------------

// Book files come from many hands (agents, imports), so the preview drops
// anything that could run code: scripts, frames, event handlers, js: URLs.
const BLOCKED_TAGS = 'script, style, iframe, frame, frameset, object, embed, link, meta, base, form, input, button, textarea, select';

export function renderMarkdown(text) {
  const tpl = document.createElement('template');
  tpl.innerHTML = marked.parse(text, { gfm: true, breaks: false });
  for (const el of tpl.content.querySelectorAll(BLOCKED_TAGS)) el.remove();
  for (const el of tpl.content.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'style'
        || (['href', 'src', 'xlink:href', 'action', 'formaction'].includes(name) && /^(javascript|vbscript|data):/.test(value) && !/^data:image\//.test(value))) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A' && el.getAttribute('href')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }
  const wrap = document.createElement('div');
  wrap.className = 'preview-content';
  wrap.append(tpl.content);
  return wrap;
}
