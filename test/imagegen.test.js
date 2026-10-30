import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';
import { createApp } from '../server/app.js';
import {
  CANDIDATES, discardCandidates, excludeCandidates, keepCandidate, listCandidates, pruneCandidates, writeCandidate,
} from '../server/candidates.js';
import { saveConfig } from '../server/config.js';
import { ComfyUIProvider, checkUrl } from '../server/imagegen/comfyui.js';
import { FakeProvider, patternPng } from '../server/imagegen/fake.js';
import { ImageJobs } from '../server/imagegen/jobs.js';
import { Limiter } from '../server/imagegen/limits.js';
import {
  editorNodes, fillWorkflow, loadWorkflows, missingChoices, parseWorkflow, removeNodes, WORKFLOWS_DIR,
} from '../server/imagegen/workflow.js';
import { listLookbook, updateImage } from '../server/lookbook.js';
import { splitMade } from '../public/js/provenance.js';
import { gitBook, gitIn, tempDir, writeFiles } from './helpers.js';

// --- a ComfyUI that knows the nodes the FLUX.2 workflow uses -------------------------

const io = (required, output, optional = {}) => ({ input: { required, optional }, output });
const INFO = {
  UNETLoader: io({ unet_name: [['flux-2-klein-9b-fp8.safetensors']], weight_dtype: [['default', 'fp8']] }, ['MODEL']),
  CLIPLoader: io({ clip_name: [['qwen_3_8b_fp8mixed.safetensors']], type: [['flux2', 'sd3']] }, ['CLIP'], { device: [['default', 'cpu']] }),
  VAELoader: io({ vae_name: ['COMBO', { options: ['full_encoder_small_decoder.safetensors'] }] }, ['VAE']),
  CLIPTextEncode: io({ text: ['STRING', {}], clip: ['CLIP'] }, ['CONDITIONING']),
  ConditioningZeroOut: io({ conditioning: ['CONDITIONING'] }, ['CONDITIONING']),
  LoadImage: io({ image: [['example.png']] }, ['IMAGE', 'MASK']),
  ImageScaleToTotalPixels: io({ image: ['IMAGE'], upscale_method: [['lanczos']], megapixels: ['FLOAT'], resolution_steps: ['INT'] }, ['IMAGE']),
  VAEEncode: io({ pixels: ['IMAGE'], vae: ['VAE'] }, ['LATENT']),
  ReferenceLatent: io({ conditioning: ['CONDITIONING'] }, ['CONDITIONING'], { latent: ['LATENT'] }),
  CFGGuider: io({ model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], cfg: ['FLOAT'] }, ['GUIDER']),
  RandomNoise: io({ noise_seed: ['INT'] }, ['NOISE']),
  KSamplerSelect: io({ sampler_name: [['euler']] }, ['SAMPLER']),
  Flux2Scheduler: io({ steps: ['INT'], width: ['INT'], height: ['INT'] }, ['SIGMAS']),
  EmptyFlux2LatentImage: io({ width: ['INT'], height: ['INT'], batch_size: ['INT'] }, ['LATENT']),
  SamplerCustomAdvanced: io({ noise: ['NOISE'], guider: ['GUIDER'], sampler: ['SAMPLER'], sigmas: ['SIGMAS'], latent_image: ['LATENT'] }, ['LATENT', 'LATENT']),
  VAEDecode: io({ samples: ['LATENT'], vae: ['VAE'] }, ['IMAGE']),
  SaveImage: io({ images: ['IMAGE'], filename_prefix: ['STRING'] }, []),
};

let klein;
before(async () => {
  klein = (await loadWorkflows()).find((w) => w.id === 'flux2-klein-9b');
});

// An SSE stream's text, up to its `end` event.
async function readEvents(url) {
  const abort = new AbortController();
  const res = await fetch(url, { signal: abort.signal });
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of res.body) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes('event: end')) break;
  }
  abort.abort();
  return text;
}

const byTitle = (g, title) => Object.values(g).find((n) => n._meta?.title === title);

test('the shipped FLUX.2 workflow loads, with four references', () => {
  assert.ok(klein, `flux2-klein-9b.json is in ${WORKFLOWS_DIR}`);
  assert.equal(klein.error, '');
  assert.equal(klein.label, 'FLUX.2 [klein] 9B');
  assert.equal(klein.maxRefs, 4);
  assert.ok(!('_editor' in klein.graph), 'editor keys are never sent to ComfyUI');
  assert.deepEqual(missingChoices(klein.graph, INFO), []);
});

test('workflow files that can’t be used say why', () => {
  assert.match(parseWorkflow('x', '{nope').error, /Not valid JSON/);
  assert.match(parseWorkflow('x', JSON.stringify({ nodes: [], links: [] })).error, /Export \(API\)/);
  assert.match(parseWorkflow('x', JSON.stringify({ 1: { class_type: 'SaveImage', inputs: {}, _meta: { title: 'EDITOR:save' } } })).error, /EDITOR:prompt/);
  const ok = parseWorkflow('my-flow', JSON.stringify({
    1: { class_type: 'CLIPTextEncode', inputs: {}, _meta: { title: 'EDITOR:prompt' } },
    2: { class_type: 'SaveImage', inputs: {}, _meta: { title: 'EDITOR:save' } },
  }));
  assert.equal(ok.error, '');
  assert.equal(ok.label, 'My Flow');
  assert.equal(ok.maxRefs, 0);
});

test('filling a workflow sets the prompt, seed, size and references, and drops unused reference chains', () => {
  const g = fillWorkflow(klein.graph, { prompt: 'Tor at the well.', refs: ['book-editor-a.png'], seed: 42, size: { width: 832, height: 1216 } }, INFO);
  assert.equal(byTitle(g, 'EDITOR:prompt').inputs.text, 'Tor at the well.');
  assert.equal(byTitle(g, 'EDITOR:ref1').inputs.image, 'book-editor-a.png');
  assert.equal(byTitle(g, 'EDITOR:seed').inputs.noise_seed, 42);
  for (const id of editorNodes(g, 'size')) assert.deepEqual([g[id].inputs.width, g[id].inputs.height], [832, 1216]);
  for (const n of [2, 3, 4]) {
    assert.equal(byTitle(g, `EDITOR:ref${n}`), undefined, `ref${n} is gone`);
    assert.equal(byTitle(g, `Encode reference ${n}`), undefined);
    // ReferenceLatent's latent is optional: without it, the node passes its
    // conditioning through unchanged.
    assert.deepEqual(Object.keys(byTitle(g, `Reference ${n} (prompt)`).inputs), ['conditioning']);
  }
  assert.ok(byTitle(g, 'Reference 1 (prompt)').inputs.latent);
  // Every link still points at a node that exists.
  for (const node of Object.values(g)) {
    for (const v of Object.values(node.inputs)) if (Array.isArray(v)) assert.ok(g[v[0]], `${v[0]} exists`);
  }
});

test('with no references the workflow is plain text-to-image', () => {
  const g = fillWorkflow(klein.graph, { prompt: 'A well.', refs: [], seed: 1 }, INFO);
  assert.ok(!Object.values(g).some((n) => ['LoadImage', 'VAEEncode', 'ImageScaleToTotalPixels'].includes(n.class_type)));
  assert.ok(Object.values(g).filter((n) => n.class_type === 'ReferenceLatent').every((n) => !n.inputs.latent));
  // With a required latent, the reference nodes are bypassed instead.
  const strict = structuredClone(INFO);
  strict.ReferenceLatent = io({ conditioning: ['CONDITIONING'], latent: ['LATENT'] }, ['CONDITIONING']);
  const bare = fillWorkflow(klein.graph, { prompt: 'A well.', refs: [], seed: 1 }, strict);
  assert.ok(!Object.values(bare).some((n) => n.class_type === 'ReferenceLatent'));
  const guider = byTitle(bare, 'CFG Guider');
  assert.equal(bare[guider.inputs.positive[0]]._meta.title, 'EDITOR:prompt');
  assert.equal(bare[guider.inputs.negative[0]].class_type, 'ConditioningZeroOut');
  assert.throws(() => fillWorkflow(klein.graph, { prompt: 'x', refs: ['1', '2', '3', '4', '5'] }, INFO), /at most 4/);
});

test('removing a node bypasses it by type, and drops what can’t be bypassed', () => {
  const info = {
    Load: io({}, ['IMAGE']),
    Encode: io({ pixels: ['IMAGE'], vae: ['VAE'] }, ['LATENT']),
    Ref: io({ conditioning: ['CONDITIONING'], latent: ['LATENT'] }, ['CONDITIONING']),
    Text: io({}, ['CONDITIONING']),
    Vae: io({}, ['VAE']),
    Use: io({ c: ['CONDITIONING'] }, []),
  };
  const g = {
    t: { class_type: 'Text', inputs: {} },
    v: { class_type: 'Vae', inputs: {} },
    l: { class_type: 'Load', inputs: {} },
    e: { class_type: 'Encode', inputs: { pixels: ['l', 0], vae: ['v', 0] } },
    r: { class_type: 'Ref', inputs: { conditioning: ['t', 0], latent: ['e', 0] } },
    u: { class_type: 'Use', inputs: { c: ['r', 0] } },
  };
  const out = removeNodes(g, ['l'], info);
  assert.deepEqual(Object.keys(out).sort(), ['t', 'u', 'v']);
  assert.deepEqual(out.u.inputs.c, ['t', 0]);
  assert.throws(() => removeNodes({ ...g, u: { ...g.u, _meta: { title: 'EDITOR:save' } } }, ['t'], info), /EDITOR:save/);
});

test('missing models and nodes are named', () => {
  const g = structuredClone(klein.graph);
  byTitle(g, 'Load Diffusion Model').inputs.unet_name = 'other.safetensors';
  assert.deepEqual(missingChoices(g, INFO), [{ node: 'Load Diffusion Model', input: 'unet_name', value: 'other.safetensors' }]);
});

test('ComfyUI must be on this machine', () => {
  assert.equal(checkUrl('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
  assert.equal(checkUrl('http://localhost:9000'), 'http://localhost:9000');
  assert.throws(() => checkUrl('http://192.168.1.5:8188'), /this machine/);
  assert.throws(() => checkUrl('file:///etc'), /this machine/);
});

// --- the provider against a fake ComfyUI ----------------------------------------------

function fakeComfy() {
  const state = { uploads: [], prompts: [], deleted: [], interrupted: 0, freed: [], reject: false, hold: false, fail: false, down: false };
  const app = express();
  app.get('/system_stats', (req, res) => (state.down ? res.status(503).end() : res.json({ system: { comfyui_version: '0.9.9' } })));
  app.post('/free', express.json(), (req, res) => { state.freed.push(req.body); res.json({}); });
  app.get('/object_info/:cls', (req, res) => res.json(INFO[req.params.cls] ? { [req.params.cls]: INFO[req.params.cls] } : {}));
  app.post('/upload/image', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
    const name = /filename="([^"]+)"/.exec(req.body.toString('latin1'))[1];
    state.uploads.push(name);
    res.json({ name, subfolder: '', type: 'input' });
  });
  app.post('/prompt', express.json({ limit: '5mb' }), (req, res) => {
    if (state.reject) {
      return res.status(400).json({
        error: { message: 'Prompt outputs failed validation' },
        node_errors: { 1: { class_type: 'UNETLoader', errors: [{ message: 'Value not in list', details: 'unet_name: x not in []' }] } },
      });
    }
    state.prompts.push(req.body);
    res.json({ prompt_id: `p${state.prompts.length}`, number: state.prompts.length });
  });
  app.get('/history/:id', (req, res) => {
    const posted = state.prompts[Number(req.params.id.slice(1)) - 1];
    if (!posted || state.hold) return res.json({});
    if (state.fail) {
      return res.json({ [req.params.id]: { status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'VAEDecode', exception_message: 'out of memory' }]] } } });
    }
    const saveId = Object.keys(posted.prompt).find((k) => posted.prompt[k]._meta?.title === 'EDITOR:save');
    res.json({ [req.params.id]: { status: { status_str: 'success', completed: true }, outputs: { [saveId]: { images: [{ filename: 'shot_00001_.png', subfolder: 'book-editor', type: 'output' }] } } } });
  });
  app.get('/view', (req, res) => res.type('png').send(patternPng(4, 4, 1)));
  app.get('/queue', (req, res) => res.json({ queue_running: state.hold ? [[0, `p${state.prompts.length}`]] : [], queue_pending: [] }));
  app.post('/queue', express.json(), (req, res) => { state.deleted.push(...(req.body.delete ?? [])); res.json({}); });
  app.post('/interrupt', (req, res) => { state.interrupted += 1; res.json({}); });
  return { app, state };
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('the ComfyUI provider uploads references, queues the filled workflow and returns the image', async (t) => {
  const { app, state } = fakeComfy();
  const { server, url } = await listen(app);
  t.after(() => server.close());
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'tor.png'), patternPng(4, 4, 7));
  const comfy = new ComfyUIProvider({ url, pollMs: 5, WebSocket: null });

  const check = await comfy.check();
  assert.equal(check.ok, true);
  assert.match(check.message, /0\.9\.9/);
  const model = check.models.find((m) => m.id === 'flux2-klein-9b');
  assert.deepEqual([model.ready, model.maxRefs], [true, 4]);

  const progress = [];
  const out = await comfy.generate(
    { model: 'flux2-klein-9b', prompt: 'Tor at the well.', refs: [path.join(dir, 'tor.png')], seed: 5, size: { width: 1024, height: 1024 } },
    { onProgress: (p) => progress.push(p.fraction) },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].ext, 'png');
  assert.equal(out[0].bytes.readUInt32BE(0), 0x89504e47);
  assert.equal(state.uploads.length, 1);
  assert.match(state.uploads[0], /^book-editor-[0-9a-f]{20}\.png$/);
  const sent = state.prompts[0].prompt;
  assert.equal(byTitle(sent, 'EDITOR:ref1').inputs.image, state.uploads[0]);
  assert.equal(byTitle(sent, 'EDITOR:prompt').inputs.text, 'Tor at the well.');
  assert.equal(byTitle(sent, 'EDITOR:ref2'), undefined);
  assert.deepEqual(progress, [1]);
});

test('ComfyUI errors come back readable, and cancelling takes the prompt off its queue', async (t) => {
  const { app, state } = fakeComfy();
  const { server, url } = await listen(app);
  t.after(() => server.close());
  const comfy = new ComfyUIProvider({ url, pollMs: 5, WebSocket: null });
  const spec = { model: 'flux2-klein-9b', prompt: 'x', refs: [], seed: 1 };

  state.reject = true;
  await assert.rejects(comfy.generate(spec), (err) => err.status === 502 && /failed validation · UNETLoader: unet_name: x not in \[\]/.test(err.message));
  state.reject = false;

  state.fail = true;
  await assert.rejects(comfy.generate(spec), /VAEDecode: out of memory/);
  state.fail = false;

  state.hold = true;
  const abort = new AbortController();
  const running = comfy.generate(spec, { signal: abort.signal });
  await new Promise((r) => setTimeout(r, 40));
  abort.abort(new Error('Cancelled'));
  await assert.rejects(running, /Cancelled/);
  assert.deepEqual(state.deleted, [`p${state.prompts.length}`]);
  assert.equal(state.interrupted, 1);

  const down = new ComfyUIProvider({ url: 'http://127.0.0.1:9', WebSocket: null });
  const offline = await down.check();
  assert.equal(offline.ok, false);
  assert.match(offline.message, /isn’t running/);
});

test('without a configured URL, ComfyUI is found on whichever usual port answers', async (t) => {
  const other = express();
  other.get('/system_stats', (req, res) => res.status(404).send('Not found')); // another dev server
  const { server: a, url: otherUrl } = await listen(other);
  const { app, state } = fakeComfy();
  const { server: b, url } = await listen(app);
  t.after(() => { a.close(); b.close(); });
  const comfy = new ComfyUIProvider({ urls: [otherUrl, url], WebSocket: null });
  const check = await comfy.check();
  assert.equal(check.ok, true);
  assert.equal(comfy.url, url);
  assert.match(check.message, new RegExp(`running at ${url}`));

  state.down = true;
  const off = await new ComfyUIProvider({ urls: [otherUrl, url], WebSocket: null }).check();
  assert.deepEqual([off.ok, off.running], [false, false]);
  assert.match(off.message, new RegExp(`isn’t running at ${otherUrl} or ${url}`));
});

test('Start opens the app and waits for ComfyUI; Unload frees its memory', async (t) => {
  const { app, state } = fakeComfy();
  const { server, url } = await listen(app);
  t.after(() => server.close());
  state.down = true;
  const opened = [];
  const launch = async (name) => { opened.push(name); setTimeout(() => { state.down = false; }, 30); };
  const comfy = new ComfyUIProvider({ url, WebSocket: null, launch, platform: 'darwin', app: 'ComfyUI' });
  const result = await comfy.start({ pollMs: 10 });
  assert.deepEqual(opened, ['ComfyUI']);
  assert.equal(result.ok, true);
  await comfy.start({ pollMs: 10 });
  assert.equal(opened.length, 1, 'already running: not opened again');

  assert.equal(await comfy.free(), true);
  assert.deepEqual(state.freed, [{ unload_models: true, free_memory: true }]);
  state.down = true;
  assert.equal(await comfy.free(), false, 'nothing to free when it isn’t running');

  const missing = new ComfyUIProvider({ url, launch: async () => { throw Object.assign(new Error('x'), { stderr: 'Unable to find application named \'ComfyUI\'' }); }, platform: 'darwin' });
  await assert.rejects(missing.start({ pollMs: 10 }), (err) => err.status === 404 && /isn’t installed/.test(err.message));
  const slow = new ComfyUIProvider({ url, launch: async () => {}, platform: 'darwin' });
  await assert.rejects(slow.start({ pollMs: 10, timeoutMs: 50 }), (err) => err.status === 504);
  await assert.rejects(new ComfyUIProvider({ url, platform: 'linux' }).start(), (err) => err.status === 501);
});

test('Start can run a start script instead, and reports one that fails', async (t) => {
  const { app, state } = fakeComfy();
  const { server, url } = await listen(app);
  t.after(() => server.close());
  const dir = await tempDir();
  const logFile = path.join(dir, 'logs', 'comfyui.log');
  const script = async (name, body, mode = 0o755) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode });
    return file;
  };

  state.down = true;
  const ok = await script('ok.sh', 'echo starting ComfyUI\nsleep 0.3');
  setTimeout(() => { state.down = false; }, 50);
  const result = await new ComfyUIProvider({ url, startScript: ok, logFile, platform: 'linux', WebSocket: null }).start({ pollMs: 10 });
  assert.equal(result.ok, true);
  // The script's echo can land after ComfyUI answers, especially under load.
  let log = '';
  for (let i = 0; i < 40 && !/starting ComfyUI/.test(log); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    log = await fs.readFile(logFile, 'utf8');
  }
  assert.match(log, /starting ComfyUI/);

  state.down = true;
  const bad = await script('bad.sh', 'echo "ModuleNotFoundError: No module named torch" >&2\nexit 3');
  await assert.rejects(
    new ComfyUIProvider({ url, startScript: bad, logFile, WebSocket: null }).start({ pollMs: 10, timeoutMs: 5000 }),
    (err) => err.status === 502 && /exit 3/.test(err.message) && /No module named torch/.test(err.message),
  );
  const plain = await script('plain.sh', 'exit 0', 0o644);
  await assert.rejects(new ComfyUIProvider({ url, startScript: plain, logFile }).start({ pollMs: 10 }), /isn’t executable/);
  await assert.rejects(new ComfyUIProvider({ url, startScript: 'start.sh', logFile }).start({ pollMs: 10 }), /absolute path/);
});

// --- candidates ------------------------------------------------------------------------

const MADE = { provider: 'fake', model: 'pattern', seed: 3, prompt: 'Tor.', references: [], shot: { characters: [{ path: 'codex/characters/tor.md', variant: '' }] } };

test('candidates are written beside a note, listed, kept and discarded', async () => {
  const root = await gitBook({ 'codex/characters/tor.md': '# Tor\n' });
  assert.equal(await excludeCandidates(root), true);
  assert.equal(await excludeCandidates(root), false, 'only added once');
  assert.match(await fs.readFile(path.join(root, '.git/info/exclude'), 'utf8'), /^\/lookbook\/\.candidates\/$/m);

  const job = '20261030-120000-abcd';
  const a = await writeCandidate(root, job, 1, { bytes: patternPng(4, 4), ext: 'png', of: ['codex/characters/tor.md'], made: MADE });
  const b = await writeCandidate(root, job, 2, { bytes: patternPng(4, 4, 2), ext: 'png', of: ['codex/characters/tor.md'], made: { ...MADE, seed: 4 } });
  assert.equal(a, `${CANDIDATES}/${job}/1.png`);
  assert.equal(gitIn(root, 'status', '--porcelain'), '', 'git ignores candidates');
  assert.deepEqual(await listLookbook(root), [], 'candidates aren’t lookbook images yet');

  const list = await listCandidates(root);
  assert.deepEqual(list.map((c) => [c.path, c.n, c.made.seed]), [[a, 1, 3], [b, 2, 4]]);
  assert.deepEqual(list[0].of, ['codex/characters/tor.md']);

  const kept = await keepCandidate(root, a, { name: 'Tor at the well', reference: true, view: 'full' });
  assert.equal(kept.path, 'lookbook/tor-at-the-well.png');
  const note = await fs.readFile(path.join(root, 'lookbook/tor-at-the-well.md'), 'utf8');
  assert.doesNotMatch(note, /status:/);
  assert.match(note, /use: reference\nview: full/);
  assert.equal(splitMade(note).made.seed, 3, 'provenance is kept');
  const [img] = await listLookbook(root);
  assert.deepEqual([img.use, img.view, img.made, img.caption], ['reference', 'full', true, '']);

  // Editing the caption keeps how it was made.
  await updateImage(root, img.path, { caption: 'At dawn.' });
  const edited = await fs.readFile(path.join(root, 'lookbook/tor-at-the-well.md'), 'utf8');
  assert.match(edited, /At dawn\.\n\n## How it was made/);
  assert.equal((await listLookbook(root))[0].caption, 'At dawn.');

  await discardCandidates(root, { path: b });
  assert.deepEqual(await listCandidates(root), []);
  await assert.rejects(fs.access(path.join(root, CANDIDATES)), 'empty folders go too');
  await assert.rejects(keepCandidate(root, 'lookbook/tor-at-the-well.png', {}), /Not a candidate/);
  await assert.rejects(discardCandidates(root, { job: '../x' }), /Not a job id/);
});

test('old candidate jobs are pruned', async () => {
  const root = await tempDir();
  await writeCandidate(root, '20260101-000000-aaaa', 1, { bytes: patternPng(4, 4), ext: 'png', made: MADE });
  await writeCandidate(root, '20261030-000000-bbbb', 1, { bytes: patternPng(4, 4), ext: 'png', made: MADE });
  const old = path.join(root, CANDIDATES, '20260101-000000-aaaa');
  const then = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  await fs.utimes(old, then, then);
  assert.deepEqual(await pruneCandidates(root), ['20260101-000000-aaaa']);
  assert.deepEqual((await listCandidates(root)).map((c) => c.job), ['20261030-000000-bbbb']);
});

// --- jobs and limits -------------------------------------------------------------------

const memoryStore = () => {
  let data = {};
  return { read: async () => structuredClone(data), write: async (d) => { data = structuredClone(d); } };
};

function eventsOf(job) {
  return new Promise((resolve) => {
    const events = [];
    job.subscribe((e) => (e ? events.push(e) : resolve(events)));
  });
}

test('jobs for one provider run one at a time, in order, and write candidates', async () => {
  const root = await gitBook({ 'codex/characters/tor.md': '# Tor\n', 'lookbook/tor.png': patternPng(4, 4) });
  const jobs = new ImageJobs({ store: memoryStore() });
  const fake = new FakeProvider({ stepMs: 5, steps: 2 });
  const order = [];
  const generate = fake.generate.bind(fake);
  fake.generate = async (spec, opts) => { order.push(`start ${spec.seed}`); const out = await generate(spec, opts); order.push(`end ${spec.seed}`); return out; };

  const shot = { characters: [{ path: 'codex/characters/tor.md', variant: '' }], location: null };
  const first = await jobs.start(root, fake, { prompt: 'One.', model: 'pattern', n: 2, seed: 10, refs: ['lookbook/tor.png'], shot });
  const second = await jobs.start(root, fake, { prompt: 'Two.', model: 'pattern', n: 1, seed: 20 });
  const [e1, e2] = await Promise.all([eventsOf(first), eventsOf(second)]);
  assert.deepEqual(order, ['start 10', 'end 10', 'start 11', 'end 11', 'start 20', 'end 20']);
  assert.deepEqual(e1[0], { seq: 0, type: 'queued', position: 0 });
  assert.deepEqual(e2[0], { seq: 0, type: 'queued', position: 1 });
  assert.deepEqual(e1.filter((e) => e.type === 'image').map((e) => e.index), [1, 2]);
  assert.deepEqual(e1.at(-1), { seq: e1.length - 1, type: 'done', images: first.images, cancelled: false });
  assert.ok(e1.some((e) => e.type === 'progress' && e.fraction === 0.5));

  const cands = await listCandidates(root);
  assert.equal(cands.length, 3);
  const one = cands.find((c) => c.job === first.id && c.n === 1);
  assert.deepEqual(one.of, ['codex/characters/tor.md']);
  assert.equal(one.made.prompt, 'One.');
  assert.equal(one.made.seed, 10);
  assert.deepEqual(one.made.references, [{ path: 'lookbook/tor.png', commit: gitIn(root, 'rev-parse', 'HEAD').trim() }]);
  assert.deepEqual(one.made.shot, shot);
  assert.equal(jobs.get(first.id, root).status, 'done');
  assert.deepEqual(jobs.list(root).map((j) => j.id).sort(), [first.id, second.id].sort());
});

test('a provider is asked to unload its model once it has been idle a while', async () => {
  const root = await tempDir();
  const jobs = new ImageJobs({ store: memoryStore() });
  const fake = new FakeProvider({ stepMs: 1, steps: 1 });
  let freed = 0;
  fake.free = async () => { freed += 1; return true; };
  fake.unloadAfterMs = 40;
  await eventsOf(await jobs.start(root, fake, { prompt: 'x', model: 'pattern' }));
  await new Promise((r) => setTimeout(r, 20));
  await eventsOf(await jobs.start(root, fake, { prompt: 'y', model: 'pattern' })); // resets the clock
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(freed, 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(freed, 1);
});

test('a job can be cancelled, and bad requests are refused before queueing', async () => {
  const root = await tempDir();
  const jobs = new ImageJobs({ store: memoryStore() });
  const fake = new FakeProvider({ stepMs: 50, steps: 10 });
  const job = await jobs.start(root, fake, { prompt: 'Slow.', model: 'pattern', n: 3 });
  const events = eventsOf(job);
  setTimeout(() => job.cancel(), 30);
  const all = await events;
  assert.deepEqual(all.at(-1).cancelled, true);
  assert.equal(job.status, 'cancelled');

  await assert.rejects(jobs.start(root, fake, { prompt: '', model: 'pattern' }), /prompt is empty/);
  await assert.rejects(jobs.start(root, fake, { prompt: 'x', model: 'pattern', n: 9 }), /between 1 and 4/);
  await assert.rejects(jobs.start(root, fake, { prompt: 'x', model: 'pattern', size: 'huge' }), /size/);
  await assert.rejects(jobs.start(root, fake, { prompt: 'x', model: 'pattern', refs: ['codex/x.md'] }), /lookbook images/);
  await assert.rejects(jobs.start(root, fake, { prompt: 'x', model: 'pattern', refs: ['lookbook/.candidates/a/1.png'] }), /lookbook images/);
  await assert.rejects(jobs.start(root, fake, { prompt: 'x', model: 'pattern', refs: ['lookbook/none.png'] }), /No such file/);
});

test('a provider’s daily limit stops jobs, and its per-minute limit makes them wait', async () => {
  let now = Date.parse('2026-10-30T10:00:00Z');
  const store = memoryStore();
  const daily = new Limiter('api', { perDay: 2 }, { store, now: () => now });
  await daily.take();
  await daily.take();
  await assert.rejects(daily.take(), (err) => err.status === 429 && /limit of 2/.test(err.message));
  now += 24 * 3600 * 1000;
  await daily.take(); // a new day

  const minute = new Limiter('api', { perMinute: 1 }, { store, now: () => now });
  await minute.take();
  const abort = new AbortController();
  const waiting = minute.take(abort.signal);
  abort.abort(new Error('Cancelled'));
  await assert.rejects(waiting, /Cancelled/);

  const root = await tempDir();
  const jobs = new ImageJobs({ store });
  const limited = new FakeProvider({ stepMs: 1, steps: 1, limits: { perDay: 1 } });
  limited.id = 'limited';
  const job = await jobs.start(root, limited, { prompt: 'x', model: 'pattern', n: 2 });
  const events = await eventsOf(job);
  assert.match(events.find((e) => e.type === 'error').message, /limit of 1/);
  assert.equal(job.images.length, 1, 'the first image was still made');
});

// --- the API ---------------------------------------------------------------------------

test('image job routes: token, a fake job end to end, keep and discard', async (t) => {
  const configDir = await tempDir();
  process.env.BOOK_EDITOR_CONFIG = path.join(configDir, 'config.json');
  const library = await tempDir();
  await saveConfig({ libraryRoot: library, registered: {} });
  const root = path.join(library, 'book');
  await writeFiles(root, { 'README.md': '# Book\n', 'codex/characters/tor.md': '# Tor\n', 'lookbook/tor.png': patternPng(4, 4) });
  gitIn(root, 'init', '-q', '-b', 'main');
  const token = 'secret-token-for-tests-0123456789abcdef';
  const fake = new FakeProvider({ stepMs: 1, steps: 2 });
  const server = createApp({ token, imageJobs: new ImageJobs({ store: memoryStore() }), imageProviders: () => [fake] }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body, auth = true) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(auth ? { 'X-Editor-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  assert.equal((await call('GET', '/imagegen/providers', null, false)).status, 403);
  assert.equal((await call('POST', '/books/book/imagegen/jobs', { provider: 'fake' }, false)).status, 403);
  const providers = await call('GET', '/imagegen/providers');
  assert.deepEqual(providers.data.providers.map((p) => [p.id, p.ok, p.models[0].id]), [['fake', true, 'pattern']]);
  assert.ok(providers.data.sizes.portrait);
  assert.equal((await call('POST', '/books/book/imagegen/jobs', { provider: 'nope', prompt: 'x', model: 'm' })).status, 400);
  assert.equal((await call('POST', '/imagegen/providers/fake/start', {}, false)).status, 403);
  assert.match((await call('POST', '/imagegen/providers/fake/start', {})).data.error, /can’t be started/);
  assert.deepEqual((await call('POST', '/imagegen/providers/fake/free', {})).data, { freed: false });

  const shot = { characters: [{ path: 'codex/characters/tor.md', variant: '' }] };
  const started = await call('POST', '/books/book/imagegen/jobs', { provider: 'fake', model: 'pattern', prompt: 'Tor.', refs: ['lookbook/tor.png'], n: 1, size: 'portrait', shot });
  assert.equal(started.status, 201);
  const events = await readEvents(`${base}/books/book/imagegen/jobs/${started.data.id}/events?token=${token}`);
  assert.match(events, /"type":"image","path":"lookbook\/\.candidates\/[^"]+\/1\.png"/);
  assert.match(events, /event: end/);

  const tree = (await call('GET', '/books/book/tree')).data;
  assert.equal(tree.candidates.length, 1);
  const cand = tree.candidates[0];
  const img = await fetch(`${base}/books/book/image?path=${encodeURIComponent(cand.path)}`);
  assert.equal(img.status, 200, 'candidates are served despite the dot folder');
  assert.equal((await fetch(`${base}/books/book/image?path=${encodeURIComponent('lookbook/.secret/x.png')}`)).status, 404);

  const kept = await call('POST', '/books/book/candidates/keep', { path: cand.path, name: 'Tor portrait' });
  assert.equal(kept.data.path, 'lookbook/tor-portrait.png');
  const again = await call('POST', '/books/book/imagegen/jobs', { provider: 'fake', model: 'pattern', prompt: 'Again.', n: 2 });
  await readEvents(`${base}/books/book/imagegen/jobs/${again.data.id}/events?token=${token}`);
  assert.equal((await call('DELETE', `/books/book/candidates?job=${again.data.id}`)).status, 200);
  assert.deepEqual((await call('GET', '/books/book/tree')).data.candidates, []);
  assert.equal((await call('GET', '/books/book/imagegen/jobs/nope/events')).status, 404);
});
