import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../errors.js';
import {
  editorNodes, fillWorkflow, loadWorkflows, missingChoices, unknownClasses, WORKFLOWS_DIR,
} from './workflow.js';

// Generating with ComfyUI on this Mac, through its local HTTP API:
//   POST /upload/image    a reference image (named by its content, so a
//                         reference sent twice is stored once)
//   POST /prompt          queue the filled-in workflow → prompt_id
//   /ws                   progress while it runs (optional; we also poll)
//   GET  /history/<id>    the result once it's done
//   GET  /view            each image
//   POST /free            unload the model when the editor is done with it
// Only a loopback URL is allowed: the prompt and references stay on this machine.
// Without a configured URL, it looks on ComfyUI Desktop's port (8000), then
// the manual install's (8188).

export const DEFAULT_URLS = ['http://127.0.0.1:8000', 'http://127.0.0.1:8188'];
const PROBE_TIMEOUT_MS = 1500;
const START_TIMEOUT_MS = 120000;

// Opens a Mac app by name.
function openApp(name) {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', name], (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve()));
  });
}

// Runs a start script (no shell, no arguments) in the background, writing
// its output to `logFile`. ComfyUI keeps running if the editor stops.
// Resolves once it has started: { exited: () => exit code or null }.
function runScript(command, logFile) {
  return new Promise((resolve, reject) => {
    fsSync.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fsSync.openSync(logFile, 'w');
    let code = null;
    const child = spawn(command, [], { detached: true, stdio: ['ignore', out, out] });
    child.once('error', (err) => { fsSync.closeSync(out); reject(err); });
    child.once('exit', (c, signal) => { code = c ?? signal; });
    child.once('spawn', () => {
      fsSync.closeSync(out);
      child.unref();
      resolve({ exited: () => code });
    });
  });
}

// The last lines of a log, for an error message.
async function logTail(file, lines = 6) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.trim().split('\n').slice(-lines).join('\n');
}
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const CHECK_TIMEOUT_MS = 3000;

export function checkUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, `ComfyUI’s address isn’t a URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(u.protocol) || !LOOPBACK.has(u.hostname)) {
    throw new HttpError(400, `ComfyUI must run on this machine (127.0.0.1 or localhost), not ${u.host}`);
  }
  return u.origin;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

// ComfyUI's error for a rejected prompt, in one readable line.
function promptError(data) {
  const lines = [data?.error?.message || 'ComfyUI refused the workflow'];
  for (const [id, e] of Object.entries(data?.node_errors ?? {})) {
    for (const err of e.errors ?? []) lines.push(`${e.class_type ?? id}: ${err.details || err.message}`);
  }
  return lines.join(' · ');
}

export class ComfyUIProvider {
  //   url: where ComfyUI is, or null to look on the usual ports
  //   app: the Mac app Start opens, unless there's a `startScript` (an
  //   absolute path) to run instead; its output goes to `logFile`
  //   unloadAfterMs: idle time before the model is unloaded (0: never)
  constructor({
    url = null, urls = DEFAULT_URLS, app = 'ComfyUI', startScript = null, logFile = null, unloadAfterMs = 10 * 60 * 1000, workflowsDir = WORKFLOWS_DIR, pollMs = 1000,
    fetch = globalThis.fetch, WebSocket = globalThis.WebSocket, launch = openApp, platform = process.platform,
  } = {}) {
    this.id = 'comfyui';
    this.label = 'ComfyUI on this Mac';
    this.urls = url ? [url] : urls;
    this.url = this.urls[0];
    this.app = app;
    this.startScript = startScript;
    this.logFile = logFile;
    this.unloadAfterMs = unloadAfterMs;
    this.launch = launch;
    this.run = runScript;
    this.platform = platform;
    this.workflowsDir = workflowsDir;
    this.pollMs = pollMs;
    this.fetch = fetch;
    this.WebSocket = WebSocket;
    this.limits = null; // local: no limits
  }

  get origin() {
    return checkUrl(this.url);
  }

  get where() {
    return this.urls.length === 1 ? this.url : this.urls.join(' or ');
  }

  // Finds the running ComfyUI and remembers its URL; returns /system_stats.
  // Something else answering on a port (another dev server) doesn't count.
  async locate() {
    for (const url of this.urls) checkUrl(url);
    for (const url of this.urls) {
      try {
        const res = await this.fetch(`${checkUrl(url)}/system_stats`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        const stats = res.ok ? await res.json().catch(() => null) : null;
        if (stats?.system) {
          this.url = url;
          return stats;
        }
      } catch {
        // not there
      }
    }
    throw new HttpError(502, `ComfyUI isn’t running at ${this.where}.`);
  }

  get canStart() {
    return Boolean(this.startScript) || this.platform === 'darwin';
  }

  // Starts ComfyUI (its start script, or the Mac app) and waits until it
  // answers; returns check().
  async start({ timeoutMs = START_TIMEOUT_MS, pollMs = 1000 } = {}) {
    if (!this.canStart) throw new HttpError(501, 'Starting ComfyUI from the editor needs a Mac, or imagegen.comfyui.start in the config; start it yourself');
    try {
      await this.locate();
      return this.check();
    } catch {
      // not running yet
    }
    let what;
    let exited = () => null;
    if (this.startScript) {
      what = this.startScript;
      if (!path.isAbsolute(this.startScript)) throw new HttpError(400, `imagegen.comfyui.start must be an absolute path, not ${this.startScript}`);
      try {
        await fs.access(this.startScript, fsSync.constants.X_OK);
        ({ exited } = await this.run(this.startScript, this.logFile));
      } catch (err) {
        throw new HttpError(404, `Couldn’t run ${this.startScript}: ${err.code === 'ENOENT' ? 'no such file' : err.code === 'EACCES' ? 'it isn’t executable (chmod +x it)' : err.message}`);
      }
    } else {
      what = `The ${this.app} app`;
      try {
        await this.launch(this.app);
      } catch (err) {
        throw new HttpError(404, `Couldn’t open the ${this.app} app${err.stderr?.includes('Unable to find') ? ': it isn’t installed' : ''}. Install ComfyUI Desktop, or set imagegen.comfyui.app or imagegen.comfyui.start in the config.`);
      }
    }
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.locate();
        return this.check();
      } catch {
        // A script that stops with an error won't start ComfyUI. (One that
        // exits cleanly may have started it in the background.)
        const code = exited();
        if (code !== null && code !== 0) {
          const tail = this.logFile ? await logTail(this.logFile) : '';
          throw new HttpError(502, `${this.startScript} stopped (exit ${code}) before ComfyUI answered.${tail ? ` Its last output: ${tail}` : ''}${this.logFile ? ` (full log: ${this.logFile})` : ''}`);
        }
        if (Date.now() > until) throw new HttpError(504, `${what} started, but ComfyUI didn’t answer at ${this.where} within ${Math.round(timeoutMs / 1000)} seconds. It may still be starting; check again in a minute.${this.logFile && this.startScript ? ` Its log: ${this.logFile}` : ''}`);
        await sleep(pollMs);
      }
    }
  }

  // Unloads the models and frees the memory ComfyUI holds. Quietly does
  // nothing if ComfyUI isn't running.
  async free() {
    try {
      await this.locate();
    } catch {
      return false;
    }
    await this.request('/free', { method: 'POST', body: { unload_models: true, free_memory: true }, timeout: PROBE_TIMEOUT_MS * 2 });
    return true;
  }

  async request(rel, { method = 'GET', body, json = true, signal, timeout } = {}) {
    const signals = [signal, timeout && AbortSignal.timeout(timeout)].filter(Boolean);
    let res;
    try {
      res = await this.fetch(`${this.origin}${rel}`, {
        method,
        body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
        headers: body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' },
        signal: signals.length ? AbortSignal.any(signals) : undefined,
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      throw new HttpError(502, `Can’t reach ComfyUI at ${this.url}. Is it running?`, { cause: err.message });
    }
    if (!json) {
      if (!res.ok) throw new HttpError(502, `ComfyUI: ${method} ${rel.split('?')[0]} failed (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new HttpError(502, `ComfyUI: ${data?.error?.message || data?.error || `${method} ${rel.split('?')[0]} failed (${res.status})`}`), { data });
    return data;
  }

  // Node definitions for the classes a graph uses: { class: def }.
  async objectInfo(classes, { signal, timeout } = {}) {
    const info = {};
    for (const cls of new Set(classes)) {
      try {
        Object.assign(info, await this.request(`/object_info/${encodeURIComponent(cls)}`, { signal, timeout }));
      } catch (err) {
        if (err.status !== 502 || /Can’t reach/.test(err.message)) throw err;
      }
    }
    return info;
  }

  async workflows() {
    return loadWorkflows(this.workflowsDir);
  }

  // Whether ComfyUI is running, and which workflows it can run:
  // { ok, message, models: [{ id, label, description, maxRefs, ready, problem }] }
  async check() {
    let workflows;
    try {
      workflows = await this.workflows();
    } catch (err) {
      return { ok: false, message: `Can’t read the workflows: ${err.message}`, models: [] };
    }
    let version = '';
    try {
      version = (await this.locate()).system.comfyui_version ?? '';
    } catch (err) {
      return {
        ok: false,
        running: false,
        message: err.message,
        models: workflows.map((w) => this.describe(w, w.error || 'ComfyUI isn’t running')),
      };
    }
    const models = [];
    for (const w of workflows) {
      if (w.error) {
        models.push(this.describe(w, w.error));
        continue;
      }
      const info = await this.objectInfo(Object.values(w.graph).map((n) => n.class_type), { timeout: CHECK_TIMEOUT_MS * 3 });
      const unknown = unknownClasses(w.graph, info);
      const missing = missingChoices(w.graph, info);
      models.push(this.describe(w, unknown.length
        ? `ComfyUI doesn’t have these nodes: ${unknown.join(', ')}. Update ComfyUI, or install the custom nodes.`
        : missing.length
          ? `ComfyUI doesn’t have ${[...new Set(missing.map((m) => m.value))].join(', ')}. Download ${missing.length === 1 ? 'it' : 'them'} into ComfyUI’s models folder.`
          : ''));
    }
    return { ok: true, running: true, message: `ComfyUI${version ? ` ${version}` : ''} is running at ${this.url}.`, models };
  }

  describe(w, problem = '') {
    return { id: w.id, label: w.label, description: w.description, maxRefs: w.maxRefs, ready: !problem, problem };
  }

  async upload(abs, signal) {
    const bytes = await fs.readFile(abs);
    const name = `book-editor-${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 20)}${path.extname(abs).toLowerCase()}`;
    const form = new FormData();
    form.append('image', new Blob([bytes]), name);
    form.append('overwrite', 'true');
    const res = await this.request('/upload/image', { method: 'POST', body: form, signal });
    return res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
  }

  // One run of the workflow: [{ bytes, ext }].
  //   refs: absolute paths of the reference images, in prompt order
  //   onProgress({ fraction }) while it samples
  async generate({ model, prompt, negative = '', refs = [], seed, size }, { signal, onProgress = () => {} } = {}) {
    await this.locate();
    const workflow = (await this.workflows()).find((w) => w.id === model);
    if (!workflow) throw new HttpError(400, `No such ComfyUI workflow: ${model}`);
    if (workflow.error) throw new HttpError(400, `${workflow.label}: ${workflow.error}`);
    const info = await this.objectInfo(Object.values(workflow.graph).map((n) => n.class_type), { signal });
    const names = [];
    for (const abs of refs) names.push(await this.upload(abs, signal));
    let graph;
    try {
      graph = fillWorkflow(workflow.graph, { prompt, negative, refs: names, seed, size }, info);
    } catch (err) {
      throw new HttpError(400, `${workflow.label}: ${err.message}`);
    }
    const saveId = editorNodes(graph, 'save')[0];
    const clientId = crypto.randomUUID();
    const ws = this.listen(clientId, onProgress);
    let promptId = null;
    try {
      let queued;
      try {
        queued = await this.request('/prompt', { method: 'POST', body: { prompt: graph, client_id: clientId }, signal });
      } catch (err) {
        if (err.data) throw new HttpError(502, `ComfyUI: ${promptError(err.data)}`);
        throw err;
      }
      promptId = queued.prompt_id;
      ws.promptId = promptId;
      for (;;) {
        await sleep(this.pollMs, signal);
        const entry = (await this.request(`/history/${encodeURIComponent(promptId)}`, { signal }))?.[promptId];
        if (!entry) continue;
        if (entry.status?.status_str === 'error') {
          const failed = entry.status.messages?.find(([type]) => type === 'execution_error')?.[1];
          throw new HttpError(502, `ComfyUI: ${failed ? `${failed.node_type}: ${failed.exception_message}`.trim() : 'the workflow failed'}`);
        }
        if (entry.status && !entry.status.completed) continue;
        const images = entry.outputs?.[saveId]?.images ?? [];
        if (!images.length) throw new HttpError(502, 'ComfyUI finished without saving an image');
        const out = [];
        for (const img of images) {
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
          out.push({ bytes: await this.request(`/view?${q}`, { json: false, signal }), ext: path.extname(img.filename).slice(1).toLowerCase() || 'png' });
        }
        onProgress({ fraction: 1 });
        return out;
      }
    } catch (err) {
      if (signal?.aborted && promptId) await this.cancel(promptId);
      throw err;
    } finally {
      ws.close();
    }
  }

  // Takes the prompt off ComfyUI's queue, or stops it if it's running.
  async cancel(promptId) {
    const quiet = (p) => p.catch(() => {});
    await quiet(this.request('/queue', { method: 'POST', body: { delete: [promptId] }, timeout: CHECK_TIMEOUT_MS }));
    const queue = await this.request('/queue', { timeout: CHECK_TIMEOUT_MS }).catch(() => null);
    if (queue?.queue_running?.some((item) => item[1] === promptId)) {
      await quiet(this.request('/interrupt', { method: 'POST', body: { prompt_id: promptId }, timeout: CHECK_TIMEOUT_MS }));
    }
  }

  // Progress messages over ComfyUI's websocket, if it can be opened. Polling
  // /history finds the result either way.
  listen(clientId, onProgress) {
    const handle = { promptId: null, close: () => {} };
    if (!this.WebSocket) return handle;
    try {
      const ws = new this.WebSocket(`${this.origin.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`);
      ws.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return; // preview images
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        const d = msg.data ?? {};
        if (handle.promptId && d.prompt_id && d.prompt_id !== handle.promptId) return;
        if (msg.type === 'progress' && d.max) onProgress({ fraction: d.value / d.max });
      });
      ws.addEventListener('error', () => {});
      handle.close = () => { try { ws.close(); } catch { /* already closed */ } };
    } catch {
      // no websocket: polling still works
    }
    return handle;
  }
}
