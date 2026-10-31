import { api } from './api.js';
import { IMAGE_TOOLS, imagePromptFrom } from './codexprompts.js';
import { confirmDialog, promptDialog } from './dialogs.js';
import { jobReduce, jobStatus, watchJob } from './generate.js';
import { handoffDialog, loadVisualStyle, pendingHandoff } from './handoff.js';
import { splitMade } from './provenance.js';
import { codexEntries, imagesByEntry } from './tree.js';
import { bookHref, h, imageSrc, showMenu, toast } from './ui.js';
import {
  ALL_VIEWS, fixedTraits, handoffPrompt, isReference, missingViews, rankImages, shotName, variantsIn, VIEW_LABELS, VIEWS,
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
// Files that follow a recent handoff on the same entries are taken to be its
// result: the note says how they were made, and images dropped with no entry
// are linked to the shot's. Returns a structure-change result for everything
// that was added; files that fail are reported in a toast and skipped.
export async function uploadImages(bookId, files, { of = [] } = {}) {
  const pending = pendingHandoff(bookId, of);
  const handoff = pending && { tool: pending.tool, prompt: pending.prompt, refs: pending.refs, shot: pending.shot };
  if (pending && !of.length) of = pending.of;
  const created = [];
  const paths = [];
  const failed = [];
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      failed.push(`${file.name}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
      continue;
    }
    try {
      const res = await api.addImage(bookId, { filename: file.name, data: await readBase64(file), of, handoff });
      created.push(...res.created);
      paths.push(res.path);
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
    }
  }
  if (failed.length) toast(failed.join(' · '), { error: true, ms: 8000 });
  else if (handoff && paths.length) toast(`Noted as made with ${handoff.tool} from the prompt you copied`);
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
//   entry: { path, title, kind }   claude: { gather(), refine(images), manuscript(), traits(), look() }
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
      { label: /^###\s+Look\s*$/m.test(text) ? 'Redraft the short look for staged shots' : 'Draft a short look for staged shots', disabled: !described, onclick: () => claude.look() },
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
//   sidebar's), upload(files, of), refine(image, entries), visualStyle(),
//   stage(initial) }
// Its Candidates view holds generated images waiting to be kept or discarded.
export class LookbookView {
  constructor({ bookId, actions }) {
    this.bookId = bookId;
    this.actions = actions;
    this.tree = null;
    this.selected = null;
    this.filter = ''; // '' all, '-' not linked, '*' references, or a codex path
    this.mode = 'images'; // or 'candidates'
    this.jobs = new Map(); // job id → { state, stop, el } for jobs still running

    this.imagesTab = h('button', { type: 'button', onclick: () => this.setMode('images') }, 'Images');
    this.candidatesTab = h('button', { type: 'button', onclick: () => this.setMode('candidates') }, 'Candidates');

    this.filterEl = h('select', { 'aria-label': 'Show images of', onchange: () => { this.filter = this.filterEl.value; this.render(); } });
    this.countEl = h('span', { class: 'muted' });
    this.gridEl = h('div', { class: 'lookbook-grid' });
    this.detailEl = h('aside', { class: 'lookbook-detail', hidden: true });
    this.el = h('div', { class: 'lookbook', hidden: true, tabindex: '-1' },
      h('div', { class: 'lookbook-head' },
        h('button', { type: 'button', onclick: () => this.actions.back() }, '← Back to writing'),
        h('h2', {}, 'Lookbook'),
        h('div', { class: 'segmented' }, this.imagesTab, this.candidatesTab),
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

  setMode(mode) {
    this.mode = mode;
    if (mode === 'candidates') {
      this.selected = null;
      this.followJobs();
    }
    if (this.visible) this.render();
  }

  render() {
    const pending = this.tree.candidates?.length ?? 0;
    this.candidatesTab.textContent = pending ? `Candidates (${pending})` : 'Candidates';
    this.imagesTab.setAttribute('aria-pressed', String(this.mode === 'images'));
    this.candidatesTab.setAttribute('aria-pressed', String(this.mode === 'candidates'));
    this.filterEl.hidden = this.mode !== 'images';
    this.countEl.hidden = this.mode !== 'images';
    if (this.mode === 'candidates') {
      this.detailEl.hidden = true;
      this.renderCandidates();
      return;
    }
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
      img.staged ? h('div', { class: 'dialog-buttons' },
        h('button', { type: 'button', title: 'Open the shot this image was generated from in the Stage dialog', onclick: () => this.stageAgain(img) }, 'Stage again')) : null,
      h('div', { class: 'dialog-buttons' },
        img.hasNote ? h('a', { class: 'button', href: bookHref(this.bookId, 'codex', img.notePath), title: 'Edit the note beside the image as text' }, 'Open note') : null,
        h('button', { type: 'button', onclick: () => this.rename(img) }, 'Rename…'),
        h('button', { type: 'button', class: 'danger', onclick: () => this.remove(img) }, 'Delete…')));
  }

  async stageAgain(img) {
    try {
      const { made } = splitMade((await api.readFile(this.bookId, img.notePath)).content);
      if (!made?.shot) throw new Error('The note doesn’t say which shot this was');
      this.actions.stage(made.shot);
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // --- candidates ---------------------------------------------------------------

  // Picks up jobs still running (after a reload, or started in Stage).
  async followJobs() {
    let jobs;
    try {
      jobs = await api.imageJobs(this.bookId);
    } catch {
      return;
    }
    for (const job of jobs) if (['queued', 'running'].includes(job.status)) this.follow(job.id, job.n);
    if (this.visible && this.mode === 'candidates') this.render();
  }

  follow(id, n = 1) {
    if (this.jobs.has(id)) return;
    const entry = { state: { n }, el: null };
    this.jobs.set(id, entry);
    entry.stop = watchJob(this.bookId, id, (e) => {
      entry.state = jobReduce(entry.state, e);
      if (entry.el) entry.el.textContent = jobStatus(entry.state);
      if (e.type === 'error') toast(e.message, { error: true, ms: 8000 });
    }, () => {
      this.jobs.delete(id);
      if (this.visible && this.mode === 'candidates') this.render();
    });
  }

  renderCandidates() {
    const entries = codexEntries(this.tree);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const groups = new Map();
    for (const id of this.jobs.keys()) groups.set(id, []);
    for (const c of this.tree.candidates ?? []) {
      if (!groups.has(c.job)) groups.set(c.job, []);
      groups.get(c.job).push(c);
    }
    const ordered = [...groups].sort((a, b) => b[0].localeCompare(a[0]));
    this.gridEl.replaceChildren(...(ordered.length ? ordered.map(([job, items]) => this.candidateGroup(job, items, byPath)) : [
      h('div', { class: 'placeholder lookbook-empty' }, h('div', {},
        h('p', {}, 'No candidates. Generated images wait here until you keep or discard them.'),
        h('p', { class: 'muted' }, 'Use “Stage a shot”, then Generate.'))),
    ]));
  }

  candidateGroup(job, items, byPath) {
    const made = items[0]?.made ?? null;
    const running = this.jobs.get(job);
    const statusEl = running ? h('span', { class: 'candidate-status' }, jobStatus(running.state)) : null;
    if (running) running.el = statusEl;
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(job);
    const when = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : job;
    const refs = made?.references?.length ?? 0;
    const title = made ? shotName(made.shot, byPath, made.prompt.slice(0, 60)) : 'Generating…';
    const kinds = new Set((items[0]?.of ?? []).map((p) => byPath.get(p)?.kind).filter(Boolean));
    const views = ALL_VIEWS.filter((v) => !kinds.size || [...kinds].some((k) => VIEWS[k]?.includes(v)));

    return h('section', { class: 'candidate-group' },
      h('div', { class: 'candidate-head' },
        h('div', {},
          h('strong', {}, title),
          h('span', { class: 'muted' }, [when, made?.model, made && `${refs} ${refs === 1 ? 'reference' : 'references'}`].filter(Boolean).join(' · ')),
          statusEl),
        h('span', { class: 'spacer' }),
        running ? h('button', { type: 'button', onclick: () => api.cancelImageJob(this.bookId, job).catch((err) => toast(err.message, { error: true })) }, 'Cancel') : null,
        made?.shot ? h('button', { type: 'button', title: 'Open this shot in the Stage dialog', onclick: () => this.actions.stage(made.shot) }, 'Stage again') : null,
        made ? h('button', { type: 'button', title: 'Make the same number again with new seeds', onclick: () => this.vary(made, made.count ?? items.length) }, 'Vary') : null,
        items.length ? h('button', { type: 'button', class: 'danger', onclick: () => this.discardJob(job, items.length) }, 'Discard all') : null),
      h('div', { class: 'candidate-grid' }, items.map((c) => h('figure', { class: 'candidate' },
        h('a', { href: imageSrc(this.bookId, c), target: '_blank', rel: 'noopener', title: 'Open full size in a new tab' },
          h('img', { src: imageSrc(this.bookId, c), alt: `Candidate ${c.n}`, loading: 'lazy' })),
        h('figcaption', {},
          h('span', { class: 'muted' }, c.made?.seed !== undefined ? `Seed ${c.made.seed}` : `#${c.n}`),
          h('button', { type: 'button', class: 'primary', onclick: () => this.keep(c, title) }, 'Keep…'),
          h('button', {
            type: 'button',
            'aria-haspopup': 'menu',
            title: 'Keep it as a reference image, to send with later prompts',
            onclick: (e) => showMenu(e.currentTarget, views.map((v) => ({ label: `Keep as reference: ${VIEW_LABELS[v]}…`, onclick: () => this.keep(c, title, v) }))),
          }, '★ ▾'),
          h('button', { type: 'button', class: 'danger', title: 'Discard this image', 'aria-label': 'Discard', onclick: () => this.discard(c) }, '×'))))));
  }

  async keep(c, title, view = null) {
    const name = await promptDialog({
      title: view ? `Keep as a reference (${VIEW_LABELS[view].toLowerCase()})` : 'Keep this image',
      label: 'Name',
      value: title,
      okLabel: 'Keep',
      hint: 'It moves into the lookbook, linked to the shot’s codex entries, with a note of how it was made.',
    });
    if (!name) return;
    const res = await this.actions.run(() => api.keepCandidate(this.bookId, c.path, { name, reference: Boolean(view), view: view ?? '' }));
    if (res) toast(`Kept as ${res.path}`);
  }

  async discard(c) {
    await this.actions.run(() => api.discardCandidate(this.bookId, c.path));
  }

  async discardJob(job, count) {
    const ok = await confirmDialog({
      title: `Discard ${count === 1 ? 'this image' : `all ${count} images`}?`,
      message: 'Candidates aren’t in git, so they can’t be restored.',
      okLabel: 'Discard',
      danger: true,
    });
    if (ok) await this.actions.run(() => api.discardJob(this.bookId, job));
  }

  async vary(made, n) {
    try {
      const job = await api.startImageJob(this.bookId, {
        provider: made.provider,
        model: made.model,
        prompt: made.prompt,
        negative: made.negative ?? '',
        refs: (made.references ?? []).map((r) => r.path),
        size: made.size,
        n: Math.min(Math.max(n, 1), 4),
        shot: made.shot,
      });
      this.follow(job.id, job.n);
      this.render();
    } catch (err) {
      toast(err.message, { error: true, ms: 8000 });
    }
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
