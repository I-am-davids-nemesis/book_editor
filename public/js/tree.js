import { bookHref, formatCount, h } from './ui.js';

// Renders one sidebar tab from the server's tree. Every entry is a link, so
// opening a file is just navigation.

function item({ id, tab, path, title, words, badges = [], active, missing }) {
  const attrs = {
    class: `item${active ? ' active' : ''}${missing ? ' missing' : ''}`,
    href: missing ? null : bookHref(id, tab, path),
    title: path,
    'data-path': path,
  };
  return h('a', attrs,
    h('span', { class: 'title' }, title),
    badges.map((b) => h('span', { class: 'badge', title: b.hint }, b.text)),
    words !== undefined ? h('span', { class: 'count' }, formatCount(words)) : null);
}

function chapterGroup(ch, children) {
  const badges = [];
  if (!ch.inManuscript) badges.push(h('span', { class: 'badge', title: 'No folder in manuscript/' }, 'no manuscript'));
  if (!ch.inOutline) badges.push(h('span', { class: 'badge', title: 'No folder in outline/' }, 'no outline'));
  return h('details', { class: 'group', open: true, 'data-chapter': ch.name },
    h('summary', {}, h('span', {}, ch.title), badges, h('span', { class: 'count' }, formatCount(ch.words))),
    children);
}

function manuscriptTab(tree, id, activePath) {
  const out = tree.chapters.map((ch) => chapterGroup(ch, ch.scenes.map((s) => item({
    id,
    tab: 'manuscript',
    path: s.manuscriptPath,
    title: s.title,
    words: s.inManuscript ? s.words : undefined,
    active: s.manuscriptPath === activePath,
    missing: !s.inManuscript,
    badges: [
      ...(!s.inOutline && s.inManuscript ? [{ text: 'no plot', hint: 'No matching file in outline/' }] : []),
      ...(!s.inManuscript ? [{ text: 'no scene file', hint: 'Only the outline file exists' }] : []),
      ...(s.variants.length ? [{ text: `+${s.variants.length} variant`, hint: s.variants.map((v) => v.name).join(', ') }] : []),
    ],
  }))));

  if (tree.looseManuscript.length) {
    out.push(h('div', { class: 'group-label' }, 'Not in a chapter'));
    out.push(...tree.looseManuscript.map((f) => item({ id, tab: 'manuscript', path: f.path, title: f.title, active: f.path === activePath })));
  }
  if (!out.length) out.push(h('div', { class: 'empty', style: 'padding: 12px' }, 'No chapters yet.'));
  return out;
}

function outlineTab(tree, id, activePath) {
  const out = tree.chapters.map((ch) => chapterGroup(ch, [
    item({
      id,
      tab: 'outline',
      path: ch.summaryPath,
      title: 'Chapter summary',
      active: ch.summaryPath === activePath,
      missing: !ch.hasSummary,
      badges: ch.hasSummary ? [] : [{ text: 'missing', hint: `${ch.summaryPath} does not exist` }],
    }),
    ...ch.scenes.map((s) => item({
      id,
      tab: 'outline',
      path: s.outlinePath,
      title: s.title,
      active: s.outlinePath === activePath,
      missing: !s.inOutline,
      badges: [
        ...(!s.inOutline ? [{ text: 'no plot file', hint: 'Only the manuscript file exists' }] : []),
        ...(!s.inManuscript && s.inOutline ? [{ text: 'no scene', hint: 'No matching file in manuscript/' }] : []),
      ],
    })),
  ]));

  if (tree.looseOutline.length) {
    out.push(h('div', { class: 'group-label' }, 'Not in a chapter'));
    out.push(...tree.looseOutline.map((f) => item({ id, tab: 'outline', path: f.path, title: f.title, active: f.path === activePath })));
  }
  if (!out.length) out.push(h('div', { class: 'empty', style: 'padding: 12px' }, 'No chapters yet.'));
  return out;
}

function codexGroup(label, entries, id, activePath, { open = true } = {}) {
  const children = [];
  let folder = '';
  for (const e of entries) {
    if (e.folder !== folder) {
      folder = e.folder;
      if (folder) children.push(h('div', { class: 'subfolder' }, folder));
    }
    children.push(item({ id, tab: 'codex', path: e.path, title: e.title, active: e.path === activePath }));
  }
  if (!children.length) children.push(h('div', { class: 'item missing' }, h('span', { class: 'title' }, 'None yet')));
  const hasActive = entries.some((e) => e.path === activePath);
  return h('details', { class: 'group', open: open || hasActive },
    h('summary', {}, h('span', {}, label), h('span', { class: 'count' }, entries.length)),
    children);
}

function codexTab(tree, id, activePath) {
  const { codex } = tree;
  return [
    codexGroup('Characters', codex.characters, id, activePath),
    codexGroup('Locations', codex.locations, id, activePath),
    codexGroup('Notes', codex.notes, id, activePath),
    codexGroup('Templates', codex.templates, id, activePath, { open: false }),
    codexGroup('Book files', tree.rootFiles.map((f) => ({ ...f, title: f.name, folder: '' })), id, activePath, { open: false }),
  ];
}

const TABS = { manuscript: manuscriptTab, outline: outlineTab, codex: codexTab };

export function renderTree(container, tree, { id, tab, activePath }) {
  container.replaceChildren(...TABS[tab](tree, id, activePath));
  container.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' });
}

// Which tab a file belongs to, for links opened without one.
export function tabForPath(path) {
  if (path.startsWith('manuscript/')) return 'manuscript';
  if (path.startsWith('outline/')) return 'outline';
  return 'codex';
}
