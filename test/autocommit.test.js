import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { AutoCommitter, checkpoint } from '../server/autocommit.js';
import { gitBook, gitIn, tempDir, writeFiles } from './helpers.js';

const log = (root) => gitIn(root, 'log', '--format=%s').trim().split('\n');

test('checkpoint commits every change and describes it', async () => {
  const root = await gitBook({ 'manuscript/01-a/01-one.md': 'one\n', 'codex/old.md': 'x\n' });
  await writeFiles(root, { 'manuscript/01-a/01-one.md': 'one two\n', 'outline/01-a/01-one.md': 'plot\n' });
  await fs.rename(path.join(root, 'codex/old.md'), path.join(root, 'codex/new.md'));

  const res = await checkpoint(root, 'switched files');
  assert.equal(res.committed, true);
  assert.match(res.commit, /^[0-9a-f]{7,}$/);
  assert.deepEqual(res.files.sort(), ['codex/new.md', 'manuscript/01-a/01-one.md', 'outline/01-a/01-one.md']);
  assert.equal(log(root)[0], 'Autosave: Edit 3 files');
  const body = gitIn(root, 'log', '-1', '--format=%b');
  assert.match(body, /^R codex\/old\.md -> codex\/new\.md$/m);
  assert.match(body, /^A outline\/01-a\/01-one\.md$/m);
  assert.match(body, /switched files/);
  assert.equal(gitIn(root, 'status', '--porcelain'), '');
});

test('checkpoint names a single file, and does nothing when clean', async () => {
  const root = await gitBook({ 'manuscript/01-a/01-one.md': 'one\n' });
  assert.deepEqual(await checkpoint(root), { committed: false });
  await writeFiles(root, { 'manuscript/01-a/01-one.md': 'changed\n' });
  await checkpoint(root);
  assert.deepEqual(log(root), ['Autosave: Edit 01-one', 'init']);
});

test('checkpoint skips folders that are not repositories', async () => {
  const root = await tempDir();
  await writeFiles(root, { 'a.md': 'x' });
  assert.equal((await checkpoint(root)).committed, false);
});

test('checkpoint reports git failures (no identity)', async () => {
  const root = await gitBook({ 'a.md': 'x\n' });
  gitIn(root, 'config', 'user.useConfigOnly', 'true');
  await writeFiles(root, { 'a.md': 'y\n' });
  const saved = { ...process.env };
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k];
  try {
    await assert.rejects(checkpoint(root), /git commit/);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('AutoCommitter commits once the interval passes after the first change', async () => {
  const root = await gitBook({ 'a.md': 'x\n' });
  const committer = new AutoCommitter({ intervalMs: 80 });
  await writeFiles(root, { 'a.md': 'y\n' });
  committer.changed(root);
  await new Promise((r) => setTimeout(r, 40));
  await writeFiles(root, { 'a.md': 'z\n' });
  committer.changed(root); // does not restart the clock
  await new Promise((r) => setTimeout(r, 70));
  await checkpoint(root); // waits for the timer's commit in the queue
  assert.deepEqual(log(root), ['Autosave: Edit a', 'init']);
  assert.match(gitIn(root, 'log', '-1', '--format=%b'), /since the last change/);
  assert.equal(committer.timers.size, 0);
});

test('AutoCommitter.commit stops the clock, and flush commits pending books', async () => {
  const one = await gitBook({ 'a.md': 'x\n' });
  const two = await gitBook({ 'b.md': 'x\n' });
  const committer = new AutoCommitter({ intervalMs: 60_000 });
  await writeFiles(one, { 'a.md': 'y\n' });
  await writeFiles(two, { 'b.md': 'y\n' });
  committer.changed(one);
  committer.changed(two);
  await committer.commit(one, 'switched files');
  assert.deepEqual([...committer.timers.keys()], [two]);
  await committer.flush();
  assert.equal(committer.timers.size, 0);
  assert.equal(log(two)[0], 'Autosave: Edit b');
});
