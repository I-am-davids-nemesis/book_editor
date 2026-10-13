import fs from 'node:fs';
import path from 'node:path';

// The browser loads CodeMirror and marked straight from node_modules. This
// walks the dependency graph from the packages the frontend imports and
// builds an import map, so there is no bundler and no hand-kept list.

const BROWSER_ROOTS = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lang-markdown',
  '@codemirror/search',
  'marked',
];

const CONDITIONS = ['browser', 'import', 'module', 'default'];

function pickEntry(exp) {
  if (typeof exp === 'string') return exp;
  if (!exp || typeof exp !== 'object') return null;
  if ('.' in exp) return pickEntry(exp['.']);
  for (const c of CONDITIONS) {
    if (c in exp) {
      const found = pickEntry(exp[c]);
      if (found) return found;
    }
  }
  return null;
}

export function buildImportMap(nodeModules, roots = BROWSER_ROOTS) {
  const imports = {};
  const packages = new Map(); // name -> absolute dir
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift();
    if (packages.has(name)) continue;
    const dir = path.join(nodeModules, name);
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      throw new Error(`Browser dependency ${name} is not installed; run npm install`);
    }
    const entry = pickEntry(pkg.exports) || pkg.module || pkg.main || 'index.js';
    packages.set(name, dir);
    imports[name] = `/vendor/${name}/${entry.replace(/^\.\//, '')}`;
    queue.push(...Object.keys(pkg.dependencies || {}));
  }
  return { importMap: { imports }, packages };
}
