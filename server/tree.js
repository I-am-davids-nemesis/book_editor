import fs from 'node:fs/promises';
import path from 'node:path';
import { countWords } from '../public/js/wordcount.js';
import { listCandidates } from './candidates.js';
import { listLookbook } from './lookbook.js';
import { compareOrdered, parseChapterName, parseSceneName, titleize } from './names.js';

const CHAPTER_SUMMARY = '_chapter.md';

async function listDir(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

async function wordsIn(file) {
  try {
    return countWords(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

const isMd = (e) => e.isFile() && e.name.toLowerCase().endsWith('.md');

// Chapters and scenes are the union of what's in manuscript/ and outline/, so
// a file missing from either side shows up flagged instead of disappearing.
async function buildChapters(root) {
  const msDirs = await listDir(path.join(root, 'manuscript'));
  const olDirs = await listDir(path.join(root, 'outline'));
  const msNames = new Set(msDirs.filter((e) => e.isDirectory()).map((e) => e.name));
  const olNames = new Set(olDirs.filter((e) => e.isDirectory()).map((e) => e.name));

  const chapters = [];
  for (const name of new Set([...msNames, ...olNames])) {
    const ch = {
      ...parseChapterName(name),
      manuscriptPath: `manuscript/${name}`,
      outlinePath: `outline/${name}`,
      inManuscript: msNames.has(name),
      inOutline: olNames.has(name),
      summaryPath: `outline/${name}/${CHAPTER_SUMMARY}`,
      hasSummary: false,
      words: 0,
      scenes: [],
    };

    const msFiles = (await listDir(path.join(root, ch.manuscriptPath))).filter(isMd);
    const olFiles = (await listDir(path.join(root, ch.outlinePath))).filter(isMd);
    ch.hasSummary = olFiles.some((e) => e.name === CHAPTER_SUMMARY);

    const scenes = new Map();
    const sceneFor = (parsed) => {
      if (!scenes.has(parsed.base)) {
        const base = parseSceneName(parsed.base);
        scenes.set(parsed.base, {
          name: base.name,
          prefix: base.prefix,
          slug: base.slug,
          title: base.title,
          manuscriptPath: `${ch.manuscriptPath}/${base.name}`,
          outlinePath: `${ch.outlinePath}/${base.name}`,
          // inManuscript: any manuscript file (plain or variant); hasBase: the plain file.
          inManuscript: false,
          hasBase: false,
          inOutline: false,
          words: 0,
          variants: [],
          // Words per mode; '' is the plain file, other keys are variant names.
          wordsByMode: {},
        });
      }
      return scenes.get(parsed.base);
    };

    for (const e of msFiles) {
      const parsed = parseSceneName(e.name);
      if (!parsed) continue;
      const scene = sceneFor(parsed);
      const filePath = `${ch.manuscriptPath}/${e.name}`;
      const words = await wordsIn(path.join(root, filePath));
      scene.inManuscript = true;
      if (parsed.variant) {
        scene.variants.push({ name: e.name, variant: parsed.variant, path: filePath, words });
      } else {
        scene.hasBase = true;
        scene.words = words;
      }
      scene.wordsByMode[parsed.variant ?? ''] = words;
    }
    for (const e of olFiles) {
      if (e.name === CHAPTER_SUMMARY) continue;
      const parsed = parseSceneName(e.name);
      if (!parsed || parsed.variant) continue;
      sceneFor(parsed).inOutline = true;
    }

    ch.scenes = [...scenes.values()].sort(compareOrdered);
    for (const scene of ch.scenes) scene.variants.sort((a, b) => a.variant.localeCompare(b.variant));
    ch.words = ch.scenes.reduce((n, s) => n + s.words, 0);
    ch.wordsByMode = sumByMode(ch.scenes);
    chapters.push(ch);
  }
  return chapters.sort(compareOrdered);
}

function sumByMode(items) {
  const out = {};
  for (const item of items) {
    for (const [mode, n] of Object.entries(item.wordsByMode)) out[mode] = (out[mode] || 0) + n;
  }
  return out;
}

// Loose .md files directly under manuscript/ or outline/ (not in a chapter).
async function looseFiles(root, dir) {
  return (await listDir(path.join(root, dir)))
    .filter(isMd)
    .map((e) => ({ name: e.name, title: titleize(e.name.replace(/\.md$/i, '')), path: `${dir}/${e.name}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function walkMarkdown(root, rel) {
  const out = [];
  for (const e of await listDir(path.join(root, rel))) {
    const childRel = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walkMarkdown(root, childRel)));
    else if (isMd(e)) out.push(childRel);
  }
  return out;
}

const CODEX_GROUPS = { characters: 'codex/characters', locations: 'codex/locations', templates: 'codex/_templates' };

async function buildCodex(root) {
  const codex = { characters: [], locations: [], notes: [], templates: [] };
  for (const rel of await walkMarkdown(root, 'codex')) {
    const group = Object.keys(CODEX_GROUPS).find((g) => rel.startsWith(CODEX_GROUPS[g] + '/')) || 'notes';
    const inner = rel.slice((group === 'notes' ? 'codex' : CODEX_GROUPS[group]).length + 1);
    const name = path.posix.basename(rel);
    codex[group].push({
      name,
      title: titleize(name.replace(/\.md$/i, '')),
      // subfolder inside the group, e.g. "supporting" for characters/supporting/x.md
      folder: path.posix.dirname(inner) === '.' ? '' : path.posix.dirname(inner),
      path: rel,
    });
  }
  for (const list of Object.values(codex)) {
    list.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  }
  return codex;
}

// Top-level .md files like README.md, AGENTS.md.
async function buildRootFiles(root) {
  return (await listDir(root))
    .filter(isMd)
    .map((e) => ({ name: e.name, path: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function buildTree(root) {
  const chapters = await buildChapters(root);
  return {
    chapters,
    looseManuscript: await looseFiles(root, 'manuscript'),
    looseOutline: await looseFiles(root, 'outline'),
    codex: await buildCodex(root),
    rootFiles: await buildRootFiles(root),
    lookbook: await listLookbook(root),
    // Generated images not kept yet, newest job first.
    candidates: await listCandidates(root),
    words: chapters.reduce((n, c) => n + c.words, 0),
    wordsByMode: sumByMode(chapters),
    // Narration modes in use (variant names), and whether any scene has a
    // plain file. Together they say which modes the editor offers.
    modes: [...new Set(chapters.flatMap((c) => c.scenes.flatMap((s) => s.variants.map((v) => v.variant))))].sort(),
    hasBaseScenes: chapters.some((c) => c.scenes.some((s) => s.hasBase)),
  };
}
