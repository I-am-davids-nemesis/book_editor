import { api } from './api.js';
import { IMAGE_TOOLS } from './codexprompts.js';
import { h, imageSrc, toast } from './ui.js';
import { handoffPrompt, isReference, rankImages, VIEW_LABELS, VISUAL_STYLE } from './worldmodel.js';

// Most outside generators take a handful of references; more dilutes them.
const DEFAULT_REFS = 4;
const IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent);

// The book's visual style note, or '' if it has none.
export async function loadVisualStyle(bookId) {
  try {
    return (await api.readFile(bookId, VISUAL_STYLE)).content;
  } catch (err) {
    if (err.status === 404) return '';
    throw err;
  }
}

// Prepares an entry for ChatGPT, Gemini or another generator: the full prompt
// (image prompt, fixed traits, numbered references, visual style) and the
// reference images to drag across in the same order.
//   entry: { path, title, kind }   text: the entry's Markdown   images: its lookbook images
export async function handoffDialog({ bookId, entry, text, images, tool = null }) {
  const styleText = await loadVisualStyle(bookId).catch(() => '');
  const ranked = rankImages(images, entry.kind);
  const chosen = new Set(ranked.filter(isReference).slice(0, DEFAULT_REFS).map((img) => img.path));
  let edited = false;

  const promptEl = h('textarea', { class: 'handoff-prompt', rows: 12, spellcheck: 'true', 'aria-label': 'Prompt' });
  promptEl.addEventListener('input', () => { edited = true; });
  const refsEl = h('ol', { class: 'handoff-refs' });
  const hintEl = h('p', { class: 'field-hint' });
  const selected = () => ranked.filter((img) => chosen.has(img.path));

  const render = () => {
    const refs = selected();
    if (!edited) promptEl.value = handoffPrompt({ kind: entry.kind, text, styleText, refs }) ?? '';
    let n = 0;
    refsEl.replaceChildren(...ranked.map((img) => {
      const on = chosen.has(img.path);
      const box = h('input', { type: 'checkbox', checked: on, 'aria-label': `Send ${img.title}` });
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(img.path);
        else chosen.delete(img.path);
        render();
      });
      const label = isReference(img)
        ? [VIEW_LABELS[img.view] ?? 'Reference', img.variant].filter(Boolean).join(' · ')
        : 'Not marked as a reference';
      return h('li', { class: `handoff-ref${on ? ' on' : ''}` },
        h('span', { class: 'handoff-num' }, on ? String((n += 1)) : ''),
        h('img', { src: imageSrc(bookId, img), alt: img.title, title: on ? 'Drag this into the generator’s tab' : img.title }),
        h('label', {}, box, h('span', {}, h('strong', {}, img.title), h('span', { class: 'muted' }, label))));
    }));
    hintEl.textContent = !ranked.length
      ? 'This entry has no images yet. The prompt works on its own; add the result to the entry, then mark the best as a reference in the Lookbook.'
      : !refs.length
        ? 'No images chosen. Mark the best images of this entry as references in the Lookbook, or tick them here.'
        : edited
          ? 'You’ve edited the prompt, so it no longer renumbers the images. Check the “Image N” lines match.'
          : `Attach the ${refs.length === 1 ? 'image' : `${refs.length} images`} in this order: drag them across, or use Show in Finder.`;
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(promptEl.value);
      return true;
    } catch {
      promptEl.select();
      toast('Couldn’t copy; the prompt is selected, so press ⌘C', { error: true });
      return false;
    }
  };

  return new Promise((resolve) => {
    const finder = IS_MAC ? h('button', {
      type: 'button',
      onclick: async () => {
        const refs = selected();
        if (!refs.length) return toast('Choose at least one image first', { error: true });
        try {
          await api.handoff(bookId, refs.map((img) => img.path), entry.title);
        } catch (err) {
          toast(err.message, { error: true });
        }
      },
    }, 'Show in Finder') : null;
    const tools = (tool ? [tool] : IMAGE_TOOLS).map((t) => h('button', {
      type: 'button',
      class: t === (tool ?? IMAGE_TOOLS[0]) ? 'primary' : null,
      onclick: async () => {
        if (!(await copy())) return;
        window.open(t.url, '_blank', 'noopener');
        toast(`Prompt copied. Paste it into ${t.label}, attach the numbered images, then drop the result on “${entry.title}”.`, { ms: 8000 });
      },
    }, `Copy and open ${t.label}`));

    const dialog = h('dialog', { class: 'dialog handoff-dialog' },
      h('form', { method: 'dialog' },
        h('h2', {}, `Prepare “${entry.title}” for an image generator`),
        h('div', { class: 'handoff-body' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Prompt'), promptEl),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Reference images'), refsEl, hintEl)),
        h('div', { class: 'dialog-buttons' },
          h('button', { type: 'button', onclick: async () => { if (await copy()) toast('Prompt copied'); } }, 'Copy prompt'),
          finder,
          h('span', { class: 'spacer' }),
          tools,
          h('button', { type: 'submit' }, 'Close'))));
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve();
    });
    render();
    if (!promptEl.value) {
      promptEl.placeholder = 'This entry has no image prompt yet. Use Claude ▾ → Gather a description first, or write a prompt here.';
    }
    document.body.append(dialog);
    dialog.showModal();
    promptEl.focus();
  });
}
