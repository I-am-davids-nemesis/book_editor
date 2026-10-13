import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest } from './errors.js';

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

// Nearest ancestor of `p` (or p itself) that exists, resolved through symlinks.
async function realpathOfExisting(p) {
  let current = p;
  for (;;) {
    try {
      return { real: await fs.realpath(current), rest: path.relative(current, p) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

// Resolve a book-relative path to an absolute one, refusing anything that
// escapes the book (.., absolute paths, symlinks out) or touches .git.
export async function resolveInBook(bookRoot, relPath) {
  if (typeof relPath !== 'string' || relPath === '') throw badRequest('Missing path');
  if (relPath.includes('\0')) throw badRequest('Invalid path');
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) throw badRequest('Path must be relative to the book');

  const root = path.resolve(bookRoot);
  const abs = path.resolve(root, relPath);
  if (!isInside(root, abs) || abs === root) throw badRequest('Path is outside the book');

  const rel = path.relative(root, abs);
  if (rel.split(path.sep).includes('.git')) throw badRequest('Cannot access .git');

  const realRoot = await fs.realpath(root);
  const { real, rest } = await realpathOfExisting(abs);
  if (!isInside(realRoot, path.join(real, rest))) throw badRequest('Path is outside the book');

  return abs;
}

// Book-relative path with forward slashes, for the client.
export function toRel(bookRoot, abs) {
  return path.relative(bookRoot, abs).split(path.sep).join('/');
}
