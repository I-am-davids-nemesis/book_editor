import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { badRequest, HttpError, notFound } from './errors.js';
import { isImagePath, LOOKBOOK } from './lookbook.js';
import { slugify } from './names.js';
import { resolveInBook } from './paths.js';

// Handing references to an outside image generator: the chosen lookbook
// images are copied, numbered in prompt order (1-tor-face.png, …), to a fresh
// folder outside the book, and the folder is opened in Finder to drag from.

export const HANDOFF_DIR = path.join(os.tmpdir(), 'book-editor-handoff');
const KEEP_MS = 24 * 60 * 60 * 1000;

function openInFinder(dir) {
  if (process.platform !== 'darwin') throw new HttpError(501, 'Showing files in Finder only works on a Mac');
  return new Promise((resolve, reject) => {
    execFile('open', [dir], (err) => (err ? reject(err) : resolve()));
  });
}

// Removes handoff folders older than a day.
async function prune(base, now) {
  for (const e of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const abs = path.join(base, e.name);
    const { mtimeMs } = await fs.stat(abs);
    if (now - mtimeMs > KEEP_MS) await fs.rm(abs, { recursive: true, force: true });
  }
}

export async function prepareHandoff(root, { paths, name = 'images' } = {}, { base = HANDOFF_DIR, reveal = openInFinder, now = Date.now() } = {}) {
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== 'string')) throw badRequest('`paths` must list lookbook images');
  if (paths.length > 16) throw badRequest('At most 16 images can be handed off at once');
  const sources = [];
  for (const rel of paths) {
    if (!rel.startsWith(`${LOOKBOOK}/`) || rel.split('/').includes('..') || !isImagePath(rel)) {
      throw badRequest(`Only lookbook images can be handed off, not ${rel}`);
    }
    const abs = await resolveInBook(root, rel);
    try {
      await fs.access(abs);
    } catch {
      throw notFound(`No such file: ${rel}`);
    }
    sources.push({ rel, abs });
  }
  await prune(base, now);
  const dir = path.join(base, `${slugify(name) || 'images'}-${now}`);
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  for (const [i, { abs }] of sources.entries()) {
    const file = `${i + 1}-${path.basename(abs)}`;
    await fs.copyFile(abs, path.join(dir, file));
    files.push(file);
  }
  await reveal(dir);
  return { dir, files };
}
