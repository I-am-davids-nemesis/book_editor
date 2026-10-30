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
  for (const c of children.flat(Infinity)) {
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

// The URL of a lookbook image ({ path, mtime }); the mtime makes a replaced
// image load fresh. `rev` gives the image as it was in that commit.
export function imageSrc(bookId, { path, mtime }, rev) {
  const q = new URLSearchParams({ path, ...(rev ? { rev } : { v: String(mtime ?? '') }) });
  return `/api/books/${encodeURIComponent(bookId)}/image?${q}`;
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

// A small popup menu under `anchor`. items: [{ label, onclick, danger, disabled }] or null for a separator.
let openMenu = null;
export function showMenu(anchor, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' },
    items.map((it) => (it === null
      ? h('div', { class: 'menu-sep', role: 'separator' })
      : h('button', {
        type: 'button',
        role: 'menuitem',
        class: it.danger ? 'danger' : null,
        disabled: it.disabled || null,
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); closeMenu(); it.onclick(); },
      }, it.label))));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
  const below = r.bottom + 4;
  menu.style.top = `${below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 4) : below}px`;
  openMenu = menu;
  menu.querySelector('button:not(:disabled)')?.focus();
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  });
}

function onOutside(e) {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}

function onKey(e) {
  if (!openMenu) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const buttons = [...openMenu.querySelectorAll('button:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
}

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}
