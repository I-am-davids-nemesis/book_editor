import { api } from './api.js';
import { confirmDialog } from './dialogs.js';
import { fileRow, groupFiles } from './gitpanel.js';
import { buildNodes, layoutGraph } from './graph.js';
import { formatCount, h, imageSrc, toast } from './ui.js';

const ROW_H = 48;
const LANE_W = 14;
const GRAPH_PAD = 12;
const PAGE = 200;
const SVG_NS = 'http://www.w3.org/2000/svg';

// --- dates and labels -------------------------------------------------------------

const sameDay = (a, b) => a.toDateString() === b.toDateString();
const timeOf = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function formatWhen(iso, now = new Date()) {
  const d = new Date(iso);
  if (sameDay(d, now)) return timeOf(d);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${timeOf(d)}`;
  const opts = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return `${d.toLocaleDateString([], opts)}, ${timeOf(d)}`;
}

const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

function changedSummary(commits) {
  const paths = new Set(commits.flatMap((c) => c.files.map((f) => f.path)));
  const scenes = [...paths].filter((p) => p.startsWith('manuscript/')).length;
  return scenes ? plural(scenes, 'scene') : plural(paths.size, 'file');
}

function nodeTitle(node) {
  if (node.kind === 'worktree') return 'Uncommitted changes';
  if (node.kind === 'group') return `${node.commits.length} autosaves`;
  if (node.auto) return node.subject.replace(/^Autosave:\s*/, '');
  return node.subject;
}

function nodeMeta(node) {
  if (node.kind === 'worktree') return `${plural(node.files.length, 'file')} not committed yet`;
  if (node.kind === 'group') {
    const from = new Date(node.oldestDate);
    const to = new Date(node.date);
    const range = sameDay(from, to) ? `${formatWhen(node.oldestDate)}–${timeOf(to)}` : `${formatWhen(node.oldestDate)} – ${formatWhen(node.date)}`;
    return `${range} · ${changedSummary(node.commits)}`;
  }
  const c = node.commits[0];
  return `${formatWhen(c.date)} · ${plural(c.files.length, 'file')}${node.auto ? ' · autosave' : ''}`;
}

function matches(node, text) {
  if (!text) return true;
  const t = text.toLowerCase();
  if (node.kind === 'worktree') return node.files.some((f) => f.path.toLowerCase().includes(t));
  return node.commits.some((c) => c.subject.toLowerCase().includes(t)
    || c.body.toLowerCase().includes(t)
    || c.files.some((f) => f.path.toLowerCase().includes(t)));
}

// --- diff rendering ---------------------------------------------------------------

// Word-level hunks from the server, as paragraphs with <ins>/<del>.
export function renderDiff(hunks) {
  if (!hunks.length) return h('p', { class: 'muted' }, 'No text changes (renamed or identical).');
  return h('div', { class: 'diff' }, hunks.map((hunk, i) => {
    const paras = [];
    let p = h('p');
    for (const seg of hunk.segments) {
      if (seg.type === 'newline') {
        if (p.childNodes.length) paras.push(p);
        p = h('p');
      } else if (seg.type === 'added') {
        p.append(h('ins', {}, seg.text));
      } else if (seg.type === 'removed') {
        p.append(h('del', {}, seg.text));
      } else {
        p.append(seg.text);
      }
    }
    if (p.childNodes.length) paras.push(p);
    return [i ? h('div', { class: 'diff-gap', 'aria-hidden': 'true' }, '⋯') : null, h('div', { class: 'hunk' }, paras)];
  }));
}

// --- the view -------------------------------------------------------------------------

// The book's history: a commit graph on the left, and on the right what the
// selected point (or the span between two points) changed.
//
// callbacks:
//   onBack()                       return to writing
//   onSelect(hash|null)            the selection changed (for the address bar)
//   onRestored()                   files on disk changed; reload panes and tree
//   onViewVersion({path, rev, content, label})   show an old version beside the current file
//   onSaveRevision()               open the Save revision panel
//   onNewDraft(hash, label)        start a draft (branch) from a commit
//   onSwitchDraft(branch)          switch to another draft
export class HistoryView {
  constructor({ bookId, onBack, onSelect, onRestored, onViewVersion, onSaveRevision, onNewDraft, onSwitchDraft }) {
    Object.assign(this, { bookId, onBack, onSelect, onRestored, onViewVersion, onSaveRevision, onNewDraft, onSwitchDraft });
    this.commits = [];
    this.more = false;
    this.status = null;
    this.expanded = new Set();
    this.namedOnly = false;
    this.filterText = '';
    this.filterPath = null;
    this.selected = []; // node ids; two means compare
    this.comparing = false;
    this.rows = [];

    this.filterInput = h('input', {
      type: 'search',
      placeholder: 'Filter by words or file',
      'aria-label': 'Filter history',
      oninput: () => { this.filterText = this.filterInput.value.trim(); this.renderList(); },
    });
    this.namedBox = h('input', { type: 'checkbox', onchange: () => { this.namedOnly = this.namedBox.checked; this.renderList(); } });
    this.compareBtn = h('button', { type: 'button', onclick: () => this.toggleCompare(), title: 'Pick two points to see everything that changed between them' }, 'Compare');
    this.pathChip = h('span', { class: 'path-chip', hidden: true });
    this.hintEl = h('span', { class: 'history-hint muted' });
    this.listEl = h('div', { class: 'history-list', tabindex: '0', 'aria-label': 'Commits' });
    this.detailEl = h('div', { class: 'history-detail' });
    this.el = h('section', { class: 'history', hidden: true },
      h('div', { class: 'history-head' },
        h('button', { type: 'button', onclick: () => this.onBack(), title: 'Back to writing (Esc)' }, '← Back to writing'),
        h('h2', {}, 'History'),
        this.pathChip,
        this.filterInput,
        h('label', { class: 'check' }, this.namedBox, 'Named save points only'),
        this.compareBtn,
        this.hintEl),
      h('div', { class: 'history-body' }, this.listEl, h('div', { class: 'pane-divider static', 'aria-hidden': 'true' }), this.detailEl));

    this.listEl.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]') && !e.defaultPrevented) {
        if (this.comparing) this.toggleCompare(false);
        else this.onBack();
      }
    });
  }

  // --- loading -----------------------------------------------------------

  async show({ hash = null, path = undefined } = {}) {
    this.el.hidden = false;
    if (path !== undefined && path !== this.filterPath) {
      this.filterPath = path;
      this.commits = [];
    }
    await this.load();
    const target = hash ? this.nodeFor(hash) : null;
    if (target) this.select([target.id], { notify: false });
    else if (!this.selected.length || !this.selected.every((id) => this.visibleNodes.some((n) => n.id === id))) {
      const first = this.visibleNodes[0];
      this.select(first ? [first.id] : [], { notify: false });
    } else {
      this.renderDetail();
    }
    this.listEl.focus({ preventScroll: true });
  }

  hide() {
    this.el.hidden = true;
  }

  async load({ older = false } = {}) {
    const skip = older ? this.commits.length : 0;
    const [graph, status] = await Promise.all([
      api.gitGraph(this.bookId, { limit: PAGE, skip, path: this.filterPath }),
      older ? Promise.resolve(this.status) : api.gitStatus(this.bookId),
    ]);
    this.repo = graph.repo;
    this.commits = older ? [...this.commits, ...graph.commits] : graph.commits;
    this.more = graph.more;
    this.head = graph.head;
    this.branch = graph.branch;
    this.status = status;
    this.renderList();
  }

  nodeFor(hash) {
    return this.visibleNodes.find((n) => n.hash === hash || n.commits.some((c) => c.hash === hash));
  }

  // --- the list and graph ------------------------------------------------------

  renderList() {
    this.pathChip.hidden = !this.filterPath;
    this.pathChip.replaceChildren(
      `Only ${this.filterPath ?? ''}`,
      h('button', { type: 'button', title: 'Show the whole book', onclick: () => this.show({ path: null }) }, '×'));

    if (this.repo === false) {
      this.visibleNodes = [];
      this.listEl.replaceChildren(h('p', { class: 'muted empty-history' }, 'This book is not a git repository, so it has no history.'));
      this.detailEl.replaceChildren();
      return;
    }
    let wtFiles = this.status?.files ?? [];
    if (this.filterPath) wtFiles = wtFiles.filter((f) => f.path === this.filterPath || f.from === this.filterPath);
    const nodes = buildNodes(this.commits, {
      expanded: this.expanded,
      namedOnly: this.namedOnly,
      worktree: wtFiles.length ? { parent: this.head, files: wtFiles } : null,
    });
    this.visibleNodes = nodes;
    const { rows, width } = layoutGraph(nodes);
    this.rows = rows;
    const graphW = GRAPH_PAD * 2 + (width - 1) * LANE_W;

    const items = rows.map((row, i) => {
      const { node } = row;
      const chips = [
        ...node.refs.map((r) => h('span', { class: `chip${r === this.branch ? ' current' : ''}`, title: r === this.branch ? 'The draft you are on' : `Draft ${r}` }, r)),
        node.head ? h('span', { class: 'chip here', title: 'The files you are editing are based on this point' }, 'you are here') : null,
      ];
      const el = h('div', {
        class: `hrow kind-${node.kind}${node.auto ? ' auto' : ''}${matches(node, this.filterText) ? '' : ' dim'}`,
        'data-id': node.id,
        role: 'option',
        style: `padding-left:${graphW}px;height:${ROW_H}px`,
        onclick: (e) => this.clickRow(node, e),
      },
      h('div', { class: 'hrow-title' },
        h('span', { class: 'subject' }, nodeTitle(node)),
        chips,
        node.kind === 'group' ? h('button', {
          type: 'button',
          class: 'expand',
          title: 'Show each autosave',
          onclick: (e) => { e.stopPropagation(); this.expanded.add(node.hash); this.renderList(); },
        }, 'expand') : null,
        node.kind === 'commit' && node.auto && this.expanded.has(node.hash) ? h('button', {
          type: 'button',
          class: 'expand',
          title: 'Fold these autosaves into one row',
          onclick: (e) => { e.stopPropagation(); this.expanded.delete(node.hash); this.renderList(); },
        }, 'fold') : null),
      h('div', { class: 'hrow-meta' }, nodeMeta(node)));
      el.dataset.index = String(i);
      return el;
    });

    const more = this.more ? h('button', { type: 'button', class: 'load-older', onclick: () => this.load({ older: true }) }, 'Load older') : null;
    const svg = this.drawGraph(rows, graphW);
    const inner = h('div', { class: 'hrows', role: 'listbox', 'aria-label': 'Commits' }, svg, items);
    const empty = !rows.length ? h('p', { class: 'muted empty-history' }, 'No commits yet.') : null;
    this.listEl.replaceChildren(...[inner, more, empty].filter(Boolean));
    this.markSelection();
  }

  drawGraph(rows, graphW) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'graph');
    svg.setAttribute('width', String(graphW));
    svg.setAttribute('height', String(rows.length * ROW_H));
    svg.setAttribute('aria-hidden', 'true');
    const x = (lane) => GRAPH_PAD + lane * LANE_W;
    const y = (i) => i * ROW_H + ROW_H / 2;
    const el = (tag, attrs) => {
      const e = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };
    rows.forEach((row, i) => {
      for (const s of row.segments) {
        const x1 = x(s.from);
        const x2 = x(s.to);
        const y1 = y(i);
        const y2 = s.offEnd ? y(i) + ROW_H / 2 : y(i + 1);
        const d = x1 === x2
          ? `M${x1} ${y1} L${x2} ${y2}`
          : `M${x1} ${y1} C${x1} ${y1 + ROW_H * 0.6} ${x2} ${y2 - ROW_H * 0.6} ${x2} ${y2}`;
        svg.append(el('path', { d, class: `edge lane-${s.color % 6}` }));
      }
    });
    rows.forEach((row, i) => {
      const cls = `dot lane-${row.color % 6} kind-${row.node.kind}${row.node.auto ? ' auto' : ''}${row.node.head ? ' head' : ''}`;
      if (row.node.kind === 'group') {
        svg.append(el('rect', { x: x(row.lane) - 5, y: y(i) - 8, width: 10, height: 16, rx: 5, class: cls }));
      } else {
        svg.append(el('circle', { cx: x(row.lane), cy: y(i), r: row.node.auto ? 3.5 : 5, class: cls }));
      }
      if (row.node.head) svg.append(el('circle', { cx: x(row.lane), cy: y(i), r: 8, class: `ring lane-${row.color % 6}` }));
    });
    return svg;
  }

  // --- selecting ---------------------------------------------------------------

  clickRow(node, e) {
    if ((this.comparing || e.shiftKey) && this.selected.length && this.selected[0] !== node.id) {
      this.select([this.selected[0], node.id]);
      this.toggleCompare(false);
    } else {
      this.select([node.id]);
    }
  }

  toggleCompare(on = !this.comparing) {
    this.comparing = on;
    this.compareBtn.setAttribute('aria-pressed', String(on));
    this.hintEl.textContent = on ? 'Now click a second point to compare with the selected one.' : '';
  }

  select(ids, { notify = true } = {}) {
    this.selected = ids;
    this.markSelection();
    this.renderDetail();
    if (notify) {
      const node = this.visibleNodes.find((n) => n.id === ids[0]);
      this.onSelect?.(ids.length === 1 && node?.hash ? node.hash : null);
    }
  }

  markSelection() {
    for (const row of this.listEl.querySelectorAll('.hrow')) {
      const i = this.selected.indexOf(row.dataset.id);
      row.classList.toggle('selected', i !== -1);
      row.setAttribute('aria-selected', String(i !== -1));
      row.dataset.mark = this.selected.length === 2 && i !== -1 ? (i === 0 ? 'A' : 'B') : '';
    }
    this.listEl.querySelector('.hrow.selected')?.scrollIntoView?.({ block: 'nearest' });
  }

  onKey(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = this.visibleNodes.findIndex((n) => n.id === this.selected[0]);
    const j = Math.min(this.visibleNodes.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
    if (this.visibleNodes[j]) this.select([this.visibleNodes[j].id]);
  }

  // The commit range a selection covers: { from, to } for the server
  // (from omitted means "the commit's parent"), plus labels.
  rangeFor(ids) {
    const nodes = ids.map((id) => this.visibleNodes.find((n) => n.id === id)).filter(Boolean);
    if (!nodes.length) return null;
    const toRev = (n) => (n.kind === 'worktree' ? 'worktree' : n.hash);
    if (nodes.length === 1) {
      const [n] = nodes;
      if (n.kind === 'group') return { from: n.base ?? undefined, to: n.hash, nodes };
      return { to: toRev(n), nodes };
    }
    // Older one first: lower in the list.
    const order = (n) => this.visibleNodes.indexOf(n);
    const [newer, older] = nodes.sort((a, b) => order(a) - order(b));
    return { from: older.hash, to: toRev(newer), nodes: [older, newer] };
  }

  // --- the detail pane -----------------------------------------------------------

  async renderDetail() {
    const range = this.rangeFor(this.selected);
    const token = Symbol('detail');
    this.detailToken = token;
    if (!range) {
      this.detailEl.replaceChildren();
      return;
    }
    this.detailEl.replaceChildren(this.detailHeader(range), h('p', { class: 'muted' }, 'Loading changes…'));
    let cmp;
    try {
      cmp = await api.gitCompare(this.bookId, { from: range.from, to: range.to });
    } catch (err) {
      if (this.detailToken === token) this.detailEl.replaceChildren(this.detailHeader(range), h('p', { class: 'error' }, err.message));
      return;
    }
    if (this.detailToken !== token) return;
    this.range = { ...range, from: cmp.from ?? undefined };
    this.files = cmp.files;
    this.showFileList();
  }

  detailHeader(range) {
    const { nodes } = range;
    if (nodes.length === 2) {
      const [older, newer] = nodes;
      return h('div', { class: 'detail-head' },
        h('h3', {}, 'Changes between two points'),
        h('p', { class: 'muted' }, h('strong', {}, 'From '), nodeTitle(older), ` (${older.kind === 'worktree' ? 'now' : formatWhen(older.date)})`),
        h('p', { class: 'muted' }, h('strong', {}, 'To '), nodeTitle(newer), ` (${newer.kind === 'worktree' ? 'now' : formatWhen(newer.date)})`));
    }
    const [n] = nodes;
    if (n.kind === 'worktree') {
      return h('div', { class: 'detail-head' },
        h('h3', {}, 'Uncommitted changes'),
        h('p', { class: 'muted' }, 'Saved to disk but not committed yet. They are committed when you switch files, after 30 minutes, or now:'),
        h('div', { class: 'detail-actions' }, h('button', { type: 'button', class: 'primary', onclick: () => this.onSaveRevision() }, 'Save revision…')));
    }
    const c = n.commits[0];
    const body = n.kind === 'commit' && !n.auto && c.body ? h('pre', { class: 'commit-body' }, c.body) : null;
    const when = n.kind === 'group'
      ? `${new Date(n.oldestDate).toLocaleString()} – ${new Date(n.date).toLocaleString()}`
      : new Date(c.date).toLocaleString();
    return h('div', { class: 'detail-head' },
      h('h3', {}, nodeTitle(n)),
      body,
      h('p', { class: 'muted' }, when, n.kind === 'commit' ? ` · ${c.author} · ${c.hash.slice(0, 7)}` : ''),
      h('div', { class: 'detail-actions' },
        n.kind === 'group' ? h('button', { type: 'button', onclick: () => { this.expanded.add(n.hash); this.renderList(); } }, 'Show each autosave') : null,
        h('button', { type: 'button', onclick: () => this.restoreBook(n) }, 'Restore whole book to here…'),
        h('button', { type: 'button', onclick: () => this.onNewDraft(n.hash, nodeTitle(n)), title: 'A separate line of work starting here' }, 'Start a draft from here…'),
        h('button', { type: 'button', onclick: () => this.toggleCompare(true) }, 'Compare with…'),
        n.refs.filter((r) => r !== this.branch).map((r) => h('button', {
          type: 'button',
          onclick: () => this.onSwitchDraft(r),
          title: `Make ${r} the draft you're working on`,
        }, `Switch to draft ${r}`))));
  }

  showFileList() {
    const range = this.range;
    const total = (key) => this.files.reduce((sum, f) => sum + (f[key] || 0), 0);
    const added = total('added');
    const removed = total('removed');
    const summary = this.files.length
      ? `${plural(this.files.length, 'file')} changed${added || removed ? ` · ${added ? `+${formatCount(added)}` : ''}${added && removed ? ' ' : ''}${removed ? `−${formatCount(removed)}` : ''} words` : ''}`
      : 'No files changed.';
    this.detailEl.replaceChildren(
      this.detailHeader(range),
      h('p', { class: 'files-summary' }, summary),
      h('div', { class: 'changes' }, groupFiles(this.files).map(([label, group]) => h('div', { class: 'change-group' },
        h('div', { class: 'group-label' }, `${label} · ${group.length}`),
        h('ul', {}, group.map((f) => fileRow(f, { onOpen: () => this.showFile(f), allowDeleted: true, openTitle: 'Show what changed' })))))));
  }

  async showFile(f) {
    const range = this.range;
    const back = h('button', { type: 'button', onclick: () => this.showFileList() }, '← All files');
    this.detailEl.replaceChildren(h('div', { class: 'detail-nav' }, back, h('strong', {}, f.path)), h('p', { class: 'muted' }, 'Loading…'));
    let d;
    try {
      d = await api.gitFileDiff(this.bookId, { from: range.from, to: range.to, path: f.path, fromPath: f.from });
    } catch (err) {
      this.detailEl.replaceChildren(h('div', { class: 'detail-nav' }, back), h('p', { class: 'error' }, err.message));
      return;
    }
    const atCommit = range.to !== 'worktree';
    const label = atCommit ? this.versionLabel(range) : '';
    if (d.image) {
      this.showImage(f, d, { back, atCommit, label });
      return;
    }
    const actions = h('div', { class: 'detail-actions' },
      atCommit && d.after !== null ? h('button', {
        type: 'button',
        onclick: () => this.onViewVersion({ path: f.path, rev: range.to, content: d.after, label }),
        title: 'Open the current file with this version beside it',
      }, 'View beside current') : null,
      atCommit && d.after !== null ? h('button', { type: 'button', onclick: () => this.restoreFile(f.path, range.to, label) }, 'Restore this version…') : null,
      atCommit && d.after === null && d.before !== null && range.from ? h('button', {
        type: 'button',
        onclick: () => this.restoreFile(f.from ?? f.path, range.from, 'the version before it was deleted'),
      }, 'Bring back the deleted file…') : null);
    this.detailEl.replaceChildren(
      h('div', { class: 'detail-nav' }, back, h('strong', { class: 'diff-path' }, f.from ? `${f.from} → ${f.path}` : f.path),
        h('span', { class: 'change-words' },
          f.added ? h('span', { class: 'words-added' }, `+${formatCount(f.added)}`) : null,
          f.removed ? h('span', { class: 'words-removed' }, `−${formatCount(f.removed)}`) : null)),
      actions,
      d.before === null ? h('p', { class: 'muted' }, 'New file.') : d.after === null ? h('p', { class: 'muted' }, 'Deleted.') : null,
      renderDiff(d.hunks));
  }

  // Images aren't diffed: the version before and after, side by side.
  showImage(f, d, { back, atCommit, label }) {
    const figure = (caption, src) => h('figure', { class: 'image-version' },
      src ? h('img', { src, alt: caption }) : h('div', { class: 'image-none muted' }, 'None'),
      h('figcaption', { class: 'muted' }, caption));
    const before = d.hasBefore ? imageSrc(this.bookId, { path: d.fromPath }, d.from) : null;
    const after = !d.hasAfter ? null
      : atCommit ? imageSrc(this.bookId, { path: d.path }, d.to) : imageSrc(this.bookId, { path: d.path, mtime: Date.now() });
    this.detailEl.replaceChildren(
      h('div', { class: 'detail-nav' }, back, h('strong', { class: 'diff-path' }, f.from ? `${f.from} → ${f.path}` : f.path)),
      h('div', { class: 'detail-actions' },
        atCommit && d.hasAfter ? h('button', { type: 'button', onclick: () => this.restoreFile(f.path, d.to, label) }, 'Restore this version…') : null,
        atCommit && !d.hasAfter && d.hasBefore && d.from ? h('button', {
          type: 'button',
          onclick: () => this.restoreFile(f.from ?? f.path, d.from, 'the version before it was deleted'),
        }, 'Bring back the deleted image…') : null),
      h('div', { class: 'image-versions' }, figure('Before', before), figure(atCommit ? 'After' : 'Now', after)));
  }

  versionLabel(range) {
    const node = range.nodes.at(-1);
    if (node.kind === 'group') return `as of ${formatWhen(node.date)}`;
    return `${nodeTitle(node)} · ${formatWhen(node.date)}`;
  }

  // --- restoring ----------------------------------------------------------------

  async restoreFile(path, rev, label) {
    const ok = await confirmDialog({
      title: 'Restore this version?',
      message: `This replaces the current text of ${path} with ${label}. The current text stays in history (it is committed first, as usual, when you switch files).`,
      okLabel: 'Restore file',
    });
    if (!ok) return;
    try {
      await api.checkpoint(this.bookId, `before restoring ${path}`);
      await api.gitRestoreFile(this.bookId, rev, path);
      toast(`Restored ${path}`);
      await this.onRestored();
      await this.load();
      this.select(this.visibleNodes[0] ? [this.visibleNodes[0].id] : []);
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async restoreBook(node) {
    const ok = await confirmDialog({
      title: 'Restore the whole book to this point?',
      message: `Every file goes back to how it was at “${nodeTitle(node)}” (${formatWhen(node.date)}). Nothing is lost: your current version is committed first, and the restore is a new commit on top, so you can come back to it from History.`,
      okLabel: 'Restore whole book',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.gitRestoreBook(this.bookId, node.hash);
      toast(res.committed ? `Book restored (${res.commit})` : 'The book already matches that point');
      await this.onRestored();
      await this.load();
      this.select(this.visibleNodes[0] ? [this.visibleNodes[0].id] : []);
    } catch (err) {
      toast(err.message, { error: true });
    }
  }
}
