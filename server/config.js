import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Settings live outside any book, so books stay plain folders.
// BOOK_EDITOR_CONFIG overrides the location (used by tests).
export function configPath() {
  return process.env.BOOK_EDITOR_CONFIG
    || path.join(os.homedir(), '.config', 'book-editor', 'config.json');
}

function defaults() {
  return {
    libraryRoot: path.join(os.homedir(), 'workspace', 'books'),
    // id -> absolute path, for books opened from outside the library root
    registered: {},
  };
}

export async function loadConfig() {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    return { ...defaults(), ...raw, registered: { ...(raw.registered || {}) } };
  } catch (err) {
    if (err.code === 'ENOENT') return defaults();
    throw new Error(`Cannot read config at ${configPath()}: ${err.message}`);
  }
}

export async function saveConfig(config) {
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n');
  await fs.rename(tmp, file);
}
