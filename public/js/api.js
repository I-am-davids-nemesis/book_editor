export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
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
  writeFile: (id, path, content, baseHash, force = false) =>
    request('PUT', `${book(id)}/file`, { path, content, baseHash, force }),
};
