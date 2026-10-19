import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { saveConfig } from '../server/config.js';
import { gitIn, SAMPLE_BOOK, tempDir, writeFiles } from './helpers.js';

let server;
let base;
let library;

before(async () => {
  const configDir = await tempDir();
  process.env.BOOK_EDITOR_CONFIG = path.join(configDir, 'config.json');
  library = await tempDir();
  await saveConfig({ libraryRoot: library, registered: {} });
  await writeFiles(path.join(library, 'sample'), SAMPLE_BOOK);
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.headers['Content-Type'] ??= 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, data, headers: res.headers };
}

test('index page embeds an import map that resolves to served files', async () => {
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  const json = /<script type="importmap">([\s\S]*?)<\/script>/.exec(res.data)[1];
  const { imports } = JSON.parse(json);
  for (const name of ['@codemirror/view', '@codemirror/lang-markdown', '@lezer/highlight', 'marked']) {
    assert.ok(imports[name], `${name} is mapped`);
    const file = await fetch(base + imports[name]);
    assert.equal(file.status, 200, `${imports[name]} is served`);
    assert.match(file.headers.get('content-type'), /javascript/);
  }
  assert.equal((await fetch(`${base}/vendor/express/package.json`)).status, 404, 'server-only packages are not exposed');
});

test('library listing and tree', async () => {
  const books = await call('GET', '/api/books');
  assert.deepEqual(books.data.books.map((b) => b.id), ['sample']);
  assert.equal(books.data.books[0].title, 'The Sample Book');

  const tree = await call('GET', '/api/books/sample/tree');
  assert.equal(tree.status, 200);
  assert.equal(tree.data.chapters.length, 3);

  assert.equal((await call('GET', '/api/books/nope/tree')).status, 404);
});

test('file read, save, and conflict over HTTP', async () => {
  const p = 'manuscript/01-the-washing-house/01-opening.md';
  const read = await call('GET', `/api/books/sample/file?path=${encodeURIComponent(p)}`);
  assert.equal(read.data.content, 'The bell struck one.\n');

  const saved = await call('PUT', '/api/books/sample/file', { path: p, content: 'Edited.\n', baseHash: read.data.hash });
  assert.equal(saved.status, 200);

  const stale = await call('PUT', '/api/books/sample/file', { path: p, content: 'Again.\n', baseHash: read.data.hash });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.diskContent, 'Edited.\n');

  assert.equal(await fs.readFile(path.join(library, 'sample', p), 'utf8'), 'Edited.\n');

  const escape = await call('GET', `/api/books/sample/file?path=${encodeURIComponent('../../etc/passwd.md')}`);
  assert.equal(escape.status, 400);
});

// fetch() won't send a custom Host header, so use node:http for that case.
function statusWithHost(host) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: '127.0.0.1', port, path: '/api/books', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

test('requests from non-local hosts or origins are refused', async () => {
  assert.equal(await statusWithHost('evil.example'), 403);
  assert.equal(await statusWithHost('evil.example:4321'), 403);
  assert.equal(await statusWithHost('localhost:4321'), 200);
  assert.equal((await call('PUT', '/api/books/sample/file', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('GET', '/api/books', undefined, { Origin: 'http://localhost:4321' })).status, 200);
});

test('non-JSON bodies are refused', async () => {
  const res = await call('PUT', '/api/books/sample/file', 'path=a.md&content=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(res.status, 415);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('create a book and change its structure over HTTP', async () => {
  const created = await call('POST', '/api/books', { title: 'Over HTTP' });
  assert.equal(created.status, 201);
  const id = created.data.id;

  const ch = await call('POST', `/api/books/${id}/chapters`, { title: 'First' });
  assert.equal(ch.data.chapter, '01-first');
  const sc = await call('POST', `/api/books/${id}/chapters/01-first/scenes`, { title: 'Opening' });
  assert.equal(sc.data.scene, '01-opening.md');
  await call('POST', `/api/books/${id}/chapters/01-first/scenes`, { title: 'Second', position: 1 });

  let tree = (await call('GET', `/api/books/${id}/tree`)).data;
  assert.deepEqual(tree.chapters[0].scenes.map((s) => s.name), ['01-second.md', '02-opening.md']);

  const re = await call('POST', `/api/books/${id}/reorder`, { chapter: '01-first', order: ['02-opening.md', '01-second.md'] });
  assert.equal(re.status, 200);
  const ren = await call('PATCH', `/api/books/${id}/chapters/01-first/scenes/02-second.md`, { title: 'Later' });
  assert.equal(ren.data.scene, '02-later.md');
  const del = await call('DELETE', `/api/books/${id}/chapters/01-first/scenes/01-opening.md`);
  assert.ok(del.data.deleted.includes('manuscript/01-first/01-opening.md'));

  tree = (await call('GET', `/api/books/${id}/tree`)).data;
  assert.deepEqual(tree.chapters[0].scenes.map((s) => s.name), ['01-later.md']);

  const cx = await call('POST', `/api/books/${id}/codex`, { kind: 'character', name: 'Tor' });
  assert.equal(cx.data.path, 'codex/characters/tor.md');
  assert.equal((await call('POST', `/api/books/${id}/codex`, { kind: 'character', name: 'Tor' })).status, 409);
  assert.equal((await call('DELETE', `/api/books/${id}/codex?path=${encodeURIComponent('codex/characters/tor.md')}`)).status, 200);

  assert.equal((await call('DELETE', `/api/books/${id}/chapters/${encodeURIComponent('../01-first')}`)).status, 404);
});

test('checkpoint commits the book over HTTP', async () => {
  const created = await call('POST', '/api/books', { title: 'Checkpointed' });
  const id = created.data.id;
  const root = path.join(library, id);
  await call('POST', `/api/books/${id}/chapters`, { title: 'First' });
  const res = await call('POST', `/api/books/${id}/checkpoint`, { reason: 'switched files' });
  assert.equal(res.status, 200);
  assert.equal(res.data.committed, true);
  assert.ok(res.data.files.includes('outline/01-first/_chapter.md'));
  assert.equal(gitIn(root, 'status', '--porcelain'), '');
  assert.deepEqual((await call('POST', `/api/books/${id}/checkpoint`, {})).data, { committed: false });
});

test('concurrent structure changes are applied one at a time', async () => {
  const id = (await call('POST', '/api/books', { title: 'Busy' })).data.id;
  await call('POST', `/api/books/${id}/chapters`, { title: 'Only' });
  const results = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((t) =>
    call('POST', `/api/books/${id}/chapters/01-only/scenes`, { title: t, position: 1 })));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.data)));
  const tree = (await call('GET', `/api/books/${id}/tree`)).data;
  assert.deepEqual(tree.chapters[0].scenes.map((s) => s.prefix), [1, 2, 3, 4, 5]);
});

test('git status, named commit and compare over HTTP', async () => {
  const created = await call('POST', '/api/books', { title: 'Revisions' });
  const id = created.data.id;
  const root = path.join(library, id);
  await call('POST', `/api/books/${id}/chapters`, { title: 'First' });
  const st = await call('GET', `/api/books/${id}/git/status`);
  assert.equal(st.data.branch, 'main');
  assert.ok(st.data.files.some((f) => f.path === 'outline/01-first/_chapter.md'));
  const cmp = await call('GET', `/api/books/${id}/git/compare?to=worktree`);
  assert.ok(cmp.data.files.some((f) => f.path === 'outline/01-first/_chapter.md' && f.status === 'A'));
  assert.equal((await call('POST', `/api/books/${id}/git/commit`, { message: '' })).status, 400);
  const c = await call('POST', `/api/books/${id}/git/commit`, { message: 'First chapter' });
  assert.equal(c.status, 200);
  assert.equal(gitIn(root, 'log', '-1', '--format=%s').trim(), 'First chapter');
  assert.equal((await call('POST', `/api/books/${id}/git/commit`, { message: 'Again' })).status, 409);
  assert.equal((await call('POST', `/api/books/${id}/git/push`)).status, 409);
  assert.equal((await call('GET', `/api/books/${id}/git/compare?to=${encodeURIComponent('--all')}`)).status, 400);
});

test('drafts: branch and switch over HTTP', async () => {
  const id = (await call('POST', '/api/books', { title: 'Drafted' })).data.id;
  const root = path.join(library, id);
  const first = gitIn(root, 'rev-parse', 'HEAD').trim();
  await call('POST', `/api/books/${id}/chapters`, { title: 'First' });
  const b = await call('POST', `/api/books/${id}/git/branch`, { name: 'Stormy opening', from: first });
  assert.equal(b.status, 200);
  assert.equal(b.data.branch, 'stormy-opening');
  assert.equal(b.data.checkpoint.committed, true);
  assert.equal((await call('GET', `/api/books/${id}/git/status`)).data.branch, 'stormy-opening');
  assert.equal((await call('POST', `/api/books/${id}/git/branch`, { name: 'stormy opening' })).status, 409);
  assert.equal((await call('POST', `/api/books/${id}/git/switch`, { branch: 'nope' })).status, 404);
  assert.equal((await call('POST', `/api/books/${id}/git/switch`, { branch: 'main' })).status, 200);
  assert.deepEqual((await call('GET', `/api/books/${id}/git/status`)).data.branches.sort(), ['main', 'stormy-opening']);
});

test('events stream reports file changes', async () => {
  const id = (await call('POST', '/api/books', { title: 'Watched' })).data.id;
  const root = path.join(library, id);
  const { port } = server.address();
  const got = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/books/${id}/events`, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        for (const m of buf.matchAll(/^data: (.*)$/gm)) {
          const batch = JSON.parse(m[1]);
          if (batch.files.some((f) => f.path === 'manuscript/hello.md')) {
            req.destroy();
            resolve(batch);
          }
        }
      });
      setTimeout(() => fs.writeFile(path.join(root, 'manuscript/hello.md'), 'Hello.\n').catch(reject), 300);
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
    setTimeout(() => reject(new Error('no event')), 5000);
  });
  assert.equal(got.files.find((f) => f.path === 'manuscript/hello.md').exists, true);
});

