import fs from 'node:fs/promises';
import path from 'node:path';
import { countWords } from '../public/js/wordcount.js';
import { badRequest, notFound } from './errors.js';
import { git, isRepo } from './git.js';
import { serialized } from './queue.js';
import { buildTree } from './tree.js';

export const DEFAULT_SEPARATOR = '* * *';
const SETTINGS_FILE = 'book.json';

// Per-book settings in a plain book.json at the root (optional):
//   { "compile": { "sceneSeparator": "⁂" } }
export async function readSettings(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, SETTINGS_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function checkSeparator(sep) {
  if (typeof sep !== 'string' || !sep.trim() || sep.length > 40 || /[\r\n]/.test(sep)) {
    throw badRequest('The scene separator must be one short line, such as * * * or ⁂');
  }
  return sep.trim();
}

async function saveSeparator(root, sep) {
  const settings = await readSettings(root);
  settings.compile = { ...(settings.compile || {}), sceneSeparator: sep };
  await fs.writeFile(path.join(root, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
}

// The file for a scene in a mode: its variant if there is one, otherwise the
// plain file, which belongs to every mode.
function sceneFileFor(scene, mode) {
  if (mode) {
    const v = scene.variants.find((x) => x.variant === mode);
    if (v) return v.path;
  }
  return scene.hasBase ? scene.manuscriptPath : null;
}

async function compileChapter(root, ch, { mode, separator, warnings }) {
  const parts = [];
  for (const s of ch.scenes) {
    if (!s.inManuscript) continue; // only planned in outline/
    const file = sceneFileFor(s, mode);
    if (!file) {
      warnings.push(`${ch.name}: “${s.title}” has no ${mode || 'main'} version`);
      continue;
    }
    const text = (await fs.readFile(path.join(root, file), 'utf8')).trim();
    if (text) parts.push(text);
    else warnings.push(`${ch.name}: “${s.title}” is empty`);
  }
  return { body: `# ${ch.title}\n\n${parts.join(`\n\n${separator}\n\n`)}\n`, scenes: parts.length };
}

const outName = (base, mode) => (mode ? `${base}.${mode}.md` : `${base}.md`);

// Joins scenes into one Markdown file for a chapter or the whole book, in one
// narration mode, and writes it to compiled/. Chapter headings come from the
// folder names; scenes are separated by the book's separator.
export async function compile(root, { scope = 'book', chapter, mode = '', separator, remember = false } = {}) {
  if (!['book', 'chapter'].includes(scope)) throw badRequest('scope must be book or chapter');
  if (typeof mode !== 'string' || (mode && !/^[A-Za-z0-9_-]+$/.test(mode))) throw badRequest('Invalid mode');
  const settings = await readSettings(root);
  const sep = separator !== undefined && separator !== null && separator !== ''
    ? checkSeparator(separator)
    : settings.compile?.sceneSeparator || DEFAULT_SEPARATOR;

  return serialized(root, async () => {
    if (remember && separator) await saveSeparator(root, sep);
    const tree = await buildTree(root);
    const known = ['', ...tree.modes];
    if (!known.includes(mode)) throw badRequest(`This book has no ${mode} mode`);
    let chapters = tree.chapters.filter((c) => c.inManuscript);
    if (scope === 'chapter') {
      chapters = chapters.filter((c) => c.name === chapter);
      if (!chapters.length) throw notFound(`No chapter ${chapter}`);
    }
    const warnings = [];
    const bodies = [];
    let scenes = 0;
    for (const ch of chapters) {
      const r = await compileChapter(root, ch, { mode, separator: sep, warnings });
      if (!r.scenes) continue;
      bodies.push(r.body);
      scenes += r.scenes;
    }
    if (!bodies.length) throw badRequest('Nothing to compile: no scenes with text in this mode');
    const content = bodies.join('\n');
    const file = `compiled/${outName(scope === 'book' ? 'book' : chapters[0].name, mode)}`;
    await fs.mkdir(path.join(root, 'compiled'), { recursive: true });
    await fs.writeFile(path.join(root, file), content);

    if (await isRepo(root)) {
      try {
        await git(root, ['check-ignore', '-q', file]);
      } catch {
        warnings.push('compiled/ is not in .gitignore, so compiled files will be committed with the book');
      }
    }
    return { path: file, content, words: countWords(content), chapters: bodies.length, scenes, separator: sep, warnings };
  });
}
