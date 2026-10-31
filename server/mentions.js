import fs from 'node:fs/promises';
import path from 'node:path';
import { entryAliases } from '../public/js/worldmodel.js';
import { readSettings } from './compile.js';
import { badRequest, notFound } from './errors.js';
import { buildTree } from './tree.js';

// More scenes than this and the list is no help: Gather searches on its own.
export const MAX_SCENES = 60;

// The names a codex entry goes by: its title, its "# " heading without a
// trailing "(canon)"-style label, its first word for a person ("Tor" for
// "Tor Halloran"), and its `aliases`. One-letter names are left out.
export function entryNames(entry, markdown) {
  const heading = /^#\s+(.+?)\s*(\([^)]*\))?\s*$/m.exec(String(markdown))?.[1];
  const names = [entry.title, ...(heading ? [heading] : []), ...entryAliases(markdown)];
  if (entry.kind === 'character' && entry.title.includes(' ')) names.splice(1, 0, entry.title.split(' ')[0]);
  return [...new Set(names.map((n) => n.trim()))].filter((n) => n.length > 1);
}

// A name as a whole-word pattern. Case matters, since names are capitalized,
// except for the first letter: "the Count" also matches "The Count" at the
// start of a sentence. With `anyCase` (for a title made from a file name,
// "The Practice Yard"), case doesn't matter at all.
export function namePattern(name, { anyCase = false } = {}) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const first = name[0];
  const head = first.toLowerCase() === first.toUpperCase() ? escape(first) : `[${escape(first.toLowerCase())}${escape(first.toUpperCase())}]`;
  const rest = [...name.slice(1)].map((c) => ("'‘’".includes(c) ? "['‘’]" : escape(c))).join('');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${head}${rest}(?![\\p{L}\\p{N}_])`, `g${anyCase ? 'i' : ''}u`);
}

// The manuscript's scenes in book order. `all` is every file of the scene
// (the plain file and one per narration mode), searched for names; `files`
// is what Gather reads: only the `mode` file where the scene has one.
function scenesInOrder(tree, mode) {
  return tree.chapters.flatMap((ch) => ch.scenes.filter((s) => s.inManuscript).map((s) => {
    const all = [...(s.hasBase ? [s.manuscriptPath] : []), ...s.variants.map((v) => v.path)];
    const inMode = s.variants.find((v) => v.variant === mode);
    return { chapter: ch.title, title: s.title, files: inMode ? [inMode.path] : all, all };
  }));
}

// The scenes that name a codex entry, plus the scene before and after each,
// since "the yard" or "he" often carries on from a scene that names it. No
// model is involved; Gather reads only these. The book's `gather.mode` in
// book.json (a narration mode, such as "rotating-third") limits each scene
// to that mode's file.
//   { title, kind, names, mode, scenes: [{ chapter, title, files, hits }], tooMany }
// `hits` counts the names in the scene's files; 0 marks a neighbor. When more
// than MAX_SCENES would be listed, `scenes` is empty and `tooMany` is true.
export async function entryScenes(root, entryPath) {
  if (typeof entryPath !== 'string' || !entryPath.startsWith('codex/')) throw badRequest('Not a codex entry');
  const tree = await buildTree(root);
  const groups = [['characters', 'character'], ['locations', 'location'], ['notes', 'note']];
  const found = groups.flatMap(([g, kind]) => tree.codex[g].map((e) => ({ ...e, kind }))).find((e) => e.path === entryPath);
  if (!found) throw notFound(`No such codex entry: ${entryPath}`);
  const names = entryNames(found, await fs.readFile(path.join(root, entryPath), 'utf8'));
  const patterns = names.map((n) => namePattern(n, { anyCase: n === found.title }));

  const mode = (await readSettings(root)).gather?.mode;
  const scenes = scenesInOrder(tree, typeof mode === 'string' && mode ? mode : null);
  const hits = await Promise.all(scenes.map(async (s) => {
    const texts = await Promise.all(s.all.map((f) => fs.readFile(path.join(root, f), 'utf8').catch(() => '')));
    return texts.reduce((n, t) => n + patterns.reduce((k, p) => k + (t.match(p)?.length ?? 0), 0), 0);
  }));
  const keep = new Set();
  hits.forEach((n, i) => {
    if (n) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < scenes.length) keep.add(j);
  });
  const about = { title: found.title, kind: found.kind, names, mode: mode || null };
  if (keep.size > MAX_SCENES) return { ...about, scenes: [], tooMany: true };
  return { ...about, scenes: [...keep].sort((a, b) => a - b).map((i) => {
    const { all, ...scene } = scenes[i];
    return { ...scene, hits: hits[i] };
  }), tooMany: false };
}
