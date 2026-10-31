import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AutoCommitter } from './autocommit.js';
import {
  createBook, forgetBook, getBook, getBookRoot, libraryExists, listBooks, registerBook,
} from './books.js';
import { CANDIDATES, discardCandidates, keepCandidate } from './candidates.js';
import { ClaudeService } from './claude.js';
import { addCodexEntry, addVisualStyle, deleteCodexEntry, renameCodexEntry } from './codex.js';
import { compile, DEFAULT_SEPARATOR, readSettings } from './compile.js';
import { configPath, loadConfig } from './config.js';
import { HttpError } from './errors.js';
import { readBookFile, writeBookFile } from './files.js';
import { prepareHandoff } from './handoff.js';
import {
  commitNamed, compare, createBranch, fileDiff, graph, imageAt, push, restoreBook, restoreFile, status, switchBranch,
} from './history.js';
import { providersFrom } from './imagegen/index.js';
import { ImageJobs, MAX_IMAGES, SIZES } from './imagegen/jobs.js';
import { buildImportMap } from './importmap.js';
import { addImage, deleteImage, IMAGE_TYPES, isImagePath, updateImage } from './lookbook.js';
import { resolveInBook } from './paths.js';
import { serialized } from './queue.js';
import { searchBook } from './search.js';
import {
  addChapter, addScene, createMissing, deleteChapter, deleteScene,
  renameChapter, renameScene, reorderChapters, reorderScenes,
} from './structure.js';
import { buildTree } from './tree.js';
import { watchBook } from './watch.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(projectRoot, 'public');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(value) {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

// The server binds to 127.0.0.1, but a web page elsewhere could still try to
// reach it through DNS rebinding or a cross-site form. Refuse any request
// whose Host or Origin isn't local.
function localOnly(req, res, next) {
  const host = hostnameOf(req.headers.host || '');
  if (!LOCAL_HOSTS.has(host)) return res.status(403).json({ error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !LOCAL_HOSTS.has(hostnameOf(origin))) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  next();
}

// Bodies must be JSON. Besides keeping parsing simple, this blocks plain
// cross-site form posts, which can only send form or text content types.
function requireJson(req, res, next) {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (mutating && req.headers['content-type'] && !req.is('application/json')) {
    return res.status(415).json({ error: 'Expected application/json' });
  }
  next();
}

// The Claude routes can edit the book through an agent, so they also need a
// random token that only the editor's own page has (embedded in index.html).
// EventSource can't set headers, so GETs may pass it as ?token=.
function requireToken(token) {
  const expected = Buffer.from(token);
  return (req, res, next) => {
    const given = Buffer.from(String(req.headers['x-editor-token'] || (req.method === 'GET' ? req.query.token : '') || ''));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return res.status(403).json({ error: 'Missing or wrong editor token; reload the page' });
    }
    next();
  };
}

export function createApp({
  autoCommitter = new AutoCommitter(),
  claude = new ClaudeService({ onCommitted: (root) => autoCommitter.committed(root) }),
  token = crypto.randomBytes(24).toString('hex'),
  imageJobs = new ImageJobs(),
  imageProviders = providersFrom,
} = {}) {
  const app = express();
  app.locals.autoCommitter = autoCommitter;
  app.locals.claude = claude;
  app.locals.token = token;
  app.disable('x-powered-by');
  app.use(localOnly);
  app.use(requireJson);
  app.use(express.json({ limit: '20mb' }));

  const { importMap, packages } = buildImportMap(path.join(projectRoot, 'node_modules'));
  const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replace('__IMPORT_MAP__', JSON.stringify(importMap, null, 2))
    .replace('__EDITOR_TOKEN__', token);

  const sendIndex = (req, res) => res.type('html').set('Cache-Control', 'no-store').send(indexHtml);
  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);
  // no-cache: the browser revalidates (cheap ETag check), so edits show up on reload.
  const staticOptions = { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') };
  app.use(express.static(publicDir, staticOptions));
  for (const [name, dir] of packages) app.use(`/vendor/${name}`, express.static(dir, staticOptions));

  const api = express.Router();

  // Each request reloads the config, so edits to the file take effect at once.
  api.use(async (req, res, next) => {
    req.config = await loadConfig();
    next();
  });

  async function bookRoot(req) {
    return getBookRoot(req.config, req.params.id);
  }

  api.get('/config', (req, res) => {
    res.json({ libraryRoot: req.config.libraryRoot, configPath: configPath() });
  });

  api.get('/books', async (req, res) => {
    res.json({
      libraryRoot: req.config.libraryRoot,
      libraryExists: await libraryExists(req.config),
      books: await listBooks(req.config),
    });
  });

  api.post('/books', async (req, res) => {
    res.status(201).json(await createBook(req.config, req.body || {}));
  });

  api.post('/books/register', async (req, res) => {
    const id = await registerBook(req.config, req.body?.path);
    res.json(await getBook(req.config, id));
  });

  api.get('/books/:id', async (req, res) => {
    res.json(await getBook(req.config, req.params.id));
  });

  api.delete('/books/:id', async (req, res) => {
    await forgetBook(req.config, req.params.id);
    res.json({ ok: true });
  });

  api.get('/books/:id/tree', async (req, res) => {
    res.json(await buildTree(await bookRoot(req)));
  });

  api.get('/books/:id/file', async (req, res) => {
    res.json(await readBookFile(await bookRoot(req), req.query.path));
  });

  api.put('/books/:id/file', async (req, res) => {
    const { path: rel, content, baseHash, force } = req.body || {};
    const root = await bookRoot(req);
    const result = await writeBookFile(root, rel, content, { baseHash, force: force === true });
    autoCommitter.changed(root);
    res.json(result);
  });

  // Images in the book, for <img> tags. SVG isn't served: it can carry script.
  api.get('/books/:id/image', async (req, res) => {
    const rel = req.query.path;
    if (typeof rel !== 'string' || !isImagePath(rel)) throw new HttpError(400, 'Not an image path');
    const root = await bookRoot(req);
    const abs = await resolveInBook(root, rel);
    res.set({ 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.type(IMAGE_TYPES[path.extname(abs).slice(1).toLowerCase()]);
    // ?rev=<commit>: the image as it was then (History).
    if (req.query.rev) return res.send(await imageAt(root, { rev: req.query.rev, path: rel }));
    // Candidates live in a dot folder; nothing else hidden is served.
    res.sendFile(abs, { dotfiles: rel.startsWith(`${CANDIDATES}/`) ? 'allow' : 'deny' }, (err) => {
      if (err && !res.headersSent) res.status([403, 404].includes(err.status) || err.code === 'ENOENT' ? 404 : 500).json({ error: `No such image: ${rel}` });
    });
  });

  api.get('/books/:id/search', async (req, res) => {
    const { q, case: caseSensitive, word, scope } = req.query;
    res.json(await searchBook(await bookRoot(req), {
      query: q, caseSensitive: caseSensitive === '1', wholeWord: word === '1', scope: scope || 'all',
    }));
  });

  // Commits all changes in the book now, if there are any (the editor calls
  // this when you switch files or leave the book).
  api.post('/books/:id/checkpoint', async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : '';
    res.json(await autoCommitter.commit(await bookRoot(req), reason));
  });

  // Live changes to the book's files, as server-sent events. Each event is a
  // batch: { files: [{path, hash, exists}], tree, git }.
  api.get('/books/:id/events', async (req, res) => {
    const root = await bookRoot(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const send = (batch) => res.write(`data: ${JSON.stringify(batch)}\n\n`);
    const unwatch = watchBook(root, send);
    // A comment now and then keeps proxies and sleeping laptops from dropping it.
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      unwatch();
    });
  });

  // --- compile ---
  api.get('/books/:id/compile', async (req, res) => {
    const settings = await readSettings(await bookRoot(req));
    res.json({ separator: settings.compile?.sceneSeparator || DEFAULT_SEPARATOR, defaultSeparator: DEFAULT_SEPARATOR });
  });

  api.post('/books/:id/compile', async (req, res) => {
    const root = await bookRoot(req);
    const { scope, chapter, mode, separator, remember } = req.body || {};
    const result = await compile(root, { scope, chapter, mode: mode ?? '', separator, remember: remember === true });
    if (remember) autoCommitter.changed(root); // book.json changed
    res.json(result);
  });

  // --- git ---
  api.get('/books/:id/git/status', async (req, res) => {
    res.json(await status(await bookRoot(req)));
  });

  api.post('/books/:id/git/commit', async (req, res) => {
    const root = await bookRoot(req);
    const result = await commitNamed(root, req.body?.message);
    autoCommitter.committed(root);
    res.json(result);
  });

  api.post('/books/:id/git/push', async (req, res) => {
    res.json(await push(await bookRoot(req)));
  });

  api.get('/books/:id/git/compare', async (req, res) => {
    res.json(await compare(await bookRoot(req), { from: req.query.from, to: req.query.to }));
  });

  api.get('/books/:id/git/graph', async (req, res) => {
    const { limit, skip, path: filterPath } = req.query;
    res.json(await graph(await bookRoot(req), { limit, skip, path: filterPath || undefined }));
  });

  api.get('/books/:id/git/file-diff', async (req, res) => {
    const { from, to, path: rel, from_path: fromPath } = req.query;
    res.json(await fileDiff(await bookRoot(req), { from, to, path: rel, from_path: fromPath || undefined }));
  });

  api.post('/books/:id/git/restore-file', async (req, res) => {
    const root = await bookRoot(req);
    const result = await restoreFile(root, { rev: req.body?.rev, path: req.body?.path });
    autoCommitter.changed(root);
    res.json(result);
  });

  // Drafts are branches. Both routes commit pending work before moving.
  api.post('/books/:id/git/branch', async (req, res) => {
    const root = await bookRoot(req);
    const result = await createBranch(root, { name: req.body?.name, from: req.body?.from || undefined });
    autoCommitter.committed(root);
    res.json(result);
  });

  api.post('/books/:id/git/switch', async (req, res) => {
    const root = await bookRoot(req);
    const result = await switchBranch(root, { branch: req.body?.branch });
    autoCommitter.committed(root);
    res.json(result);
  });

  api.post('/books/:id/git/restore-book', async (req, res) => {
    const root = await bookRoot(req);
    const result = await restoreBook(root, { rev: req.body?.rev });
    autoCommitter.committed(root);
    res.json(result);
  });

  // Runs a structure operation for the book in the route, one at a time.
  function structureRoute(op) {
    return async (req, res) => {
      const root = await bookRoot(req);
      const result = await serialized(root, () => op(root, req));
      autoCommitter.changed(root);
      res.json(result);
    };
  }

  api.post('/books/:id/chapters', structureRoute((root, req) => addChapter(root, req.body)));
  api.patch('/books/:id/chapters/:chapter', structureRoute((root, req) => renameChapter(root, req.params.chapter, req.body)));
  api.delete('/books/:id/chapters/:chapter', structureRoute((root, req) => deleteChapter(root, req.params.chapter)));
  api.post('/books/:id/chapters/:chapter/scenes', structureRoute((root, req) => addScene(root, req.params.chapter, req.body)));
  api.patch('/books/:id/chapters/:chapter/scenes/:scene',
    structureRoute((root, req) => renameScene(root, req.params.chapter, req.params.scene, req.body)));
  api.delete('/books/:id/chapters/:chapter/scenes/:scene',
    structureRoute((root, req) => deleteScene(root, req.params.chapter, req.params.scene)));
  api.post('/books/:id/reorder', structureRoute((root, req) => (req.body?.chapter
    ? reorderScenes(root, req.body.chapter, req.body)
    : reorderChapters(root, req.body))));
  api.post('/books/:id/create-missing', structureRoute((root, req) => createMissing(root, req.body?.path)));

  api.post('/books/:id/lookbook', structureRoute((root, req) => addImage(root, req.body)));
  api.patch('/books/:id/lookbook', structureRoute((root, req) => updateImage(root, req.body?.path, req.body)));
  api.delete('/books/:id/lookbook', structureRoute((root, req) => deleteImage(root, req.query.path)));

  api.post('/books/:id/codex', structureRoute((root, req) => addCodexEntry(root, req.body)));
  api.patch('/books/:id/codex', structureRoute((root, req) => renameCodexEntry(root, req.body?.path, req.body)));
  api.delete('/books/:id/codex', structureRoute((root, req) => deleteCodexEntry(root, req.query.path)));
  api.post('/books/:id/visual-style', structureRoute((root) => addVisualStyle(root)));

  // Copies reference images to a numbered folder and opens it in Finder. It
  // starts a program, so it needs the page's token like the Claude routes.
  api.post('/books/:id/handoff', requireToken(token), async (req, res) => {
    res.json(await prepareHandoff(await bookRoot(req), req.body ?? {}));
  });

  // --- generating images ---
  // These talk to a program on this machine and write files, so they need the
  // page's token too.
  const providerOf = (req, id) => {
    const provider = imageProviders(req.config).find((p) => p.id === id);
    if (!provider) throw new HttpError(400, `No such image generator: ${id}`);
    return provider;
  };

  api.get('/imagegen/providers', requireToken(token), async (req, res) => {
    const providers = await Promise.all(imageProviders(req.config).map(async (p) => ({
      id: p.id, label: p.label, limits: p.limits, canStart: Boolean(p.canStart), canFree: Boolean(p.free), ...(await p.check()),
    })));
    res.json({ providers, sizes: SIZES, maxImages: MAX_IMAGES });
  });

  // Opens the generator's app (ComfyUI) and waits for it.
  api.post('/imagegen/providers/:provider/start', requireToken(token), async (req, res) => {
    const provider = providerOf(req, req.params.provider);
    if (!provider.start) throw new HttpError(400, `${provider.label} can’t be started from here`);
    res.json({ id: provider.id, label: provider.label, limits: provider.limits, canStart: true, canFree: Boolean(provider.free), ...(await provider.start()) });
  });

  // Unloads the generator's model now, to free memory.
  api.post('/imagegen/providers/:provider/free', requireToken(token), async (req, res) => {
    const provider = providerOf(req, req.params.provider);
    res.json({ freed: provider.free ? await provider.free() : false });
  });

  const jobRoutes = express.Router({ mergeParams: true });
  jobRoutes.use(requireToken(token));

  jobRoutes.get('/', async (req, res) => {
    res.json(imageJobs.list(await bookRoot(req)));
  });

  jobRoutes.post('/', async (req, res) => {
    const job = await imageJobs.start(await bookRoot(req), providerOf(req, req.body?.provider), req.body ?? {});
    res.status(201).json(job.summary);
  });

  jobRoutes.get('/:job/events', async (req, res) => {
    const job = imageJobs.get(req.params.job, await bookRoot(req));
    const after = Number(req.headers['last-event-id'] ?? req.query.after ?? -1);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const unsubscribe = job.subscribe((e) => {
      if (e) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      else res.write('event: end\ndata: {}\n\n');
    }, Number.isFinite(after) ? after : -1);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  jobRoutes.post('/:job/cancel', async (req, res) => {
    imageJobs.get(req.params.job, await bookRoot(req)).cancel();
    res.json({ ok: true });
  });

  api.use('/books/:id/imagegen/jobs', jobRoutes);

  api.post('/books/:id/candidates/keep', structureRoute((root, req) => keepCandidate(root, req.body?.path, req.body ?? {})));
  api.delete('/books/:id/candidates', structureRoute((root, req) => discardCandidates(root, { path: req.query.path, job: req.query.job })));

  // --- Claude ---
  const claudeRoutes = express.Router({ mergeParams: true });
  claudeRoutes.use(requireToken(token));

  claudeRoutes.get('/session', async (req, res) => {
    res.json(await claude.session(await bookRoot(req)));
  });

  // A one-off, read-only question; the answer comes back in the response.
  claudeRoutes.post('/ask', async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    res.json({ text: await claude.ask(await bookRoot(req), req.body?.prompt, { signal: abort.signal }) });
  });

  claudeRoutes.delete('/session', async (req, res) => {
    res.json(await claude.clear(await bookRoot(req)));
  });

  claudeRoutes.put('/settings', async (req, res) => {
    res.json(await claude.setSettings(await bookRoot(req), { extraTools: req.body?.extraTools }));
  });

  claudeRoutes.post('/runs', async (req, res) => {
    const { prompt, context, newSession, images } = req.body || {};
    const imageModel = typeof req.config.claude?.imageModel === 'string' && req.config.claude.imageModel ? req.config.claude.imageModel : undefined;
    res.status(201).json(await claude.start(await bookRoot(req), { prompt, context, newSession, images: images === true, imageModel }));
  });

  // The run's events from the start (or after Last-Event-ID), then live.
  // An `end` event says the run is over.
  claudeRoutes.get('/runs/:run/events', async (req, res) => {
    const run = claude.run(req.params.run, await bookRoot(req));
    const after = Number(req.headers['last-event-id'] ?? req.query.after ?? -1);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const unsubscribe = run.subscribe((e) => {
      if (e) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      else res.write('event: end\ndata: {}\n\n');
    }, Number.isFinite(after) ? after : -1);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  claudeRoutes.post('/runs/:run/permission', async (req, res) => {
    const run = claude.run(req.params.run, await bookRoot(req));
    run.answer(req.body?.requestId, req.body?.allow === true);
    res.json({ ok: true });
  });

  claudeRoutes.post('/runs/:run/stop', async (req, res) => {
    claude.run(req.params.run, await bookRoot(req)).stop();
    res.json({ ok: true });
  });

  api.use('/books/:id/claude', claudeRoutes);

  api.use((req, res) => res.status(404).json({ error: `No such API route: ${req.method} ${req.path}` }));

  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File too large' });
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal error' });
  });

  return app;
}
