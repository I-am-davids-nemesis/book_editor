#!/usr/bin/env node
// Pictures of every place in a book: for each codex location, gather a
// description from the manuscript if it has none (the editor's Gather, run by
// Claude), then generate candidate images of the place on this Mac with
// ComfyUI. The candidates wait in the Lookbook's Candidates view to be kept or
// discarded, like any made from the Stage dialog.
//
//   node ~/workspace/local_editor/bin/location-images.mjs [book] [options]
//
//   book          the book folder (default: the current directory)
//   --only a,b    just these locations (file names without .md)
//   --n 2         images per location (1-4); a location that already has
//                 this many pictures of the place alone (kept or waiting;
//                 pictures with characters in them don't count) is skipped
//   --force       generate even for locations that have enough pictures
//   --gather      write missing descriptions first (one Claude run each;
//                 each run is committed as "Claude: …", like the panel's)
//   --size wide   square, portrait, landscape or wide
//   --model id    the ComfyUI workflow (default: flux2-klein-9b)
//   --dry-run     print what would happen and each prompt; generate nothing
//
// A location is pictured only if its Description quotes at least 3 passages
// of the manuscript and has an image prompt: places the text never shows, or
// only mentions in passing, are reported and skipped. The prompt is the entry's
// "### Image prompt", its fixed traits, its reference images, the book's
// visual style, and a line asking for the place empty, as an establishing view.

import fs from 'node:fs/promises';
import path from 'node:path';
import { listCandidates } from '../server/candidates.js';
import { ClaudeService, modelsFrom } from '../server/claude.js';
import { configPath, loadConfig } from '../server/config.js';
import { providersFrom } from '../server/imagegen/index.js';
import { ImageJobs, MAX_IMAGES, SIZES } from '../server/imagegen/jobs.js';
import { listLookbook } from '../server/lookbook.js';
import { entryScenes } from '../server/mentions.js';
import { DESCRIPTION, gatherPrompt } from '../public/js/codexprompts.js';
import { sectionBody } from '../public/js/sections.js';
import { handoffPrompt, isReference, rankImages, VISUAL_STYLE } from '../public/js/worldmodel.js';

const EMPTY_PLACE = 'Wide establishing view of the place itself, empty and quiet, with nobody in it.';

function parseArgs(argv) {
  const opts = { positional: [], only: null, n: 2, force: false, gather: false, size: 'wide', model: 'flux2-klein-9b', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
    if (a === '--only' || a.startsWith('--only=')) opts.only = value().split(',').map((s) => s.trim().replace(/\.md$/, '')).filter(Boolean);
    else if (a === '--n' || a.startsWith('--n=')) opts.n = Number(value());
    else if (a === '--size' || a.startsWith('--size=')) opts.size = value();
    else if (a === '--model' || a.startsWith('--model=')) opts.model = value();
    else if (a === '--force') opts.force = true;
    else if (a === '--gather') opts.gather = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.positional.push(a);
  }
  return opts;
}

const usage = () => fs.readFile(new URL(import.meta.url), 'utf8')
  .then((src) => src.split('\n').slice(1).filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));

const read = (root, rel) => fs.readFile(path.join(root, rel), 'utf8').catch(() => '');
const titleOf = (text, rel) => (/^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? path.basename(rel, '.md')).replace(/\s*\((?:canon|assumed|invented)[^)]*\)\s*$/i, '');

// How many passages the Description quotes from manuscript/. A place the text
// only mentions in passing has one or two; one it shows has more.
const MIN_QUOTES = 3;
const manuscriptQuotes = (text) => ((sectionBody(sectionBody(text, 2, DESCRIPTION) ?? '', 3, 'From the manuscript') ?? '').match(/\(manuscript\//g) ?? []).length;

async function locations(root) {
  const dir = path.join(root, 'codex', 'locations');
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.md')).sort();
  return names.map((n) => `codex/locations/${n}`);
}

// One Gather run, headless: Claude reads the manuscript and writes the
// Description. Anything that would need the writer's approval is refused.
async function gather(claude, root, rel, title, model) {
  const entry = { path: rel, title, kind: 'location' };
  const { runId } = await claude.start(root, { prompt: gatherPrompt(entry, await entryScenes(root, rel)), newSession: true, model });
  const run = claude.run(runId, root);
  let text = '';
  const errors = [];
  run.subscribe((e) => {
    if (!e) return;
    if (e.type === 'permission') run.answer(e.requestId, false);
    if (e.type === 'text') text += e.text;
    if (e.type === 'tool') text = '';
    if (e.type === 'error') errors.push(e.message);
  });
  await run.done;
  if (errors.length) throw new Error(errors[0]);
  return text.trim();
}

function waitFor(job, label) {
  return new Promise((resolve) => {
    let last = -1;
    job.subscribe((e) => {
      if (!e) return resolve(job);
      if (e.type === 'progress') {
        const pct = Math.floor(e.fraction * 4) * 25;
        if (pct !== last) process.stdout.write(`\r  ${label}: image ${e.index + 1} of ${e.n}, ${pct}%   `);
        last = pct;
      } else if (e.type === 'image') {
        process.stdout.write(`\r  ${label}: ${e.path}          \n`);
        last = -1;
      } else if (e.type === 'error') {
        process.stdout.write(`\r  ${label}: failed: ${e.message}\n`);
      }
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(await usage());
  const root = path.resolve(opts.positional[0] ?? '.');
  if (!(await fs.stat(path.join(root, 'codex')).catch(() => null))) throw new Error(`${root} isn’t a book (no codex/ folder)`);
  if (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > MAX_IMAGES) throw new Error(`--n must be 1 to ${MAX_IMAGES}`);
  if (!SIZES[opts.size]) throw new Error(`--size must be one of: ${Object.keys(SIZES).join(', ')}`);

  let paths = await locations(root);
  if (opts.only) {
    const missing = opts.only.filter((o) => !paths.some((p) => path.basename(p, '.md') === o));
    if (missing.length) throw new Error(`No such location: ${missing.join(', ')}`);
    paths = paths.filter((p) => opts.only.includes(path.basename(p, '.md')));
  }

  const config = await loadConfig();
  const provider = providersFrom(config).find((p) => p.id === 'comfyui');
  if (!opts.dryRun) {
    const check = await provider.check();
    const model = check.models.find((m) => m.id === opts.model);
    if (!check.ok) throw new Error(check.message);
    if (!model) throw new Error(`No workflow called ${opts.model}`);
    if (!model.ready) throw new Error(`${model.label}: ${model.problem}`);
  }
  // Gather runs keep their own session store, so the editor's Claude panel
  // conversation for this book is left alone.
  const claude = new ClaudeService({ storeDir: path.join(path.dirname(configPath()), 'claude-pipeline') });
  const jobs = new ImageJobs();
  const styleText = await read(root, VISUAL_STYLE);
  const report = { pictured: [], enough: [], notInText: [], noDescription: [], failed: [] };

  for (const rel of paths) {
    let text = await read(root, rel);
    const title = titleOf(text, rel);
    const lookbook = await listLookbook(root);
    // Pictures of the place itself; ones with characters in them are scenes.
    const placeOnly = (item) => item.of.includes(rel) && !item.of.some((p) => p.startsWith('codex/characters/'));
    const images = lookbook.filter(placeOnly);
    const waiting = (await listCandidates(root)).filter(placeOnly);
    const have = images.length + waiting.length;
    console.log(`\n${title} (${rel}): ${images.length} kept, ${waiting.length} waiting`);
    if (have >= opts.n && !opts.force) {
      console.log('  has enough pictures; skipped (--force to make more)');
      report.enough.push(title);
      continue;
    }

    if (sectionBody(text, 2, DESCRIPTION) === null) {
      if (!opts.gather || opts.dryRun) {
        console.log(`  no Description${opts.gather ? ' (would gather one)' : '; run with --gather to write one from the manuscript'}`);
        report.noDescription.push(title);
        continue;
      }
      console.log('  gathering a description from the manuscript (Claude)…');
      try {
        const said = await gather(claude, root, rel, title, modelsFrom(config).model);
        if (said) console.log(said.split('\n').map((l) => `    ${l}`).join('\n'));
      } catch (err) {
        console.log(`  gathering failed: ${err.message}`);
        report.failed.push(title);
        continue;
      }
      text = await read(root, rel);
    }
    const quotes = manuscriptQuotes(text);
    if (quotes < MIN_QUOTES) {
      console.log(`  the manuscript doesn’t show this place yet (${quotes} ${quotes === 1 ? 'passage' : 'passages'}); skipped`);
      report.notInText.push(title);
      continue;
    }

    const refs = rankImages(images, 'location').filter(isReference).slice(0, 4);
    const base = handoffPrompt({ kind: 'location', text, styleText, refs });
    if (!base) {
      console.log('  no image prompt in its Description; skipped');
      report.noDescription.push(title);
      continue;
    }
    const prompt = `${base}\n\n${EMPTY_PLACE}`;
    const n = opts.force ? opts.n : opts.n - have;
    if (opts.dryRun) {
      console.log(`  would make ${n} ${opts.size} ${n === 1 ? 'image' : 'images'} from:\n${prompt.split('\n').map((l) => `    ${l}`).join('\n')}`);
      report.pictured.push(title);
      continue;
    }
    const shot = { location: rel, characters: [], moment: { text: '', source: '' }, brief: '', framing: { shot: 'wide', time: '', notes: '' } };
    const job = await jobs.start(root, provider, { prompt, refs: refs.map((r) => r.path), model: opts.model, n, size: opts.size, shot });
    await waitFor(job, title);
    (job.status === 'done' ? report.pictured : report.failed).push(title);
  }

  const line = (label, list) => list.length && console.log(`${label}: ${list.join(', ')}`);
  console.log('');
  line(opts.dryRun ? 'Would picture' : 'Pictured (see Lookbook → Candidates)', report.pictured);
  line('Already enough pictures', report.enough);
  line('Not in the manuscript yet', report.notInText);
  line('No description', report.noDescription);
  line('Failed', report.failed);
  if (!opts.dryRun) await provider.free?.().catch(() => {});
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
