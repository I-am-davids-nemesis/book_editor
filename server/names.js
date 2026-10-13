// Naming rules for chapters and scenes (see PLAN.md §2).
// Parsing is lenient so folders made by hand, by Obsidian or by agents still
// show up; the editor itself always writes `NN-slug` names.

const CHAPTER_RE = /^(\d+)[-_ ](.+)$/;
const SCENE_RE = /^(\d+)[-_ ]([^.]+)(?:\.([^.]+))?\.md$/i;
const UNPREFIXED_SCENE_RE = /^([^.]+)(?:\.([^.]+))?\.md$/i;

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs']);

export function titleize(slug) {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export function slugify(title) {
  return String(title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseChapterName(name) {
  const m = CHAPTER_RE.exec(name);
  if (m) return { name, prefix: Number(m[1]), slug: m[2], title: titleize(m[2]) };
  return { name, prefix: null, slug: name, title: titleize(name) };
}

// `variant` is the reserved middle segment (`01-opening.camera.md`); v1 only
// reports it. `base` is the file name without the variant.
function withoutVariant(name, variant) {
  return variant ? `${name.slice(0, -(variant.length + 4))}.md` : name;
}

export function parseSceneName(name) {
  let m = SCENE_RE.exec(name);
  if (m) {
    const [, num, slug, variant = null] = m;
    return { name, base: withoutVariant(name, variant), prefix: Number(num), slug, variant, title: titleize(slug) };
  }
  m = UNPREFIXED_SCENE_RE.exec(name);
  if (m) {
    const [, slug, variant = null] = m;
    return { name, base: withoutVariant(name, variant), prefix: null, slug, variant, title: titleize(slug) };
  }
  return null;
}

// Prefixed entries by number, then unprefixed ones alphabetically.
export function compareOrdered(a, b) {
  if (a.prefix !== null && b.prefix !== null) return a.prefix - b.prefix || a.name.localeCompare(b.name);
  if (a.prefix !== null) return -1;
  if (b.prefix !== null) return 1;
  return a.name.localeCompare(b.name);
}
