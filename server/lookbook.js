import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest, conflict, notFound } from './errors.js';
import { slugify, titleize } from './names.js';
import { resolveInBook } from './paths.js';
import { applyMoves } from './structure.js';

// The lookbook is the book's picture folder: images in lookbook/, each with
// an optional note of the same name that says which codex entries it shows:
//
//   lookbook/tor-at-the-well.jpg
//   lookbook/tor-at-the-well.md   ---
//                                 of:
//                                   - codex/characters/tor.md
//                                 ---
//                                 ![Tor at the well](tor-at-the-well.jpg)
//
//                                 Caption.
//
// The image line makes the note show its picture in Obsidian; the editor
// reads the caption from what follows it.

export const LOOKBOOK = 'lookbook';
export const MAX_IMAGE_BYTES = 14 * 1024 * 1024; // fits the 20 MB JSON body as base64
export const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };

export const isImagePath = (rel) => Object.hasOwn(IMAGE_TYPES, path.posix.extname(rel).slice(1).toLowerCase());
const notePathOf = (rel) => rel.replace(/\.[^./]+$/, '.md');

// The format from the file's first bytes, so an image's extension always
// matches what it is.
export function sniffImage(buf) {
  const ascii = (from, to) => buf.subarray(from, to).toString('latin1');
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'avif';
  return null;
}

// --- the note -----------------------------------------------------------------

function splitFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? { front: m[1].split(/\r?\n/), body: text.slice(m[0].length) } : { front: [], body: text };
}

function unquote(s) {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length > 1) {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length > 1) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

const quote = (s) => (/^[\w./ -]+$/.test(s) && s.trim() === s ? s : JSON.stringify(s));

// The `of:` key's lines in the front matter: [start, end).
function ofRange(front) {
  const start = front.findIndex((l) => /^of\s*:/.test(l));
  if (start === -1) return null;
  let end = start + 1;
  if (!front[start].replace(/^of\s*:/, '').trim()) {
    while (end < front.length && /^\s*-(\s|$)/.test(front[end])) end += 1;
  }
  return [start, end];
}

// Reads `of:` as a block list, an inline [a, b] list or a single value.
export function parseNote(text, imageName) {
  const { front, body } = splitFrontMatter(text);
  const range = ofRange(front);
  let of = [];
  if (range) {
    const inline = front[range[0]].replace(/^of\s*:/, '').trim();
    if (inline.startsWith('[')) of = inline.replace(/^\[|\]$/g, '').split(',').map(unquote);
    else if (inline) of = [unquote(inline)];
    else of = front.slice(range[0] + 1, range[1]).map((l) => unquote(l.replace(/^\s*-/, '')));
  }
  const lines = body.split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  const embed = /^!\[[^\]]*\]\(<?([^)>]*)>?\)\s*$/.exec(lines[0] ?? '');
  if (embed && decodeURI(embed[1]) === imageName) lines.shift();
  return { of: [...new Set(of.filter(Boolean))], caption: lines.join('\n').trim() };
}

// The note's text with new links and caption. Other front matter (tags,
// anything added in Obsidian) is kept. Returns '' when nothing is left to say.
export function writeNote(previous, { of, caption, imageName, title }) {
  const { front } = splitFrontMatter(previous);
  const range = ofRange(front);
  const ofLines = of.length ? ['of:', ...of.map((p) => `  - ${quote(p)}`)] : [];
  const rest = range ? [...front.slice(0, range[0]), ...front.slice(range[1])] : front;
  const insertAt = range ? range[0] : 0;
  const lines = [...rest.slice(0, insertAt), ...ofLines, ...rest.slice(insertAt)].filter((l, i, all) => l.trim() || i < all.length - 1);
  if (!lines.some((l) => l.trim()) && !caption) return '';
  const head = lines.some((l) => l.trim()) ? `---\n${lines.join('\n')}\n---\n\n` : '';
  const target = /[\s()<>]/.test(imageName) ? `<${imageName}>` : imageName;
  return `${head}![${title}](${target})\n${caption ? `\n${caption}\n` : ''}`;
}

// --- reading ------------------------------------------------------------------

async function readText(abs) {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function walkImages(root, rel) {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walkImages(root, child)));
    else if (e.isFile() && isImagePath(e.name)) out.push(child);
  }
  return out;
}

// Every image in the lookbook, by name:
//   [{ path, name, title, notePath, hasNote, of: [codex paths], caption, size, mtime }]
export async function listLookbook(root) {
  const items = [];
  for (const rel of await walkImages(root, LOOKBOOK)) {
    const abs = path.join(root, rel);
    const notePath = notePathOf(rel);
    const [stat, note] = await Promise.all([fs.stat(abs), readText(path.join(root, notePath))]);
    const name = path.posix.basename(rel);
    items.push({
      path: rel,
      name,
      title: titleize(name.replace(/\.[^.]+$/, '')),
      notePath,
      hasNote: note !== null,
      ...(note === null ? { of: [], caption: '' } : parseNote(note, name)),
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
    });
  }
  const base = (p) => p.replace(/\.[^./]+$/, '');
  return items.sort((a, b) => base(a.path).localeCompare(base(b.path), undefined, { numeric: true }) || a.path.localeCompare(b.path));
}

// --- changing -----------------------------------------------------------------

function requireImagePath(rel) {
  const ok = typeof rel === 'string'
    && rel.startsWith(`${LOOKBOOK}/`)
    && !rel.split('/').includes('..')
    && isImagePath(rel);
  if (!ok) throw badRequest('Only images in lookbook/ can be changed here');
}

async function requireExists(root, rel) {
  try {
    await fs.access(await resolveInBook(root, rel));
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound(`No such file: ${rel}`);
    throw err;
  }
}

// Links must point at existing Markdown files in codex/.
async function checkLinks(root, of) {
  if (!Array.isArray(of) || of.some((p) => typeof p !== 'string')) throw badRequest('`of` must be a list of codex paths');
  const unique = [...new Set(of)];
  for (const p of unique) {
    if (!p.startsWith('codex/') || p.split('/').includes('..') || !p.toLowerCase().endsWith('.md')) {
      throw badRequest(`Images can only be linked to codex entries, not ${p}`);
    }
    await requireExists(root, p);
  }
  return unique;
}

async function saveNote(root, imageRel, { of, caption }) {
  const notePath = notePathOf(imageRel);
  const abs = await resolveInBook(root, notePath);
  const previous = (await readText(abs)) ?? '';
  const name = path.posix.basename(imageRel);
  const text = writeNote(previous, { of, caption, imageName: name, title: titleize(name.replace(/\.[^.]+$/, '')) });
  if (text) {
    await fs.writeFile(abs, text);
    return previous ? [] : [notePath];
  }
  if (previous) await fs.rm(abs);
  return [];
}

// A name in lookbook/ that no image or note uses yet: slug.ext, slug-2.ext, ...
async function freeName(root, slug, ext) {
  const taken = new Set((await fs.readdir(path.join(root, LOOKBOOK)).catch(() => []))
    .map((n) => n.toLowerCase().replace(/\.[^.]+$/, '')));
  let base = slug;
  for (let n = 2; taken.has(base); n += 1) base = `${slug}-${n}`;
  return `${LOOKBOOK}/${base}.${ext}`;
}

// Adds an image sent as base64. Its name comes from `filename` (or `name`),
// its extension from its content.
export async function addImage(root, { filename, name, data, of = [], caption = '' } = {}) {
  if (typeof data !== 'string' || !data) throw badRequest('Missing image data');
  const buf = Buffer.from(data, 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw badRequest(`Images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const ext = sniffImage(buf);
  if (!ext) throw badRequest('That isn’t a PNG, JPEG, GIF, WebP or AVIF image');
  const links = await checkLinks(root, of);
  const slug = slugify(String(name || filename || '').replace(/\.[^.]+$/, '')) || 'image';

  await fs.mkdir(path.join(root, LOOKBOOK), { recursive: true });
  const rel = await freeName(root, slug, ext);
  const abs = await resolveInBook(root, rel);
  try {
    await fs.writeFile(abs, buf, { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw conflict(`${rel} already exists`);
    throw err;
  }
  const created = [rel, ...(await saveNote(root, rel, { of: links, caption: String(caption).trim() }))];
  return { path: rel, moves: [], created, deleted: [] };
}

// Changes an image's links or caption, or renames it (with its note).
export async function updateImage(root, rel, { of, caption, name } = {}) {
  requireImagePath(rel);
  await requireExists(root, rel);
  let target = rel;
  let moves = [];
  if (name !== undefined) {
    const slug = slugify(name ?? '');
    if (!slug) throw badRequest('Give a name with at least one letter or number');
    const ext = path.posix.extname(rel);
    target = `${path.posix.dirname(rel)}/${slug}${ext}`;
    if (target !== rel) {
      // Images share a note by base name, so x.jpg can't sit beside x.png.
      const own = path.posix.basename(rel).toLowerCase().replace(/\.[^.]+$/, '');
      const clash = (await fs.readdir(path.join(root, path.posix.dirname(rel))))
        .find((n) => n.toLowerCase().replace(/\.[^.]+$/, '') === slug && slug !== own);
      if (clash) throw conflict(`${path.posix.dirname(rel)}/${clash} already uses that name`);
      const note = notePathOf(rel);
      const hasNote = (await readText(path.join(root, note))) !== null;
      moves = await applyMoves(root, [{ from: rel, to: target }, ...(hasNote ? [{ from: note, to: notePathOf(target) }] : [])]);
    }
  }
  const created = [];
  if (of !== undefined || caption !== undefined || moves.length) {
    const current = parseNote((await readText(path.join(root, notePathOf(target)))) ?? '', path.posix.basename(target));
    const next = {
      of: of === undefined ? current.of : await checkLinks(root, of),
      caption: caption === undefined ? current.caption : String(caption).trim(),
    };
    created.push(...(await saveNote(root, target, next)));
  }
  return { path: target, moves, created, deleted: [] };
}

export async function deleteImage(root, rel) {
  requireImagePath(rel);
  await requireExists(root, rel);
  const deleted = [rel];
  await fs.rm(await resolveInBook(root, rel));
  const note = notePathOf(rel);
  if ((await readText(path.join(root, note))) !== null) {
    await fs.rm(path.join(root, note));
    deleted.push(note);
  }
  return { moves: [], created: [], deleted };
}

// A codex entry was renamed (`to`) or deleted (`to` null): follow it in every
// note that links to it. Returns the notes it changed.
export async function relinkCodex(root, from, to) {
  const changed = [];
  for (const item of await listLookbook(root)) {
    if (!item.of.includes(from)) continue;
    const of = to ? item.of.map((p) => (p === from ? to : p)) : item.of.filter((p) => p !== from);
    await saveNote(root, item.path, { of: [...new Set(of)], caption: item.caption });
    changed.push(item.notePath);
  }
  return changed;
}
