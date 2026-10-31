import path from 'node:path';
import { excludeCandidates, newJobId, pruneCandidates, writeCandidate } from '../candidates.js';
import { badRequest, notFound } from '../errors.js';
import { commitsOf, isImagePath, LOOKBOOK, requireExists } from '../lookbook.js';
import { resolveInBook } from '../paths.js';
import { Limiter } from './limits.js';

// Image jobs: each makes n candidates for one prompt with one provider. Jobs
// for a provider run one at a time, in order (a Mac has one GPU). Events are
// kept, like a Claude run's, so a reloaded page can pick a job up again:
//   queued { position }   start   progress { index, n, fraction }
//   image { path, index }   error { message }   done { images, cancelled }
// Jobs live in memory: a server restart forgets them, but their images stay.

export const SIZES = {
  square: { width: 1024, height: 1024, label: 'Square' },
  portrait: { width: 832, height: 1216, label: 'Portrait' },
  landscape: { width: 1216, height: 832, label: 'Landscape' },
  wide: { width: 1344, height: 768, label: 'Wide' },
};
export const MAX_IMAGES = 4;
const MAX_PROMPT = 20000;
const FORGET_AFTER_MS = 60 * 60 * 1000;

class Job {
  constructor({ id, root, provider, model, n }) {
    this.id = id;
    this.root = root;
    this.provider = provider;
    this.model = model;
    this.n = n;
    this.status = 'queued';
    this.events = [];
    this.listeners = new Set();
    this.abort = new AbortController();
    this.images = [];
    this.finished = false;
  }

  emit(event) {
    const e = { seq: this.events.length, ...event };
    this.events.push(e);
    for (const fn of this.listeners) fn(e);
  }

  subscribe(send, after = -1) {
    for (const e of this.events) if (e.seq > after) send(e);
    if (this.finished) {
      send(null);
      return () => {};
    }
    this.listeners.add(send);
    return () => this.listeners.delete(send);
  }

  finish() {
    this.finished = true;
    for (const fn of this.listeners) fn(null);
    this.listeners.clear();
  }

  cancel() {
    if (!this.finished) this.abort.abort(new Error('Cancelled'));
  }

  get summary() {
    return { id: this.id, provider: this.provider.id, model: this.model, n: this.n, status: this.status, images: this.images };
  }
}

async function checkRefs(root, refs) {
  if (!Array.isArray(refs) || refs.some((p) => typeof p !== 'string')) throw badRequest('`refs` must list lookbook images');
  if (refs.length > 16) throw badRequest('At most 16 reference images');
  for (const rel of refs) {
    if (!rel.startsWith(`${LOOKBOOK}/`) || rel.split('/').some((p) => p === '..' || p.startsWith('.')) || !isImagePath(rel)) {
      throw badRequest(`References must be lookbook images, not ${rel}`);
    }
    await requireExists(root, rel);
  }
  return Promise.all(refs.map((rel) => resolveInBook(root, rel)));
}

// The codex entries a shot shows, for the candidates' `of:`.
function entriesOf(shot) {
  const paths = [...(Array.isArray(shot?.characters) ? shot.characters.map((c) => c?.path) : []), shot?.location];
  return [...new Set(paths.filter((p) => typeof p === 'string' && p.startsWith('codex/') && !p.split('/').includes('..')))];
}

export class ImageJobs {
  constructor({ store, now = () => new Date() } = {}) {
    this.jobs = new Map();
    this.queues = new Map(); // provider id → tail promise
    this.waiting = new Map(); // provider id → [job]
    this.running = new Map(); // provider id → job
    this.idle = new Map(); // provider id → timer that frees its memory
    this.limiters = new Map();
    this.store = store;
    this.now = now;
  }

  limiter(provider) {
    const key = JSON.stringify([provider.id, provider.limits]);
    if (!this.limiters.has(key)) this.limiters.set(key, new Limiter(provider.id, provider.limits, this.store ? { store: this.store } : {}));
    return this.limiters.get(key);
  }

  // Validates the request and queues the job.
  //   { prompt, negative, refs: [lookbook paths], model, n, size, seed, shot }
  async start(root, provider, { prompt, negative = '', refs = [], model, n = 1, size = 'square', seed, shot = null } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw badRequest('The prompt is empty');
    if (prompt.length > MAX_PROMPT) throw badRequest(`The prompt is longer than ${MAX_PROMPT} characters`);
    if (typeof negative !== 'string') throw badRequest('`negative` must be text');
    if (typeof model !== 'string' || !model) throw badRequest('Choose a model');
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES) throw badRequest(`Make between 1 and ${MAX_IMAGES} images`);
    if (!Object.hasOwn(SIZES, size)) throw badRequest(`\`size\` must be one of: ${Object.keys(SIZES).join(', ')}`);
    if (seed !== undefined && seed !== null && !(Number.isInteger(seed) && seed >= 0)) throw badRequest('`seed` must be a whole number');
    if (shot !== null && (typeof shot !== 'object' || JSON.stringify(shot).length > 100000)) throw badRequest('`shot` must be an object');
    const abs = await checkRefs(root, refs);

    clearTimeout(this.idle.get(provider.id));
    this.idle.delete(provider.id);
    const job = new Job({ id: newJobId(this.now()), root, provider, model, n });
    this.jobs.set(job.id, job);
    const base = seed ?? Math.floor(Math.random() * 2 ** 32);
    const spec = { prompt, negative, refs, abs, model, n, size, seed: base, shot, of: entriesOf(shot) };

    const waiting = this.waiting.get(provider.id) ?? [];
    waiting.push(job);
    this.waiting.set(provider.id, waiting);
    job.emit({ type: 'queued', position: waiting.length - 1 + (this.running.has(provider.id) ? 1 : 0) });

    const run = (this.queues.get(provider.id) ?? Promise.resolve()).then(() => this.run(job, spec));
    const tail = run.catch(() => {});
    this.queues.set(provider.id, tail);
    tail.then(() => { if (this.queues.get(provider.id) === tail) this.queues.delete(provider.id); });
    return job;
  }

  async run(job, spec) {
    const { provider } = job;
    const waiting = this.waiting.get(provider.id) ?? [];
    waiting.splice(waiting.indexOf(job), 1);
    this.running.set(provider.id, job);
    waiting.forEach((j, i) => j.emit({ type: 'queued', position: i + 1 }));
    try {
      if (job.abort.signal.aborted) throw job.abort.signal.reason;
      job.status = 'running';
      job.emit({ type: 'start' });
      await excludeCandidates(job.root);
      await pruneCandidates(job.root).catch(() => {});
      const commits = await commitsOf(job.root, spec.refs);
      const size = SIZES[spec.size];
      let index = 0;
      for (let i = 0; i < spec.n; i += 1) {
        const seed = (spec.seed + i) % 2 ** 32;
        await this.limiter(provider).take(job.abort.signal);
        const results = await provider.generate(
          { model: spec.model, prompt: spec.prompt, negative: spec.negative, refs: spec.abs, seed, size: { width: size.width, height: size.height } },
          { signal: job.abort.signal, onProgress: ({ fraction }) => job.emit({ type: 'progress', index: i, n: spec.n, fraction }) },
        );
        for (const { bytes, ext } of results) {
          index += 1;
          const made = {
            provider: provider.id,
            model: spec.model,
            seed,
            count: spec.n,
            size: spec.size,
            prompt: spec.prompt,
            ...(spec.negative ? { negative: spec.negative } : {}),
            references: spec.refs.map((p, k) => ({ path: p, commit: commits[k] })),
            shot: spec.shot,
            made: this.now().toISOString(),
          };
          const rel = await writeCandidate(job.root, job.id, index, { bytes, ext, of: spec.of, made });
          job.images.push(rel);
          job.emit({ type: 'image', path: rel, index });
        }
      }
      job.status = 'done';
      job.emit({ type: 'done', images: job.images, cancelled: false });
    } catch (err) {
      if (job.abort.signal.aborted) {
        job.status = 'cancelled';
        job.emit({ type: 'done', images: job.images, cancelled: true });
      } else {
        job.status = 'error';
        job.emit({ type: 'error', message: err.message });
        job.emit({ type: 'done', images: job.images, cancelled: false });
      }
    } finally {
      this.running.delete(provider.id);
      this.whenIdle(provider);
      job.finish();
      setTimeout(() => this.jobs.delete(job.id), FORGET_AFTER_MS).unref?.();
    }
  }

  // A local model holds a lot of memory: once a provider has had nothing to
  // do for its unloadAfterMs, ask it to let go.
  whenIdle(provider) {
    if (!provider.free || !provider.unloadAfterMs || this.waiting.get(provider.id)?.length) return;
    clearTimeout(this.idle.get(provider.id));
    const timer = setTimeout(() => {
      this.idle.delete(provider.id);
      if (!this.running.has(provider.id)) provider.free().catch(() => {});
    }, provider.unloadAfterMs);
    timer.unref?.();
    this.idle.set(provider.id, timer);
  }

  get(id, root) {
    const job = this.jobs.get(id);
    if (!job || path.resolve(job.root) !== path.resolve(root)) throw notFound('No such image job; it may have finished before the server restarted');
    return job;
  }

  list(root) {
    return [...this.jobs.values()].filter((j) => path.resolve(j.root) === path.resolve(root)).map((j) => j.summary);
  }
}
