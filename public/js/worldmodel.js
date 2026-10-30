// The book's visual model, read from plain Markdown: the visual style, each
// entry's fixed traits and variants, and the lookbook images marked as its
// references. Shared by the browser and the server.

import { FIXED_TRAITS, imagePromptFrom } from './codexprompts.js';
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

// How a reference is named in a prompt: "this character's face (winter coat)".
function describeRef(img, kind) {
  const subject = kind === 'location' ? 'this place' : kind === 'character' ? 'this character' : 'the subject';
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
