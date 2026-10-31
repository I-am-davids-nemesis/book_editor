import { api } from './api.js';
import { renderMarkdown } from './pane.js';
import { h, showMenu, toast } from './ui.js';
import { countWords } from './wordcount.js';

const STATUS_LABELS = { A: 'new', M: 'edited', D: 'deleted', R: 'renamed' };
const EXTRA_TOOLS = {
  off: 'Bash and web tools: off',
  ask: 'Bash and web tools: ask each time',
};

// The Claude panel, docked to the right of the panes: the conversation, a
// prompt box with chips for what's attached (the open file, the file beside
// it, the selection), approval cards, Stop and New conversation. The run
// itself happens on the server; this follows its events.
//
//   getContext() -> { file, companion, selection, mode, modes }
//     file / companion: { path, label } or null; selection: { path, text } or null
//   beforeRun() -> true once the panes are saved
export class ClaudePanel {
  constructor({ bookId, getContext, beforeRun, onOpenFile, onReview, onUndo, onClose }) {
    this.bookId = bookId;
    this.getContext = getContext;
    this.beforeRun = beforeRun;
    this.onOpenFile = onOpenFile;
    this.onReview = onReview;
    this.onUndo = onUndo;
    this.loaded = false;
    this.runId = null;
    this.source = null;
    this.extraTools = 'off';
    this.excluded = new Set(); // chips switched off for the current files
    this.contextKey = '';
    this.resetRender();

    this.statusEl = h('span', { class: 'claude-status' });
    this.newBtn = h('button', { type: 'button', title: 'Forget this conversation and start a new one', onclick: () => this.newConversation() }, 'New conversation');
    this.moreBtn = h('button', { type: 'button', class: 'more', title: 'Settings', 'aria-haspopup': 'menu', onclick: (e) => this.showSettings(e.currentTarget) }, '⋯');
    this.logEl = h('div', { class: 'claude-log', 'aria-live': 'polite' });
    this.chipsEl = h('div', { class: 'claude-chips' });
    this.quickEl = h('div', { class: 'claude-quick' });
    this.input = h('textarea', {
      rows: '3',
      placeholder: 'Ask Claude to draft, revise or check something…',
      spellcheck: 'true',
      'aria-label': 'Prompt for Claude',
    });
    this.sendBtn = h('button', { type: 'submit', class: 'primary' }, 'Send');
    this.stopBtn = h('button', { type: 'button', class: 'danger', hidden: true, onclick: () => this.stop() }, 'Stop');
    const form = h('form', { class: 'claude-compose' },
      this.chipsEl,
      this.quickEl,
      this.input,
      h('div', { class: 'claude-actions' },
        h('span', { class: 'muted claude-hint' }, '⌘↩ to send'),
        h('span', { class: 'spacer' }), this.stopBtn, this.sendBtn));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.send();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.send();
      }
    });
    this.input.addEventListener('input', () => this.renderQuick());

    this.el = h('aside', { class: 'claude-panel', hidden: true, 'aria-label': 'Claude' },
      h('div', { class: 'claude-head' },
        h('h2', {}, 'Claude'), this.statusEl, h('span', { class: 'spacer' }), this.newBtn, this.moreBtn,
        h('button', { type: 'button', class: 'more', title: 'Close (⌘⌥C)', 'aria-label': 'Close the Claude panel', onclick: () => onClose() }, '×')),
      this.logEl,
      form);
  }

  get visible() {
    return !this.el.hidden;
  }

  async show() {
    this.el.hidden = false;
    this.refreshContext();
    this.input.focus();
    if (!this.loaded) await this.loadSession();
  }

  hide() {
    this.el.hidden = true;
  }

  dispose() {
    this.source?.close();
    this.source = null;
  }

  // --- the conversation --------------------------------------------------------

  async loadSession() {
    try {
      const data = await api.claudeSession(this.bookId);
      this.loaded = true;
      this.extraTools = data.extraTools;
      this.logEl.replaceChildren();
      this.resetRender();
      for (const e of data.entries) this.render(e, { live: false });
      if (!data.entries.length) this.showWelcome();
      if (data.running) this.follow(data.running);
      this.scrollToEnd(true);
    } catch (err) {
      this.logEl.replaceChildren(h('p', { class: 'error' }, err.message));
    }
  }

  showWelcome() {
    this.logEl.append(h('div', { class: 'claude-welcome muted' },
      h('p', {}, 'Claude Code works in this book’s folder. It can read the whole book and change files inside it; you’ll see the changes appear in your panes.'),
      h('p', {}, 'Your work is committed before each run, and Claude’s changes are committed after it as “Claude: …”, so you can review or undo a run from here or in History.')));
  }

  async newConversation() {
    if (this.runId) return toast('Claude is still working; stop it first', { error: true });
    try {
      await api.claudeClear(this.bookId);
      this.logEl.replaceChildren();
      this.resetRender();
      this.showWelcome();
      this.input.focus();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  showSettings(anchor) {
    showMenu(anchor, Object.entries(EXTRA_TOOLS).map(([value, label]) => ({
      label: `${value === this.extraTools ? '✓' : '  '} ${label}`,
      disabled: value === this.extraTools,
      onclick: async () => {
        try {
          ({ extraTools: this.extraTools } = await api.claudeSettings(this.bookId, { extraTools: value }));
          toast(value === 'ask' ? 'Claude will ask before running commands or using the web' : 'Claude can’t run commands or use the web');
        } catch (err) {
          toast(err.message, { error: true });
        }
      },
    })));
  }

  //   images: the run looks at images (the server runs it on Haiku)
  async send(text = this.input.value, { images = false } = {}) {
    const prompt = text.trim();
    if (!prompt || this.runId) return;
    this.setRunning(true, 'Saving…');
    if (!(await this.beforeRun())) {
      this.setRunning(false);
      return toast('Save failed, so Claude didn’t start. Fix the problem shown in the pane first.', { error: true });
    }
    try {
      const { runId } = await api.claudeStart(this.bookId, { prompt, context: this.contextToSend(), images });
      this.input.value = '';
      this.renderQuick();
      this.logEl.querySelector('.claude-welcome')?.remove();
      this.follow(runId);
    } catch (err) {
      this.setRunning(false);
      toast(err.message, { error: true });
    }
  }

  async stop() {
    if (!this.runId) return;
    this.statusEl.textContent = 'Stopping…';
    try {
      await api.claudeStop(this.bookId, this.runId);
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // Follows a run's events. The browser reconnects by itself after a blip,
  // and the server resumes after the last event seen.
  follow(runId) {
    this.source?.close();
    this.runId = runId;
    this.setRunning(true);
    const source = new EventSource(api.claudeEventsUrl(this.bookId, runId));
    this.source = source;
    source.onmessage = (e) => {
      try {
        this.render(JSON.parse(e.data), { live: true });
      } catch (err) {
        console.error('Bad Claude event', err);
      }
    };
    const end = () => {
      source.close();
      if (this.source === source) this.source = null;
      if (this.runId === runId) {
        this.runId = null;
        this.setRunning(false);
      }
    };
    source.addEventListener('end', end);
    source.onerror = () => {
      // CLOSED means it won't retry (the server forgot the run, e.g. after
      // a restart): show what was saved instead.
      if (source.readyState === EventSource.CLOSED) {
        end();
        this.loadSession();
      }
    };
  }

  setRunning(on, label = 'Working…') {
    this.sendBtn.disabled = on;
    this.stopBtn.hidden = !on || !this.runId;
    this.newBtn.disabled = on;
    this.statusEl.textContent = on ? label : '';
    this.statusEl.classList.toggle('busy', on);
  }

  // --- rendering events ----------------------------------------------------------

  resetRender() {
    this.textEl = null;
    this.tools = new Map();
    this.cards = new Map();
  }

  render(e, { live }) {
    const atEnd = this.nearEnd();
    if (e.type !== 'text') this.textEl = null;
    switch (e.type) {
      case 'start': this.renderStart(e); break;
      case 'text': this.renderText(e.text, live); break;
      case 'tool': {
        const row = h('div', { class: 'claude-tool' }, h('span', { class: 'claude-tool-name' }, e.summary));
        this.tools.set(e.id, row);
        this.logEl.append(row);
        break;
      }
      case 'tool-error': {
        const row = this.tools.get(e.id);
        if (row) {
          row.classList.add('failed');
          row.append(h('span', { class: 'claude-tool-error' }, firstLine(e.message)));
          row.title = e.message;
        }
        break;
      }
      case 'permission': this.renderCard(e, live); break;
      case 'permission-done': {
        const card = this.cards.get(e.requestId);
        card?.querySelector('.claude-card-buttons')?.replaceChildren(
          h('span', { class: e.allow ? 'claude-allowed' : 'claude-denied' }, e.allow ? 'Allowed' : 'Denied'));
        break;
      }
      case 'files': this.renderFiles(e); break;
      case 'done': {
        const parts = [e.stopped ? 'Stopped' : e.ok ? 'Done' : 'Finished with an error'];
        if (typeof e.cost === 'number') parts.push(`$${e.cost.toFixed(e.cost < 0.1 ? 3 : 2)}`);
        if (e.turns) parts.push(`${e.turns} turn${e.turns === 1 ? '' : 's'}`);
        this.logEl.append(h('div', { class: 'claude-done muted' }, parts.join(' · ')));
        break;
      }
      case 'error':
        this.logEl.append(h('div', { class: 'claude-msg claude-error', role: 'alert' }, e.message));
        break;
      default:
        break;
    }
    this.scrollToEnd(atEnd);
  }

  renderStart(e) {
    const c = e.context || {};
    const attached = [
      c.file && `Open: ${c.file}`,
      c.companion && `Beside: ${c.companion}`,
      c.selection && `Selection (${countWords(c.selection.text)} words)`,
      e.model && `Model: ${e.model}`,
    ].filter(Boolean);
    this.logEl.append(h('div', { class: 'claude-msg claude-user' },
      h('div', { class: 'claude-prompt' }, e.prompt),
      attached.length ? h('div', { class: 'claude-attached muted' }, attached.join(' · ')) : null));
  }

  // Streamed text collects into one block, rendered as Markdown at most once
  // a frame.
  renderText(text, live) {
    if (!this.textEl) {
      this.textEl = h('div', { class: 'claude-msg claude-assistant claude-md' });
      this.textEl.markdown = '';
      this.logEl.append(this.textEl);
    }
    const el = this.textEl;
    el.markdown += text;
    const draw = () => el.replaceChildren(renderMarkdown(el.markdown));
    if (!live) return draw();
    if (el.pending) return;
    el.pending = true;
    requestAnimationFrame(() => {
      el.pending = false;
      const atEnd = this.nearEnd();
      draw();
      this.scrollToEnd(atEnd);
    });
  }

  renderCard(e, live) {
    const buttons = h('div', { class: 'claude-card-buttons' });
    const answer = async (allow) => {
      for (const b of buttons.querySelectorAll('button')) b.disabled = true;
      try {
        await api.claudeAnswer(this.bookId, this.runId, e.requestId, allow);
      } catch (err) {
        toast(err.message, { error: true });
      }
    };
    if (live) {
      buttons.append(
        h('button', { type: 'button', onclick: () => answer(false) }, 'Deny'),
        h('button', { type: 'button', class: 'primary', onclick: () => answer(true) }, 'Allow'));
    } else {
      buttons.append(h('span', { class: 'muted' }, 'Not answered'));
    }
    const card = h('div', { class: 'claude-card', role: 'group', 'aria-label': 'Claude asks for permission' },
      h('div', { class: 'claude-card-title' }, 'Claude wants to: ', h('strong', {}, e.summary)),
      e.detail && e.detail !== e.summary.replace(/^Run: /, '') ? h('pre', { class: 'claude-card-detail' }, e.detail) : null,
      buttons);
    this.cards.set(e.requestId, card);
    this.logEl.append(card);
    if (live) buttons.querySelector('.primary')?.focus({ preventScroll: true });
  }

  renderFiles(e) {
    if (!e.files.length) {
      this.logEl.append(h('div', { class: 'claude-files muted' }, 'No files changed.'));
      return;
    }
    const n = e.files.length;
    this.logEl.append(h('div', { class: 'claude-files' },
      h('div', { class: 'claude-files-head' }, `Changed ${n} file${n === 1 ? '' : 's'}`, e.commit ? h('span', { class: 'muted' }, ` · ${e.commit}`) : null),
      h('ul', {}, e.files.map((f) => h('li', { class: 'change' },
        h('span', { class: `status-letter s-${f.status}`, title: STATUS_LABELS[f.status] || f.status }, f.status),
        f.status === 'D'
          ? h('span', { class: 'change-path' }, f.path)
          : h('a', { href: '#', class: 'change-path', title: `Open ${f.path}`, onclick: (ev) => { ev.preventDefault(); this.onOpenFile(f.path); } }, f.path)))),
      h('div', { class: 'claude-files-actions' },
        e.commit ? h('button', { type: 'button', title: 'See the word-level changes in History', onclick: () => this.onReview(e.commit) }, 'Review changes') : null,
        e.before ? h('button', { type: 'button', title: 'Put the book back as it was before this run', onclick: () => this.onUndo(e.before) }, 'Undo this run') : null)));
  }

  nearEnd() {
    const el = this.logEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  scrollToEnd(force) {
    if (force) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // --- context chips and quick prompts -------------------------------------------

  // Called when the open files or the selection change.
  refreshContext() {
    if (!this.visible) return;
    clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => this.renderContext(), 100);
  }

  renderContext() {
    const ctx = this.getContext();
    this.ctx = ctx;
    const key = `${ctx.file?.path}|${ctx.companion?.path}`;
    if (key !== this.contextKey) {
      this.contextKey = key;
      this.excluded.clear();
    }
    const chips = [
      ctx.file && ['file', ctx.file.label, ctx.file.path],
      ctx.companion && ['companion', ctx.companion.label, ctx.companion.path],
      ctx.selection && ['selection', `Selection · ${countWords(ctx.selection.text)} words`, `Selected text in ${ctx.selection.path}`],
    ].filter(Boolean);
    this.chipsEl.replaceChildren(...chips.map(([kind, label, title]) => {
      const off = this.excluded.has(kind);
      return h('button', {
        type: 'button',
        class: `claude-chip${off ? ' off' : ''}`,
        'aria-pressed': String(!off),
        title: `${title}\n${off ? 'Not sent. Click to attach it again.' : 'Sent with your prompt. Click to leave it out.'}`,
        onclick: () => {
          if (off) this.excluded.delete(kind);
          else this.excluded.add(kind);
          this.renderContext();
        },
      }, off ? `+ ${label}` : `${label} ×`);
    }));
    this.chipsEl.hidden = !chips.length;
    this.renderQuick();
  }

  contextToSend() {
    const ctx = this.getContext();
    const out = { mode: ctx.mode || undefined };
    if (ctx.file && !this.excluded.has('file')) out.file = ctx.file.path;
    if (ctx.companion && !this.excluded.has('companion')) out.companion = ctx.companion.path;
    if (ctx.selection && !this.excluded.has('selection')) out.selection = ctx.selection;
    return out;
  }

  // Starting points, shown while the prompt box is empty. They fill the box
  // rather than sending, so they can be adjusted first.
  renderQuick() {
    const ctx = this.ctx;
    const scene = ctx && [ctx.file, ctx.companion].find((f) => f?.path.startsWith('manuscript/'));
    const plot = ctx && [ctx.file, ctx.companion].find((f) => f?.path.startsWith('outline/') && !f.path.endsWith('/_chapter.md'));
    const prompts = [];
    if (scene || plot) {
      if (plot) prompts.push('Draft this scene from its plot.');
      const others = (ctx.modes || []).filter((m) => m.value !== ctx.mode);
      if (scene && others.length) prompts.push(`Write the ${others[0].label} version of this scene.`);
      if (scene) prompts.push('Check this scene against the codex and list any contradictions.');
    }
    this.quickEl.hidden = !prompts.length || this.input.value.trim() !== '';
    this.quickEl.replaceChildren(...prompts.map((p) => h('button', {
      type: 'button',
      class: 'quick',
      onclick: () => {
        this.input.value = p;
        this.renderQuick();
        this.input.focus();
      },
    }, p)));
  }
}

function firstLine(s) {
  const line = String(s || '').split('\n').find((l) => l.trim()) || '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
