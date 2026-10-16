import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolate git from the user's own config and give it an identity.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

export function gitIn(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

// A temp book with `files`, committed to a fresh repo.
export async function gitBook(files) {
  const root = await tempDir();
  await writeFiles(root, files);
  gitIn(root, 'init', '-q', '-b', 'main');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'init');
  return root;
}

// Every file under root (not .git), sorted, as book-relative paths.
export async function listFiles(root, rel = '') {
  const out = [];
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, child)));
    else out.push(child);
  }
  return out.sort();
}

export async function tempDir(prefix = 'book-editor-test-') {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

// Writes { 'rel/path.md': 'content', 'some/dir/': null } under root.
export async function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (rel.endsWith('/')) {
      await fs.mkdir(abs, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
  }
}

export const SAMPLE_BOOK = {
  'README.md': '# The Sample Book\n',
  'AGENTS.md': '# Agents\n',
  'manuscript/01-the-washing-house/01-opening.md': 'The bell struck one.\n',
  'manuscript/01-the-washing-house/02-dorgal-arrives.md': 'Dorgal came in laughing. He stopped.\n',
  'manuscript/01-the-washing-house/02-dorgal-arrives.camera.md': 'A camera version.\n',
  'manuscript/01-the-washing-house/03-only-in-manuscript.md': 'One two three four.\n',
  'manuscript/02-the-courtyard/01-merchant.md': 'Five words are right here.\n',
  'manuscript/notes-to-self.md': 'loose\n',
  'outline/01-the-washing-house/_chapter.md': '# Chapter summary\n',
  'outline/01-the-washing-house/01-opening.md': 'Summary: the bell.\n',
  'outline/01-the-washing-house/02-dorgal-arrives.md': 'Summary: Dorgal.\n',
  'outline/01-the-washing-house/04-only-in-outline.md': 'Planned scene.\n',
  'outline/03-planned-chapter/01-idea.md': 'An idea.\n',
  'codex/characters/tor.md': '# Tor\n',
  'codex/characters/supporting/davie.md': '# Davie\n',
  'codex/locations/washing-house.md': '# Washing house\n',
  'codex/canon-notes.md': '# Canon\n',
  'codex/_templates/character.md': '# {{name}}\n',
};
