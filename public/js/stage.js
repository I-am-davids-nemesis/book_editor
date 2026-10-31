import { api } from './api.js';
import { briefPrompt } from './codexprompts.js';
import { generateRow } from './generate.js';
import { handoffButtons, loadVisualStyle, referenceItems } from './handoff.js';
import { codexEntries } from './tree.js';
import { h, toast } from './ui.js';
import {
  assembleShot, entryAliases, entryLook, fixedTraits, lookOf, mentionedEntries, pickReferences, SHOT_SIZES, shotImages, variantsIn, VIEW_LABELS,
} from './worldmodel.js';

// A moment this long reads as a scene, not a picture: suggest a brief.
const LONG_MOMENT = 1500;
const REF_LIMITS = [2, 4, 6, 8, 10, 16];
const DEFAULT_REFS = 6;

// The Stage dialog: choose who and where, the moment and the framing; the
// editor builds the prompt from the codex (visual style, each entry's look
// and fixed traits) and picks reference images, numbered in the prompt.
//   initial: { characters: [path or { path, variant }], location: path|null,
//              moment: { text, source }, brief, framing } — a whole saved shot
//              (Stage again) or just who and what
//   readEntry(path) → the entry's Markdown (the open editor's, if it's open)
//   onCandidates(): show generated images in the Lookbook
export async function stageDialog({ bookId, tree, initial = {}, readEntry, onCandidates = () => {} }) {
  const all = codexEntries(tree);
  const byPath = new Map(all.map((e) => [e.path, e]));
  const characters = all.filter((e) => e.kind === 'character');
  const locations = all.filter((e) => e.kind === 'location');
  const styleText = await loadVisualStyle(bookId).catch(() => '');

  const shot = {
    location: initial.location ?? null,
    characters: (initial.characters ?? []).map((c) => (typeof c === 'string' ? { path: c, variant: '' } : { path: c?.path, variant: c?.variant ?? '' }))
      .filter((c) => byPath.has(c.path)),
    moment: { text: initial.moment?.text ?? '', source: initial.moment?.source ?? '' },
    brief: initial.brief ?? '',
    framing: { shot: '', time: '', notes: '', ...initial.framing },
  };
  if (shot.location && !byPath.has(shot.location)) shot.location = null;
  let maxRefs = DEFAULT_REFS;
  const overrides = new Map(); // image path → true/false, where the writer ticked or unticked
  let edited = false;

  // Entry texts, loaded as entries join the shot.
  const texts = new Map();
  const load = async (path) => {
    if (texts.has(path)) return;
    texts.set(path, '');
    try {
      texts.set(path, await readEntry(path));
    } catch (err) {
      toast(`Couldn’t read ${path}: ${err.message}`, { error: true });
    }
    update();
  };
  // Every person's and place's aliases, so the moment's "Mentioned" chips
  // catch other names. Read once, in the background.
  const aliases = new Map();
  Promise.all([...characters, ...locations].map(async (e) => {
    try { aliases.set(e.path, entryAliases(await readEntry(e.path))); } catch { /* the title still matches */ }
  })).then(() => update());
  const entries = () => new Map([...byPath].map(([p, e]) => [p, { ...e, text: texts.get(p) ?? '' }]));

  // --- left: what's in the shot ---
  const settingEl = h('select', { 'aria-label': 'Setting' },
    h('option', { value: '' }, locations.length ? 'No particular place' : 'No locations in the codex yet'),
    locations.map((e) => h('option', { value: e.path, selected: e.path === shot.location }, e.title)));
  settingEl.addEventListener('change', () => {
    shot.location = settingEl.value || null;
    if (shot.location) load(shot.location);
    update();
  });
  const peopleEl = h('div', { class: 'chips stage-people' });
  const addPersonEl = h('select', { 'aria-label': 'Add a character' });
  addPersonEl.addEventListener('change', () => {
    if (addPersonEl.value) addPerson(addPersonEl.value);
  });
  const mentionedEl = h('div', { class: 'stage-mentioned' });
  const thinEl = h('p', { class: 'field-hint warning', hidden: true });

  const momentEl = h('textarea', { rows: 6, placeholder: 'The moment to picture: a passage from the scene, or your own words.' }, shot.moment.text);
  momentEl.addEventListener('input', () => { shot.moment.text = momentEl.value; update(); });
  const momentHint = h('p', { class: 'field-hint' });

  const briefEl = h('textarea', { rows: 5, placeholder: 'Optional: what the picture shows, in a few sentences. Used instead of the moment when it’s filled in.' }, shot.brief);
  briefEl.addEventListener('input', () => { shot.brief = briefEl.value; update(); });
  const briefBtn = h('button', { type: 'button', onclick: () => writeBrief() }, 'Write it with Claude');

  const sizeEl = h('select', { 'aria-label': 'Shot size' },
    h('option', { value: '' }, 'Any size'),
    Object.entries(SHOT_SIZES).map(([v, label]) => h('option', { value: v, selected: v === shot.framing.shot }, label)));
  sizeEl.addEventListener('change', () => { shot.framing.shot = sizeEl.value; update(); });
  const timeEl = h('input', { type: 'text', value: shot.framing.time, placeholder: 'Time of day, e.g. dawn', 'aria-label': 'Time of day' });
  timeEl.addEventListener('input', () => { shot.framing.time = timeEl.value.trim(); update(); });
  const notesEl = h('input', { type: 'text', value: shot.framing.notes, placeholder: 'Camera notes, e.g. low angle, from behind Tor', 'aria-label': 'Camera notes' });
  notesEl.addEventListener('input', () => { shot.framing.notes = notesEl.value.trim(); update(); });

  // --- middle: the prompt ---
  const promptEl = h('textarea', { class: 'handoff-prompt', spellcheck: 'true', 'aria-label': 'Prompt' });
  promptEl.addEventListener('input', () => { edited = true; promptHint.hidden = false; gen.refresh(); });
  const promptHint = h('p', { class: 'field-hint', hidden: true },
    'You’ve edited the prompt, so changes on the left no longer rebuild it. ',
    h('button', { type: 'button', class: 'link', onclick: () => { edited = false; promptHint.hidden = true; update(); } }, 'Rebuild it'));

  // --- right: references ---
  const refsEl = h('ol', { class: 'handoff-refs' });
  const refsHint = h('p', { class: 'field-hint' });
  const maxEl = h('select', { 'aria-label': 'Most references to send' },
    REF_LIMITS.map((n) => h('option', { value: String(n), selected: n === maxRefs }, `Up to ${n}`)));
  maxEl.addEventListener('change', () => { maxRefs = Number(maxEl.value); update(); });

  // --- generating here ---
  let closeDialog = () => {};
  const gen = generateRow({
    bookId,
    getJob: () => ({ prompt: promptEl.value, refs: references().chosen.map((c) => c.img.path), shot: structuredClone(shot) }),
    // Send no more references than the model takes.
    onModel: (model) => {
      if (maxRefs <= model.maxRefs) return;
      maxRefs = model.maxRefs;
      if (![...maxEl.options].some((o) => Number(o.value) === maxRefs)) maxEl.prepend(h('option', { value: String(maxRefs) }, `Up to ${maxRefs}`));
      maxEl.value = String(maxRefs);
      update();
    },
    onCandidates: () => { closeDialog(); onCandidates(); },
  });

  // The references in the order they'll be attached, and the rest.
  const references = () => {
    const candidates = shotImages({ shot, entries: entries(), images: tree.lookbook ?? [] });
    const auto = pickReferences(candidates, maxRefs).filter((c) => overrides.get(c.img.path) !== false);
    const picked = new Set(auto.map((c) => c.img.path));
    const extra = candidates.filter((c) => overrides.get(c.img.path) === true && !picked.has(c.img.path));
    const chosen = [...auto, ...extra];
    const ids = new Set(chosen.map((c) => c.img.path));
    return { chosen, rest: candidates.filter((c) => !ids.has(c.img.path)) };
  };

  function addPerson(path) {
    if (!shot.characters.some((c) => c.path === path)) shot.characters.push({ path, variant: '' });
    load(path);
    update();
  }

  function renderPeople() {
    const ents = entries();
    peopleEl.replaceChildren(...(shot.characters.length ? shot.characters.map((c) => {
      const e = ents.get(c.path);
      const variants = variantsIn(e?.text ?? '');
      const variantEl = variants.length ? h('select', { class: 'chip-select', 'aria-label': `${e.title}’s look` },
        h('option', { value: '' }, 'usual look'),
        variants.map((v) => h('option', { value: v, selected: v === c.variant }, v))) : null;
      variantEl?.addEventListener('change', () => { c.variant = variantEl.value; update(); });
      return h('span', { class: 'chip' }, e?.title ?? c.path, variantEl,
        h('button', {
          type: 'button',
          class: 'chip-x',
          title: `Leave ${e?.title} out`,
          'aria-label': `Leave ${e?.title} out`,
          onclick: () => { shot.characters = shot.characters.filter((x) => x !== c); update(); },
        }, '×'));
    }) : [h('span', { class: 'muted' }, 'No one yet.')]));

    const left = characters.filter((e) => !shot.characters.some((c) => c.path === e.path));
    addPersonEl.replaceChildren(h('option', { value: '' }, characters.length ? '+ Add a character…' : 'No characters in the codex yet'),
      ...left.map((e) => h('option', { value: e.path }, e.title)));
    addPersonEl.disabled = !left.length;

    // Entries the prompt can say nothing about yet (once their text is in),
    // and ones whose long Description it had to cut.
    const inShot = [...shot.characters.map((c) => c.path), ...(shot.location ? [shot.location] : [])].filter((p) => texts.get(p));
    const thin = inShot.filter((p) => !entryLook(texts.get(p)) && !fixedTraits(texts.get(p)).length).map((p) => byPath.get(p).title);
    const cut = inShot.filter((p) => lookOf(texts.get(p)).cut).map((p) => byPath.get(p).title);
    const list = (names) => names.join(', ');
    thinEl.hidden = !thin.length && !cut.length;
    thinEl.textContent = [
      thin.length ? `${list(thin)} ${thin.length === 1 ? 'has' : 'have'} no description in the codex yet, so the prompt leaves ${thin.length === 1 ? 'it' : 'them'} out. Gather one from the entry’s Claude ▾ menu, or describe ${thin.length === 1 ? 'it' : 'them'} in the brief.` : '',
      cut.length ? `${list(cut)}’s description is long, so the prompt uses only its start. Give ${cut.length === 1 ? 'the entry' : 'each'} a short look with Claude ▾ → Draft a short look.` : '',
    ].filter(Boolean).join(' ');

    // Characters and places the moment names that aren't in the shot yet.
    const named = mentionedEntries(`${shot.moment.text}\n${shot.brief}`, [...characters, ...locations].map((e) => ({ ...e, aliases: aliases.get(e.path) })))
      .filter((p) => !shot.characters.some((c) => c.path === p) && p !== shot.location);
    mentionedEl.replaceChildren(...(named.length ? [
      h('span', { class: 'muted' }, 'Mentioned:'),
      ...named.map((p) => h('button', {
        type: 'button',
        class: 'link',
        onclick: () => {
          if (byPath.get(p).kind === 'location') {
            shot.location = p;
            settingEl.value = p;
            load(p);
            update();
          } else addPerson(p);
        },
      }, `+ ${byPath.get(p).title}`)),
    ] : []));
  }

  function update() {
    renderPeople();
    const { chosen, rest } = references();
    if (!edited) promptEl.value = assembleShot({ shot, entries: entries(), styleText, refs: chosen });
    refsEl.replaceChildren(...referenceItems(bookId, [
      ...chosen.map((c) => ({ img: c.img, on: true, note: noteFor(c) })),
      ...rest.map((c) => ({ img: c.img, on: false, note: noteFor(c) })),
    ], (img, on) => { overrides.set(img.path, on); update(); }));
    const hasImages = chosen.length + rest.length;
    refsHint.textContent = !shot.characters.length && !shot.location
      ? 'Add people or a setting to see their images.'
      : !hasImages
        ? 'None of these entries has images yet. Mark the best ones as references in the Lookbook.'
        : !chosen.length
          ? 'No references chosen. Mark images as references in the Lookbook, or tick them here.'
          : `Attach the ${chosen.length === 1 ? 'image' : `${chosen.length} images`} in this order.`;
    const long = !shot.brief.trim() && shot.moment.text.length > LONG_MOMENT;
    momentHint.textContent = long
      ? 'That’s a long passage for one picture. Select a shorter passage, or have Claude write a brief from it.'
      : shot.moment.source ? `From ${shot.moment.source}.` : '';
    momentHint.classList.toggle('warning', long);
    briefBtn.disabled = !shot.moment.text.trim();
    gen.refresh();
  }

  function noteFor({ img, entry }) {
    const e = byPath.get(entry);
    const what = img.use === 'reference' ? [VIEW_LABELS[img.view] ?? 'reference', img.variant].filter(Boolean).join(' · ') : 'not a reference';
    return `${e?.title ?? entry}: ${what}`;
  }

  async function writeBrief() {
    const label = briefBtn.textContent;
    briefBtn.disabled = true;
    briefBtn.textContent = 'Claude is reading…';
    try {
      const people = shot.characters.map((c) => byPath.get(c.path)).filter(Boolean);
      const setting = shot.location ? byPath.get(shot.location) : null;
      const { text } = await api.claudeAsk(bookId, briefPrompt(shot, { people, setting }));
      shot.brief = text;
      briefEl.value = text;
    } catch (err) {
      toast(err.message, { error: true, ms: 8000 });
    } finally {
      briefBtn.textContent = label;
      update();
    }
  }

  return new Promise((resolve) => {
    const name = () => shot.characters.map((c) => byPath.get(c.path)?.title).filter(Boolean).join(' and ') || byPath.get(shot.location)?.title || 'shot';
    const buttons = handoffButtons({ bookId, name, promptEl, getRefs: () => references().chosen.map((c) => c.img), after: ', then drop the result in the Lookbook' });
    const field = (label, ...children) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), children);
    const dialog = h('dialog', { class: 'dialog stage-dialog' },
      h('form', { method: 'dialog' },
        h('h2', {}, 'Stage a shot'),
        h('div', { class: 'stage-body' },
          h('div', { class: 'stage-col stage-what' },
            field('Setting', settingEl),
            field('People', peopleEl, addPersonEl, mentionedEl, thinEl),
            field('Moment', momentEl, momentHint),
            field('Brief', briefEl, h('div', { class: 'stage-row' }, briefBtn,
              h('span', { class: 'field-hint' }, 'Claude reads the scene and says what the picture shows.'))),
            field('Framing', h('div', { class: 'stage-row' }, sizeEl, timeEl), notesEl)),
          h('div', { class: 'stage-col stage-prompt' }, field('Prompt', promptEl, promptHint), field('Generate here', gen.el)),
          h('div', { class: 'stage-col stage-refs' }, field('Reference images', maxEl, refsEl, refsHint))),
        h('div', { class: 'dialog-buttons' },
          buttons.start,
          h('span', { class: 'spacer' }),
          buttons.end,
          h('button', { type: 'submit' }, 'Close'))));
    closeDialog = () => dialog.close();
    dialog.addEventListener('close', () => {
      gen.close();
      dialog.remove();
      resolve();
    });
    for (const c of shot.characters) load(c.path);
    if (shot.location) load(shot.location);
    update();
    document.body.append(dialog);
    dialog.showModal();
    (shot.moment.text ? settingEl : momentEl).focus();
  });
}
