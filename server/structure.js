import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest, conflict, notFound } from './errors.js';
import { move } from './git.js';
import { parseSceneName, slugify, titleize } from './names.js';
import { renderTemplate } from './templates.js';
import { buildTree } from './tree.js';

// Chapter and scene operations. Each keeps manuscript/ and outline/ in step,
// and leaves prefixed entries numbered 1..n with a uniform width. Entries
// without a number prefix (made by hand) are left alone unless a reorder
// explicitly gives them a position.
//
// Every operation returns { moves: [{from, to}], created: [...], deleted: [...] }
// with book-relative paths, so the client can follow an open file.

const TREES = ['manuscript', 'outline'];
const CHAPTER_SUMMARY = '_chapter.md';

const prefixWidth = (n) => Math.max(2, String(n).length);
const pad = (i, w) => String(i).padStart(w, '0');

async function exists(abs) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function listNames(abs) {
  try {
    return (await fs.readdir(abs)).filter((n) => !n.startsWith('.'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function requireSlug(title) {
  const slug = slugify(title ?? '');
  if (!slug) throw badRequest('Give a title with at least one letter or number');
  return slug;
}

async function findChapter(root, name) {
  const tree = await buildTree(root);
  const ch = tree.chapters.find((c) => c.name === name);
  if (!ch) throw notFound(`No chapter named ${name}`);
  return { tree, ch };
}

function findScene(ch, name) {
  const scene = ch.scenes.find((s) => s.name === name);
  if (!scene) throw notFound(`No scene named ${name} in ${ch.name}`);
  return scene;
}

// Renames in two phases (everything to a temporary hidden name, then to the
// final name), so swapping two entries never collides.
export async function applyMoves(root, moves) {
  moves = moves.filter((m) => m.from !== m.to);
  const froms = new Set(moves.map((m) => m.from));
  for (const m of moves) {
    if (!froms.has(m.to) && (await exists(path.join(root, m.to)))) throw conflict(`${m.to} already exists`);
  }
  const staged = [];
  for (const [i, m] of moves.entries()) {
    const tmp = path.posix.join(path.posix.dirname(m.from), `.moving-${process.pid}-${i}-${path.posix.basename(m.from)}`);
    await move(root, m.from, tmp);
    staged.push({ ...m, tmp });
  }
  for (const m of staged) await move(root, m.tmp, m.to);
  return moves.map(({ from, to }) => ({ from, to }));
}

// --- name mapping ---------------------------------------------------------

function chapterMoves(ch, newName) {
  if (newName === ch.name) return [];
  const moves = [];
  if (ch.inManuscript) moves.push({ from: `manuscript/${ch.name}`, to: `manuscript/${newName}` });
  if (ch.inOutline) moves.push({ from: `outline/${ch.name}`, to: `outline/${newName}` });
  return moves;
}

// Every file belonging to a scene: the scene, its plot file, and variants.
async function sceneFiles(root, chapterName, sceneName) {
  const files = [];
  for (const t of TREES) {
    for (const file of await listNames(path.join(root, t, chapterName))) {
      if (parseSceneName(file)?.base === sceneName) files.push(`${t}/${chapterName}/${file}`);
    }
  }
  return files;
}

async function sceneMoves(root, chapterName, sceneName, newName) {
  if (newName === sceneName) return [];
  const oldStem = sceneName.replace(/\.md$/i, '');
  const newStem = newName.replace(/\.md$/i, '');
  return (await sceneFiles(root, chapterName, sceneName)).map((from) => {
    const file = path.posix.basename(from);
    return { from, to: `${path.posix.dirname(from)}/${newStem}${file.slice(oldStem.length)}` };
  });
}

const numberedChapter = (i, w, ch) => `${pad(i, w)}-${ch.slug}`;
const numberedScene = (i, w, s) => `${pad(i, w)}-${s.slug}.md`;

// Moves that renumber `entries` (in the given order) 1..n.
async function renumber(root, entries, kind, chapterName) {
  const w = prefixWidth(entries.length);
  const moves = [];
  for (const [i, e] of entries.entries()) {
    if (e.isNew) continue;
    if (kind === 'chapter') moves.push(...chapterMoves(e, numberedChapter(i + 1, w, e)));
    else moves.push(...(await sceneMoves(root, chapterName, e.name, numberedScene(i + 1, w, e))));
  }
  return moves;
}

const ordered = (list) => list.filter((e) => e.prefix !== null);

function insertAt(list, position, entry) {
  const at = position === undefined || position === null ? list.length : Math.min(Math.max(Number(position) - 1, 0), list.length);
  if (Number.isNaN(at)) throw badRequest('Invalid position');
  return [...list.slice(0, at), entry, ...list.slice(at)];
}

// --- chapters -------------------------------------------------------------

export async function addChapter(root, { title, position } = {}) {
  const slug = requireSlug(title);
  const tree = await buildTree(root);
  const entries = insertAt(ordered(tree.chapters), position, { isNew: true, slug });
  const moves = await applyMoves(root, await renumber(root, entries, 'chapter'));

  const i = entries.findIndex((e) => e.isNew);
  const name = numberedChapter(i + 1, prefixWidth(entries.length), { slug });
  await fs.mkdir(path.join(root, 'manuscript', name), { recursive: true });
  await fs.mkdir(path.join(root, 'outline', name), { recursive: true });
  const summary = `outline/${name}/${CHAPTER_SUMMARY}`;
  await fs.writeFile(path.join(root, summary), await renderTemplate(root, 'chapter-outline', { chapter: titleize(slug), name: titleize(slug) }));
  return { chapter: name, moves, created: [`manuscript/${name}`, summary], deleted: [] };
}

export async function renameChapter(root, chapter, { title } = {}) {
  const slug = requireSlug(title);
  const { ch } = await findChapter(root, chapter);
  const m = /^(\d+)[-_ ]/.exec(ch.name);
  const name = m ? `${m[1]}-${slug}` : slug;
  const moves = await applyMoves(root, chapterMoves(ch, name));
  return { chapter: name, moves, created: [], deleted: [] };
}

export async function deleteChapter(root, chapter) {
  const { tree, ch } = await findChapter(root, chapter);
  const deleted = [];
  for (const t of TREES) {
    const rel = `${t}/${ch.name}`;
    if (await exists(path.join(root, rel))) {
      await fs.rm(path.join(root, rel), { recursive: true, force: true });
      deleted.push(rel);
    }
  }
  const rest = ordered(tree.chapters).filter((c) => c.name !== ch.name);
  const moves = await applyMoves(root, await renumber(root, rest, 'chapter'));
  return { moves, created: [], deleted };
}

// `order` lists chapter names. It must include every numbered chapter; it may
// also include unnumbered ones, which then get a number.
export async function reorderChapters(root, { order } = {}) {
  const tree = await buildTree(root);
  const entries = pickOrder(tree.chapters, order);
  const moves = await applyMoves(root, await renumber(root, entries, 'chapter'));
  return { moves, created: [], deleted: [] };
}

function pickOrder(all, order) {
  if (!Array.isArray(order) || order.some((n) => typeof n !== 'string')) throw badRequest('order must be a list of names');
  if (new Set(order).size !== order.length) throw badRequest('order lists a name twice');
  const byName = new Map(all.map((e) => [e.name, e]));
  const unknown = order.filter((n) => !byName.has(n));
  if (unknown.length) throw badRequest(`Unknown in order: ${unknown.join(', ')}`);
  const missing = ordered(all).filter((e) => !order.includes(e.name));
  if (missing.length) throw badRequest(`order is missing: ${missing.map((e) => e.name).join(', ')}`);
  return order.map((n) => byName.get(n));
}

// --- scenes ---------------------------------------------------------------

export async function addScene(root, chapter, { title, position } = {}) {
  const slug = requireSlug(title);
  const { ch } = await findChapter(root, chapter);
  const entries = insertAt(ordered(ch.scenes), position, { isNew: true, slug });
  const moves = await applyMoves(root, await renumber(root, entries, 'scene', ch.name));

  const i = entries.findIndex((e) => e.isNew);
  const name = numberedScene(i + 1, prefixWidth(entries.length), { slug });
  const scenePath = `manuscript/${ch.name}/${name}`;
  const plotPath = `outline/${ch.name}/${name}`;
  await fs.mkdir(path.join(root, 'manuscript', ch.name), { recursive: true });
  await fs.mkdir(path.join(root, 'outline', ch.name), { recursive: true });
  await fs.writeFile(path.join(root, scenePath), '');
  await fs.writeFile(path.join(root, plotPath), await renderTemplate(root, 'scene-outline', { scene: titleize(slug), name: titleize(slug), chapter: ch.title }));
  return { scene: name, moves, created: [scenePath, plotPath], deleted: [] };
}

export async function renameScene(root, chapter, scene, { title } = {}) {
  const slug = requireSlug(title);
  const { ch } = await findChapter(root, chapter);
  const s = findScene(ch, scene);
  const m = /^(\d+)[-_ ]/.exec(s.name);
  const name = m ? `${m[1]}-${slug}.md` : `${slug}.md`;
  const moves = await applyMoves(root, await sceneMoves(root, ch.name, s.name, name));
  return { scene: name, moves, created: [], deleted: [] };
}

export async function deleteScene(root, chapter, scene) {
  const { ch } = await findChapter(root, chapter);
  const s = findScene(ch, scene);
  const deleted = await sceneFiles(root, ch.name, s.name);
  for (const rel of deleted) await fs.rm(path.join(root, rel), { force: true });
  const rest = ordered(ch.scenes).filter((e) => e.name !== s.name);
  const moves = await applyMoves(root, await renumber(root, rest, 'scene', ch.name));
  return { moves, created: [], deleted };
}

export async function reorderScenes(root, chapter, { order } = {}) {
  const { ch } = await findChapter(root, chapter);
  const entries = pickOrder(ch.scenes, order);
  const moves = await applyMoves(root, await renumber(root, entries, 'scene', ch.name));
  return { moves, created: [], deleted: [] };
}

// --- mirror repair ----------------------------------------------------------

// Creates the missing half of a chapter or scene: a chapter summary, a plot
// file, or an empty scene file. Only those three shapes are accepted.
export async function createMissing(root, rel) {
  const parts = typeof rel === 'string' ? rel.split('/') : [];
  if (parts.length !== 3 || !TREES.includes(parts[0]) || !parts[2].toLowerCase().endsWith('.md')) {
    throw badRequest('Can only create a missing scene, plot file or chapter summary');
  }
  const [tree, chapterName, file] = parts;
  const { ch } = await findChapter(root, chapterName);
  if (await exists(path.join(root, rel))) throw conflict(`${rel} already exists`);

  let content;
  if (tree === 'outline' && file === CHAPTER_SUMMARY) {
    content = await renderTemplate(root, 'chapter-outline', { chapter: ch.title, name: ch.title });
  } else {
    const s = findScene(ch, file);
    content = tree === 'outline'
      ? await renderTemplate(root, 'scene-outline', { scene: s.title, name: s.title, chapter: ch.title })
      : '';
  }
  await fs.mkdir(path.join(root, tree, ch.name), { recursive: true });
  await fs.writeFile(path.join(root, rel), content, { flag: 'wx' });
  return { moves: [], created: [rel], deleted: [] };
}
