import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest, notFound } from './errors.js';
import {
  freeName, isImagePath, notePathOf, parseNote, readText, writeNote,
} from './lookbook.js';
import { slugify, titleize } from './names.js';
import { splitMade } from '../public/js/provenance.js';

// Generated images wait in lookbook/.candidates/<job>/ until the writer keeps
// or discards them:
//
//   lookbook/.candidates/20261030-142501-k3vq/1.png
//   lookbook/.candidates/20261030-142501-k3vq/1.md   of: …, status: candidate,
//                                                    and "How it was made"
//
// The folder is kept out of git through .git/info/exclude, so the book's own
// files (.gitignore) don't change. Keeping one moves it into lookbook/ with
// its note, where it's committed like any other image.

// Spelled out: lookbook.js and this module import each other through tree.js.
export const CANDIDATES = 'lookbook/.candidates';
export const JOB_ID = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
const KEEP_DAYS = 30;

export function newJobId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}

// Adds the candidates folder to the repo's exclude list, once.
export async function excludeCandidates(root) {
  const git = path.join(root, '.git');
  try {
    if (!(await fs.stat(git)).isDirectory()) return false;
  } catch {
    return false;
  }
  const file = path.join(git, 'info', 'exclude');
  const line = `/${CANDIDATES}/`;
  const text = (await readText(file)) ?? '';
  if (text.split(/\r?\n/).includes(line)) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# Generated images waiting to be kept (book editor)\n${line}\n`);
  return true;
}

// Writes one generated image and its note; returns the image's path.
export async function writeCandidate(root, job, n, { bytes, ext, of = [], made }) {
  if (!JOB_ID.test(job)) throw badRequest(`Not a job id: ${job}`);
  const dir = `${CANDIDATES}/${job}`;
  await fs.mkdir(path.join(root, dir), { recursive: true });
  const rel = `${dir}/${n}.${ext}`;
  await fs.writeFile(path.join(root, rel), bytes);
  const note = writeNote('', { of, caption: '', imageName: `${n}.${ext}`, title: `Candidate ${n}`, meta: { status: 'candidate' }, made });
  await fs.writeFile(path.join(root, notePathOf(rel)), note);
  return rel;
}

async function dirs(abs) {
  try {
    return (await fs.readdir(abs, { withFileTypes: true })).filter((e) => e.isDirectory() && JOB_ID.test(e.name)).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

// Every candidate, newest job first, in the order they were made:
//   [{ path, job, n, of, made, mtime }]
export async function listCandidates(root) {
  const out = [];
  for (const job of (await dirs(path.join(root, CANDIDATES))).sort().reverse()) {
    const files = await fs.readdir(path.join(root, CANDIDATES, job));
    const images = files.filter((f) => /^\d+\.\w+$/.test(f) && isImagePath(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const name of images) {
      const rel = `${CANDIDATES}/${job}/${name}`;
      const [stat, note] = await Promise.all([fs.stat(path.join(root, rel)), readText(path.join(root, notePathOf(rel)))]);
      const { made } = splitMade(note ?? '');
      out.push({ path: rel, job, n: parseInt(name, 10), of: parseNote(note ?? '', name).of, made, mtime: Math.round(stat.mtimeMs) });
    }
  }
  return out;
}

function requireCandidate(rel) {
  const parts = typeof rel === 'string' ? rel.split('/') : [];
  const ok = parts.length === 4 && `${parts[0]}/${parts[1]}` === CANDIDATES && JOB_ID.test(parts[2]) && /^\d+\.\w+$/.test(parts[3]) && isImagePath(rel);
  if (!ok) throw badRequest('Not a candidate image');
}

async function removeIfEmpty(abs) {
  try {
    if (!(await fs.readdir(abs)).length) await fs.rmdir(abs);
  } catch {
    // gone already, or not empty
  }
}

const exists = (abs) => fs.access(abs).then(() => true, () => false);

// Keeps a candidate: it moves into lookbook/ as <name>.<ext> with its note,
// no longer a candidate, and as a reference if asked.
//   { name, reference: bool, view, variant }
export async function keepCandidate(root, rel, { name, reference = false, view = '', variant = '' } = {}) {
  requireCandidate(rel);
  const abs = path.join(root, rel);
  if (!(await exists(abs))) throw notFound(`No such candidate: ${rel}`);
  const slug = slugify(String(name ?? '')) || 'shot';
  const ext = path.posix.extname(rel).slice(1);
  const target = await freeName(root, slug, ext);
  const imageName = path.posix.basename(target);
  const previous = (await readText(path.join(root, notePathOf(rel)))) ?? '';
  // Entries deleted since it was made are dropped.
  const of = [];
  for (const p of parseNote(previous, path.posix.basename(rel)).of) if (await exists(path.join(root, p))) of.push(p);
  const note = writeNote(previous, {
    of,
    caption: '',
    imageName,
    title: titleize(slug),
    meta: { status: '', use: reference ? 'reference' : '', view: reference ? view : '', variant: reference ? variant : '' },
  });
  await fs.copyFile(abs, path.join(root, target), fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(root, notePathOf(target)), note, { flag: 'wx' });
  await discardCandidates(root, { path: rel });
  return { path: target, moves: [], created: [target, notePathOf(target)], deleted: [] };
}

// Deletes one candidate ({ path }) or a whole job's ({ job }).
export async function discardCandidates(root, { path: rel, job } = {}) {
  if (job !== undefined) {
    if (!JOB_ID.test(job)) throw badRequest(`Not a job id: ${job}`);
    await fs.rm(path.join(root, CANDIDATES, job), { recursive: true, force: true });
  } else {
    requireCandidate(rel);
    await fs.rm(path.join(root, rel), { force: true });
    await fs.rm(path.join(root, notePathOf(rel)), { force: true });
    await removeIfEmpty(path.join(root, path.posix.dirname(rel)));
  }
  await removeIfEmpty(path.join(root, CANDIDATES));
  return { moves: [], created: [], deleted: [] };
}

// Deletes jobs older than `days` days; returns their ids.
export async function pruneCandidates(root, { days = KEEP_DAYS, now = Date.now() } = {}) {
  const gone = [];
  for (const job of await dirs(path.join(root, CANDIDATES))) {
    const abs = path.join(root, CANDIDATES, job);
    if (now - (await fs.stat(abs)).mtimeMs > days * 24 * 60 * 60 * 1000) {
      await fs.rm(abs, { recursive: true, force: true });
      gone.push(job);
    }
  }
  return gone;
}
