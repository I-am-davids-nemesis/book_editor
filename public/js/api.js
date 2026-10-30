export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}

// A random token from the server, embedded in the page; the Claude routes
// refuse requests without it.
export const TOKEN = typeof document === 'undefined' ? '' : document.querySelector('meta[name="editor-token"]')?.content || '';

async function request(method, url, body, { keepalive = false } = {}) {
  const opts = { method, headers: { 'X-Editor-Token': TOKEN }, keepalive };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    // The server is gone (stopped, or the laptop slept through a restart).
    throw new ApiError(0, { error: 'Can’t reach the editor server. Is `npm start` still running?' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const book = (id) => `/api/books/${encodeURIComponent(id)}`;

export const api = {
  listBooks: () => request('GET', '/api/books'),
  registerBook: (path) => request('POST', '/api/books/register', { path }),
  forgetBook: (id) => request('DELETE', book(id)),
  getBook: (id) => request('GET', book(id)),
  getTree: (id) => request('GET', `${book(id)}/tree`),
  readFile: (id, path) => request('GET', `${book(id)}/file?path=${encodeURIComponent(path)}`),
  writeFile: (id, path, content, baseHash, force = false, opts) =>
    request('PUT', `${book(id)}/file`, { path, content, baseHash, force }, opts),
  search: (id, { query, caseSensitive, wholeWord, scope }) =>
    request('GET', `${book(id)}/search?${new URLSearchParams({ q: query, case: caseSensitive ? '1' : '0', word: wholeWord ? '1' : '0', scope })}`),
  checkpoint: (id, reason) => request('POST', `${book(id)}/checkpoint`, { reason }),
  getCompileSettings: (id) => request('GET', `${book(id)}/compile`),
  compile: (id, opts) => request('POST', `${book(id)}/compile`, opts),
  gitStatus: (id) => request('GET', `${book(id)}/git/status`),
  gitCommit: (id, message) => request('POST', `${book(id)}/git/commit`, { message }),
  gitPush: (id) => request('POST', `${book(id)}/git/push`),
  gitGraph: (id, { limit, skip, path } = {}) =>
    request('GET', `${book(id)}/git/graph?${new URLSearchParams(Object.entries({ limit, skip, path }).filter(([, v]) => v !== undefined && v !== null && v !== ''))}`),
  gitFileDiff: (id, { from, to, path, fromPath }) =>
    request('GET', `${book(id)}/git/file-diff?${new URLSearchParams(Object.entries({ from, to, path, from_path: fromPath }).filter(([, v]) => v))}`),
  gitRestoreFile: (id, rev, path) => request('POST', `${book(id)}/git/restore-file`, { rev, path }),
  gitBranch: (id, name, from) => request('POST', `${book(id)}/git/branch`, { name, from }),
  gitSwitch: (id, branch) => request('POST', `${book(id)}/git/switch`, { branch }),
  gitRestoreBook: (id, rev) => request('POST', `${book(id)}/git/restore-book`, { rev }),
  gitCompare: (id, { from, to }) => request('GET', `${book(id)}/git/compare?${new URLSearchParams({ ...(from ? { from } : {}), to })}`),

  claudeSession: (id) => request('GET', `${book(id)}/claude/session`),
  claudeClear: (id) => request('DELETE', `${book(id)}/claude/session`),
  claudeSettings: (id, settings) => request('PUT', `${book(id)}/claude/settings`, settings),
  claudeStart: (id, { prompt, context, newSession }) => request('POST', `${book(id)}/claude/runs`, { prompt, context, newSession }),
  claudeAnswer: (id, run, requestId, allow) =>
    request('POST', `${book(id)}/claude/runs/${encodeURIComponent(run)}/permission`, { requestId, allow }),
  claudeStop: (id, run) => request('POST', `${book(id)}/claude/runs/${encodeURIComponent(run)}/stop`),
  claudeEventsUrl: (id, run) => `${book(id)}/claude/runs/${encodeURIComponent(run)}/events?token=${encodeURIComponent(TOKEN)}`,

  createBook: (title, remote) => request('POST', '/api/books', { title, remote }),

  addChapter: (id, title, position) => request('POST', `${book(id)}/chapters`, { title, position }),
  renameChapter: (id, chapter, title) => request('PATCH', `${book(id)}/chapters/${encodeURIComponent(chapter)}`, { title }),
  deleteChapter: (id, chapter) => request('DELETE', `${book(id)}/chapters/${encodeURIComponent(chapter)}`),
  addScene: (id, chapter, title, position) =>
    request('POST', `${book(id)}/chapters/${encodeURIComponent(chapter)}/scenes`, { title, position }),
  renameScene: (id, chapter, scene, title) =>
    request('PATCH', `${book(id)}/chapters/${encodeURIComponent(chapter)}/scenes/${encodeURIComponent(scene)}`, { title }),
  deleteScene: (id, chapter, scene) =>
    request('DELETE', `${book(id)}/chapters/${encodeURIComponent(chapter)}/scenes/${encodeURIComponent(scene)}`),
  reorder: (id, chapter, order) => request('POST', `${book(id)}/reorder`, { chapter, order }),
  createMissing: (id, path) => request('POST', `${book(id)}/create-missing`, { path }),

  addImage: (id, { filename, data, of }) => request('POST', `${book(id)}/lookbook`, { filename, data, of }),
  updateImage: (id, path, changes) => request('PATCH', `${book(id)}/lookbook`, { path, ...changes }),
  deleteImage: (id, path) => request('DELETE', `${book(id)}/lookbook?path=${encodeURIComponent(path)}`),
  handoff: (id, paths, name) => request('POST', `${book(id)}/handoff`, { paths, name }),
  addVisualStyle: (id) => request('POST', `${book(id)}/visual-style`, {}),

  addCodex: (id, kind, name) => request('POST', `${book(id)}/codex`, { kind, name }),
  renameCodex: (id, path, name) => request('PATCH', `${book(id)}/codex`, { path, name }),
  deleteCodex: (id, path) => request('DELETE', `${book(id)}/codex?path=${encodeURIComponent(path)}`),
};
