import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_FINDER_MODEL } from './claude.js';
import { entryScenes } from './mentions.js';

// Gather's first reader: a small model reads the scenes that name a codex
// entry (see mentions.js) and copies out every passage that describes it.
// No model writes anything here; the editor checks each quote word for word
// against its scene, drops the ones that don't match, and writes the rest to
// a scratch file outside the book for the Gather run to work from.

// Scenes go to the model in batches of about this many characters, a few
// batches at a time.
export const BATCH_CHARS = 80000;
const PARALLEL = 3;
const BATCH_TIMEOUT_MS = 4 * 60 * 1000;

const KIND_FOCUS = {
  character: 'appearance (face, build, hair, scars, age), clothing, posture and movement, voice, habits and mannerisms',
  location: 'layout and size, materials, light at different times, weather, sounds, smells, and the objects in it',
  note: 'anything visual or sensory',
};

const SYSTEM = 'You copy passages out of a novel\'s scenes, exactly as written. You never paraphrase, invent or fix a quote. You answer with JSON only.';

export function finderPrompt(entry, names, scenes) {
  const focus = KIND_FOCUS[entry.kind] ?? KIND_FOCUS.note;
  const text = scenes.map((s) => `<scene file="${s.file}">\n${s.text.trim()}\n</scene>`).join('\n\n');
  return `${text}

Above are scenes from a novel. Copy out every passage that describes ${entry.title} (a ${entry.kind}, also called ${names.map((n) => `“${n}”`).join(', ')}): ${focus}.

- Include indirect references (a pronoun, "the yard", a title) only when the scene makes clear they mean ${entry.title}.
- Include what others say or notice about ${entry.title}, and comparisons ("taller than Davie").
- Leave out passages that only name ${entry.title} without describing anything.
- Copy each quote exactly, character for character, one to three sentences. Don't join text from different places into one quote.

Answer with only a JSON array, [] if there is nothing:
[{"file": "<the scene's file, as given>", "quote": "<exact text>", "note": "<a few words: what it tells about ${entry.title}; for an indirect reference, how you know it's them>"}]`;
}

// Text as compared: typographic quotes and dashes made plain, emphasis marks
// dropped, runs of whitespace made one space.
export function normalize(s) {
  return String(s)
    .replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, '-').replace(/[*_]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Whether a quote is in the text, allowing "..." or "…" where the model left
// words out.
export function quoteIn(quote, text) {
  const t = normalize(text);
  const parts = normalize(quote).split(/\s*(?:\.\.\.|…)\s*/).filter((p) => p.length);
  return parts.length > 0 && parts.every((p) => t.includes(p));
}

// The JSON array in a model's answer, even with prose or a code fence around it.
export function parsePassages(answer) {
  const start = answer.indexOf('[');
  const end = answer.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const list = JSON.parse(answer.slice(start, end + 1));
    return Array.isArray(list) ? list.filter((p) => p && typeof p.file === 'string' && typeof p.quote === 'string' && p.quote.trim()) : [];
  } catch {
    return [];
  }
}

// Scene files in batches of about BATCH_CHARS (a longer scene goes alone).
export function batches(files, size = BATCH_CHARS) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const f of files) {
    if (cur.length && chars + f.text.length > size) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(f);
    chars += f.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function inParallel(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

const fileName = (entryPath) => `passages-${entryPath.replace(/\.md$/, '').replace(/[^\w-]+/g, '-')}.md`;

// Finds a codex entry's passages and writes them to the scratch file.
// Resolves with { found, file, count, dropped, failed }: `found` is
// entryScenes' answer; `file` is null when there were no scenes to read (or
// too many), and Gather falls back to reading on its own. `failed` counts
// batches the model couldn't answer; their scenes are listed as unread.
export async function findPassages(claude, root, entryPath, { model = DEFAULT_FINDER_MODEL, signal } = {}) {
  const found = await entryScenes(root, entryPath);
  const entry = { path: entryPath, title: found.title, kind: found.kind };
  if (!found.scenes.length) return { found, file: null, count: 0, dropped: 0, failed: 0 };
  const files = [];
  for (const s of found.scenes) {
    for (const f of s.files) files.push({ scene: s, file: f, text: await fs.readFile(path.join(root, f), 'utf8').catch(() => '') });
  }
  const byFile = new Map(files.map((f) => [f.file, f]));
  let failed = 0;
  const unread = new Set();
  const answers = await inParallel(batches(files.filter((f) => f.text.trim())), PARALLEL, async (batch) => {
    try {
      return { batch, list: parsePassages(await claude.complete(root, finderPrompt(entry, found.names, batch), { model, signal, system: SYSTEM, timeoutMs: BATCH_TIMEOUT_MS })) };
    } catch (err) {
      if (signal?.aborted) throw err;
      failed++;
      for (const f of batch) unread.add(f.file);
      return { batch, list: [] };
    }
  });

  let dropped = 0;
  const kept = new Map(); // file -> [{ quote, note }]
  for (const { batch, list } of answers) {
    const inBatch = new Set(batch.map((f) => f.file));
    for (const p of list) {
      const f = byFile.get(p.file.trim());
      if (!f || !inBatch.has(f.file) || !quoteIn(p.quote, f.text)) {
        dropped++;
        continue;
      }
      const quotes = kept.get(f.file) ?? [];
      if (!quotes.some((q) => normalize(q.quote) === normalize(p.quote))) quotes.push({ quote: p.quote.trim(), note: typeof p.note === 'string' ? p.note.trim() : '' });
      kept.set(f.file, quotes);
    }
  }

  const count = [...kept.values()].reduce((n, q) => n + q.length, 0);
  const lines = [
    `# Passages about ${entry.title}`,
    '',
    `Copied out of ${found.scenes.length} scenes by ${model} for Gather, on ${new Date().toLocaleDateString('sv')}. The editor searched for ${found.names.map((n) => `“${n}”`).join(', ')} and kept the scenes that name ${entry.title}, plus the scene before and after each. Every quote below was checked word for word against its scene${dropped ? `; ${dropped} that didn't match were dropped` : ''}.`,
    '',
  ];
  for (const f of files) {
    const quotes = kept.get(f.file);
    if (!quotes) continue;
    lines.push(`## ${f.scene.chapter}, “${f.scene.title}” (${f.file})`, '');
    for (const q of quotes) lines.push(`- “${q.quote.replace(/\s+/g, ' ')}”${q.note ? ` (${q.note})` : ''}`);
    lines.push('');
  }
  const empty = files.filter((f) => !kept.has(f.file) && !unread.has(f.file)).map((f) => f.file);
  if (empty.length) lines.push('## Read, with nothing found', '', ...empty.map((f) => `- ${f}`), '');
  if (unread.size) lines.push('## Not read (the first reader failed on these)', '', ...[...unread].map((f) => `- ${f}`), '');

  const dir = claude.scratchDir(root);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName(entry.path));
  await fs.writeFile(file, lines.join('\n'));
  return { found, file, count, dropped, failed };
}
