import { h } from './ui.js';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const ALT = IS_MAC ? '⌥' : 'Alt+';
const SHIFT = IS_MAC ? '⇧' : 'Shift+';

// key: what to match (e.code for letters, so Alt combos work on every
// keyboard layout); label: how the help sheet shows it.
export const SHORTCUTS = [
  { id: 'save', mod: true, code: 'KeyS', label: `${MOD}S`, help: 'Save now (edits also save by themselves)' },
  { id: 'revision', mod: true, shift: true, code: 'KeyS', label: `${MOD}${SHIFT}S`, help: 'Save revision (a named commit)' },
  { id: 'quickOpen', mod: true, code: 'KeyP', label: `${MOD}P`, help: 'Find and open a file' },
  { id: 'prevScene', mod: true, alt: true, key: 'ArrowUp', label: `${MOD}${ALT}↑`, help: 'Previous scene' },
  { id: 'nextScene', mod: true, alt: true, key: 'ArrowDown', label: `${MOD}${ALT}↓`, help: 'Next scene' },
  { id: 'companion', mod: true, alt: true, code: 'KeyP', label: `${MOD}${ALT}P`, help: 'Show or hide the plot (or scene) beside the file' },
  { id: 'cycleView', mod: true, code: 'KeyE', label: `${MOD}E`, help: 'Edit → Split → Preview, in the pane you are in' },
  { id: 'history', mod: true, alt: true, code: 'KeyH', label: `${MOD}${ALT}H`, help: 'History' },
  { id: 'claude', mod: true, alt: true, code: 'KeyC', label: `${MOD}${ALT}C`, help: 'Show or hide the Claude panel' },
  { id: 'help', mod: true, code: 'Slash', label: `${MOD}/  or  ?`, help: 'This list' },
  { id: 'escape', label: 'Esc', help: 'Close History, a dialog or a menu' },
  { id: 'find', label: `${MOD}F`, help: 'Find in the file (inside the editor)' },
];

function matches(sc, e) {
  if (sc.mod === undefined) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (Boolean(sc.mod) !== mod || Boolean(sc.shift) !== e.shiftKey || Boolean(sc.alt) !== e.altKey) return false;
  return sc.code ? e.code === sc.code : e.key === sc.key;
}

const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// Installs one window-level handler; `handlers[id]()` runs the shortcut.
// Captures before CodeMirror, so ⌘S saves both panes and ⌘E isn't eaten.
export function installShortcuts(handlers) {
  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    let sc = SHORTCUTS.find((s) => matches(s, e));
    if (!sc && e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(document.activeElement)) {
      sc = SHORTCUTS.find((s) => s.id === 'help');
    }
    if (!sc || !handlers[sc.id]) return;
    if (handlers[sc.id]() === false) return; // not applicable here; let the browser have it
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

export function showShortcutHelp() {
  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog' },
      h('h2', {}, 'Keyboard shortcuts'),
      h('table', { class: 'shortcuts' }, SHORTCUTS.map((s) => h('tr', {}, h('td', {}, h('kbd', {}, s.label)), h('td', {}, s.help)))),
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'submit', class: 'primary' }, 'Close'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
