import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { countWords } from '../public/js/wordcount.js';
import { checkpoint } from './autocommit.js';
import { badRequest, conflict, HttpError, notFound } from './errors.js';
import { git, isRepo } from './git.js';
import { isImagePath } from './lookbook.js';
import { resolveInBook, toRel } from './paths.js';
import { serialized } from './queue.js';

// The tree with no files, used as the "before" side of a book's first commit.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const WORKTREE = 'worktree';
const AUTO_PREFIX = 'Autosave:';
// Prose diffs: words are runs of anything but spaces and punctuation, and each
// punctuation mark is its own token, so "waited." -> "waited by the door."
// shows only "by the door" as added. Bytes above ASCII count as word
// characters, so accented letters never split.
const WORD_DIFF = ['--word-diff=porcelain', '--word-diff-regex=[^[:space:][:punct:]]+|[[:punct:]]'];

// Every git call that names files or revisions passes core.quotePath=false so
// paths come back as written, not octal-escaped.
const g = (root, args, opts) => git(root, ['-c', 'core.quotePath=false', ...args], opts);

async function requireRepo(root) {
  if (!(await isRepo(root))) throw new HttpError(400, 'This book is not a git repository');
}

// Commit ids from the client are full or abbreviated hashes, nothing else
// (no options, no ranges, no ref names).
function checkRev(rev, label = 'revision') {
  if (typeof rev !== 'string' || !/^[0-9a-f]{4,64}$/.test(rev)) throw badRequest(`Invalid ${label}`);
  return rev;
}

async function headCommit(root) {
  try {
    return (await g(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim() || null;
  } catch {
    return null; // no commits yet
  }
}

async function currentBranch(root) {
  try {
    return (await g(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null;
  } catch {
    return null; // detached
  }
}

// --- status ----------------------------------------------------------------------

export async function status(root) {
  if (!(await isRepo(root))) return { repo: false };
  const out = await g(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--branch']);
  const entries = out.split('\0');
  const files = [];
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      const m = /\.\.\.(\S+)(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(e);
      if (m) {
        upstream = m[1];
        ahead = Number(m[2] || 0);
        behind = Number(m[3] || 0);
      }
      continue;
    }
    const code = e.slice(0, 2);
    const file = { path: e.slice(3), status: code === '??' ? 'A' : (code.trim()[0] || 'M') };
    if (code.includes('R') || code.includes('C')) {
      file.from = entries[++i];
      file.status = 'R';
    }
    files.push(file);
  }
  const remotes = (await g(root, ['remote'])).trim().split('\n').filter(Boolean);
  const branches = (await g(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']))
    .trim().split('\n').filter(Boolean);
  return {
    repo: true,
    branch: await currentBranch(root),
    branches,
    head: await headCommit(root),
    files,
    remotes,
    upstream,
    ahead,
    behind,
  };
}

// --- commit and push ---------------------------------------------------------------

export async function commitNamed(root, message) {
  const msg = typeof message === 'string' ? message.trim() : '';
  if (!msg) throw badRequest('Write a short description of this revision');
  return serialized(root, async () => {
    await requireRepo(root);
    if (!(await g(root, ['status', '--porcelain'])).trim()) throw conflict('Nothing to commit: no changes since the last revision');
    await g(root, ['add', '-A']);
    await g(root, ['commit', '-q', '-m', msg]);
    return { committed: true, commit: (await g(root, ['rev-parse', '--short', 'HEAD'])).trim() };
  });
}

export function push(root) {
  return serialized(root, async () => {
    await requireRepo(root);
    const branch = await currentBranch(root);
    if (!branch) throw conflict('Not on a draft (detached HEAD); switch to one before pushing');
    const remotes = (await g(root, ['remote'])).trim().split('\n').filter(Boolean);
    if (!remotes.length) throw conflict('This book has no remote to push to');
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    // Never wait for a password prompt: there's no terminal to type it in.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
    const out = await git(root, ['push', '--porcelain', '-u', remote, `HEAD:refs/heads/${branch}`], { env });
    return { pushed: true, remote, branch, output: out.trim() };
  });
}

// --- the graph ---------------------------------------------------------------------

const FIELD = '\x1f';
const RECORD = '\x1e';

// Commits on every branch, newest first in topological order (children before
// parents), with the files each one touched.
export async function graph(root, { limit = 200, skip = 0, path: filterPath } = {}) {
  if (!(await isRepo(root))) return { repo: false, commits: [] };
  const head = await headCommit(root);
  if (!head) return { repo: true, commits: [], head: null, branch: await currentBranch(root), branches: [] };
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const args = [
    'log', '--all', '--topo-order', `--max-count=${n + 1}`, `--skip=${Math.max(Number(skip) || 0, 0)}`,
    `--format=${RECORD}%H${FIELD}%P${FIELD}%an${FIELD}%aI${FIELD}%D${FIELD}%s${FIELD}%b${FIELD}`,
    '--name-status', '-M',
  ];
  if (filterPath) {
    const abs = await resolveInBook(root, filterPath);
    args.push('--', toRel(root, abs));
  }
  const out = await g(root, args);
  const commits = out.split(RECORD).slice(1).map(parseCommit);
  const more = commits.length > n;
  const branches = (await g(root, ['for-each-ref', '--format=%(refname:short)\x1f%(objectname)', 'refs/heads']))
    .trim().split('\n').filter(Boolean).map((l) => {
      const [name, hash] = l.split(FIELD);
      return { name, hash };
    });
  return { repo: true, head, branch: await currentBranch(root), branches, commits: commits.slice(0, n), more };
}

function parseCommit(record) {
  const [hash, parents, author, date, refs, subject, body, rest = ''] = record.split(FIELD);
  const files = rest.trim().split('\n').filter(Boolean).map((line) => {
    const [st, ...paths] = line.split('\t');
    return { status: st[0], path: paths.at(-1), ...(paths.length > 1 ? { from: paths[0] } : {}) };
  });
  return {
    hash,
    parents: parents ? parents.split(' ') : [],
    author,
    date,
    refs: refs ? refs.split(', ').map((r) => r.replace(/^HEAD -> /, '')).filter((r) => r !== 'HEAD') : [],
    head: /(^|, )HEAD( ->|$|,)/.test(refs),
    subject,
    body: body.trim(),
    auto: subject.startsWith(AUTO_PREFIX),
    files,
  };
}

// --- compare -------------------------------------------------------------------------

// `from` and `to` are commits; `to` may be "worktree" (the files on disk now).
// Without `from`, compares `to` with its first parent.
async function resolveRange(root, from, to) {
  await requireRepo(root);
  const toRev = to === WORKTREE ? WORKTREE : checkRev(to, 'commit');
  if (toRev !== WORKTREE) await verifyCommit(root, toRev);
  let fromRev;
  if (from) {
    fromRev = checkRev(from, 'commit');
    await verifyCommit(root, fromRev);
  } else if (toRev === WORKTREE) {
    fromRev = (await headCommit(root)) || EMPTY_TREE;
  } else {
    const parents = (await g(root, ['rev-list', '--parents', '-n', '1', toRev])).trim().split(' ').slice(1);
    fromRev = parents[0] || EMPTY_TREE;
  }
  return { fromRev, toRev };
}

async function verifyCommit(root, rev) {
  try {
    await g(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  } catch {
    throw notFound(`No such commit: ${rev}`);
  }
}

const diffArgs = (fromRev, toRev) => (toRev === WORKTREE ? [fromRev] : [fromRev, toRev]);

// Files changed between two points, with words added and removed in each.
export async function compare(root, { from, to } = {}) {
  const { fromRev, toRev } = await resolveRange(root, from, to);
  const nameStatus = await g(root, ['diff', '--name-status', '-z', '-M', ...diffArgs(fromRev, toRev)]);
  const files = parseNameStatusZ(nameStatus);
  const words = parseWordDiff(await g(root, ['diff', ...WORD_DIFF, '--unified=0', '-M', ...diffArgs(fromRev, toRev)]));
  for (const f of files) {
    const w = words.get(f.path) || words.get(f.from) || { added: 0, removed: 0 };
    f.added = w.added;
    f.removed = w.removed;
  }
  if (toRev === WORKTREE) {
    // git diff ignores untracked files; they are new files with every word added.
    const untracked = (await g(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    for (const p of untracked) {
      const content = await fs.readFile(path.join(root, p), 'utf8').catch(() => '');
      files.push({ status: 'A', path: p, added: countWords(content), removed: 0, untracked: true });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { from: fromRev === EMPTY_TREE ? null : fromRev, to: toRev, files };
}

function parseNameStatusZ(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (!st) continue;
    if (st[0] === 'R' || st[0] === 'C') {
      files.push({ status: 'R', from: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      files.push({ status: st[0], path: parts[++i] });
    }
  }
  return files;
}

// Splits `git diff --word-diff=porcelain` output by file, counting words in
// the added and removed pieces. Keys are the new path (old path for deletes).
function parseWordDiff(out) {
  const result = new Map();
  for (const file of splitDiffFiles(out)) {
    let added = 0;
    let removed = 0;
    for (const line of file.lines) {
      if (line.startsWith('+')) added += countWords(line.slice(1));
      else if (line.startsWith('-')) removed += countWords(line.slice(1));
    }
    result.set(file.path, { added, removed });
  }
  return result;
}

function splitDiffFiles(out) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { path: null, from: null, lines: [], hunks: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('--- ')) cur.from = stripPrefix(line.slice(4));
      else if (line.startsWith('+++ ')) cur.path = stripPrefix(line.slice(4)) ?? cur.from;
      else if (line.startsWith('rename from ')) cur.from = line.slice(12);
      else if (line.startsWith('rename to ')) cur.path = line.slice(10);
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      cur.hunks.push({ header: line, segments: [] });
      continue;
    }
    if (inHunk) {
      cur.lines.push(line);
      const hunk = cur.hunks.at(-1);
      const type = line[0];
      if (type === '~') hunk.segments.push({ type: 'newline' });
      else if (type === ' ' || type === '+' || type === '-') {
        hunk.segments.push({ type: type === ' ' ? 'same' : type === '+' ? 'added' : 'removed', text: line.slice(1) });
      }
    }
  }
  for (const f of files) f.path ??= f.from;
  return files;
}

function stripPrefix(p) {
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

// One file's word-level diff, as hunks of same/added/removed/newline pieces,
// plus both full versions so the client can show either.
export async function fileDiff(root, { from, to, path: rel, from_path: fromPath } = {}) {
  const { fromRev, toRev } = await resolveRange(root, from, to);
  const filePath = toRel(root, await resolveInBook(root, rel));
  const oldPath = fromPath ? toRel(root, await resolveInBook(root, fromPath)) : filePath;
  if (isImagePath(filePath)) {
    // Images aren't diffed; History shows them side by side.
    const at = async (rev, p) => (rev === WORKTREE
      ? fs.access(path.join(root, p)).then(() => true, () => false)
      : (await fileAt(root, rev, p, { encoding: 'buffer' })) !== null);
    return {
      path: filePath,
      from: fromRev === EMPTY_TREE ? null : fromRev,
      to: toRev,
      image: true,
      fromPath: oldPath,
      hasBefore: await at(fromRev, oldPath),
      hasAfter: await at(toRev, filePath),
      hunks: [],
    };
  }
  const before = await fileAt(root, fromRev, oldPath);
  const after = toRev === WORKTREE ? await readWorktree(root, filePath) : await fileAt(root, toRev, filePath);
  let hunks;
  if (before === null || after === null || toRev === WORKTREE) {
    // Whole-file additions/deletions, and the working copy (which may be
    // untracked), are diffed with --no-index on temporary copies.
    hunks = await diffTexts(root, before ?? '', after ?? '');
  } else {
    const paths = oldPath === filePath ? [filePath] : [oldPath, filePath];
    const out = await g(root, ['diff', ...WORD_DIFF, '--unified=2', '-M', fromRev, toRev, '--', ...paths]);
    hunks = splitDiffFiles(out)[0]?.hunks ?? [];
  }
  return {
    path: filePath,
    from: fromRev === EMPTY_TREE ? null : fromRev,
    to: toRev,
    before,
    after,
    hunks,
  };
}

async function readWorktree(root, rel) {
  try {
    return await fs.readFile(path.join(root, rel), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function fileAt(root, rev, rel, { encoding } = {}) {
  if (rev === EMPTY_TREE) return null;
  try {
    return await g(root, ['show', `${rev}:${rel}`], { encoding });
  } catch {
    return null; // not in that commit
  }
}

// An image's bytes as it was at `rev`, for History.
export async function imageAt(root, { rev, path: rel }) {
  await requireRepo(root);
  checkRev(rev, 'commit');
  await verifyCommit(root, rev);
  const filePath = toRel(root, await resolveInBook(root, rel));
  const bytes = await fileAt(root, rev, filePath, { encoding: 'buffer' });
  if (bytes === null) throw notFound(`${filePath} did not exist in that revision`);
  return bytes;
}

async function diffTexts(root, a, b) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'book-editor-diff-'));
  try {
    await fs.writeFile(path.join(dir, 'a'), a);
    await fs.writeFile(path.join(dir, 'b'), b);
    let out = '';
    try {
      out = await git(dir, ['diff', '--no-index', ...WORD_DIFF, '--unified=2', 'a', 'b']);
    } catch (err) {
      // --no-index exits 1 when the files differ; the diff is on stdout.
      if (err.code === 1 && typeof err.stdout === 'string') out = err.stdout;
      else throw err;
    }
    return splitDiffFiles(out)[0]?.hunks ?? [];
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// --- restore ---------------------------------------------------------------------------

// Writes a file as it was at `rev` into the working copy (not committed; the
// editor's auto-commit picks it up).
export function restoreFile(root, { rev, path: rel }) {
  return serialized(root, async () => {
    await requireRepo(root);
    checkRev(rev, 'commit');
    await verifyCommit(root, rev);
    const abs = await resolveInBook(root, rel);
    const filePath = toRel(root, abs);
    // As bytes, so images come back intact.
    const content = await fileAt(root, rev, filePath, { encoding: 'buffer' });
    if (content === null) throw notFound(`${filePath} did not exist in that revision`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    return { restored: filePath, rev };
  });
}

// Makes the whole book look like `rev`, as a new commit on top of the current
// one, after committing whatever is pending. Nothing in history is lost.
export async function restoreBook(root, { rev }) {
  await requireRepo(root);
  checkRev(rev, 'commit');
  await verifyCommit(root, rev);
  const before = await checkpoint(root, 'before restoring an earlier version');
  return serialized(root, async () => {
    const short = (await g(root, ['rev-parse', '--short', rev])).trim();
    const subject = (await g(root, ['log', '-1', '--format=%s', rev])).trim();
    await g(root, ['restore', `--source=${rev}`, '--staged', '--worktree', '--', ':/']);
    // restore leaves files that are new since `rev` and untracked; remove them
    // too, so the book really matches that version (they stay in history).
    await g(root, ['clean', '-f', '-d', '-q', '--', ':/']);
    if (!(await g(root, ['status', '--porcelain'])).trim()) return { committed: false, checkpoint: before, rev };
    await g(root, ['add', '-A']);
    const name = subject.length > 60 ? `${subject.slice(0, 57)}…` : subject;
    await g(root, ['commit', '-q', '-m', `Restore the book to “${name}” (${short})\n\nEvery file was put back as it was at ${short}: ${subject}`]);
    return { committed: true, commit: (await g(root, ['rev-parse', '--short', 'HEAD'])).trim(), checkpoint: before, rev };
  });
}

// --- drafts (branches) --------------------------------------------------------------------

async function checkBranchName(root, name) {
  if (typeof name !== 'string' || !name.trim()) throw badRequest('Give the draft a name');
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug.startsWith('-')) throw badRequest('That name cannot be used for a draft');
  try {
    return (await g(root, ['check-ref-format', '--branch', slug])).trim();
  } catch {
    throw badRequest(`“${name}” cannot be used as a draft name`);
  }
}

async function branchExists(root, name) {
  try {
    await g(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function createBranch(root, { name, from }) {
  await requireRepo(root);
  const branch = await checkBranchName(root, name);
  if (await branchExists(root, branch)) throw conflict(`A draft named ${branch} already exists`);
  const start = from ? checkRev(from, 'commit') : 'HEAD';
  if (from) await verifyCommit(root, from);
  const saved = await checkpoint(root, `before starting the draft ${branch}`);
  return serialized(root, async () => {
    await g(root, ['switch', '-q', '-c', branch, start]);
    return { branch, checkpoint: saved };
  });
}

export async function switchBranch(root, { branch }) {
  await requireRepo(root);
  if (typeof branch !== 'string' || !(await branchExists(root, branch)) || branch.startsWith('-')) {
    throw notFound(`No draft named ${branch}`);
  }
  const saved = await checkpoint(root, `before switching to the draft ${branch}`);
  return serialized(root, async () => {
    await g(root, ['switch', '-q', branch]);
    return { branch, checkpoint: saved };
  });
}
