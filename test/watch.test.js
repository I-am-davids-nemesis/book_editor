import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { hashContent } from '../server/files.js';
import { serialized } from '../server/queue.js';
import { BookWatcher } from '../server/watch.js';
import { gitBook, gitIn, writeFiles } from './helpers.js';

// Collects batches until `done(batches)` is true, or fails after `ms`.
function collect(w, done, ms = 4000) {
  const batches = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timed out; got ${JSON.stringify(batches)}`)); }, ms);
    const off = w.subscribe((b) => {
      batches.push(b);
      if (done(batches)) {
        clearTimeout(timer);
        off();
        resolve(batches);
      }
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 300));
const allFiles = (batches) => batches.flatMap((b) => b.files);

test('reports edited files with their hash, and ignores temp files', async () => {
  const root = await gitBook({ 'manuscript/01-a/01-one.md': 'one\n' });
  const w = new BookWatcher(root, { debounceMs: 50 });
  const got = collect(w, (bs) => allFiles(bs).some((f) => f.path === 'manuscript/01-a/01-one.md' && f.hash === hashContent('two\n')));
  await settle();
  await fs.writeFile(path.join(root, 'manuscript/01-a/.01-one.md.123.456.tmp'), 'temp');
  await fs.writeFile(path.join(root, 'manuscript/01-a/01-one.md'), 'two\n');
  const batches = await got;
  assert.ok(!allFiles(batches).some((f) => f.path.endsWith('.tmp')));
  w.stop();
});

test('new and deleted files and folders mark the tree as changed', async () => {
  const root = await gitBook({ 'manuscript/01-a/01-one.md': 'one\n' });
  const w = new BookWatcher(root, { debounceMs: 50 });
  const added = collect(w, (bs) => bs.some((b) => b.tree) && allFiles(bs).some((f) => f.path === 'manuscript/02-b/01-new.md' && f.exists));
  await settle();
  await writeFiles(root, { 'manuscript/02-b/01-new.md': 'new\n' });
  await added;
  const removed = collect(w, (bs) => bs.some((b) => b.tree) && allFiles(bs).some((f) => f.path === 'manuscript/01-a/01-one.md' && !f.exists && f.hash === null));
  await fs.rm(path.join(root, 'manuscript/01-a/01-one.md'));
  await removed;
  w.stop();
});

test('commits and branch switches are reported as git changes; other .git noise is not', async () => {
  const root = await gitBook({ 'a.md': 'x\n' });
  const w = new BookWatcher(root, { debounceMs: 50 });
  const got = collect(w, (bs) => bs.some((b) => b.git));
  await settle();
  gitIn(root, 'switch', '-qc', 'draft');
  const batches = await got;
  assert.ok(batches.every((b) => b.files.every((f) => !f.path.startsWith('.git/'))));
  w.stop();
});

test('waits for a running structure change before reporting', async () => {
  const root = await gitBook({ 'a.md': 'x\n' });
  const w = new BookWatcher(root, { debounceMs: 30 });
  let released;
  const job = serialized(root, () => new Promise((r) => { released = r; }));
  const order = [];
  const got = collect(w, (bs) => allFiles(bs).some((f) => f.path === 'b.md')).then(() => order.push('event'));
  await settle();
  await writeFiles(root, { 'b.md': 'y\n' });
  await new Promise((r) => setTimeout(r, 400));
  order.push('released');
  released();
  await job;
  await got;
  assert.deepEqual(order, ['released', 'event']);
  w.stop();
});
