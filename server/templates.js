import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const scaffoldDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'book');

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Replaces {{key}} placeholders; unknown keys are left as written.
export function fillTemplate(text, vars) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

// A book's own codex/_templates/<name>.md wins, so templates can be edited per
// book; the built-in copy is the fallback for books that don't have one.
export async function loadTemplate(bookRoot, name) {
  for (const dir of [path.join(bookRoot, 'codex', '_templates'), path.join(scaffoldDir, 'codex', '_templates')]) {
    try {
      return await fs.readFile(path.join(dir, `${name}.md`), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return '# {{name}}\n';
}

export async function renderTemplate(bookRoot, name, vars) {
  return fillTemplate(await loadTemplate(bookRoot, name), { date: today(), ...vars });
}
