import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest, conflict, notFound } from './errors.js';
import { relinkCodex } from './lookbook.js';
import { applyMoves } from './structure.js';
import { slugify } from './names.js';
import { resolveInBook } from './paths.js';
import { renderTemplate } from './templates.js';
import { VISUAL_STYLE } from '../public/js/worldmodel.js';

const KINDS = {
  character: { dir: 'codex/characters', template: 'character' },
  location: { dir: 'codex/locations', template: 'location' },
  note: { dir: 'codex', template: 'note' },
};

function requireCodexPath(rel) {
  const ok = typeof rel === 'string'
    && !rel.split('/').includes('..')
    && path.posix.normalize(rel).startsWith('codex/')
    && rel.toLowerCase().endsWith('.md');
  if (!ok) {
    throw badRequest('Only Markdown files in codex/ can be changed here');
  }
}

export async function addCodexEntry(root, { kind, name } = {}) {
  const spec = KINDS[kind];
  if (!spec) throw badRequest(`kind must be one of: ${Object.keys(KINDS).join(', ')}`);
  const slug = slugify(name ?? '');
  if (!slug) throw badRequest('Give a name with at least one letter or number');

  const rel = `${spec.dir}/${slug}.md`;
  const abs = await resolveInBook(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const content = await renderTemplate(root, spec.template, { name: String(name).trim() });
  try {
    await fs.writeFile(abs, content, { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw conflict(`${rel} already exists`);
    throw err;
  }
  return { path: rel, moves: [], created: [rel], deleted: [] };
}

// Renames the file within its folder; the heading inside is left to the writer.
export async function renameCodexEntry(root, rel, { name } = {}) {
  requireCodexPath(rel);
  const slug = slugify(name ?? '');
  if (!slug) throw badRequest('Give a name with at least one letter or number');
  try {
    await fs.access(await resolveInBook(root, rel));
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound(`No such file: ${rel}`);
    throw err;
  }
  const to = `${path.posix.dirname(rel)}/${slug}.md`;
  const moves = await applyMoves(root, [{ from: rel, to }]);
  // Lookbook images that show this entry follow it.
  if (to !== rel) await relinkCodex(root, rel, to);
  return { path: to, moves, created: [], deleted: [] };
}

export async function deleteCodexEntry(root, rel) {
  requireCodexPath(rel);
  const abs = await resolveInBook(root, rel);
  try {
    await fs.rm(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound(`No such file: ${rel}`);
    throw err;
  }
  // Its images stay in the lookbook, unlinked from it.
  await relinkCodex(root, rel, null);
  return { moves: [], created: [], deleted: [rel] };
}

// The book's visual style note, at a fixed path so the editor, Claude and the
// writer all find it. Creates it from the template if it isn't there yet.
export async function addVisualStyle(root) {
  const abs = await resolveInBook(root, VISUAL_STYLE);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const content = await renderTemplate(root, 'visual-style', { name: 'Visual style' });
  try {
    await fs.writeFile(abs, content, { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return { path: VISUAL_STYLE, moves: [], created: [], deleted: [] };
    throw err;
  }
  return { path: VISUAL_STYLE, moves: [], created: [VISUAL_STYLE], deleted: [] };
}
