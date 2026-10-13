import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest, conflict, notFound } from './errors.js';
import { resolveInBook, toRel } from './paths.js';

export function hashContent(content) {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

function requireMarkdown(rel) {
  if (!rel.toLowerCase().endsWith('.md')) throw badRequest('Only Markdown (.md) files can be opened');
}

export async function readBookFile(bookRoot, rel) {
  requireMarkdown(rel);
  const abs = await resolveInBook(bookRoot, rel);
  let content;
  try {
    content = await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound(`No such file: ${rel}`);
    if (err.code === 'EISDIR') throw badRequest(`Not a file: ${rel}`);
    throw err;
  }
  return { path: toRel(bookRoot, abs), content, hash: hashContent(content) };
}

// Saves only if the file on disk still matches `baseHash` (the hash the client
// loaded), unless `force` is set. A null baseHash means "expect a new file".
export async function writeBookFile(bookRoot, rel, content, { baseHash, force = false } = {}) {
  requireMarkdown(rel);
  if (typeof content !== 'string') throw badRequest('Missing content');
  const abs = await resolveInBook(bookRoot, rel);

  if (!force) {
    let current = null;
    try {
      current = await fs.readFile(abs, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const currentHash = current === null ? null : hashContent(current);
    if (currentHash !== (baseHash ?? null)) {
      throw conflict('The file changed on disk since it was opened', {
        path: toRel(bookRoot, abs),
        diskContent: current,
        diskHash: currentHash,
      });
    }
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, abs);
  return { path: toRel(bookRoot, abs), hash: hashContent(content) };
}
