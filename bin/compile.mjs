#!/usr/bin/env node
// Compile a book from the command line, with the same rules as the editor's
// Compile dialog (server/compile.js). For agents and scripts: books hold only
// prose and notes, and every tool lives in this project.
//
//   node ~/workspace/local_editor/bin/compile.mjs [book] [chapter] [--mode <mode>] [--separator <text>]
//
//   book       the book folder (default: the current directory)
//   chapter    one chapter, by folder name (03-chapter-three) or number (3);
//              without it, every chapter plus the whole book
//   --mode     one narration mode (camera, rotating-third, or main for plain
//              files); without it, every mode the book has
//
// Output goes to <book>/compiled/: <chapter>[.<mode>].md and book[.<mode>].md.

import fs from 'node:fs/promises';
import path from 'node:path';
import { compile } from '../server/compile.js';
import { buildTree } from '../server/tree.js';

function parseArgs(argv) {
  const opts = { positional: [], modes: [], separator: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') opts.modes.push(argv[++i]);
    else if (a.startsWith('--mode=')) opts.modes.push(a.slice(7));
    else if (a === '--separator') opts.separator = argv[++i];
    else if (a.startsWith('--separator=')) opts.separator = a.slice(12);
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.positional.push(a);
  }
  return opts;
}

async function isBook(dir) {
  try {
    return (await fs.stat(path.join(dir, 'manuscript'))).isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const text = await fs.readFile(new URL(import.meta.url), 'utf8');
    console.log(text.split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  // The first argument is the book if it's a book folder; otherwise a chapter.
  let root = process.cwd();
  if (opts.positional[0] && (await isBook(path.resolve(opts.positional[0])))) {
    root = path.resolve(opts.positional.shift());
  }
  if (!(await isBook(root))) throw new Error(`${root} is not a book (no manuscript/ folder)`);
  const wanted = opts.positional;

  const tree = await buildTree(root);
  const all = tree.chapters.filter((c) => c.inManuscript);
  const chapters = wanted.length
    ? all.filter((c) => wanted.some((w) => w === c.name || (c.prefix !== null && Number(w) === c.prefix)))
    : all;
  if (!chapters.length) throw new Error(`No chapters match: ${wanted.join(', ')}`);
  const bookModes = [...(tree.hasBaseScenes || !tree.modes.length ? [''] : []), ...tree.modes];
  const modes = opts.modes.length ? opts.modes.map((m) => (m === 'main' ? '' : m)) : bookModes;

  const warnings = new Set();
  const run = async (args) => {
    try {
      const r = await compile(root, { ...args, separator: opts.separator });
      r.warnings.forEach((w) => warnings.add(w));
      const what = args.scope === 'book' ? `${r.chapters} chapters` : `${r.scenes} scenes`;
      console.log(`${r.path}  ${what}, ${r.words} words`);
    } catch (err) {
      if (!/^Nothing to compile/.test(err.message)) throw err; // a chapter with no scenes in this mode
    }
  };
  for (const mode of modes) {
    for (const ch of chapters) await run({ scope: 'chapter', chapter: ch.name, mode });
    if (!wanted.length) await run({ scope: 'book', mode });
  }
  for (const w of warnings) console.warn(`warning: ${w}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
