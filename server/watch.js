import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashContent } from './files.js';
import { whenIdle } from './queue.js';

const DEBOUNCE_MS = 150;
const MAX_HASH_BYTES = 5 * 1024 * 1024;

// Files the editor itself writes in passing (atomic-save temp files, the
// two-phase rename names) and editor/OS clutter. Their final names still
// produce events.
const IGNORED = [
  /(^|\/)\.[^/]*\.tmp$/,
  /(^|\/)\.moving-/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.obsidian(\/|$)/,
  /^compiled(\/|$)/,
  /~$/,
  /(^|\/)\.#/,
  /\.sw[px]$/,
];

// Inside .git, only these mean "the history or current draft changed".
const GIT_SIGNALS = [/^\.git\/HEAD$/, /^\.git\/refs\//, /^\.git\/packed-refs$/, /^\.git\/index$/];

// Watches one book folder and reports batches of changes:
//   { files: [{ path, hash }], tree, git }
// `hash` is the SHA-1 of a Markdown file's content (null if it's gone), so
// the editor can tell its own saves from changes made elsewhere. `tree` says
// files or folders were added, removed or renamed. `git` says commits or the
// current branch may have changed.
export class BookWatcher {
  constructor(root, { debounceMs = DEBOUNCE_MS, log = console } = {}) {
    this.root = root;
    this.debounceMs = debounceMs;
    this.log = log;
    this.listeners = new Set();
    this.pending = new Map(); // rel path -> fs event type
    this.git = false;
    this.timer = null;
    this.watcher = null;
  }

  start() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (type, name) => {
        if (name) this.note(type, name.split(path.sep).join('/'));
      });
      this.watcher.on('error', (err) => this.log.error(`Watching ${this.root} failed: ${err.message}`));
    } catch (err) {
      this.log.error(`Cannot watch ${this.root}: ${err.message}`);
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    this.start();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.stop();
    };
  }

  note(type, rel) {
    if (rel === '.git' || rel.startsWith('.git/')) {
      if (!GIT_SIGNALS.some((re) => re.test(rel))) return;
      this.git = true;
    } else if (IGNORED.some((re) => re.test(rel))) {
      return;
    } else {
      this.pending.set(rel, this.pending.get(rel) === 'rename' ? 'rename' : type);
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch((err) => this.log.error(err)), this.debounceMs);
  }

  async flush() {
    // Don't report the middle of a structure change or commit; wait for the
    // book's queue to go quiet and report the end result.
    await whenIdle(this.root);
    const entries = [...this.pending];
    const git = this.git;
    this.pending.clear();
    this.git = false;
    if (!entries.length && !git) return;

    const files = [];
    let tree = false;
    for (const [rel, type] of entries) {
      let stat = null;
      try {
        stat = await fsp.stat(path.join(this.root, rel));
      } catch {
        // gone
      }
      if (type === 'rename' || !stat || stat.isDirectory()) tree = true;
      if (stat?.isDirectory() || !rel.toLowerCase().endsWith('.md')) continue;
      let hash = null;
      if (stat && stat.size <= MAX_HASH_BYTES) {
        try {
          hash = hashContent(await fsp.readFile(path.join(this.root, rel), 'utf8'));
        } catch {
          hash = null;
        }
      }
      files.push({ path: rel, hash, exists: Boolean(stat) });
    }
    if (!files.length && !tree && !git) return;
    const batch = { files, tree, git };
    for (const fn of this.listeners) fn(batch);
  }
}

// One watcher per book, shared by every open tab.
const watchers = new Map();

export function watchBook(root, listener) {
  let w = watchers.get(root);
  if (!w) {
    w = new BookWatcher(root);
    watchers.set(root, w);
  }
  const unsubscribe = w.subscribe(listener);
  return () => {
    unsubscribe();
    if (!w.listeners.size) watchers.delete(root);
  };
}
