import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest } from './errors.js';

export const MAX_MATCHES = 2000;
const MAX_QUERY = 200;
const BEFORE_CHARS = 40;
const AFTER_CHARS = 80;

// compiled/ holds copies of the manuscript, so its matches would only repeat.
const SKIPPED_DIRS = new Set(['compiled', 'node_modules']);
const SCOPES = ['all', 'manuscript', 'outline', 'codex'];
const GROUP_ORDER = ['manuscript', 'outline', 'codex'];

// Every Markdown file in the book, as book-relative paths. Hidden files and
// folders (.git, .obsidian, temp files) are left out.
async function markdownFiles(root, rel = '') {
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
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!(rel === '' && SKIPPED_DIRS.has(e.name))) out.push(...(await markdownFiles(root, child)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(child);
    }
  }
  return out;
}

// manuscript/ and outline/ have their own tabs; everything else is under Codex.
function groupOf(rel) {
  if (rel.startsWith('manuscript/')) return 'manuscript';
  if (rel.startsWith('outline/')) return 'outline';
  return 'codex';
}

// The query as a regular expression. It's plain text, not a pattern, except
// that straight and curly quotes match each other, since prose uses both.
export function queryPattern(query, { caseSensitive = false, wholeWord = false } = {}) {
  let source = '';
  for (const c of query) {
    if ("'‘’".includes(c)) source += "['‘’]";
    else if ('"“”'.includes(c)) source += '["“”]';
    else source += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  if (wholeWord) source = `(?<![\\p{L}\\p{N}_])${source}(?![\\p{L}\\p{N}_])`;
  return new RegExp(source, `g${caseSensitive ? '' : 'i'}u`);
}

// A short piece of the line around a match, cut at a space where possible.
function snippet(line, start, end) {
  let from = Math.max(0, start - BEFORE_CHARS);
  if (from > 0) {
    const space = line.indexOf(' ', from);
    if (space !== -1 && space < start) from = space + 1;
  }
  let to = Math.min(line.length, end + AFTER_CHARS);
  if (to < line.length) {
    const space = line.lastIndexOf(' ', to);
    if (space > end) to = space;
  }
  return {
    before: (from > 0 ? '…' : '') + line.slice(from, start),
    text: line.slice(start, end),
    after: line.slice(end, to) + (to < line.length ? '…' : ''),
  };
}

// Searches the book's Markdown files for `query`. Returns the files with
// matches, in book order (manuscript, outline, codex), each with its matches:
//   { files: [{ path, matches: [{ line, col, length, before, text, after }] }], total, truncated }
// `line` is 1-based; `col` and `length` are in UTF-16 code units, as in the editor.
export async function searchBook(root, { query, caseSensitive = false, wholeWord = false, scope = 'all' } = {}) {
  if (typeof query !== 'string' || !query.trim()) throw badRequest('Missing search text');
  if (query.length > MAX_QUERY) throw badRequest(`Search text is too long (at most ${MAX_QUERY} characters)`);
  if (!SCOPES.includes(scope)) throw badRequest(`Unknown search scope: ${scope}`);
  const pattern = queryPattern(query, { caseSensitive, wholeWord });

  const paths = (await markdownFiles(root))
    .filter((rel) => scope === 'all' || groupOf(rel) === scope)
    .sort((a, b) => GROUP_ORDER.indexOf(groupOf(a)) - GROUP_ORDER.indexOf(groupOf(b))
      || a.localeCompare(b, undefined, { numeric: true }));
  const contents = await Promise.all(paths.map((rel) => fs.readFile(path.join(root, rel), 'utf8').catch(() => '')));

  const files = [];
  let total = 0;
  let truncated = false;
  for (const [i, rel] of paths.entries()) {
    const matches = [];
    const lines = contents[i].split(/\r\n|\r|\n/);
    for (const [n, line] of lines.entries()) {
      for (const m of line.matchAll(pattern)) {
        if (total === MAX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push({ line: n + 1, col: m.index, length: m[0].length, ...snippet(line, m.index, m.index + m[0].length) });
        total += 1;
      }
      if (truncated) break;
    }
    if (matches.length) files.push({ path: rel, matches });
    if (truncated) break;
  }
  return { files, total, truncated };
}
