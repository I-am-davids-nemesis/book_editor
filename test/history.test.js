import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  commitNamed, compare, createBranch, fileDiff, graph, push, restoreBook, restoreFile, status, switchBranch, WORKTREE,
} from '../server/history.js';
import { gitBook, gitIn, listFiles, tempDir, writeFiles } from './helpers.js';

const head = (root) => gitIn(root, 'rev-parse', 'HEAD').trim();
const subjects = (root) => gitIn(root, 'log', '--format=%s').trim().split('\n');

test('status lists changes, branch and remotes', async () => {
  const root = await gitBook({ 'manuscript/01-a/01-one.md': 'one\n', 'codex/x.md': 'x\n' });
  await writeFiles(root, { 'manuscript/01-a/01-one.md': 'two\n', 'outline/01-a/01-one.md': 'plot\n' });
  await fs.rm(path.join(root, 'codex/x.md'));
  const s = await status(root);
  assert.equal(s.repo, true);
  assert.equal(s.branch, 'main');
  assert.deepEqual(s.remotes, []);
  assert.deepEqual(s.files.map((f) => `${f.status} ${f.path}`).sort(),
    ['A outline/01-a/01-one.md', 'D codex/x.md', 'M manuscript/01-a/01-one.md']);
  assert.deepEqual(await status(await tempDir()), { repo: false });
});

test('commitNamed commits everything with the message, and refuses empty ones', async () => {
  const root = await gitBook({ 'a.md': 'x\n' });
  await assert.rejects(commitNamed(root, 'Nothing here'), /Nothing to commit/);
  await writeFiles(root, { 'a.md': 'y\n', 'b.md': 'new\n' });
  await assert.rejects(commitNamed(root, '  '), /short description/);
  const res = await commitNamed(root, 'Editor pass: softer cadence');
  assert.equal(res.committed, true);
  assert.equal(subjects(root)[0], 'Editor pass: softer cadence');
  assert.equal(gitIn(root, 'status', '--porcelain'), '');
});

test('commitNamed shows git errors verbatim (no identity)', async () => {
  const root = await gitBook({ 'a.md': 'x\n' });
  gitIn(root, 'config', 'user.useConfigOnly', 'true');
  await writeFiles(root, { 'a.md': 'y\n' });
  const saved = { ...process.env };
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k];
  try {
    await assert.rejects(commitNamed(root, 'x'), /git commit:.*(identity|user\.email|name)/is);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('push sends the branch to a local bare remote and sets upstream', async () => {
  const root = await gitBook({ 'a.md': 'x\n' });
  await assert.rejects(push(root), /no remote/);
  const bare = await tempDir();
  gitIn(bare, 'init', '-q', '--bare');
  gitIn(root, 'remote', 'add', 'origin', bare);
  const res = await push(root);
  assert.equal(res.pushed, true);
  assert.equal(gitIn(bare, 'rev-parse', 'main').trim(), head(root));
  await writeFiles(root, { 'a.md': 'y\n' });
  await commitNamed(root, 'More');
  const s = await status(root);
  assert.equal(s.upstream, 'origin/main');
  assert.equal(s.ahead, 1);
});

test('graph returns commits with parents, refs, files and the autosave flag', async () => {
  const root = await gitBook({ 'manuscript/01-a/01-one.md': 'one\n' });
  await writeFiles(root, { 'manuscript/01-a/01-one.md': 'one two\n' });
  gitIn(root, 'commit', '-qam', 'Autosave: Edit 01-one');
  gitIn(root, 'switch', '-qc', 'stormy', 'HEAD~1');
  await writeFiles(root, { 'manuscript/01-a/01-one.md': 'storm\n' });
  gitIn(root, 'commit', '-qam', 'Stormier opening');
  gitIn(root, 'switch', '-q', 'main');
  const g = await graph(root);
  assert.equal(g.branch, 'main');
  assert.deepEqual(g.branches.map((b) => b.name).sort(), ['main', 'stormy']);
  assert.equal(g.commits.length, 3);
  const bySubject = Object.fromEntries(g.commits.map((c) => [c.subject, c]));
  assert.equal(bySubject['Autosave: Edit 01-one'].auto, true);
  assert.equal(bySubject['Autosave: Edit 01-one'].head, true);
  assert.deepEqual(bySubject['Autosave: Edit 01-one'].refs, ['main']);
  assert.deepEqual(bySubject['Stormier opening'].refs, ['stormy']);
  assert.equal(bySubject['Stormier opening'].parents[0], bySubject.init.hash);
  assert.deepEqual(bySubject.init.files, [{ status: 'A', path: 'manuscript/01-a/01-one.md' }]);
  // Paging
  const page = await graph(root, { limit: 2 });
  assert.equal(page.commits.length, 2);
  assert.equal(page.more, true);
  // Filter to a file
  assert.equal((await graph(root, { path: 'manuscript/01-a/01-one.md' })).commits.length, 3);
});

test('compare counts words per file; worktree includes untracked files', async () => {
  const root = await gitBook({ 'manuscript/01-a/01-one.md': 'The bell struck one.\n\nShe waited.\n', 'codex/old.md': 'Old note here.\n' });
  const first = head(root);
  await writeFiles(root, { 'manuscript/01-a/01-one.md': 'The bell struck two.\n\nShe waited by the door.\n' });
  await fs.rename(path.join(root, 'codex/old.md'), path.join(root, 'codex/new.md'));
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-qm', 'Edit');
  const c = await compare(root, { to: head(root) });
  assert.equal(c.from, first);
  const scene = c.files.find((f) => f.path === 'manuscript/01-a/01-one.md');
  // Punctuation is its own token: "one." -> "two." changes one word, and
  // "waited." -> "waited by the door." adds three.
  assert.deepEqual([scene.status, scene.added, scene.removed], ['M', 4, 1]);
  assert.deepEqual(c.files.find((f) => f.path === 'codex/new.md'), { status: 'R', from: 'codex/old.md', path: 'codex/new.md', added: 0, removed: 0 });

  await writeFiles(root, { 'outline/01-a/01-one.md': 'A brand new plot.\n' });
  const w = await compare(root, { to: WORKTREE });
  assert.deepEqual(w.files.map((f) => [f.path, f.status, f.added]), [['outline/01-a/01-one.md', 'A', 4]]);

  // The first commit compares against nothing.
  const firstCmp = await compare(root, { to: first });
  assert.equal(firstCmp.from, null);
  assert.equal(firstCmp.files.length, 2);
  await assert.rejects(compare(root, { to: '--all' }), /Invalid commit/);
  await assert.rejects(compare(root, { to: 'deadbeef' }), /No such commit/);
});

test('fileDiff gives word-level hunks and both versions', async () => {
  const root = await gitBook({ 'a.md': 'The bell struck one.\n' });
  await writeFiles(root, { 'a.md': 'The bell struck two.\n' });
  gitIn(root, 'commit', '-qam', 'two');
  const d = await fileDiff(root, { to: head(root), path: 'a.md' });
  assert.equal(d.before, 'The bell struck one.\n');
  assert.equal(d.after, 'The bell struck two.\n');
  const segs = d.hunks.flatMap((h) => h.segments);
  assert.deepEqual(segs.filter((s) => s.type !== 'same' && s.type !== 'newline').map((s) => `${s.type}:${s.text}`), ['removed:one', 'added:two']);

  await writeFiles(root, { 'new.md': 'Fresh words\n' });
  const u = await fileDiff(root, { to: WORKTREE, path: 'new.md' });
  assert.equal(u.before, null);
  assert.deepEqual(u.hunks.flatMap((h) => h.segments).filter((s) => s.type === 'added').map((s) => s.text), ['Fresh words']);
  await assert.rejects(fileDiff(root, { to: WORKTREE, path: '../x.md' }), /outside the book/);
});

test('restoreFile writes an old version; restoreBook commits a snapshot on top', async () => {
  const root = await gitBook({ 'manuscript/01-a/01-one.md': 'v1\n', 'codex/x.md': 'x1\n' });
  const v1 = head(root);
  await writeFiles(root, { 'manuscript/01-a/01-one.md': 'v2\n', 'codex/added-later.md': 'later\n' });
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-qm', 'v2');

  await restoreFile(root, { rev: v1, path: 'manuscript/01-a/01-one.md' });
  assert.equal(await fs.readFile(path.join(root, 'manuscript/01-a/01-one.md'), 'utf8'), 'v1\n');
  await assert.rejects(restoreFile(root, { rev: v1, path: 'codex/added-later.md' }), /did not exist/);

  await writeFiles(root, { 'codex/x.md': 'x3 unsaved work\n', 'scratch.md': 'untracked\n' });
  const res = await restoreBook(root, { rev: v1 });
  assert.equal(res.committed, true);
  assert.equal(res.checkpoint.committed, true);
  assert.deepEqual(await listFiles(root), ['codex/x.md', 'manuscript/01-a/01-one.md']);
  assert.equal(await fs.readFile(path.join(root, 'codex/x.md'), 'utf8'), 'x1\n');
  assert.match(subjects(root)[0], /^Restore the book to “init” \([0-9a-f]+\)$/);
  assert.match(subjects(root)[1], /^Autosave:/); // the pending work was committed first
  assert.equal(gitIn(root, 'status', '--porcelain'), '');
});

test('drafts: create from a commit and switch, with checkpoints', async () => {
  const root = await gitBook({ 'a.md': 'v1\n' });
  const v1 = head(root);
  await writeFiles(root, { 'a.md': 'v2\n' });
  gitIn(root, 'commit', '-qam', 'v2');
  await writeFiles(root, { 'a.md': 'v3 pending\n' });

  const res = await createBranch(root, { name: 'Stormier Opening!', from: v1 });
  assert.equal(res.branch, 'stormier-opening');
  assert.equal(res.checkpoint.committed, true);
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'v1\n');
  assert.equal((await status(root)).branch, 'stormier-opening');
  await assert.rejects(createBranch(root, { name: 'stormier opening' }), /already exists/);
  await assert.rejects(createBranch(root, { name: '..' }), /cannot be used/);

  await switchBranch(root, { branch: 'main' });
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'v3 pending\n');
  await assert.rejects(switchBranch(root, { branch: '--orphan' }), /No draft/);
});
