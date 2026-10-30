import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleize } from '../names.js';

// ComfyUI workflows in its API format (Export (API) in ComfyUI), kept as
// files in imagegen/workflows/. The editor fills in the nodes whose title
// starts with "EDITOR:" and leaves the rest alone:
//
//   EDITOR:prompt     a text node: `text` is set to the prompt
//   EDITOR:negative   a text node: `text` is set to the negative prompt, if any
//   EDITOR:ref1 …     LoadImage nodes: `image` is set to each reference
//   EDITOR:seed       `seed` or `noise_seed` is set
//   EDITOR:size       `width` and `height` are set (any number of nodes)
//   EDITOR:save       the SaveImage node whose images come back
//
// Reference nodes the shot doesn't use are taken out, and the nodes that
// only made sense with them are bypassed the way ComfyUI bypasses a node:
// whatever used one of them gets that node's input of the same type
// instead. So one workflow with four reference chains also works with one
// reference, or none.
//
// A file may carry `"_editor": { "label": "…", "description": "…" }`; keys
// starting with "_" are never sent to ComfyUI.

export const WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'imagegen', 'workflows');

const titleOf = (node) => String(node?._meta?.title ?? '').trim();
export const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);

// Node ids titled EDITOR:<name>.
export function editorNodes(graph, name) {
  return Object.keys(graph).filter((id) => titleOf(graph[id]) === `EDITOR:${name}`);
}

// How many references the workflow takes: EDITOR:ref1, ref2, … with no gaps.
export function refCount(graph) {
  let n = 0;
  while (editorNodes(graph, `ref${n + 1}`).length) n += 1;
  return n;
}

// Reads one workflow file: { id, label, description, graph, maxRefs, error }.
// `error` says why it can't be used (it's still listed, so the writer sees it).
export function parseWorkflow(id, text) {
  const out = { id, label: titleize(id), description: '', graph: null, maxRefs: 0, error: '' };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ...out, error: `Not valid JSON: ${err.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...out, error: 'Not a ComfyUI workflow' };
  const meta = raw._editor ?? {};
  const graph = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
  out.label = typeof meta.label === 'string' && meta.label ? meta.label : out.label;
  out.description = typeof meta.description === 'string' ? meta.description : '';
  if (Array.isArray(raw.nodes)) return { ...out, error: 'This is the UI format; export it with Export (API) instead' };
  if (!Object.values(graph).every((n) => n && typeof n.class_type === 'string')) return { ...out, error: 'Not in ComfyUI’s API format' };
  if (!editorNodes(graph, 'prompt').length) return { ...out, error: 'No node titled EDITOR:prompt' };
  if (editorNodes(graph, 'save').length !== 1) return { ...out, error: 'Needs exactly one node titled EDITOR:save' };
  return { ...out, graph, maxRefs: refCount(graph) };
}

export async function loadWorkflows(dir = WORKFLOWS_DIR) {
  let names;
  try {
    names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.json')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return Promise.all(names.map(async (n) => parseWorkflow(n.replace(/\.json$/i, ''), await fs.readFile(path.join(dir, n), 'utf8'))));
}

// --- node types, from ComfyUI's /object_info ---------------------------------------

// A node class's inputs in order: [{ name, type, required, options }].
// `options` is the list of choices for a combo input (model files and such).
export function inputSpecs(info, cls) {
  const def = info?.[cls];
  if (!def) return [];
  const specs = [];
  for (const group of ['required', 'optional']) {
    const inputs = def.input?.[group] ?? {};
    const order = def.input_order?.[group] ?? Object.keys(inputs);
    for (const name of order) {
      const spec = inputs[name];
      if (!spec) continue;
      const [type, opts] = spec;
      const options = Array.isArray(type) ? type : type === 'COMBO' && Array.isArray(opts?.options) ? opts.options : null;
      specs.push({ name, type: options ? 'COMBO' : type, required: group === 'required', options });
    }
  }
  return specs;
}

const outputType = (info, cls, slot) => info?.[cls]?.output?.[slot] ?? null;

// The graph without the nodes `ids`, bypassing what depended on them (see
// above). Throws if that takes out the EDITOR:save node.
export function removeNodes(graph, ids, info) {
  const g = structuredClone(graph);
  const removed = new Set(ids);

  // Where a removed node's output `slot` passes through to: its first input
  // of the same type, followed back past other removed nodes. Null if none.
  const passThrough = (id, slot, seen = new Set()) => {
    if (!removed.has(id)) return [id, slot];
    if (seen.has(id) || !g[id]) return null;
    seen.add(id);
    const node = g[id];
    const type = outputType(info, node.class_type, slot);
    if (!type) return null;
    for (const spec of inputSpecs(info, node.class_type)) {
      const v = node.inputs?.[spec.name];
      if (spec.type === type && isLink(v)) {
        const to = passThrough(v[0], v[1], seen);
        if (to) return to;
      }
    }
    return null;
  };

  for (let changed = true; changed;) {
    changed = false;
    for (const [id, node] of Object.entries(g)) {
      if (removed.has(id)) continue;
      for (const [name, v] of Object.entries(node.inputs ?? {})) {
        if (!isLink(v) || !removed.has(v[0])) continue;
        const to = passThrough(v[0], v[1]);
        const spec = inputSpecs(info, node.class_type).find((s) => s.name === name);
        if (to) node.inputs[name] = to;
        else if (spec && !spec.required) delete node.inputs[name];
        else {
          removed.add(id);
          changed = true;
          break;
        }
      }
    }
  }
  for (const id of removed) {
    if (titleOf(g[id]) === 'EDITOR:save') throw new Error('Leaving out the unused references would also take out the EDITOR:save node');
    delete g[id];
  }
  return g;
}

// The graph to queue: the workflow with the prompt, references (as names
// ComfyUI knows them by), seed and size filled in, unused references taken out.
export function fillWorkflow(graph, { prompt, negative = '', refs = [], seed, size }, info) {
  const max = refCount(graph);
  if (refs.length > max) throw new Error(`This workflow takes at most ${max} reference ${max === 1 ? 'image' : 'images'}`);
  const unused = [];
  for (let i = refs.length + 1; i <= max; i += 1) unused.push(...editorNodes(graph, `ref${i}`));
  const g = removeNodes(graph, unused, info);
  const set = (name, fn) => {
    for (const id of editorNodes(g, name)) {
      g[id].inputs ??= {};
      fn(g[id].inputs);
    }
  };
  set('prompt', (inputs) => { inputs.text = prompt; });
  set('negative', (inputs) => { inputs.text = negative; });
  refs.forEach((name, i) => set(`ref${i + 1}`, (inputs) => { inputs.image = name; }));
  if (seed !== undefined) {
    set('seed', (inputs) => {
      const key = ['noise_seed', 'seed'].find((k) => k in inputs) ?? 'seed';
      inputs[key] = seed;
    });
  }
  if (size) set('size', (inputs) => { inputs.width = size.width; inputs.height = size.height; });
  set('save', (inputs) => { inputs.filename_prefix = 'book-editor/shot'; });
  return g;
}

// Model files and other choices the workflow names that this ComfyUI doesn't
// have: [{ node, input, value }]. Reference images aren't checked; they're
// uploaded when a job runs.
export function missingChoices(graph, info) {
  const out = [];
  for (const [id, node] of Object.entries(graph)) {
    if (/^EDITOR:ref\d+$/.test(titleOf(node))) continue;
    for (const spec of inputSpecs(info, node.class_type)) {
      const v = node.inputs?.[spec.name];
      if (spec.options && typeof v === 'string' && !spec.options.includes(v)) {
        out.push({ node: titleOf(node) || `${node.class_type} #${id}`, input: spec.name, value: v });
      }
    }
  }
  return out;
}

// Node classes the graph uses that ComfyUI doesn't know (missing custom nodes).
export const unknownClasses = (graph, info) => [...new Set(Object.values(graph).map((n) => n.class_type))].filter((c) => !info?.[c]);
