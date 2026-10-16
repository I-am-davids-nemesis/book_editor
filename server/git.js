import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { conflict, HttpError } from './errors.js';

// Every call goes through execFile with an argument list, never a shell string.
export function git(root, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message = (stderr || err.message).trim();
        reject(Object.assign(new HttpError(500, `git ${args[0]}: ${message}`), { stderr, code: err.code }));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function isRepo(root) {
  try {
    await fs.access(path.join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}

// Rename a file or folder, through `git mv` when git tracks it so history
// follows; plain rename otherwise (untracked files, folders git doesn't know,
// books that aren't repos).
export async function move(root, from, to) {
  // fs.rename would silently replace an existing file, so check first.
  try {
    await fs.access(path.join(root, to));
    throw conflict(`Cannot move ${from}: ${to} already exists`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (await isRepo(root)) {
    try {
      await git(root, ['mv', '--', from, to]);
      return;
    } catch {
      // not tracked (or partly tracked): fall through to a plain rename
    }
  }
  await fs.rename(path.join(root, from), path.join(root, to));
}

export async function initRepo(root, { remote } = {}) {
  await git(root, ['init', '-b', 'main']);
  if (remote) await git(root, ['remote', 'add', 'origin', remote]);
}

export async function commitAll(root, message) {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', message]);
}
