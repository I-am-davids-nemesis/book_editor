#!/usr/bin/env node
// One-time migration of ~/workspace/the_builder into the editor's book layout
// at ~/workspace/books/the_builder, keeping both narration modes as scene
// variants (`NN-scene.camera.md`, `NN-scene.rotating-third.md`).
//
//   node scripts/migrate-the-builder.mjs            # dry run: print the plan
//   node scripts/migrate-the-builder.mjs --write    # create the book
//
// Options: --from <dir> --to <dir>. The source is only read, never changed.
//
// Scene text comes from the assembled chapters (chapters/<mode>/chNN.md, the
// latest corrected text), split at the boundaries between the draft scenes in
// examples/. Each `* * *` section is assigned to the draft it shares the most
// wording with; the plan shows every assignment so it can be checked.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countWords } from '../public/js/wordcount.js';
import { slugify, titleize } from '../server/names.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scaffold = path.join(projectRoot, 'templates', 'book');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const SRC = path.resolve(opt('--from', path.join(os.homedir(), 'workspace', 'the_builder')));
const DEST = path.resolve(opt('--to', path.join(os.homedir(), 'workspace', 'books', 'the_builder')));
const WRITE = args.includes('--write');

const MODES = ['camera', 'rotating-third'];
const HR = /^\* \* \*\s*$/m;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(SRC, rel));
const warnings = [];
const out = new Map(); // dest-relative path -> content

// --- text similarity -----------------------------------------------------------

function shingles(text, n = 5) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(' '));
  return set;
}

function overlap(a, b) {
  if (!a.size) return 0;
  let hit = 0;
  for (const s of a) if (b.has(s)) hit++;
  return hit / a.size;
}

// --- chapters and scenes -----------------------------------------------------

function chapterFiles() {
  const nums = new Set();
  for (const mode of MODES) {
    for (const f of fs.readdirSync(path.join(SRC, 'chapters', mode))) {
      const m = /^ch(\d+)\.md$/.exec(f);
      if (m) nums.add(m[1]);
    }
  }
  return [...nums].sort();
}

// "# Chapter 1, the laundry scene: external..." -> "the laundry scene"
function draftTitle(text) {
  const m = /^#\s*Chapter\s+\d+,\s*(.+?):/m.exec(text);
  return m ? m[1].trim() : null;
}

// `Beats follow outline/chapters.md, "The afternoon" and "The visit."`
function draftBeatRefs(text) {
  const line = /Beats follow[^\n]*/.exec(text)?.[0] ?? '';
  return [...line.matchAll(/"([^"]+?)[.,]?"/g)].map((m) => m[1].replace(/,?\s*beat by beat$/i, '').replace(/[.,]$/, '').trim());
}

function draftBody(text) {
  const i = text.search(/^---\s*$/m);
  return i >= 0 ? text.slice(i).replace(/^---\s*$/m, '') : text;
}

function planChapter(num) {
  const n = Number(num);
  const chapterTitle = `Chapter ${titleize(NUMBER_WORDS[n] ?? String(n))}`;
  const chapterName = `${String(n).padStart(2, '0')}-${slugify(chapterTitle)}`;

  // Draft scene order comes from the assembled chapter's header note.
  const order = [];
  const chapters = {};
  for (const mode of MODES) {
    const rel = `chapters/${mode}/ch${num}.md`;
    if (!exists(rel)) {
      warnings.push(`${rel} is missing; chapter ${n} has no ${mode} text`);
      continue;
    }
    const text = read(rel);
    const note = /Assembled from the scene drafts[^\n]*/.exec(text)?.[0] ?? '';
    for (const m of note.matchAll(/`(ch\d+-[a-z0-9-]+)`/g)) if (!order.includes(m[1])) order.push(m[1]);
    // Drop the "# Chapter One" heading and the draft note: everything before the first break.
    const parts = text.split(HR);
    chapters[mode] = parts.slice(1).map((p) => p.trim()).filter(Boolean);
  }
  if (!order.length) throw new Error(`Can't find the draft list in chapters/*/ch${num}.md`);

  const drafts = order.map((key, i) => {
    const byMode = {};
    let title = null;
    const beatRefs = new Set();
    for (const mode of MODES) {
      const rel = `examples/${key}-${mode}.md`;
      if (!exists(rel)) {
        warnings.push(`${rel} is missing`);
        continue;
      }
      const text = read(rel);
      title ??= draftTitle(text);
      for (const r of draftBeatRefs(text)) beatRefs.add(r);
      byMode[mode] = shingles(draftBody(text));
    }
    title ??= key.replace(/^ch\d+-/, '').replace(/-/g, ' ');
    const sceneTitle = title[0].toUpperCase() + title.slice(1);
    const name = `${String(i + 1).padStart(2, '0')}-${slugify(title)}`;
    return { key, title: sceneTitle, name, byMode, beatRefs: [...beatRefs], sections: {} };
  });

  // Assign each section to the draft it overlaps most; keep assignments in
  // order (a section can't belong to an earlier scene than the one before it).
  const assignments = {};
  for (const mode of MODES) {
    const sections = chapters[mode] ?? [];
    let floor = 0;
    assignments[mode] = sections.map((text, idx) => {
      const sh = shingles(text);
      const scores = drafts.map((d) => (d.byMode[mode] ? overlap(sh, d.byMode[mode]) : 0));
      let best = scores.indexOf(Math.max(...scores));
      const flags = [];
      if (best < floor) {
        flags.push(`best match ${drafts[best].key} is earlier than the previous section's scene; kept in ${drafts[floor].key}`);
        best = floor;
      }
      floor = best;
      if (scores[best] < 0.3) flags.push('weak match');
      const sorted = [...scores].sort((a, b) => b - a);
      if (sorted[1] > 0 && sorted[0] - sorted[1] < 0.15) flags.push('close second');
      for (const f of flags) warnings.push(`ch${num} ${mode} section ${idx + 1}: ${f}`);
      (drafts[best].sections[mode] ??= []).push(text);
      return { idx: idx + 1, scene: drafts[best].key, score: scores[best], start: text.replace(/\s+/g, ' ').slice(0, 60), flags };
    });
  }

  for (const d of drafts) {
    for (const mode of MODES) {
      if (!d.sections[mode]?.length) warnings.push(`ch${num} ${d.key}: no ${mode} sections were assigned`);
    }
  }
  return { num, chapterTitle, chapterName, drafts, assignments };
}

// --- outline -----------------------------------------------------------------

// Splits outline/chapters.md into the book-level preamble and one block per
// "## Chapter N", each with its "### ..." subsections.
function parseOutline() {
  const text = read('outline/chapters.md');
  const blocks = text.split(/^(?=## )/m);
  const preamble = blocks.shift();
  const chapters = {};
  const bookSections = [];
  for (const b of blocks) {
    const m = /^## Chapter (\d+)\s*$/m.exec(b.split('\n')[0]);
    if (!m) {
      bookSections.push(b);
      continue;
    }
    const [intro, ...subs] = b.split(/^(?=### )/m);
    chapters[Number(m[1])] = {
      intro: intro.replace(/^## .*\n/, ''),
      subs: subs.map((s) => ({ heading: s.split('\n')[0].replace(/^###\s*/, '').trim(), text: s })),
    };
  }
  return { preamble, bookSections, chapters };
}

const cleanHr = (text) => text.replace(/\n-{3,}\s*$/, '').trimEnd();

function outlineFiles(plan, outline) {
  const n = Number(plan.num);
  const ch = outline.chapters[n];
  const used = new Set();
  const sceneOutlines = {};

  for (const d of plan.drafts) {
    const parts = [];
    for (const ref of d.beatRefs) {
      const sub = ch?.subs.find((s) => s.heading.toLowerCase().replace(/,?\s*beat by beat$/, '') === ref.toLowerCase());
      if (!sub) {
        warnings.push(`ch${plan.num} ${d.key}: no outline section "${ref}"`);
        continue;
      }
      used.add(sub);
      parts.push(cleanHr(sub.text.replace(/^### /, '## ')));
    }
    const body = parts.length
      ? parts.join('\n\n')
      : '*No beats were written for this scene in the_builder\'s `outline/chapters.md`; see the chapter summary.*';
    sceneOutlines[d.name] = `# ${d.title}\n\n${body}\n`;
  }

  const rest = (ch?.subs ?? []).filter((s) => !used.has(s)).map((s) => cleanHr(s.text.replace(/^### /, '## ')));
  const summary = `# ${plan.chapterTitle}\n\n${cleanHr(ch?.intro ?? '').trim()}\n\n${rest.join('\n\n')}\n`.replace(/\n{3,}/g, '\n\n');
  return { sceneOutlines, summary, movedToScenes: [...used].map((s) => s.heading), keptInSummary: (ch?.subs ?? []).filter((s) => !used.has(s)).map((s) => s.heading) };
}

// --- codex -------------------------------------------------------------------

function walk(rel) {
  const outFiles = [];
  for (const e of fs.readdirSync(path.join(SRC, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) outFiles.push(...walk(child));
    else if (e.name.endsWith('.md')) outFiles.push(child);
  }
  return outFiles;
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function planPlaces() {
  const text = read('codex/places.md');
  const lines = text.split('\n');
  const tableStart = lines.findIndex((l) => /^\|\s*Place\s*\|/i.test(l));
  let tableEnd = tableStart + 2;
  while (tableEnd < lines.length && lines[tableEnd].startsWith('|')) tableEnd++;
  const header = splitRow(lines[tableStart]);
  const places = lines.slice(tableStart + 2, tableEnd).map((l) => {
    const cells = splitRow(l);
    const name = cells[0];
    const plain = name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    return { name, slug: slugify(plain), cells };
  });
  const files = {};
  for (const p of places) {
    const fields = header.slice(1).map((h, i) => `- **${h}:** ${p.cells[i + 1] ?? ''}`).join('\n');
    files[`codex/locations/${p.slug}.md`] = `# ${p.name}\n\n${fields}\n`;
  }
  const intro = lines.slice(0, tableStart).join('\n').trimEnd();
  const outro = lines.slice(tableEnd).join('\n').trim();
  const list = places.map((p) => `- [${p.name}](locations/${p.slug}.md)`).join('\n');
  files['codex/places-overview.md'] = `${intro}\n\nOne file per place in \`locations/\`:\n\n${list}\n${outro ? `\n${outro}\n` : ''}`;
  return { places, files };
}

// --- AGENTS.md ---------------------------------------------------------------

const LAYOUT_SECTION = `## 7. Repository layout

The book is edited with a local browser editor (see \`~/workspace/local_editor\`), by hand, in Obsidian and by agents. Keep to this layout; the editor relies on it.

\`\`\`
AGENTS.md                         # this file
manuscript/
  01-chapter-one/
    01-the-opening.camera.md          # one file per scene per narrative mode
    01-the-opening.rotating-third.md
outline/
  book-plan.md                    # the book's engine and other book-wide planning
  01-chapter-one/
    _chapter.md                   # what the chapter must do, planning fields, open questions
    01-the-opening.md             # beats for the scene of the same name (both modes)
codex/
  README.md                       # profile template, tension rule, how to use
  canon-notes.md  voice-tests.md  tension-ledger.md  reader-knowledge.md
  places-overview.md              # how places work as pressure; links to locations/
  builder-handoff.md              # original research + codex (historical; codex/ supersedes it)
  characters/                     # one file per main character
    supporting/                   # one file per supporting character
  locations/                      # one file per place
  _templates/                     # templates the editor uses for new entries
compiled/                         # generated chapters/book per mode; not committed
\`\`\`

- **Names:** chapters are folders named \`NN-slug\`; scenes are \`NN-slug.<mode>.md\`, with modes \`camera\` and \`rotating-third\`. The number sets the order.
- **Mirror:** every scene has one outline file, \`outline/<chapter>/NN-slug.md\` (no mode suffix), and every chapter has \`outline/<chapter>/_chapter.md\`. When you add, rename, move or delete a scene, do the same to all of its files.
- **Reordering:** renumber with \`git mv\` so history follows the file.
- **Scene files hold prose only:** no headings, no draft notes. Plot, POV and who's present go in the outline file.
- **Whole chapters are compiled** from the scene files, per mode; don't keep hand-assembled chapter files.

Migrated from \`the_builder\` (see the first commit for the source commit). The old \`examples/\` drafts and hand-assembled \`chapters/\` stay in that repository.
`;

function planAgents() {
  let text = read('AGENTS.md');
  const notes = [];
  const replace = (from, to, label) => {
    if (typeof from === 'string' ? text.includes(from) : from.test(text)) {
      text = text.replace(from, to);
      notes.push(label);
    } else {
      warnings.push(`AGENTS.md: couldn't find the text for "${label}"; edit it by hand`);
    }
  };
  replace(/^## 7\. Repository layout[\s\S]*?(?=^## 8\.)/m, `${LAYOUT_SECTION}\n---\n\n`, 'replaced §7 with the new layout');
  replace(/^\*\*Current practice: parallel drafts\.\*\*[^\n]*$/m,
    '**Current practice: parallel drafts.** Write each scene in **both** rotating close third (option 1) and the external, camera-like narrator (option 3), as the paired files `manuscript/<chapter>/<NN-scene>.rotating-third.md` and `.camera.md`. Keep the dialogue close between the two so the modes can be compared. Whole chapters are compiled from the scene files per mode. The user found that both read well with different impacts (October 9, 2026).',
    'rewrote "Current practice: parallel drafts" for scene variants');
  replace('label which mode is being tried, and put them in `examples/`', 'label which mode is being tried, and keep each mode in its own scene variant file (§7)', 'pointed mode experiments at scene variants');
  replace(/`builder_handoff\.md`/g, '`codex/builder-handoff.md`', 'pointed builder_handoff.md at codex/builder-handoff.md');
  if (text.includes('outline/chapters.md')) {
    text = text.replace(/`outline\/chapters\.md`/g, '`outline/<chapter>/_chapter.md`');
    notes.push('pointed outline/chapters.md at the per-chapter summaries');
  }
  return { text, notes };
}

// --- assemble the plan ---------------------------------------------------------

function sourceCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: SRC, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: SRC, encoding: 'utf8' }).trim();
    if (dirty) warnings.push('the_builder has uncommitted changes; the migration reads the working copy');
    return sha;
  } catch {
    return 'unknown';
  }
}

function plan() {
  const sha = sourceCommit();
  const outline = parseOutline();
  const chapterPlans = chapterFiles().map(planChapter);

  for (const p of chapterPlans) {
    for (const d of p.drafts) {
      for (const mode of MODES) {
        const sections = d.sections[mode] ?? [];
        out.set(`manuscript/${p.chapterName}/${d.name}.${mode}.md`, `${sections.join('\n\n* * *\n\n')}\n`);
      }
    }
    const o = outlineFiles(p, outline);
    p.outline = o;
    for (const [name, content] of Object.entries(o.sceneOutlines)) out.set(`outline/${p.chapterName}/${name}.md`, content);
    out.set(`outline/${p.chapterName}/_chapter.md`, o.summary);
  }

  const bookPlan = [outline.preamble.replace(/^# Chapter plan/m, '# Book plan'), ...outline.bookSections].join('').replace(/\n-{3,}\s*$/, '\n');
  out.set('outline/book-plan.md', bookPlan.trimEnd() + '\n');

  // Codex: copied as is, except places.md (split into locations/).
  const codexFiles = walk('codex').filter((f) => f !== 'codex/places.md');
  for (const f of codexFiles) out.set(f, read(f));
  const places = planPlaces();
  for (const [f, c] of Object.entries(places.files)) out.set(f, c);
  if (out.has('codex/README.md')) {
    out.set('codex/README.md', out.get('codex/README.md').replace(
      /^\| `places\.md` \|.*$/m,
      '| `locations/` | One file per setting and the tension it squeezes; `places-overview.md` explains how places work as pressure |',
    ));
  }
  if (exists('builder_handoff.md')) out.set('codex/builder-handoff.md', read('builder_handoff.md'));

  // Editor templates, README, CLAUDE.md, .gitignore from the scaffold.
  for (const f of fs.readdirSync(path.join(scaffold, 'codex', '_templates'))) {
    out.set(`codex/_templates/${f}`, fs.readFileSync(path.join(scaffold, 'codex', '_templates', f), 'utf8'));
  }
  out.set('README.md', `# The Builder\n\nA retelling of *The Builder* (P.S. Power), drafted in two narrative modes. Migrated from \`the_builder\` @ ${sha} on ${new Date().toISOString().slice(0, 10)}.\n\n- \`manuscript/\`: one folder per chapter; each scene as \`NN-scene.camera.md\` and \`NN-scene.rotating-third.md\`.\n- \`outline/\`: \`book-plan.md\`, and per chapter a \`_chapter.md\` plus one beat file per scene.\n- \`codex/\`: characters, locations and reference notes.\n\nSee \`AGENTS.md\` for the conventions.\n`);
  out.set('CLAUDE.md', read('CLAUDE.md'));
  out.set('.gitignore', fs.readFileSync(path.join(scaffold, '_gitignore'), 'utf8'));
  const agents = planAgents();
  out.set('AGENTS.md', agents.text);

  return { sha, chapterPlans, places, agents, codexFiles };
}

// --- report ------------------------------------------------------------------

function report({ sha, chapterPlans, places, agents, codexFiles }) {
  const lines = [];
  const p = (s = '') => lines.push(s);
  p(`Migrate ${SRC} @ ${sha}`);
  p(`     to ${DEST}${WRITE ? '' : '   (dry run; add --write to create it)'}`);
  for (const cp of chapterPlans) {
    p();
    p(`== ${cp.chapterTitle} -> manuscript/${cp.chapterName}/`);
    for (const mode of MODES) {
      p(`   ${mode}: sections -> scenes`);
      for (const a of cp.assignments[mode] ?? []) {
        p(`     ${String(a.idx).padStart(2)}  ${a.scene.padEnd(18)} ${(a.score * 100).toFixed(0).padStart(3)}%  ${a.start}…${a.flags.length ? `  ⚠ ${a.flags.join('; ')}` : ''}`);
      }
    }
    p('   scenes:');
    for (const d of cp.drafts) {
      const counts = MODES.map((m) => `${m} ${countWords((d.sections[m] ?? []).join('\n'))}w/${(d.sections[m] ?? []).length}s`).join(', ');
      p(`     ${d.name.padEnd(36)} ${counts}`);
      p(`        outline: ${d.beatRefs.length ? d.beatRefs.map((r) => `"${r}"`).join(' + ') : '(no beat section)'}`);
    }
    p(`   _chapter.md keeps: ${cp.outline.keptInSummary.join(' · ')}`);
  }
  p();
  p(`== Codex: ${codexFiles.length} files copied; places.md -> ${places.places.length} locations:`);
  p(`   ${places.places.map((x) => x.slug).join(', ')}`);
  p('   + codex/places-overview.md, codex/builder-handoff.md, codex/_templates/*');
  p();
  p('== AGENTS.md:');
  for (const n of agents.notes) p(`   - ${n}`);
  p();
  p('== Not migrated (stays in the_builder): examples/ drafts, chapters/ assembled files, .obsidian/');
  p();
  p(`== ${out.size} files:`);
  const byDir = {};
  for (const f of out.keys()) {
    const dir = f.includes('/') ? f.split('/').slice(0, 2).join('/') : '.';
    byDir[dir] = (byDir[dir] || 0) + 1;
  }
  for (const [dir, n] of Object.entries(byDir).sort()) p(`   ${dir.padEnd(40)} ${n}`);
  p();
  p(warnings.length ? `== ${warnings.length} warning(s):` : '== No warnings.');
  for (const w of warnings) p(`   ⚠ ${w}`);
  return lines.join('\n');
}

// --- write -------------------------------------------------------------------

function write(sha) {
  if (fs.existsSync(DEST)) throw new Error(`${DEST} already exists; move it away first`);
  for (const [rel, content] of out) {
    const abs = path.join(DEST, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, { flag: 'wx' });
  }
  const git = (...a) => execFileSync('git', a, { cwd: DEST, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', `Migrate from the_builder @ ${sha}\n\nScenes come from the assembled chapters (chapters/<mode>/chNN.md),\nsplit at the draft-scene boundaries in examples/, one file per mode.\noutline/chapters.md is split into per-chapter and per-scene files, and\ncodex/places.md into codex/locations/.`);
  return git('log', '--oneline').trim();
}

const result = plan();
console.log(report(result));
if (WRITE) {
  const log = write(result.sha);
  console.log(`\nCreated ${DEST}\n${log}`);
}
