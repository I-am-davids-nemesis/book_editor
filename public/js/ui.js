// Small DOM helpers shared by the views.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

let toastTimer;
export function toast(message, { error = false, ms = 3500 } = {}) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function formatCount(n) {
  return n.toLocaleString();
}

// Hash routes: #/  and  #/book/<id>[/<tab>[/<path...>]]
export function bookHref(id, tab, path) {
  let href = `#/book/${encodeURIComponent(id)}`;
  if (tab) href += `/${tab}`;
  if (path) href += '/' + path.split('/').map(encodeURIComponent).join('/');
  return href;
}

export function parseHash(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'book' || !parts[1]) return { view: 'library' };
  return { view: 'book', id: parts[1], tab: parts[2] || null, path: parts.slice(3).join('/') || null };
}
