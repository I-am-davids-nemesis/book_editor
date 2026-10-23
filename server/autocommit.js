import path from 'node:path';
import { git, isRepo } from './git.js';
import { serialized } from './queue.js';

export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

// Commits everything that changed in the book, if anything did. Runs in the
// book's queue so it never lands in the middle of a structure change.
// `message(changes)` replaces the usual "Autosave: …" message.
export function checkpoint(root, reason = '', { message } = {}) {
  return serialized(root, async () => {
    if (!(await isRepo(root))) return { committed: false, reason: 'not a git repository' };
    if (!(await git(root, ['status', '--porcelain'])).trim()) return { committed: false };
    await git(root, ['add', '-A']);
    const changes = (await git(root, ['diff', '--cached', '--name-status', '-M']))
      .trim().split('\n').filter(Boolean).map((line) => {
        const [status, ...paths] = line.split('\t');
        return { status: status[0], path: paths.at(-1), from: paths.length > 1 ? paths[0] : undefined };
      });
    if (!changes.length) return { committed: false };
    await git(root, ['commit', '-q', '-m', message ? message(changes) : commitMessage(changes, reason)]);
    const commit = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
    return { committed: true, commit, files: changes.map((c) => c.path), changes };
  });
}

const VERBS = { A: 'Add', D: 'Delete', R: 'Rename', M: 'Edit' };

function commitMessage(changes, reason) {
  const [first] = changes;
  const subject = changes.length === 1
    ? `${VERBS[first.status] || 'Edit'} ${path.basename(first.path, '.md')}`
    : `Edit ${changes.length} files`;
  const lines = changes.map((c) => `${c.status} ${c.from ? `${c.from} -> ` : ''}${c.path}`);
  return `Autosave: ${subject}\n\n${lines.join('\n')}\n${reason ? `\nCommitted automatically (${reason}).\n` : ''}`;
}

// Makes sure no change sits uncommitted for longer than the interval: the
// first change after a commit starts the clock, and the commit stops it.
export class AutoCommitter {
  constructor({ intervalMs = DEFAULT_INTERVAL_MS, log = console } = {}) {
    this.intervalMs = intervalMs;
    this.log = log;
    this.timers = new Map();
    this.running = new Set(); // commits in progress, so shutdown can wait for them
  }

  changed(root) {
    if (this.timers.has(root) || !this.intervalMs) return;
    const timer = setTimeout(() => {
      this.commit(root, `${Math.round(this.intervalMs / 60000)} minutes since the last change was committed`)
        .catch((err) => this.log.error(`Auto-commit failed in ${root}: ${err.message}`));
    }, this.intervalMs);
    timer.unref?.();
    this.timers.set(root, timer);
  }

  // A commit was made some other way (Save revision): stop the clock.
  committed(root) {
    clearTimeout(this.timers.get(root));
    this.timers.delete(root);
  }

  async commit(root, reason) {
    clearTimeout(this.timers.get(root));
    this.timers.delete(root);
    const run = checkpoint(root, reason);
    this.running.add(run);
    run.finally(() => this.running.delete(run)).catch(() => {});
    return run;
  }

  // Commits every book with pending changes, and lets commits already under
  // way finish (on shutdown).
  async flush(reason = 'editor shut down') {
    const roots = [...this.timers.keys()];
    const running = [...this.running];
    const results = await Promise.allSettled(roots.map((root) => this.commit(root, reason)));
    await Promise.allSettled(running);
    results.forEach((r, i) => {
      if (r.status === 'rejected') this.log.error(`Auto-commit failed in ${roots[i]}: ${r.reason.message}`);
    });
  }
}
