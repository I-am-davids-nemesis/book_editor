// The book's visual model, read from plain Markdown: the visual style, each
// entry's fixed traits and variants, and the lookbook images marked as its
// references. Shared by the browser and the server.

import { DESCRIPTION, FIXED_TRAITS, imagePromptFrom } from './codexprompts.js';
import { bullets, prose, sectionBody } from './sections.js';

export const VISUAL_STYLE = 'codex/visual-style.md';

// The views a reference image can be, by entry kind. A model sheet wants the
// first ones; the order is also the order references are sent in.
export const VIEWS = {
  character: ['face', 'full', 'turnaround', 'expressions'],
  location: ['establishing', 'interior', 'map'],
};
export const ALL_VIEWS = [...VIEWS.character, ...VIEWS.location];
export const VIEW_LABELS = {
  face: 'Face',
  full: 'Full length',
  turnaround: 'Turnaround',
  expressions: 'Expressions',
  establishing: 'Establishing shot',
  interior: 'Interior',
  map: 'Map or plan',
};
const NEEDED_VIEWS = { character: ['face', 'full'], location: ['establishing'] };

const STYLE_PARTS = ['Medium', 'Palette', 'Period and setting', 'Light', 'Framing'];

export function fixedTraits(markdown) {
  const section = sectionBody(markdown, 2, FIXED_TRAITS);
  return section === null ? [] : bullets(section);
}

// Names of the "### Variant: winter coat" subsections anywhere in the entry.
export function variantsIn(markdown) {
  const names = [...String(markdown).matchAll(/^#{3,4}\s+Variant:\s*(.*?)\s*#*\s*$/gim)].map((m) => m[1]).filter(Boolean);
  return [...new Set(names)];
}

// The visual style note as prompt text: { style, avoid }, each '' when empty.
export function visualStyle(markdown) {
  if (!markdown) return { style: '', avoid: '' };
  const parts = STYLE_PARTS
    .map((title) => [title, prose(sectionBody(markdown, 2, title) ?? '').replace(/\n\n/g, ' ')])
    .filter(([, text]) => text)
    .map(([title, text]) => `${title}: ${text.replace(/[.\s]+$/, '')}.`);
  const avoidSection = sectionBody(markdown, 2, 'Avoid') ?? '';
  const avoid = (bullets(avoidSection).length ? bullets(avoidSection).join('; ') : prose(avoidSection).replace(/\n\n/g, ' ')).replace(/[.\s]+$/, '');
  return { style: parts.join(' '), avoid };
}

export const isReference = (img) => img.use === 'reference';

// An entry's images, references first, then the rest in lookbook order.
// References go in view order: the wanted variant's first, then the base look
// (no variant), then other variants.
export function rankImages(images, kind, { variant = '' } = {}) {
  const order = VIEWS[kind] ?? ALL_VIEWS;
  const rank = (img) => {
    if (!isReference(img)) return 1000;
    const v = order.indexOf(img.view);
    const fit = variant && img.variant === variant ? 0 : !img.variant ? 50 : 100;
    return fit + (v === -1 ? order.length : v);
  };
  return images.map((img, i) => ({ img, i })).sort((a, b) => rank(a.img) - rank(b.img) || a.i - b.i).map((x) => x.img);
}

// The views a character's or location's references don't cover yet.
export function missingViews(kind, images) {
  const have = new Set(images.filter(isReference).map((img) => img.view));
  return (NEEDED_VIEWS[kind] ?? []).filter((v) => !have.has(v));
}

// How a reference is named in a prompt: "this character's face (winter coat)",
// or with a name, "Tor’s face (winter coat)".
function describeRef(img, kind, name = null) {
  const subject = name ?? (kind === 'location' ? 'this place' : kind === 'character' ? 'this character' : 'the subject');
  const view = {
    face: `${subject}’s face`,
    full: `${subject}, full length`,
    turnaround: `${subject} from several sides`,
    expressions: `${subject}’s expressions`,
    establishing: `${subject}, establishing view`,
    interior: `${subject}, interior`,
    map: `the layout of ${subject}`,
  }[img.view] ?? subject;
  return img.variant ? `${view} (${img.variant})` : view;
}

// The prompt to paste into an outside image generator for one entry: its
// image prompt, its fixed traits, the numbered references that go with it,
// and the book's visual style. Null when the entry has no image prompt yet.
export function handoffPrompt({ kind, text, styleText = '', refs = [] }) {
  const imagePrompt = imagePromptFrom(text);
  if (!imagePrompt) return null;
  const traits = fixedTraits(text);
  const { style, avoid } = visualStyle(styleText);
  const parts = [imagePrompt];
  if (traits.length) parts.push(`Must match exactly: ${traits.map((t) => t.replace(/[.\s]+$/, '')).join('; ')}.`);
  if (refs.length) {
    parts.push([
      `Reference images, attached in this order. Keep ${kind === 'location' ? 'the place' : 'the subject'} consistent with them:`,
      ...refs.map((img, i) => `Image ${i + 1}: ${describeRef(img, kind)}.`),
    ].join('\n'));
  }
  if (style) parts.push(`Style: ${style}`);
  if (avoid) parts.push(`Avoid: ${avoid}.`);
  return parts.join('\n\n');
}

// --- staging a shot -------------------------------------------------------------

export const SHOT_SIZES = { wide: 'Wide shot', medium: 'Medium shot', close: 'Close-up' };

// How an entry looks, for a picture with others in it: its Description's prose
// (not the image prompt, which stages its own scene), plus the chosen
// variant's subsection; or the entry's opening lines if it has no Description.
export function entryLook(text, variant = '') {
  const desc = sectionBody(text, 2, DESCRIPTION);
  let base = desc === null ? '' : prose(desc.split(/^#{3,6}\s/m)[0]);
  if (!base) {
    const intro = String(text).replace(/^\s*#\s.*$/m, '').split(/^##\s/m)[0];
    base = prose(intro);
  }
  const variantText = variant ? prose(sectionBody(desc ?? text, 3, `Variant: ${variant}`) ?? '') : '';
  return [base, variantText].filter(Boolean).join(' ').replace(/\n\n/g, ' ');
}

// The entries a shot shows: its people, then its setting.
//   shot: { location, characters: [{ path, variant }] }
function shotEntries(shot) {
  return [
    ...shot.characters.map((c) => ({ path: c.path, variant: c.variant ?? '' })),
    ...(shot.location ? [{ path: shot.location, variant: '' }] : []),
  ];
}

// Every image of the shot's entries, ranked per entry, each once:
//   [{ img, entry: path }]. An image of two entries counts for the first.
export function shotImages({ shot, entries, images }) {
  const seen = new Set();
  const out = [];
  for (const { path, variant } of shotEntries(shot)) {
    const kind = entries.get(path)?.kind;
    const mine = images.filter((img) => img.of.includes(path));
    for (const img of rankImages(mine, kind, { variant })) {
      if (seen.has(img.path)) continue;
      seen.add(img.path);
      out.push({ img, entry: path });
    }
  }
  return out;
}

// The references to send, at most `max`: each person's best one, then the
// setting's, then everyone's second, and so on.
export function pickReferences(candidates, max) {
  const byEntry = new Map();
  for (const c of candidates) {
    if (!isReference(c.img)) continue;
    if (!byEntry.has(c.entry)) byEntry.set(c.entry, []);
    byEntry.get(c.entry).push(c);
  }
  const queues = [...byEntry.values()];
  const out = [];
  for (let round = 0; out.length < max && queues.some((q) => q.length > round); round += 1) {
    for (const q of queues) if (q[round] && out.length < max) out.push(q[round]);
  }
  return out;
}

// The full prompt for a shot. `refs` are the chosen [{ img, entry }], in the
// order they'll be attached.
//   shot: { location, characters, moment: { text }, brief, framing: { shot, time, notes } }
//   entries: Map(path → { title, kind, text })
export function assembleShot({ shot, entries, styleText = '', refs = [] }) {
  const parts = [];
  const what = (shot.brief || '').trim() || (shot.moment?.text || '').trim().replace(/\s*\n\s*/g, ' ');
  if (what) parts.push(what);

  const f = shot.framing ?? {};
  const framing = [SHOT_SIZES[f.shot] && `${SHOT_SIZES[f.shot]}.`, f.time && `Time: ${f.time.replace(/[.\s]+$/, '')}.`, f.notes && `${f.notes.replace(/[.\s]+$/, '')}.`].filter(Boolean);
  if (framing.length) parts.push(framing.join(' '));

  const describe = ({ path, variant }, setting) => {
    const e = entries.get(path);
    if (!e) return null;
    const look = entryLook(e.text ?? '', variant);
    const traits = fixedTraits(e.text ?? '').map((t) => t.replace(/[.\s]+$/, ''));
    // Nothing known yet: a bare name gives a generator nothing to go on.
    if (!look && !traits.length) return null;
    const label = setting ? `Setting, ${e.title}` : e.title;
    return `${label}${variant ? ` (${variant})` : ''}:${look ? ` ${look.replace(/[.\s]+$/, '')}.` : ''}${traits.length ? ` Must match exactly: ${traits.join('; ')}.` : ''}`;
  };
  if (shot.location) {
    const line = describe({ path: shot.location, variant: '' }, true);
    if (line) parts.push(line);
  }
  for (const c of shot.characters) {
    const line = describe(c, false);
    if (line) parts.push(line);
  }

  if (refs.length) {
    parts.push([
      'Reference images, attached in this order. Keep each person and place consistent with their images:',
      ...refs.map(({ img, entry }, i) => {
        const e = entries.get(entry);
        return `Image ${i + 1}: ${describeRef(img, e?.kind, e?.title)}.`;
      }),
    ].join('\n'));
  }
  const { style, avoid } = visualStyle(styleText);
  if (style) parts.push(`Style: ${style}`);
  if (avoid) parts.push(`Avoid: ${avoid}.`);
  return parts.join('\n\n');
}

// Codex entries whose title (or its first word, for "Tor Halloran") appears as
// a word in `text`, matching case, since names are capitalized: [path], in
// entry order.
export function mentionedEntries(text, entries) {
  const words = String(text);
  const has = (name) => name.length > 1 && new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(words);
  return entries.filter((e) => has(e.title) || (e.title.includes(' ') && has(e.title.split(' ')[0]) && e.kind === 'character')).map((e) => e.path);
}
