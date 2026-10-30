import { api } from './api.js';
import { h, imageSrc, toast } from './ui.js';

// Generating images on this machine (ComfyUI), or with whatever providers the
// server offers: the Generate row in the Stage dialog, and following a job's
// progress anywhere.

const PREFS_KEY = 'book-editor.generate';

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // private window: not remembered
  }
}

// Follows a job's events until it's over. Returns a function that stops.
//   onEvent({ type, … })   onEnd()
export function watchJob(bookId, jobId, onEvent, onEnd = () => {}) {
  const source = new EventSource(api.imageJobEventsUrl(bookId, jobId));
  let over = false;
  const stop = () => {
    if (over) return;
    over = true;
    source.close();
    onEnd();
  };
  source.onmessage = (e) => onEvent(JSON.parse(e.data));
  source.addEventListener('end', stop);
  source.onerror = () => {
    // The server forgot the job (restart): stop rather than retry forever.
    if (source.readyState === EventSource.CLOSED) stop();
  };
  return stop;
}

// A job's progress in words, from its events so far.
export function jobStatus(state) {
  if (state.error) return state.error;
  if (state.done) return state.cancelled ? 'Cancelled.' : `Done: ${state.images} ${state.images === 1 ? 'image' : 'images'}.`;
  if (!state.started) return state.position ? `Waiting for ${state.position} ${state.position === 1 ? 'job' : 'jobs'} ahead…` : 'Starting…';
  const pct = Math.round((state.fraction ?? 0) * 100);
  return state.n > 1 ? `Making image ${state.index + 1} of ${state.n}… ${pct}%` : `Making the image… ${pct}%`;
}

// Folds one event into a job's state.
export function jobReduce(state, e) {
  switch (e.type) {
    case 'queued': return { ...state, position: e.position };
    case 'start': return { ...state, started: true };
    case 'progress': return { ...state, started: true, index: e.index, n: e.n, fraction: e.fraction };
    case 'image': return { ...state, images: (state.images ?? 0) + 1, paths: [...(state.paths ?? []), e.path] };
    case 'error': return { ...state, error: e.message };
    case 'done': return { ...state, done: true, cancelled: e.cancelled, images: e.images.length };
    default: return state;
  }
}

// The Generate row for the Stage dialog.
//   getJob() → { prompt, refs: [lookbook paths], shot }
//   onModel(model): the chosen model changed (so the dialog can cap references)
//   onCandidates(): show the candidates in the Lookbook
// Returns { el, refresh() } — refresh() rechecks limits after the refs change.
export function generateRow({ bookId, getJob, onModel = () => {}, onCandidates }) {
  const prefs = loadPrefs();
  let providers = [];
  let sizes = {};
  let maxImages = 4;
  let running = null; // { id, stop }

  const modelEl = h('select', { 'aria-label': 'Image model' }, h('option', { value: '' }, 'Checking for image generators…'));
  const sizeEl = h('select', { 'aria-label': 'Image shape' });
  const countEl = h('select', { 'aria-label': 'How many images' });
  const goBtn = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => start() }, 'Generate');
  const cancelBtn = h('button', { type: 'button', hidden: true, onclick: () => running && api.cancelImageJob(bookId, running.id).catch((err) => toast(err.message, { error: true })) }, 'Cancel');
  const statusEl = h('p', { class: 'field-hint generate-status' });
  const recheck = h('button', { type: 'button', class: 'link', onclick: () => load() }, 'Check again');
  const startBtn = h('button', { type: 'button', onclick: () => startApp() }, 'Start');
  const freeBtn = h('button', {
    type: 'button',
    class: 'link',
    title: 'Unload the model so the memory is free for other apps (it also happens on its own after a while)',
    onclick: () => freeMemory(),
  }, 'Unload the model');
  const resultsEl = h('div', { class: 'generate-results' });

  const chosen = () => {
    const [pid, mid] = modelEl.value.split('\n');
    const provider = providers.find((p) => p.id === pid);
    return { provider, model: provider?.models.find((m) => m.id === mid) };
  };

  function refresh() {
    const { provider, model } = chosen();
    const refs = getJob().refs.length;
    let problem = '';
    if (!providers.length) problem = '';
    else if (!provider) problem = 'No image generator is set up. See “Generating on this Mac” in the README.';
    else if (!provider.ok) problem = provider.message;
    else if (!model?.ready) problem = model?.problem || 'This model isn’t ready.';
    else if (refs > model.maxRefs) problem = `${model.label} takes at most ${model.maxRefs} reference ${model.maxRefs === 1 ? 'image' : 'images'}; this shot has ${refs}. Untick some, or lower “Up to”.`;
    else if (!getJob().prompt.trim()) problem = 'The prompt is empty.';
    goBtn.disabled = Boolean(problem) || Boolean(running);
    if (!running) {
      startBtn.textContent = `Start ${provider?.label.replace(/ on this Mac$/, '') ?? ''}`;
      const canStart = provider && !provider.running && provider.canStart;
      statusEl.replaceChildren(...(problem
        ? [problem, ' ', canStart ? startBtn : null, ' ', recheck].filter(Boolean)
        : [model?.description || '', provider?.canFree && provider.running ? [' ', freeBtn] : []].flat()));
      statusEl.classList.toggle('warning', Boolean(problem));
    }
  }

  // Opens the generator's app and waits for it to answer.
  async function startApp() {
    const { provider } = chosen();
    startBtn.disabled = true;
    statusEl.classList.remove('warning');
    statusEl.textContent = `Starting ${provider.label.replace(/ on this Mac$/, '')}… This can take a minute.`;
    try {
      const fresh = await api.startImageProvider(provider.id);
      providers = providers.map((p) => (p.id === fresh.id ? fresh : p));
      fillModels();
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.classList.add('warning');
      statusEl.append(' ', recheck);
    } finally {
      startBtn.disabled = false;
    }
  }

  async function freeMemory() {
    const { provider } = chosen();
    try {
      const { freed } = await api.freeImageProvider(provider.id);
      toast(freed ? `${provider.label.replace(/ on this Mac$/, '')} unloaded the model` : 'It wasn’t running');
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async function load() {
    statusEl.textContent = 'Checking…';
    try {
      ({ providers, sizes, maxImages } = await api.imageProviders());
    } catch (err) {
      statusEl.textContent = err.message;
      return;
    }
    fillModels();
  }

  function fillModels() {
    const options = providers.flatMap((p) => p.models.map((m) => h('option', { value: `${p.id}\n${m.id}` }, `${m.label} · ${p.label}${m.ready && p.ok ? '' : ' (not ready)'}`)));
    modelEl.replaceChildren(...(options.length ? options : [h('option', { value: '' }, 'No image generators')]));
    const ready = providers.flatMap((p) => (p.ok ? p.models.filter((m) => m.ready).map((m) => `${p.id}\n${m.id}`) : []));
    const values = providers.flatMap((p) => p.models.map((m) => `${p.id}\n${m.id}`));
    modelEl.value = values.includes(prefs.model) ? prefs.model : ready[0] ?? values[0] ?? '';
    sizeEl.replaceChildren(...Object.entries(sizes).map(([k, s]) => h('option', { value: k }, `${s.label} (${s.width}×${s.height})`)));
    sizeEl.value = sizes[prefs.size] ? prefs.size : 'square';
    countEl.replaceChildren(...Array.from({ length: maxImages }, (_, i) => h('option', { value: String(i + 1) }, `× ${i + 1}`)));
    countEl.value = String(Math.min(prefs.n ?? 2, maxImages));
    changed();
  }

  function changed() {
    Object.assign(prefs, { model: modelEl.value, size: sizeEl.value, n: Number(countEl.value) });
    savePrefs(prefs);
    const { model } = chosen();
    if (model) onModel(model);
    refresh();
  }
  for (const el of [modelEl, sizeEl, countEl]) el.addEventListener('change', changed);

  async function start() {
    const { provider, model } = chosen();
    const job = getJob();
    goBtn.disabled = true;
    let started;
    try {
      started = await api.startImageJob(bookId, {
        provider: provider.id, model: model.id, size: sizeEl.value, n: Number(countEl.value), ...job,
      });
    } catch (err) {
      toast(err.message, { error: true, ms: 8000 });
      refresh();
      return;
    }
    let state = { n: Number(countEl.value) };
    statusEl.classList.remove('warning');
    cancelBtn.hidden = false;
    running = { id: started.id };
    running.stop = watchJob(bookId, started.id, (e) => {
      state = jobReduce(state, e);
      statusEl.textContent = jobStatus(state);
      statusEl.classList.toggle('warning', Boolean(state.error));
      if (e.type === 'image') {
        resultsEl.append(h('a', { class: 'thumb', href: imageSrc(bookId, { path: e.path }), target: '_blank', rel: 'noopener', title: 'Open full size' },
          h('img', { src: imageSrc(bookId, { path: e.path }), alt: `Candidate ${e.index}` })));
        resultsEl.hidden = false;
        candidatesLink.hidden = false;
      }
    }, () => {
      running = null;
      cancelBtn.hidden = true;
      refresh();
      statusEl.textContent = state.done || state.error ? jobStatus(state) : 'Lost track of the job; its images will still appear in the Lookbook.';
      statusEl.classList.toggle('warning', Boolean(state.error));
    });
  }

  const candidatesLink = h('button', { type: 'button', class: 'link', hidden: true, onclick: () => onCandidates() }, 'Keep or discard them in the Lookbook →');
  resultsEl.hidden = true;
  load();
  return {
    el: h('div', { class: 'generate' },
      h('div', { class: 'stage-row generate-row' }, modelEl, sizeEl, countEl, goBtn, cancelBtn),
      statusEl,
      resultsEl,
      candidatesLink),
    refresh,
    close: () => running?.stop(),
  };
}
