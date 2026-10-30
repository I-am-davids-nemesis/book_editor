import { api } from './api.js';
import { ClaudePanel } from './claude.js';
import { confirmDialog, formDialog, promptDialog } from './dialogs.js';
import { openCompileDialog } from './compile.js';
import { connectEvents } from './events.js';
import { openRevisionPanel } from './gitpanel.js';
import { HistoryView } from './history.js';
import { renderLibrary } from './library.js';
import { gatherPrompt, manuscriptPrompt, refinePrompt } from './codexprompts.js';
import { entryStrip, LookbookView, uploadImages } from './lookbook.js';
import { Pane } from './pane.js';
import { quickOpen, quickOpenItems } from './quickopen.js';
import { searchDialog } from './search.js';
import { installShortcuts, showShortcutHelp } from './shortcuts.js';
import {
  availableModes, codexEntries, companionOf, findScene, modeLabel, renderTree, sceneFile, sceneFiles, setFileWords, tabForPath,
} from './tree.js';
import { bookHref, formatCount, h, parseHash, showMenu, toast } from './ui.js';

const view = document.getElementById('view');
const crumb = document.getElementById('crumb');
const topbarActions = document.getElementById('topbar-actions');

const TAB_LABELS = { manuscript: 'Manuscript', outline: 'Outline', codex: 'Codex' };
const NOTHING_OPEN = 'Choose a scene, plot file or codex entry on the left, or press ⌘P to find one. Press ? for all shortcuts.';

// The book screen is built once per book and updated as the route changes.
// It has two panes: the main one shows the file in the address bar, the side
// one shows its companion (a scene's plot file, or a plot file's scene).
class BookView {
  constructor(id) {
    this.id = id;
    this.book = null;
    this.tree = null;
    this.tab = 'manuscript';
    this.showCompanion = readStored('companion') !== 'off';
    this.companion = null;

    this.tabButtons = Object.entries(TAB_LABELS).map(([tab, label]) =>
      h('button', { type: 'button', role: 'tab', 'data-tab': tab, onclick: () => this.showTab(tab) }, label));
    this.treeEl = h('nav', { class: 'tree', 'aria-label': 'Book contents' });
    this.totalEl = h('div', { class: 'sidebar-foot' });

    this.modeSwitchEl = h('span', { class: 'segmented mode-switch', role: 'group', 'aria-label': 'Narration mode', hidden: true });
    this.companionBtn = h('button', { type: 'button', class: 'companion-toggle', hidden: true, onclick: () => this.toggleCompanion() });

    const paneOptions = (role) => ({
      bookId: id,
      role,
      view: readStored(`view:${role}`) || 'edit',
      onChange: (pane) => this.paneChanged(pane),
      onView: (v) => writeStored(`view:${role}`, v),
      onSaved: () => this.refreshGit(),
      onCloseRequest: (pane) => this.closePane(pane),
      onSelect: () => this.claude?.refreshContext(),
    });
    this.main = new Pane({ ...paneOptions('main'), headExtras: [this.modeSwitchEl, this.companionBtn] });
    this.sideModeEl = h('span', { class: 'segmented mode-switch', role: 'group', 'aria-label': 'Narration mode of the scene', hidden: true });
    this.side = new Pane({ ...paneOptions('side'), headExtras: [this.sideModeEl] });
    this.main.close(NOTHING_OPEN);

    this.dividerEl = h('div', { class: 'pane-divider', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
    this.panesEl = h('div', { class: 'panes' }, this.main.el, this.dividerEl, this.side.el);
    this.wordsEl = h('span');
    this.sideWordsEl = h('span');
    this.chapterWordsEl = h('span');
    this.commitEl = h('span', { class: 'commit-state' });
    this.connEl = h('span', { class: 'conn-state', hidden: true, title: 'Changes made outside the editor won’t show until it reconnects' }, 'Disconnected from the editor server; retrying…');
    this.gitBtn = h('button', { type: 'button', class: 'git-status', hidden: true, onclick: () => this.openRevisions() });

    this.el = h('div', { class: 'book' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'tabs', role: 'tablist' }, this.tabButtons),
        this.treeEl,
        this.totalEl),
      h('section', { class: 'editor-area' },
        this.panesEl,
        h('div', { class: 'statusbar' },
          this.wordsEl, this.sideWordsEl, this.chapterWordsEl, h('span', { class: 'spacer' }), this.connEl, this.commitEl, this.gitBtn)));

    this.history = new HistoryView({
      bookId: id,
      onBack: async () => {
        if (this.busy) await this.busy.catch(() => {});
        this.open(this.tab, this.file?.path);
      },
      onSelect: (hash) => history.replaceState(null, '', bookHref(this.id, 'history', hash)),
      onRestored: () => this.rewriting(() => {}),
      onViewVersion: (v) => this.viewVersion(v),
      onNewDraft: (from, label) => this.newDraft(from, label),
      onSwitchDraft: (branch) => this.switchDraft(branch),
      onSaveRevision: async () => {
        await this.openRevisions();
        await this.history.show();
      },
    });
    this.el.append(this.history.el);

    this.lookbook = new LookbookView({
      bookId: id,
      actions: {
        back: () => this.open(this.tab, this.file?.path),
        run: (fn) => this.runOp(fn),
        upload: (files, of) => this.uploadImages(files, of),
        refine: (img, entries) => this.askClaude(refinePrompt(entries, [img]), { open: entries[0].path }),
      },
    });
    this.el.append(this.lookbook.el);

    this.claude = new ClaudePanel({
      bookId: id,
      getContext: () => this.claudeContext(),
      beforeRun: () => this.save(),
      onOpenFile: (p) => this.open(tabForPath(p), p),
      onReview: (commit) => { location.hash = bookHref(this.id, 'history', commit); },
      onUndo: (before) => this.undoClaudeRun(before),
      onClose: () => this.toggleClaude(false),
    });
    this.el.append(this.claude.el);
    this.claudeBtn = h('button', { type: 'button', class: 'claude-btn', title: 'Claude Code in this book (⌘⌥C)', onclick: () => this.toggleClaude() }, 'Claude');
    this.searchBtn = h('button', { type: 'button', class: 'search-btn', title: 'Search the whole book (⌘⇧F)', onclick: () => this.search() }, 'Search');
    this.historyBtn = h('button', { type: 'button', class: 'history-btn', onclick: () => this.openHistory() }, 'History');
    this.lookbookBtn = h('button', { type: 'button', class: 'lookbook-btn', title: 'Images of characters, places and things', onclick: () => this.openLookbook() }, 'Lookbook');
    this.draftBtn = h('button', {
      type: 'button',
      class: 'draft-btn',
      hidden: true,
      'aria-haspopup': 'menu',
      title: 'Drafts: separate lines of work (git branches)',
      onclick: (e) => this.showDraftMenu(e.currentTarget),
    });
    this.revisionView = null; // { path, rev, content, label }: an old version shown beside the file

    this.setSideVisible(false);
    this.setSplit(Number(readStored('split')) || 0.5);
    this.initResize();
  }

  async init() {
    [this.book, this.tree] = await Promise.all([api.getBook(this.id), api.getTree(this.id)]);
    crumb.textContent = this.book.title;
    document.title = `${this.book.title} · Book Editor`;
    topbarActions.replaceChildren(this.draftBtn, this.searchBtn, this.lookbookBtn, this.historyBtn, this.claudeBtn);
    if (readStored('claude') === 'open') this.toggleClaude(true);
    else this.claudeBtn.setAttribute('aria-pressed', 'false');
    this.mode = this.validMode(readStored(`mode:${this.id}`));
    this.showNothingOpen();
    this.refreshGit({ now: true });
    this.events = connectEvents(this.id, {
      onBatch: (batch) => this.onDiskChanges(batch),
      onReconnect: () => this.onDiskChanges({ files: [], tree: true, git: true, resync: true }),
      onStatus: (up) => {
        // Brief blips are normal; only show a lasting disconnection. Each
        // failed retry reports again, so the clock starts at the first one.
        if (up) {
          clearTimeout(this.connTimer);
          this.connTimer = null;
          this.connEl.hidden = true;
        } else if (!this.connTimer && this.connEl.hidden) {
          this.connTimer = setTimeout(() => {
            this.connTimer = null;
            this.connEl.hidden = false;
          }, 3000);
        }
      },
    });
  }

  // Leaving the book.
  dispose() {
    this.events?.close();
    this.claude.dispose();
    clearTimeout(this.gitTimer);
    clearTimeout(this.historyTimer);
    clearTimeout(this.connTimer);
  }

  // --- live reload -------------------------------------------------------------

  // Changes the server saw on disk: from another editor, an agent, git in a
  // terminal, or the editor's own saves (recognized by their hash). Batches
  // are handled one at a time, after any change the editor itself is making.
  onDiskChanges(batch) {
    this.diskQueue = (this.diskQueue || Promise.resolve())
      .then(() => this.applyDiskChanges(batch))
      .catch((err) => console.error('Live reload failed', err));
  }

  async applyDiskChanges(batch) {
    await Promise.all([this.busy, this.opInFlight].filter(Boolean).map((p) => p.catch(() => {})));
    const panes = [this.main, this.side];
    const ownHash = new Map(panes.filter((p) => p.file).map((p) => [p.file.path, p.file.hash]));
    // Files changed by someone else (our own saves come back with our hash).
    const foreign = batch.files.filter((f) => !(f.hash && ownHash.get(f.path) === f.hash));
    for (const pane of panes) {
      const path = pane.file?.path;
      if (!path) continue;
      const change = batch.resync ? { path } : foreign.find((f) => f.path === path);
      if (change) await pane.externalChange(change);
    }
    // Lookbook notes carry an image's links, which the tree reports.
    const treeChanged = foreign.some((f) => f.path.startsWith('manuscript/') || f.path.startsWith('lookbook/'));
    if (batch.tree || treeChanged) {
      await this.refreshTree();
      // A missing plot or scene file may have appeared.
      if (!this.side.file && !this.side.readOnly) await this.syncSide();
      this.updateStatus();
    }
    if (foreign.length || batch.tree || batch.git) {
      this.refreshGit();
      if (this.el.classList.contains('show-history')) {
        clearTimeout(this.historyTimer);
        this.historyTimer = setTimeout(() => this.history.show().catch(() => {}), 400);
      }
    }
  }

  // The banner's Close, for a file deleted on disk.
  closePane(pane) {
    if (pane === this.main) {
      this.main.close(NOTHING_OPEN);
      history.replaceState(null, '', bookHref(this.id, this.tab));
      this.renderTree();
    } else {
      this.side.close();
    }
    this.syncSide().then(() => this.updateStatus());
  }

  get file() {
    return this.main.file;
  }

  get dirty() {
    return this.main.dirty || this.side.dirty;
  }

  // Resolves true when both panes are saved.
  async save() {
    const results = await Promise.all([this.main.save(), this.side.save()]);
    return results.every(Boolean);
  }

  saveOnExit() {
    this.main.saveOnExit();
    this.side.saveOnExit();
  }

  // --- narration modes -------------------------------------------------------

  validMode(mode) {
    const modes = availableModes(this.tree);
    return modes.includes(mode) ? mode : modes[0];
  }

  async setMode(mode, { follow = true } = {}) {
    this.mode = this.validMode(mode);
    writeStored(`mode:${this.id}`, this.mode);
    this.renderTree();
    const path = this.file?.path;
    const hit = follow && path && findScene(this.tree, path);
    if (hit && path.startsWith('manuscript/')) {
      // Show the same scene in the new mode, if it exists.
      const target = sceneFile(hit.scene, this.mode);
      if (target && target !== path) this.open('manuscript', target);
    } else if (hit) {
      // A plot file is open: the scene beside it follows the mode.
      await this.syncSide();
    }
  }

  // Opening a scene in some mode makes that the sidebar's mode.
  adoptModeOf(path) {
    const hit = path.startsWith('manuscript/') && findScene(this.tree, path);
    if (!hit) return;
    const m = hit.scene.variants.find((v) => v.path === path)?.variant ?? '';
    if (m !== this.mode && availableModes(this.tree).includes(m)) {
      this.mode = m;
      writeStored(`mode:${this.id}`, m);
    }
  }

  // Buttons in the editor header to flip the open scene between its modes.
  renderModeSwitch() {
    const path = this.file?.path;
    const hit = path?.startsWith('manuscript/') ? findScene(this.tree, path) : null;
    const files = hit ? sceneFiles(hit.scene) : [];
    if (files.length < 2) {
      this.modeSwitchEl.hidden = true;
      this.modeSwitchEl.replaceChildren();
      return;
    }
    const modes = [...(hit.scene.hasBase ? [''] : []), ...hit.scene.variants.map((v) => v.variant)];
    this.modeSwitchEl.replaceChildren(...modes.map((m) => {
      const target = sceneFile(hit.scene, m);
      const current = target === path;
      return h('button', {
        type: 'button',
        'aria-pressed': String(current),
        title: current ? `Showing the ${modeLabel(m)} version` : `Switch to the ${modeLabel(m)} version`,
        onclick: () => { if (!current) this.setMode(m); },
      }, modeLabel(m));
    }));
    this.modeSwitchEl.hidden = false;
  }

  // --- routing ---------------------------------------------------------------

  async route({ tab, path }) {
    // A draft switch or restore is rewriting files; let it finish first.
    if (this.busy) await this.busy.catch(() => {});
    this.showLookbook(tab === 'lookbook', path);
    if (tab === 'lookbook') return;
    if (tab === 'history') {
      // `path` here is a commit hash, if any.
      this.el.classList.add('show-history');
      this.historyBtn.setAttribute('aria-pressed', 'true');
      const filter = this.historyFilter;
      this.historyFilter = undefined;
      await this.history.show({ hash: path, path: filter });
      return;
    }
    if (this.el.classList.contains('show-history')) {
      this.el.classList.remove('show-history');
      this.history.hide();
      this.historyBtn.setAttribute('aria-pressed', 'false');
    }
    const nextTab = tab && TAB_LABELS[tab] ? tab : (path ? tabForPath(path) : this.tab);
    const previous = this.file?.path ?? null;
    const changed = path !== previous;
    if (changed && this.revisionView?.path !== path) this.revisionView = null;
    if (changed) this.missingPath = null;
    if (changed) {
      if (path) {
        await this.main.open(path);
        this.adoptModeOf(this.main.file.path);
      } else {
        this.showNothingOpen();
      }
      if (previous) this.checkpoint(`switched away from ${previous}`);
    }
    this.showTab(nextTab, { updateHash: false });
    await this.syncSide();
    this.updateStatus();
    this.claude.refreshContext();
    this.renderCodexStrip();
    if (changed && path) this.main.focus();
    if (this.pendingReveal && this.pendingReveal.path === this.main.file?.path) this.main.reveal(this.pendingReveal);
    this.pendingReveal = null;
    const after = this.afterRoute;
    this.afterRoute = null;
    after?.();
  }

  // The main pane with no file: a nudge for an empty book, tips otherwise.
  showNothingOpen() {
    if (this.tree && !this.tree.chapters.length) {
      this.main.close('This book has no chapters yet.', [
        h('button', { type: 'button', class: 'primary', onclick: () => this.actions.addChapter() }, '+ Add the first chapter'),
      ]);
    } else {
      this.main.close(NOTHING_OPEN);
    }
  }

  showTab(tab, { updateHash = true } = {}) {
    this.tab = tab;
    for (const b of this.tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    this.renderTree();
    if (updateHash) history.replaceState(null, '', bookHref(this.id, tab, this.file?.path));
  }

  renderTree() {
    this.mode = this.validMode(this.mode);
    renderTree(this.treeEl, this.tree, { id: this.id, tab: this.tab, activePath: this.file?.path, actions: this.actions, mode: this.mode });
    this.renderTotal();
    this.renderModeSwitch();
  }

  renderTotal() {
    const words = this.tree.wordsByMode[this.mode] || 0;
    const which = availableModes(this.tree).length > 1 ? ` (${modeLabel(this.mode)})` : '';
    this.totalEl.textContent = `${formatCount(words)} words in the manuscript${which}`;
  }

  async refreshTree() {
    this.tree = await api.getTree(this.id);
    // Unsaved typing isn't on disk yet; keep the live counts.
    for (const pane of [this.main, this.side]) {
      if (pane.dirty) setFileWords(this.tree, pane.file.path, pane.words);
    }
    this.renderTree();
    this.lookbook.update(this.tree);
    this.renderCodexStrip();
  }

  open(tab, path) {
    location.hash = bookHref(this.id, tab, path);
  }

  // --- keyboard -------------------------------------------------------------------

  async quickOpen() {
    const items = quickOpenItems(this.tree, { sceneFileFor: (s) => sceneFile(s, this.mode) ?? sceneFiles(s)[0] });
    const path = await quickOpen(items);
    if (path) this.open(tabForPath(path), path);
  }

  // Full-text search (⌘⇧F). The search reads files from disk, so pending
  // edits are saved first; choosing a match opens its file and selects it.
  async search() {
    await this.save();
    const hit = await searchDialog({ bookId: this.id, tree: this.tree });
    if (!hit) return;
    if (this.main.file?.path === hit.path && !this.el.matches('.show-history, .show-lookbook')) {
      this.main.reveal(hit);
    } else {
      this.pendingReveal = hit;
      this.open(tabForPath(hit.path), hit.path);
    }
  }

  // Moves to the previous or next scene, staying in the same kind of file
  // (scene text in the current mode, or plot files).
  stepScene(dir) {
    const path = this.file?.path ?? '';
    const scenes = this.tree.chapters.flatMap((ch) => ch.scenes.map((s) => ({ ch, s })));
    const plot = path.startsWith('outline/');
    const fileOf = ({ s }) => (plot ? (s.inOutline ? s.outlinePath : null) : sceneFile(s, this.mode));
    let i = scenes.findIndex(({ s }) => s.outlinePath === path || sceneFiles(s).includes(path));
    if (i === -1 && path.endsWith('/_chapter.md')) {
      // From a chapter summary, "next" is its first scene.
      const chName = path.split('/')[1];
      i = scenes.findIndex(({ ch }) => ch.name === chName) - (dir > 0 ? 1 : 0);
    }
    if (i === -1 && !path) i = dir > 0 ? -1 : scenes.length;
    if (i === -1 && path) return false;
    for (let j = i + dir; j >= 0 && j < scenes.length; j += dir) {
      const target = fileOf(scenes[j]);
      if (target) {
        this.open(plot ? 'outline' : 'manuscript', target);
        return true;
      }
    }
    toast(dir > 0 ? 'That was the last scene' : 'That was the first scene');
    return true;
  }

  cycleView() {
    const pane = this.side.el.contains(document.activeElement) && !this.side.el.hidden ? this.side : this.main;
    if (!pane.file && !pane.readOnly) return false;
    pane.setView({ edit: 'split', split: 'preview', preview: 'edit' }[pane.view]);
    pane.focus();
    return true;
  }

  // --- lookbook ------------------------------------------------------------------

  openLookbook() {
    location.hash = bookHref(this.id, 'lookbook');
  }

  // Shows or hides the Lookbook in place of the panes; `path` is the image
  // to show in detail.
  showLookbook(show, path = null) {
    this.el.classList.toggle('show-lookbook', show);
    this.lookbookBtn.setAttribute('aria-pressed', String(show));
    if (show) this.lookbook.show(this.tree, path);
    else this.lookbook.hide();
  }

  // Adds images to the lookbook, linked to the codex entries in `of`.
  uploadImages(files, of = []) {
    return this.runOp(() => uploadImages(this.id, files, { of }));
  }

  // A codex entry's images and description actions, above its text.
  renderCodexStrip() {
    const path = this.main.file?.path;
    const entry = path && codexEntries(this.tree).find((e) => e.path === path);
    this.main.setExtra(entry ? entryStrip({
      bookId: this.id,
      tree: this.tree,
      path,
      getText: () => this.main.content,
      onAdd: (files) => this.uploadImages(files, [path]),
      claude: {
        gather: () => this.askClaude(gatherPrompt(entry)),
        refine: (images) => this.askClaude(refinePrompt([entry], images)),
        manuscript: () => this.askClaude(manuscriptPrompt(entry)),
      },
    }) : null);
  }

  // Sends a prompt to the Claude panel, first opening `open` (a file) if
  // given, so the panel's context matches what the run is about.
  askClaude(prompt, { open = null } = {}) {
    if (this.claude.runId) {
      toast('Claude is still working on the last request; stop it or wait, then try again', { error: true });
      return;
    }
    const send = () => {
      this.toggleClaude(true);
      this.claude.send(prompt);
    };
    if (open && (this.file?.path !== open || this.el.matches('.show-history, .show-lookbook'))) {
      this.afterRoute = send;
      this.open(tabForPath(open), open);
    } else {
      send();
    }
  }

  // --- history -------------------------------------------------------------------

  // Opens History, optionally showing only one file's commits.
  openHistory(path = null) {
    this.historyFilter = path;
    const target = bookHref(this.id, 'history');
    if (location.hash === target) this.route({ tab: 'history' });
    else location.hash = target;
  }

  // Files changed on disk underneath the editor (a restore): reread the open
  // files, which are saved by now, and the tree.
  async reloadFromDisk() {
    this.revisionView = null;
    await this.refreshTree();
    // A file missing in one draft may be back in the next: remember it.
    const path = this.main.file?.path ?? this.missingPath;
    if (path) {
      try {
        await this.main.open(path);
        this.missingPath = null;
        if (location.hash !== bookHref(this.id, this.tab, path) && !this.el.matches('.show-history, .show-lookbook')) {
          history.replaceState(null, '', bookHref(this.id, this.tab, path));
        }
      } catch {
        this.missingPath = path;
        this.main.close(`${path} doesn't exist in this version of the book.`);
      }
    }
    this.side.close();
    await this.syncSide();
    this.updateStatus();
    this.refreshGit({ now: true });
  }

  // Shows an earlier version of a file, read-only, beside the current one.
  async viewVersion({ path, rev, content, label }) {
    try {
      await api.readFile(this.id, path);
    } catch (err) {
      if (err.status !== 404) throw err;
      toast(`${path} doesn't exist any more. Use “Restore this version” to bring it back.`, { error: true });
      return;
    }
    this.revisionView = { path, rev, content, label };
    if (this.file?.path === path && !this.el.matches('.show-history, .show-lookbook')) await this.syncSide();
    else this.open(tabForPath(path), path);
  }

  async showRevisionSide() {
    const v = this.revisionView;
    this.setSideVisible(true);
    this.sideModeEl.hidden = true;
    this.side.showReadOnly({
      path: v.path,
      content: v.content,
      label: 'Earlier version',
      note: `${v.label} (read-only)`,
      actions: [
        h('button', { type: 'button', onclick: () => this.restoreShownVersion() }, 'Restore this version'),
        h('button', { type: 'button', onclick: () => { this.revisionView = null; this.side.close(); this.syncSide(); } }, 'Close'),
      ],
    });
  }

  async restoreShownVersion() {
    const v = this.revisionView;
    if (!v) return;
    const ok = await confirmDialog({
      title: 'Restore this version?',
      message: `This replaces the current text of ${v.path} with the earlier version. The current text is committed first, so it stays in history.`,
      okLabel: 'Restore',
    });
    if (!ok || !(await this.save())) return;
    try {
      await this.rewriting(async () => {
        await api.checkpoint(this.id, `before restoring ${v.path}`);
        await api.gitRestoreFile(this.id, v.rev, v.path);
      });
      toast(`Restored ${v.path}`);
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // --- the side pane -----------------------------------------------------------

  toggleCompanion() {
    this.showCompanion = !this.showCompanion;
    writeStored('companion', this.showCompanion ? 'on' : 'off');
    this.syncSide().then(() => this.updateStatus());
  }

  setSideVisible(visible) {
    this.side.el.hidden = !visible;
    this.dividerEl.hidden = !visible;
    this.panesEl.classList.toggle('single', !visible);
  }

  // Puts the open file's companion in the side pane (or hides it).
  async syncSide() {
    const path = this.file?.path;
    if (this.revisionView && this.revisionView.path === path) {
      this.companionBtn.hidden = true;
      if (!(await this.side.save())) return;
      await this.showRevisionSide();
      return;
    }
    const c = path && this.tree ? companionOf(this.tree, path, this.mode) : null;
    this.companion = c;
    const what = c?.kind === 'plot' ? 'plot' : 'scene';
    this.companionBtn.hidden = !c;
    this.companionBtn.textContent = c?.kind === 'plot' ? 'Plot' : 'Scene';
    this.companionBtn.setAttribute('aria-pressed', String(this.showCompanion));
    this.companionBtn.title = `${this.showCompanion ? 'Hide' : 'Show'} the ${what} beside this file`;

    if (!c || !this.showCompanion) {
      this.sideModeEl.hidden = true;
      if (!(await this.side.save())) return; // keep it open (with its banner) until saved
      this.side.close();
      this.setSideVisible(false);
      return;
    }
    this.setSideVisible(true);
    const modes = availableModes(this.tree);
    const multiMode = modes.length > 1;
    this.side.setLabel(c.kind === 'plot' ? 'Plot' : 'Scene');
    // Beside a plot file, the scene can be flipped between modes here too.
    this.sideModeEl.hidden = !(c.kind === 'scene' && multiMode);
    this.sideModeEl.replaceChildren(...(this.sideModeEl.hidden ? [] : modes.map((m) => h('button', {
      type: 'button',
      'aria-pressed': String(m === c.mode),
      title: sceneFile(c.scene, m) ? `Show the ${modeLabel(m)} version` : `No ${modeLabel(m)} version yet`,
      onclick: () => { if (m !== this.mode) this.setMode(m); },
    }, modeLabel(m)))));
    if (this.side.file?.path === c.path) return;
    if (!(await this.side.save())) return;
    if (!c.exists) {
      const missing = c.kind === 'plot' ? 'This scene has no plot file yet.'
        : multiMode ? `This scene has no ${modeLabel(c.mode)} version yet.` : 'This plot has no scene file yet.';
      this.side.close(missing, [
        h('button', { type: 'button', onclick: () => this.createCompanion(c.path) },
          c.kind === 'plot' ? 'Create plot file' : 'Create scene file'),
      ]);
      this.side.pathEl.textContent = c.path;
      return;
    }
    try {
      await this.side.open(c.path);
    } catch (err) {
      this.side.close(`Could not open ${c.path}: ${err.message}`);
    }
  }

  async createCompanion(path) {
    const res = await this.runOp(() => api.createMissing(this.id, path));
    if (res) this.updateStatus();
  }

  // Lets the divider between the panes be dragged.
  initResize() {
    this.dividerEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dividerEl.setPointerCapture(e.pointerId);
      this.panesEl.classList.add('resizing');
      const move = (ev) => {
        const r = this.panesEl.getBoundingClientRect();
        const column = getComputedStyle(this.panesEl).flexDirection === 'column';
        const f = column ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width;
        this.setSplit(f);
      };
      const up = () => {
        this.dividerEl.removeEventListener('pointermove', move);
        this.dividerEl.removeEventListener('pointerup', up);
        this.panesEl.classList.remove('resizing');
        writeStored('split', String(this.split));
      };
      this.dividerEl.addEventListener('pointermove', move);
      this.dividerEl.addEventListener('pointerup', up);
    });
    this.dividerEl.addEventListener('dblclick', () => {
      this.setSplit(0.5);
      writeStored('split', '0.5');
    });
  }

  setSplit(f) {
    this.split = Math.min(0.8, Math.max(0.2, Number.isFinite(f) ? f : 0.5));
    this.main.el.style.flex = `${this.split} 1 0`;
    this.side.el.style.flex = `${1 - this.split} 1 0`;
  }

  // --- word counts and status ----------------------------------------------------

  paneChanged(pane) {
    this.claude?.refreshContext();
    clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => {
      this.liveWords(pane);
      this.updateStatus();
    }, 150);
  }

  // Updates the sidebar's counts for a scene being typed in.
  liveWords(pane) {
    const path = pane.file?.path;
    const hit = path && setFileWords(this.tree, path, pane.words);
    if (!hit) return;
    this.renderTotal();
    if (this.tab !== 'manuscript') return;
    const { ch, scene } = hit;
    const find = (selector, test) => [...this.treeEl.querySelectorAll(selector)].find(test);
    const row = find('.item', (el) => el.dataset.path === path)?.querySelector('.count');
    if (row && sceneFile(scene, this.mode) === path) row.textContent = formatCount(scene.wordsByMode[this.mode] || 0);
    const chapter = find('details.chapter', (el) => el.dataset.chapter === ch.name)?.querySelector(':scope > summary .count');
    if (chapter) chapter.textContent = formatCount(ch.wordsByMode[this.mode] || 0);
  }

  updateStatus() {
    const main = this.main.file;
    this.wordsEl.textContent = main ? `${formatCount(this.main.words)} words` : '';
    const side = this.side.file && !this.side.el.hidden;
    this.sideWordsEl.textContent = side ? `${this.companion?.kind === 'plot' ? 'Plot' : 'Scene'}: ${formatCount(this.side.words)} words` : '';
    const hit = main?.path.startsWith('manuscript/') && findScene(this.tree, main.path);
    const mode = hit ? (hit.scene.variants.find((v) => v.path === main.path)?.variant ?? '') : '';
    this.chapterWordsEl.textContent = hit ? `Chapter: ${formatCount(hit.ch.wordsByMode[mode] || 0)} words` : '';
  }

  // --- git ---------------------------------------------------------------------

  // Updates the status-bar button: current draft and uncommitted files. Saves
  // happen every second while typing, so this waits for a quiet moment.
  refreshGit({ now = false } = {}) {
    clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(async () => {
      try {
        const st = await api.gitStatus(this.id);
        this.git = st;
        if (!st.repo) {
          this.gitBtn.hidden = true;
          this.draftBtn.hidden = true;
          return;
        }
        this.draftBtn.hidden = false;
        this.draftBtn.replaceChildren('Draft: ', h('strong', {}, st.branch || 'detached'), ' ▾');
        const n = st.files.length;
        const parts = [st.branch || 'detached', n ? `${n} uncommitted` : 'all committed'];
        if (st.ahead) parts.push(`${st.ahead} to push`);
        this.gitBtn.textContent = parts.join(' · ');
        this.gitBtn.title = 'Save a named revision, or push';
        this.gitBtn.hidden = false;
      } catch {
        // status is a convenience; leave the last value
      }
    }, now ? 0 : 1500);
  }

  // --- Claude -------------------------------------------------------------------

  toggleClaude(show = !this.claude.visible) {
    if (show) this.claude.show();
    else this.claude.hide();
    this.claudeBtn.setAttribute('aria-pressed', String(show));
    writeStored('claude', show ? 'open' : 'closed');
  }

  // What the panel can attach to a prompt: the open file, the file beside
  // it, and the selected text in either.
  claudeContext() {
    const describe = (path) => ({ path, label: fileLabel(path) });
    const sideShown = this.side.file && !this.side.el.hidden;
    const focused = [this.main, this.side].find((p) => p.el.contains(document.activeElement));
    const withSelection = [focused, this.main, sideShown ? this.side : null].find((p) => p?.file && p.selection.trim());
    return {
      file: this.main.file ? describe(this.main.file.path) : null,
      companion: sideShown ? describe(this.side.file.path) : null,
      selection: withSelection ? { path: withSelection.file.path, text: withSelection.selection } : null,
      mode: this.tree && availableModes(this.tree).length > 1 ? this.mode : '',
      modes: this.tree ? availableModes(this.tree).map((m) => ({ value: m, label: modeLabel(m) })) : [],
    };
  }

  // Puts the whole book back as it was before a run (as a new commit).
  async undoClaudeRun(before) {
    const ok = await confirmDialog({
      title: 'Undo this run?',
      message: 'This puts every file in the book back as it was before Claude started. Anything since then, including your own edits, is committed first, so it stays in History.',
      okLabel: 'Undo run',
    });
    if (!ok || !(await this.save())) return;
    try {
      await this.rewriting(() => api.gitRestoreBook(this.id, before));
      toast('The book is back as it was before the run');
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // --- drafts (branches) ---------------------------------------------------------

  showDraftMenu(anchor) {
    const st = this.git;
    if (!st?.repo) return;
    showMenu(anchor, [
      ...st.branches.map((b) => ({
        label: b === st.branch ? `✓ ${b}` : `   ${b}`,
        disabled: b === st.branch,
        onclick: () => this.switchDraft(b),
      })),
      null,
      { label: 'New draft from here…', onclick: () => this.newDraft() },
      { label: 'Start a draft from an earlier point…', onclick: () => this.openHistory() },
    ]);
  }

  async newDraft(from = null, fromLabel = '') {
    const name = await promptDialog({
      title: 'Start a new draft',
      label: 'Name',
      okLabel: 'Start draft',
      hint: `${from ? `Starts from “${fromLabel}”.` : 'Starts from where you are now.'} Your current work is committed first; switch back any time from the Draft menu.`,
    });
    if (!name || !(await this.save())) return;
    try {
      let res;
      await this.rewriting(async () => { res = await api.gitBranch(this.id, name, from || undefined); });
      toast(`Now on draft ${res.branch}`);
      await this.afterDraftChange();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async switchDraft(branch) {
    if (!(await this.save())) return;
    try {
      await this.rewriting(() => api.gitSwitch(this.id, branch));
      toast(`Now on draft ${branch}`);
      await this.afterDraftChange();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // The files on disk are now another draft's.
  async afterDraftChange() {
    if (this.el.classList.contains('show-history')) await this.history.show();
  }

  // Runs a change that rewrites files on disk (switching drafts, restoring),
  // then rereads the open files. Navigation waits for it.
  async rewriting(fn) {
    const run = (async () => {
      await fn();
      await this.reloadFromDisk();
    })();
    this.busy = run;
    try {
      await run;
    } finally {
      if (this.busy === run) this.busy = null;
    }
  }

  async openRevisions() {
    if (!(await this.save())) return;
    await openRevisionPanel({
      bookId: this.id,
      onCommitted: (res) => {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.commitEl.textContent = `Saved revision ${res.commit} at ${time}`;
        this.commitEl.classList.remove('error');
      },
      onOpenFile: (p) => this.open(tabForPath(p), p),
    });
    this.refreshGit({ now: true });
  }

  // Asks the server to commit everything that changed in the book. Never
  // blocks editing; a failure shows in the status bar.
  async checkpoint(reason) {
    try {
      const res = await api.checkpoint(this.id, reason);
      if (res.committed) {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.commitEl.textContent = `Committed ${res.commit} at ${time}`;
        this.commitEl.title = res.files.join('\n');
        this.commitEl.classList.remove('error');
      }
      this.refreshGit({ now: true });
    } catch (err) {
      this.commitEl.textContent = 'Auto-commit failed';
      this.commitEl.title = err.message;
      this.commitEl.classList.add('error');
    }
  }

  // --- structure changes ------------------------------------------------------

  // Saves the open files, runs a structure change, then follows the open
  // files if they moved (or closes them if deleted) and refreshes the tree.
  async runOp(fn) {
    let done;
    this.opInFlight = new Promise((r) => { done = r; });
    try {
      return await this.runOpInner(fn);
    } finally {
      done();
      this.opInFlight = null;
    }
  }

  async runOpInner(fn) {
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
    if (!this.main.file && !this.main.readOnly) this.showNothingOpen();
    await this.syncSide();
    this.updateStatus();
    this.refreshGit();
    return res;
  }

  followChanges(res) {
    this.side.follow(res);
    const outcome = this.main.follow(res);
    if (outcome === 'deleted') {
      this.main.close(NOTHING_OPEN);
      history.replaceState(null, '', bookHref(this.id, this.tab));
    } else if (outcome === 'moved') {
      history.replaceState(null, '', bookHref(this.id, this.tab, this.file.path));
    }
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
        if (this.tab === 'outline') {
          this.open('outline', `outline/${ch.name}/${res.scene}`);
        } else {
          const scenes = res.created.filter((p) => p.startsWith('manuscript/'));
          const inMode = scenes.find((p) => (this.mode ? p.endsWith(`.${this.mode}.md`) : p.endsWith(`/${res.scene}`)));
          this.open('manuscript', inMode ?? scenes[0]);
        }
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

      setMode: (mode) => this.setMode(mode),

      history: (path) => this.openHistory(path),

      lookbook: () => this.openLookbook(),

      compile: async (chapter = null) => {
        if (!(await this.save())) return;
        await openCompileDialog({
          bookId: id,
          bookTitle: this.book.title,
          chapters: this.tree.chapters.filter((c) => c.inManuscript),
          modes: availableModes(this.tree).map((m) => ({ value: m, label: modeLabel(m) })),
          mode: this.mode,
          chapter,
        });
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
}

// "Scene: Dorgal arrives", "Plot: Opening", "Codex: Tor" for a book path.
function fileLabel(path) {
  const [top] = path.split('/');
  const base = path.split('/').pop();
  if (base === '_chapter.md') return 'Chapter summary';
  const title = base.replace(/\.md$/, '').replace(/^\d+-/, '').replace(/\.[a-z0-9-]+$/, '').replace(/-/g, ' ');
  const name = title.charAt(0).toUpperCase() + title.slice(1);
  const kind = { manuscript: 'Scene', outline: 'Plot', codex: 'Codex' }[top];
  return kind ? `${kind}: ${name}` : name;
}

// Per-browser conveniences (like the chosen mode); never required to work.
function readStored(key) {
  try {
    return localStorage.getItem(`book-editor:${key}`);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(`book-editor:${key}`, value);
  } catch {
    // storage blocked; the choice just won't be remembered
  }
}

let bookView = null;
let currentHash = location.hash;

async function handleRoute() {
  const route = parseHash();
  try {
    if (route.view === 'library') {
      if (bookView?.dirty && !(await bookView.save())) return revert();
      bookView?.checkpoint('left the book');
      bookView?.dispose();
      bookView = null;
      crumb.textContent = '';
      topbarActions.replaceChildren();
      document.title = 'Book Editor';
      await renderLibrary(view);
    } else {
      if (bookView?.id !== route.id) {
        if (bookView?.dirty && !(await bookView.save())) return revert();
        bookView?.checkpoint('left the book');
        bookView?.dispose();
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

installShortcuts({
  help: () => showShortcutHelp(),
  save: () => (bookView ? (bookView.save(), true) : false),
  revision: () => (bookView ? (bookView.openRevisions(), true) : false),
  quickOpen: () => (bookView ? (bookView.quickOpen(), true) : false),
  search: () => (bookView ? (bookView.search(), true) : false),
  prevScene: () => (bookView ? bookView.stepScene(-1) : false),
  nextScene: () => (bookView ? bookView.stepScene(1) : false),
  companion: () => (bookView && !bookView.companionBtn.hidden ? (bookView.toggleCompanion(), true) : false),
  cycleView: () => (bookView ? bookView.cycleView() : false),
  history: () => (bookView ? (bookView.openHistory(), true) : false),
  claude: () => (bookView ? (bookView.toggleClaude(), true) : false),
});
document.getElementById('help-btn')?.addEventListener('click', () => showShortcutHelp());

// Anything that fails without its own handling still gets said.
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason || 'Something went wrong');
  toast(msg, { error: true, ms: 6000 });
});

window.addEventListener('hashchange', handleRoute);
window.addEventListener('beforeunload', (e) => {
  if (bookView?.dirty) e.preventDefault();
});
window.addEventListener('pagehide', () => bookView?.saveOnExit());

handleRoute();
