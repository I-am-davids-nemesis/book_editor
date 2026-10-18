import { bookHref, formatCount, h, showMenu } from './ui.js';

// --- narration modes -------------------------------------------------------
// A scene can exist as a plain file (mode '') and/or as variants
// (`01-x.camera.md` is mode 'camera'). The sidebar shows one mode at a time.

export function modeLabel(mode) {
  if (!mode) return 'Main';
  const words = mode.replace(/[-_]+/g, ' ');
  return words[0].toUpperCase() + words.slice(1);
}

// Modes the book offers, in display order.
export function availableModes(tree) {
  return [...(tree.hasBaseScenes || !tree.modes.length ? [''] : []), ...tree.modes];
}

// The scene's manuscript file for a mode, or null if it doesn't exist.
export function sceneFile(scene, mode) {
  if (!mode) return scene.hasBase ? scene.manuscriptPath : null;
  return scene.variants.find((v) => v.variant === mode)?.path ?? null;
}

// Where the scene's file for a mode would be (for "Create").
export function expectedSceneFile(scene, mode) {
  return mode ? scene.manuscriptPath.replace(/\.md$/i, `.${mode}.md`) : scene.manuscriptPath;
}

export function sceneFiles(scene) {
  return [...(scene.hasBase ? [scene.manuscriptPath] : []), ...scene.variants.map((v) => v.path)];
}

// The scene (and chapter) that a manuscript path belongs to, if any.
export function findScene(tree, path) {
  for (const ch of tree.chapters) {
    for (const s of ch.scenes) {
      if (s.outlinePath === path || sceneFiles(s).includes(path)) return { ch, scene: s };
    }
  }
  return null;
}

// The plot file or scene shown beside `path` (null if it has none): a scene's
// plot file, or a plot file's scene in the given mode. `exists` says whether
// that file is on disk yet.
export function companionOf(tree, path, mode) {
  const hit = findScene(tree, path);
  if (!hit) return null;
  const { scene } = hit;
  if (path.startsWith('manuscript/')) {
    return { kind: 'plot', path: scene.outlinePath, exists: scene.inOutline, scene };
  }
  const file = sceneFile(scene, mode);
  return { kind: 'scene', path: file ?? expectedSceneFile(scene, mode), exists: Boolean(file), mode, scene };
}

// Updates the tree's word counts for one manuscript file, the way the server
// computes them, so the sidebar can follow typing. Returns the scene and
// chapter it touched, or null when the file isn't a counted scene file.
export function setFileWords(tree, path, words) {
  const hit = path.startsWith('manuscript/') && findScene(tree, path);
  if (!hit) return null;
  const { ch, scene } = hit;
  const variant = scene.variants.find((v) => v.path === path);
  const mode = variant ? variant.variant : '';
  const delta = words - (scene.wordsByMode[mode] || 0);
  if (!delta) return hit;
  if (variant) variant.words = words;
  else scene.words = words;
  scene.wordsByMode[mode] = words;
  ch.wordsByMode[mode] = (ch.wordsByMode[mode] || 0) + delta;
  tree.wordsByMode[mode] = (tree.wordsByMode[mode] || 0) + delta;
  if (!variant) {
    ch.words += delta;
    tree.words += delta;
  }
  return hit;
}

// Renders one sidebar tab from the server's tree. Opening a file is a link
// (navigation); everything that changes the book goes through `actions`,
// which main.js supplies:
//   addChapter(), addScene(ch), renameChapter(ch), deleteChapter(ch),
//   renameScene(ch, scene), deleteScene(ch, scene), reorder(chapterName|null, names),
//   createMissing(path), addCodex(kind), renameCodex(entry), deleteCodex(entry)

function moreButton(label, items) {
  return h('button', {
    type: 'button',
    class: 'more',
    title: label,
    'aria-label': label,
    'aria-haspopup': 'menu',
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e.currentTarget, items());
    },
  }, '⋯');
}

function row({ id, tab, path, title, words, badges = [], active, missing, onCreate, menu, drag }) {
  const content = [
    h('span', { class: 'title' }, title),
    badges.map((b) => h('span', { class: 'badge', title: b.hint }, b.text)),
    words !== undefined ? h('span', { class: 'count' }, formatCount(words)) : null,
  ];
  const main = missing
    ? h('span', { class: 'row-main', title: `${path} does not exist` }, content)
    : h('a', { class: 'row-main', href: bookHref(id, tab, path), title: path, draggable: 'false' }, content);
  const el = h('div', { class: `item${active ? ' active' : ''}${missing ? ' missing' : ''}`, 'data-path': path },
    main,
    missing && onCreate ? h('button', { type: 'button', class: 'create', title: `Create ${path}`, onclick: onCreate }, 'Create') : null,
    menu ? moreButton(`Actions for ${title}`, menu) : null);
  if (drag) makeDraggable(el, drag);
  return el;
}

// --- drag to reorder ---------------------------------------------------------
// A drag carries { group, name }; it can only drop onto rows of the same group
// (the chapter list, or the scenes of one chapter).

let dragging = null;

function makeDraggable(el, { group, name, names, onDrop }) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    dragging = { group, name };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', name);
    el.classList.add('dragging');
    e.stopPropagation();
  });
  el.addEventListener('dragend', () => {
    dragging = null;
    el.classList.remove('dragging');
    clearDropMarks();
  });
  el.addEventListener('dragover', (e) => {
    if (!dragging || dragging.group !== group || dragging.name === name) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearDropMarks();
    el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
  el.addEventListener('drop', (e) => {
    if (!dragging || dragging.group !== group || dragging.name === name) return;
    e.preventDefault();
    e.stopPropagation();
    const after = el.classList.contains('drop-after');
    const moved = dragging.name;
    clearDropMarks();
    const order = names.filter((n) => n !== moved);
    order.splice(order.indexOf(name) + (after ? 1 : 0), 0, moved);
    if (order.join('/') !== names.join('/')) onDrop(order);
  });
}

function clearDropMarks() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}

function moveItems(names, name, onReorder) {
  const i = names.indexOf(name);
  const swap = (j) => {
    const order = [...names];
    [order[i], order[j]] = [order[j], order[i]];
    onReorder(order);
  };
  return [
    { label: 'Move up', disabled: i <= 0, onclick: () => swap(i - 1) },
    { label: 'Move down', disabled: i >= names.length - 1, onclick: () => swap(i + 1) },
  ];
}

// --- manuscript and outline tabs --------------------------------------------

function toolbar(...buttons) {
  return h('div', { class: 'tree-toolbar' }, buttons);
}

function addButton(label, title, onclick) {
  return h('button', {
    type: 'button',
    class: 'add',
    title,
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); onclick(); },
  }, label);
}

function chapterGroup(ctx, ch, children) {
  const { tab, actions, chapterNames, mode } = ctx;
  const sceneLabel = tab === 'outline' ? '+ Scene summary' : '+ Scene';
  const summary = h('summary', {},
    h('span', { class: 'chapter-title' }, ch.title),
    h('span', { class: 'count' }, tab === 'manuscript' ? formatCount(ch.wordsByMode[mode] || 0) : ''),
    addButton(sceneLabel, 'Add a scene to this chapter (creates the scene file and its plot file)', () => actions.addScene(ch)),
    moreButton(`Actions for chapter ${ch.title}`, () => [
      { label: sceneLabel, onclick: () => actions.addScene(ch) },
      null,
      { label: 'Rename chapter…', onclick: () => actions.renameChapter(ch) },
      ...moveItems(chapterNames, ch.name, (order) => actions.reorder(null, order)),
      null,
      { label: 'Delete chapter…', danger: true, onclick: () => actions.deleteChapter(ch) },
    ]));
  const group = h('details', { class: 'group chapter', open: true, 'data-chapter': ch.name }, summary, children);
  makeDraggable(summary, {
    group: 'chapters',
    name: ch.name,
    names: chapterNames,
    onDrop: (order) => actions.reorder(null, order),
  });
  return group;
}

function sceneRow(ctx, ch, s) {
  const { id, tab, activePath, actions, mode } = ctx;
  const modeFile = sceneFile(s, mode);
  const scenePath = modeFile ?? expectedSceneFile(s, mode);
  const inThisTab = tab === 'outline' ? s.inOutline : Boolean(modeFile);
  const path = tab === 'outline' ? s.outlinePath : scenePath;
  const otherPath = tab === 'outline' ? (sceneFile(s, mode) ?? sceneFiles(s)[0] ?? scenePath) : s.outlinePath;
  const otherExists = tab === 'outline' ? s.inManuscript : s.inOutline;
  const names = ch.scenes.map((x) => x.name);

  const badges = [];
  if (tab === 'manuscript') {
    if (s.inManuscript && !s.inOutline) badges.push({ text: 'no plot', hint: 'No matching file in outline/' });
    if (!modeFile && s.inManuscript) badges.push({ text: `no ${modeLabel(mode).toLowerCase()}`, hint: `This scene has no ${modeLabel(mode)} version yet` });
  } else if (s.inOutline && !s.inManuscript) {
    badges.push({ text: 'no scene', hint: 'No matching file in manuscript/' });
  }

  return row({
    id,
    tab,
    path,
    title: s.title,
    words: tab === 'manuscript' && modeFile ? s.wordsByMode[mode] : undefined,
    active: tab === 'outline' ? path === activePath : sceneFiles(s).includes(activePath) || path === activePath,
    missing: !inThisTab,
    onCreate: () => actions.createMissing(path),
    badges,
    drag: { group: `scenes:${ch.name}`, name: s.name, names, onDrop: (order) => actions.reorder(ch.name, order) },
    menu: () => [
      otherExists
        ? { label: tab === 'outline' ? 'Open scene' : 'Open plot', onclick: () => { location.hash = bookHref(id, tab === 'outline' ? 'manuscript' : 'outline', otherPath); } }
        : { label: tab === 'outline' ? 'Create scene file' : 'Create plot file', onclick: () => actions.createMissing(otherPath) },
      null,
      { label: 'Rename scene…', onclick: () => actions.renameScene(ch, s) },
      ...moveItems(names, s.name, (order) => actions.reorder(ch.name, order)),
      null,
      { label: 'Delete scene…', danger: true, onclick: () => actions.deleteScene(ch, s) },
    ],
  });
}

function looseFiles(ctx, files) {
  if (!files.length) return [];
  return [
    h('div', { class: 'group-label' }, 'Not in a chapter'),
    ...files.map((f) => row({ id: ctx.id, tab: ctx.tab, path: f.path, title: f.title, active: f.path === ctx.activePath })),
  ];
}

function modePicker(ctx) {
  const modes = availableModes(ctx.tree);
  if (modes.length < 2) return null;
  return h('label', { class: 'mode-picker', title: 'Which narration mode the sidebar opens and counts' },
    h('span', {}, 'Mode'),
    h('select', { onchange: (e) => ctx.actions.setMode(e.target.value) },
      modes.map((m) => h('option', { value: m, selected: m === ctx.mode || null }, modeLabel(m)))));
}

function manuscriptTab(ctx) {
  const { tree, actions } = ctx;
  const out = [toolbar(addButton('+ Chapter', 'Add a chapter at the end', () => actions.addChapter()), modePicker(ctx))];
  out.push(...tree.chapters.map((ch) => chapterGroup(ctx, ch, ch.scenes.map((s) => sceneRow(ctx, ch, s)))));
  out.push(...looseFiles(ctx, tree.looseManuscript));
  if (!tree.chapters.length) out.push(h('div', { class: 'empty-tree' }, 'No chapters yet. Use “+ Chapter” to start.'));
  return out;
}

function outlineTab(ctx) {
  const { tree, actions, id, activePath } = ctx;
  const out = [toolbar(addButton('+ Chapter', 'Add a chapter at the end', () => actions.addChapter()))];
  out.push(...tree.chapters.map((ch) => chapterGroup(ctx, ch, [
    row({
      id,
      tab: 'outline',
      path: ch.summaryPath,
      title: 'Chapter summary',
      active: ch.summaryPath === activePath,
      missing: !ch.hasSummary,
      onCreate: () => actions.createMissing(ch.summaryPath),
    }),
    ...ch.scenes.map((s) => sceneRow(ctx, ch, s)),
  ])));
  out.push(...looseFiles(ctx, tree.looseOutline));
  if (!tree.chapters.length) out.push(h('div', { class: 'empty-tree' }, 'No chapters yet. Use “+ Chapter” to start.'));
  return out;
}

// --- codex tab ---------------------------------------------------------------

function codexGroup(ctx, label, entries, { open = true, addKind, editable = true } = {}) {
  const { id, activePath, actions } = ctx;
  const children = [];
  let folder = '';
  for (const e of entries) {
    if (e.folder !== folder) {
      folder = e.folder;
      if (folder) children.push(h('div', { class: 'subfolder' }, folder));
    }
    children.push(row({
      id,
      tab: 'codex',
      path: e.path,
      title: e.title,
      active: e.path === activePath,
      menu: editable ? () => [
        { label: 'Rename…', onclick: () => actions.renameCodex(e) },
        null,
        { label: 'Delete…', danger: true, onclick: () => actions.deleteCodex(e) },
      ] : null,
    }));
  }
  if (!children.length) children.push(h('div', { class: 'empty-tree' }, 'None yet.'));
  const hasActive = entries.some((e) => e.path === activePath);
  return h('details', { class: 'group', open: open || hasActive },
    h('summary', {},
      h('span', { class: 'chapter-title' }, label),
      h('span', { class: 'count' }, entries.length),
      addKind ? addButton('+', `Add ${addKind.label}`, () => actions.addCodex(addKind.kind)) : null),
    children);
}

function codexTab(ctx) {
  const { tree, actions } = ctx;
  const { codex } = tree;
  return [
    toolbar(
      addButton('+ Character', 'Add a character from the template', () => actions.addCodex('character')),
      addButton('+ Location', 'Add a location from the template', () => actions.addCodex('location')),
      addButton('+ Note', 'Add a free-form codex note', () => actions.addCodex('note')),
    ),
    codexGroup(ctx, 'Characters', codex.characters, { addKind: { kind: 'character', label: 'a character' } }),
    codexGroup(ctx, 'Locations', codex.locations, { addKind: { kind: 'location', label: 'a location' } }),
    codexGroup(ctx, 'Notes', codex.notes, { addKind: { kind: 'note', label: 'a note' } }),
    codexGroup(ctx, 'Templates', codex.templates, { open: false }),
    codexGroup(ctx, 'Book files', tree.rootFiles.map((f) => ({ ...f, title: f.name, folder: '' })), { open: false, editable: false }),
  ];
}

const TABS = { manuscript: manuscriptTab, outline: outlineTab, codex: codexTab };

export function renderTree(container, tree, { id, tab, activePath, actions, mode = '' }) {
  // Keep collapsed chapters collapsed across re-renders.
  const closed = new Set([...container.querySelectorAll('details.chapter:not([open])')].map((d) => d.dataset.chapter));
  const scroll = container.scrollTop;
  const ctx = { id, tab, activePath, actions, mode, tree, chapterNames: tree.chapters.map((c) => c.name) };
  container.replaceChildren(...TABS[tab](ctx));
  for (const d of container.querySelectorAll('details.chapter')) {
    if (closed.has(d.dataset.chapter) && !d.querySelector('.item.active')) d.open = false;
  }
  container.scrollTop = scroll;
  container.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' });
}

// Which tab a file belongs to, for links opened without one.
export function tabForPath(path) {
  if (path.startsWith('manuscript/')) return 'manuscript';
  if (path.startsWith('outline/')) return 'outline';
  return 'codex';
}
