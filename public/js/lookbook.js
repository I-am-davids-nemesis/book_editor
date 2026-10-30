import { api } from './api.js';
import { IMAGE_TOOLS, imagePromptFrom } from './codexprompts.js';
import { confirmDialog, promptDialog } from './dialogs.js';
import { handoffDialog, loadVisualStyle } from './handoff.js';
import { codexEntries, imagesByEntry } from './tree.js';
import { bookHref, h, imageSrc, showMenu, toast } from './ui.js';
import {
  ALL_VIEWS, fixedTraits, handoffPrompt, isReference, missingViews, rankImages, variantsIn, VIEW_LABELS, VIEWS,
} from './worldmodel.js';

// Matches MAX_IMAGE_BYTES on the server.
export const MAX_IMAGE_BYTES = 14 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif';

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Uploads files to the lookbook, each linked to the codex entries in `of`.
// Returns a structure-change result for everything that was added; files that
// fail are reported in a toast and skipped.
export async function uploadImages(bookId, files, { of = [] } = {}) {
  const created = [];
  const paths = [];
  const failed = [];
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      failed.push(`${file.name}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
      continue;
    }
    try {
      const res = await api.addImage(bookId, { filename: file.name, data: await readBase64(file), of });
      created.push(...res.created);
      paths.push(res.path);
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
    }
  }
  if (failed.length) toast(failed.join(' · '), { error: true, ms: 8000 });
  return { moves: [], created, deleted: [], paths };
}

// Opens the file picker; resolves with the chosen files (maybe none).
export function pickImages() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

// Makes `el` accept image files dropped from Finder; `onFiles(files)` gets them.
export function acceptDrops(el, onFiles) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth += 1;
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) el.classList.remove('drop-target');
  });
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    el.classList.remove('drop-target');
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) onFiles(files);
    else toast('Only image files can be added to the lookbook', { error: true });
  });
}

// Copies an entry's image prompt (with its fixed traits and the book's visual
// style, but no references).
async function copyImagePrompt(bookId, entry, text) {
  const prompt = handoffPrompt({ kind: entry.kind, text, styleText: await loadVisualStyle(bookId).catch(() => '') });
  try {
    await navigator.clipboard.writeText(prompt);
  } catch {
    toast('Couldn’t copy the prompt; select it in the Description section instead', { error: true });
    return;
  }
  toast('Image prompt copied, with fixed traits and the visual style');
}

const viewLabel = (img) => [VIEW_LABELS[img.view] ?? 'Reference', img.variant].filter(Boolean).join(' · ');

// The bar above an open codex entry: its images, references first (and a way
// to add more), what its model sheet still lacks, the image prompt for outside
// generators, and Claude's description actions.
//   entry: { path, title, kind }   claude: { gather(), refine(images), manuscript(), traits() }
//   onStage(): opens the Stage dialog with this entry in the shot
export function entryStrip({ bookId, tree, entry, getText, onAdd, onStage, claude }) {
  const images = rankImages(imagesByEntry(tree).get(entry.path) ?? [], entry.kind);
  const thumbs = h('div', { class: 'thumb-strip', title: 'Drop images here to add them to the lookbook, linked to this entry' },
    images.map((img) => h('a', {
      class: `thumb${isReference(img) ? ' ref' : ''}`,
      href: bookHref(bookId, 'lookbook', img.path),
      title: isReference(img) ? `${img.title} (reference: ${viewLabel(img)})` : img.caption || img.title,
    },
    h('img', { src: imageSrc(bookId, img), alt: img.title, loading: 'lazy' }),
    isReference(img) ? h('span', { class: 'ref-star', 'aria-hidden': 'true' }, '★') : null)),
    h('button', { type: 'button', class: 'thumb add-thumb', title: 'Add images linked to this entry', onclick: async () => {
      const files = await pickImages();
      if (files.length) onAdd(files);
    } }, images.length ? '+' : '+ Add image'));
  acceptDrops(thumbs, onAdd);

  const gaps = missingViews(entry.kind, images);
  const gapsEl = gaps.length && images.length ? h('a', {
    class: 'model-gaps',
    href: bookHref(bookId, 'lookbook', images[0].path),
    title: 'Mark images as references, with their view, in the Lookbook',
  }, `Model sheet: no ${gaps.map((v) => VIEW_LABELS[v].toLowerCase()).join(' or ')} reference yet`) : null;

  const promptMenu = (e) => {
    const text = getText();
    const hasPrompt = imagePromptFrom(text) !== null;
    showMenu(e.currentTarget, [
      ...(hasPrompt ? [] : [{ label: 'No image prompt yet: gather a description first (Claude ▾)', disabled: true, onclick: () => {} }, null]),
      ...IMAGE_TOOLS.map((tool) => ({
        label: `Prepare for ${tool.label}…`,
        onclick: () => handoffDialog({ bookId, entry, text: getText(), images, tool }),
      })),
      null,
      { label: 'Copy image prompt only', disabled: !hasPrompt, onclick: () => copyImagePrompt(bookId, entry, text) },
      null,
      { label: `Stage a shot with ${entry.title}…`, onclick: () => onStage() },
    ]);
  };
  const claudeMenu = (e) => {
    const text = getText();
    const described = imagePromptFrom(text) !== null;
    const traits = fixedTraits(text).length;
    showMenu(e.currentTarget, [
      { label: described ? 'Gather the description again from the manuscript' : 'Gather a description from the manuscript', onclick: () => claude.gather() },
      { label: traits ? 'Suggest more fixed traits' : 'Draft fixed traits from the description', disabled: !described, onclick: () => claude.traits() },
      { label: images.length ? `Refine the description from ${images.length === 1 ? 'its image' : `its ${images.length} images`}` : 'Refine from images (add an image first)', disabled: !images.length, onclick: () => claude.refine(images) },
      { label: 'Suggest manuscript edits from the description', disabled: !described, onclick: () => claude.manuscript() },
    ]);
  };
  return h('div', { class: 'entry-bar' },
    h('div', { class: 'entry-images' }, thumbs, gapsEl),
    h('div', { class: 'entry-actions' },
      h('button', { type: 'button', 'aria-haspopup': 'menu', title: 'Copy the image prompt for an image generator', onclick: promptMenu }, 'Image prompt ▾'),
      h('button', { type: 'button', 'aria-haspopup': 'menu', title: 'Have Claude gather or refine this entry’s description', onclick: claudeMenu }, 'Claude ▾')));
}

// The Lookbook: every image in the book as a grid, filtered by codex entry,
// with a detail panel for the chosen image (links, caption, name).
//   actions: { back(), run(fn) → result|null (a structure change, like the
//   sidebar's), upload(files, of), refine(image, entries), visualStyle(), stage() }
export class LookbookView {
  constructor({ bookId, actions }) {
    this.bookId = bookId;
    this.actions = actions;
    this.tree = null;
    this.selected = null;
    this.filter = ''; // '' all, '-' not linked, '*' references, or a codex path

    this.filterEl = h('select', { 'aria-label': 'Show images of', onchange: () => { this.filter = this.filterEl.value; this.render(); } });
    this.countEl = h('span', { class: 'muted' });
    this.gridEl = h('div', { class: 'lookbook-grid' });
    this.detailEl = h('aside', { class: 'lookbook-detail', hidden: true });
    this.el = h('div', { class: 'lookbook', hidden: true, tabindex: '-1' },
      h('div', { class: 'lookbook-head' },
        h('button', { type: 'button', onclick: () => this.actions.back() }, '← Back to writing'),
        h('h2', {}, 'Lookbook'),
        this.filterEl,
        this.countEl,
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', title: 'How every picture of this book should look (codex/visual-style.md)', onclick: () => this.actions.visualStyle() }, 'Visual style'),
        h('button', { type: 'button', title: 'Put characters in a place and build a prompt for an image generator', onclick: () => this.actions.stage() }, 'Stage a shot'),
        h('button', { type: 'button', class: 'primary', onclick: () => this.add() }, '+ Add images')),
      h('div', { class: 'lookbook-body' }, this.gridEl, this.detailEl));
    acceptDrops(this.el, (files) => this.upload(files));
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || document.querySelector('dialog[open]') || e.defaultPrevented) return;
      if (this.selected) this.select(null);
      else this.actions.back();
    });
  }

  get visible() {
    return !this.el.hidden;
  }

  show(tree, selected = null) {
    const wasHidden = this.el.hidden;
    this.el.hidden = false;
    this.tree = tree;
    this.selected = selected;
    this.render();
    if (wasHidden || !this.el.contains(document.activeElement)) this.el.focus({ preventScroll: true });
  }

  hide() {
    this.el.hidden = true;
  }

  // The tree changed (an upload, or files changed on disk).
  update(tree) {
    this.tree = tree;
    if (this.visible) this.render();
  }

  // New images are linked to the entry being filtered on, if any.
  linkTarget() {
    return this.filter && !['-', '*'].includes(this.filter) ? [this.filter] : [];
  }

  async add() {
    const files = await pickImages();
    if (files.length) await this.upload(files);
  }

  async upload(files) {
    const res = await this.actions.upload(files, this.linkTarget());
    if (res?.paths.length === 1) this.select(res.paths[0]);
  }

  select(path) {
    location.hash = bookHref(this.bookId, 'lookbook', path);
  }

  render() {
    const { lookbook } = this.tree;
    const entries = codexEntries(this.tree);
    const byEntry = imagesByEntry(this.tree);
    const known = new Set(entries.map((e) => e.path));
    if (this.filter && !['-', '*'].includes(this.filter) && !known.has(this.filter)) this.filter = '';

    const unlinked = lookbook.filter((img) => !img.of.some((p) => known.has(p))).length;
    const references = lookbook.filter(isReference);
    this.filterEl.replaceChildren(
      h('option', { value: '' }, `All images (${lookbook.length})`),
      h('option', { value: '*' }, `References (${references.length})`),
      h('option', { value: '-' }, `Not linked (${unlinked})`),
      ...['character', 'location', 'note'].map((kind) => {
        const group = entries.filter((e) => e.kind === kind && byEntry.has(e.path));
        return group.length ? h('optgroup', { label: { character: 'Characters', location: 'Locations', note: 'Notes' }[kind] },
          group.map((e) => h('option', { value: e.path }, `${e.title} (${byEntry.get(e.path).length})`))) : null;
      }));
    this.filterEl.value = this.filter;

    const shown = this.filter === '-' ? lookbook.filter((img) => !img.of.some((p) => known.has(p)))
      : this.filter === '*' ? references
        : this.filter ? rankImages(byEntry.get(this.filter) ?? [], entries.find((e) => e.path === this.filter)?.kind)
          : lookbook;
    this.countEl.textContent = this.filter ? `${shown.length} of ${lookbook.length}` : '';
    this.gridEl.replaceChildren(...(shown.length ? shown.map((img) => this.card(img, entries)) : [
      h('div', { class: 'placeholder lookbook-empty' }, h('div', {},
        h('p', {}, lookbook.length ? 'No images here.' : 'No images yet. Add pictures of your characters, places and things, then link each one to the codex entries it shows.'),
        h('p', { class: 'muted' }, 'Drop image files anywhere on this page, or use “+ Add images”.'))),
    ]));

    const img = lookbook.find((i) => i.path === this.selected);
    this.detailEl.hidden = !img;
    if (img) this.renderDetail(img, entries);
    this.gridEl.querySelector('.selected')?.scrollIntoView?.({ block: 'nearest' });
  }

  card(img, entries) {
    const titles = img.of.map((p) => entries.find((e) => e.path === p)?.title).filter(Boolean);
    return h('a', {
      class: `lookbook-card${img.path === this.selected ? ' selected' : ''}`,
      href: bookHref(this.bookId, 'lookbook', img.path),
      title: img.caption || img.title,
    },
    h('span', { class: 'lookbook-img' },
      h('img', { src: imageSrc(this.bookId, img), alt: img.title, loading: 'lazy' }),
      isReference(img) ? h('span', { class: 'ref-badge' }, `★ ${viewLabel(img)}`) : null),
    h('span', { class: 'lookbook-title' }, img.title),
    h('span', { class: 'lookbook-of' }, titles.length ? titles.join(', ') : 'Not linked'));
  }

  renderDetail(img, entries) {
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const linked = img.of.map((p) => byPath.get(p) ?? { path: p, title: p, missing: true });
    const linkSel = h('select', { 'aria-label': 'Link to a codex entry' },
      h('option', { value: '' }, '+ Link to a codex entry…'),
      ...['character', 'location', 'note'].map((kind) => {
        const group = entries.filter((e) => e.kind === kind && !img.of.includes(e.path));
        return group.length ? h('optgroup', { label: { character: 'Characters', location: 'Locations', note: 'Notes' }[kind] },
          group.map((e) => h('option', { value: e.path }, e.title))) : null;
      }));
    linkSel.addEventListener('change', () => {
      if (linkSel.value) this.change(img, { of: [...img.of, linkSel.value] });
    });
    const caption = h('textarea', { rows: 4, placeholder: 'Caption or notes: what this shows, where it came from…' }, img.caption);
    caption.addEventListener('blur', () => {
      if (caption.value.trim() !== img.caption) this.change(img, { caption: caption.value });
    });

    this.detailEl.replaceChildren(
      h('div', { class: 'detail-nav' },
        h('strong', {}, img.title),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => this.select(null) }, '×')),
      h('a', { class: 'lookbook-big', href: imageSrc(this.bookId, img), target: '_blank', rel: 'noopener', title: 'Open full size in a new tab' },
        h('img', { src: imageSrc(this.bookId, img), alt: img.title })),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Shows'),
        h('div', { class: 'chips' },
          linked.length ? linked.map((e) => h('span', { class: `chip${e.missing ? ' missing' : ''}`, title: e.missing ? `${e.path} doesn’t exist` : e.path },
            e.missing ? e.title : h('a', { href: bookHref(this.bookId, 'codex', e.path) }, e.title),
            h('button', { type: 'button', class: 'chip-x', title: `Unlink ${e.title}`, 'aria-label': `Unlink ${e.title}`, onclick: () => this.change(img, { of: img.of.filter((p) => p !== e.path) }) }, '×')))
            : h('span', { class: 'muted' }, 'Nothing yet.')),
        linkSel),
      this.referenceFields(img, linked.filter((e) => !e.missing)),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Caption'), caption),
      h('p', { class: 'muted lookbook-path' }, `${img.path} · ${Math.max(1, Math.round(img.size / 1024)).toLocaleString()} KB`),
      h('div', { class: 'dialog-buttons' },
        h('button', {
          type: 'button',
          disabled: !linked.some((e) => !e.missing),
          title: linked.some((e) => !e.missing) ? 'Claude looks at this image and adds what it settles to the linked entries’ descriptions' : 'Link the image to a codex entry first',
          onclick: () => this.actions.refine(img, linked.filter((e) => !e.missing)),
        }, 'Refine descriptions from this image')),
      h('div', { class: 'dialog-buttons' },
        img.hasNote ? h('a', { class: 'button', href: bookHref(this.bookId, 'codex', img.notePath), title: 'Edit the note beside the image as text' }, 'Open note') : null,
        h('button', { type: 'button', onclick: () => this.rename(img) }, 'Rename…'),
        h('button', { type: 'button', class: 'danger', onclick: () => this.remove(img) }, 'Delete…')));
  }

  // Whether the image is a reference for generating more pictures of what it
  // shows, and which view and variant it is.
  referenceFields(img, linked) {
    const on = isReference(img);
    const box = h('input', { type: 'checkbox', checked: on });
    box.addEventListener('change', () => this.change(img, { use: box.checked ? 'reference' : '' }));

    // The views that fit what the image shows, plus whatever it already says.
    const kinds = new Set(linked.map((e) => e.kind));
    const views = ALL_VIEWS.filter((v) => [...kinds].some((k) => VIEWS[k]?.includes(v)) || v === img.view);
    const view = h('select', { 'aria-label': 'View', disabled: !on },
      h('option', { value: '' }, 'Any view'),
      (views.length ? views : ALL_VIEWS).map((v) => h('option', { value: v, selected: v === img.view }, VIEW_LABELS[v])));
    view.addEventListener('change', () => this.change(img, { view: view.value }));

    const listId = 'variant-suggestions';
    const variant = h('input', { type: 'text', value: img.variant, list: listId, placeholder: 'Variant, e.g. winter coat (optional)', disabled: !on, maxlength: '60', 'aria-label': 'Variant' });
    variant.addEventListener('change', () => {
      if (variant.value.trim() !== img.variant) this.change(img, { variant: variant.value });
    });
    // Variants used by the entry's other references and named in its text.
    const known = new Set(this.tree.lookbook.filter((i) => i.variant && i.of.some((p) => img.of.includes(p))).map((i) => i.variant));
    const datalist = h('datalist', { id: listId }, [...known].map((v) => h('option', { value: v })));
    for (const e of linked) {
      api.readFile(this.bookId, e.path).then(({ content }) => {
        for (const v of variantsIn(content)) {
          if (!known.has(v)) {
            known.add(v);
            datalist.append(h('option', { value: v }));
          }
        }
      }).catch(() => {});
    }

    return h('div', { class: 'field reference-fields' },
      h('label', { class: 'check' }, box, h('span', {}, h('strong', {}, '★ Reference'), h('span', { class: 'muted' }, ' — send it with prompts to keep this look'))),
      h('div', { class: 'reference-row' }, view, variant, datalist));
  }

  async change(img, changes) {
    const res = await this.actions.run(() => api.updateImage(this.bookId, img.path, changes));
    if (res && res.path !== img.path) this.select(res.path);
  }

  async rename(img) {
    const name = await promptDialog({ title: 'Rename image', label: 'Name', value: img.title, okLabel: 'Rename', hint: 'Renames the image and its note.' });
    if (name) await this.change(img, { name });
  }

  async remove(img) {
    const ok = await confirmDialog({
      title: `Delete “${img.title}”?`,
      message: `This deletes ${img.path}${img.hasNote ? ' and its note' : ''}. If it was committed, it can be restored from git history.`,
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    if (await this.actions.run(() => api.deleteImage(this.bookId, img.path))) this.select(null);
  }
}
