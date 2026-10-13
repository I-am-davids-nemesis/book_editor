import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveConfig } from './config.js';
import { badRequest, notFound } from './errors.js';
import { slugify, titleize } from './names.js';

// Books in the library root use their folder name as id. Books registered
// from elsewhere get a "~"-prefixed id stored in the config.
const REGISTERED_PREFIX = '~';

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function bookTitle(root) {
  try {
    const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    const m = /^#\s+(.+?)\s*$/m.exec(readme);
    if (m) return m[1];
  } catch {
    // no README; fall back to the folder name
  }
  return titleize(path.basename(root));
}

async function describe(id, root, source) {
  const present = await isDir(root);
  return {
    id,
    path: root,
    source,
    exists: present,
    title: present ? await bookTitle(root) : titleize(path.basename(root)),
    isGit: present && (await exists(path.join(root, '.git'))),
    hasManuscript: present && (await isDir(path.join(root, 'manuscript'))),
  };
}

async function realLibraryRoot(config) {
  const abs = path.resolve(config.libraryRoot);
  try {
    return await fs.realpath(abs);
  } catch {
    return abs;
  }
}

async function isLibraryChild(config, abs) {
  let real = abs;
  try {
    real = await fs.realpath(abs);
  } catch {
    // missing folder; compare as given
  }
  return path.dirname(real) === (await realLibraryRoot(config));
}

export async function listBooks(config) {
  const books = [];
  const libRoot = path.resolve(config.libraryRoot);
  let entries = [];
  try {
    entries = await fs.readdir(libRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      books.push(await describe(e.name, path.join(libRoot, e.name), 'library'));
    }
  }
  for (const [id, root] of Object.entries(config.registered)) {
    if (!(await isLibraryChild(config, root))) books.push(await describe(id, root, 'registered'));
  }
  return books.sort((a, b) => a.title.localeCompare(b.title));
}

export async function getBookRoot(config, id) {
  if (typeof id !== 'string' || id === '') throw notFound('No book id');
  if (id.startsWith(REGISTERED_PREFIX)) {
    const root = config.registered[id];
    if (!root) throw notFound(`Unknown book: ${id}`);
    if (!(await isDir(root))) throw notFound(`Book folder is missing: ${root}`);
    return root;
  }
  if (id.includes('/') || id.includes('\\') || id === '.' || id === '..' || id.startsWith('.')) {
    throw notFound(`Unknown book: ${id}`);
  }
  const root = path.join(path.resolve(config.libraryRoot), id);
  if (!(await isDir(root))) throw notFound(`Unknown book: ${id}`);
  return root;
}

export async function getBook(config, id) {
  const root = await getBookRoot(config, id);
  return describe(id, root, id.startsWith(REGISTERED_PREFIX) ? 'registered' : 'library');
}

// Register an existing folder. Returns the book's id (existing one if the
// folder is in the library or already registered).
export async function registerBook(config, folder) {
  if (typeof folder !== 'string' || !folder.trim()) throw badRequest('Missing folder path');
  let abs = folder.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(abs)) throw badRequest('Give an absolute path (or one starting with ~/)');
  abs = path.resolve(abs);
  if (!(await isDir(abs))) throw badRequest(`Not a folder: ${abs}`);
  abs = await fs.realpath(abs);

  if (await isLibraryChild(config, abs)) return path.basename(abs);
  for (const [id, root] of Object.entries(config.registered)) {
    if (root === abs) return id;
  }

  const base = REGISTERED_PREFIX + (slugify(path.basename(abs)) || 'book');
  let id = base;
  for (let n = 2; config.registered[id]; n++) id = `${base}-${n}`;
  config.registered[id] = abs;
  await saveConfig(config);
  return id;
}

export async function forgetBook(config, id) {
  if (!config.registered[id]) throw badRequest('Only books opened from outside the library can be removed from the list');
  delete config.registered[id];
  await saveConfig(config);
}
