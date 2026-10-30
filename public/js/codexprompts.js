// Claude prompts for codex entries: gathering a description from the
// manuscript, refining it from lookbook images, and carrying it back into the
// prose. They all work on one section of the entry, so reruns replace it.

export const DESCRIPTION = 'Description';
export const IMAGE_PROMPT = 'Image prompt';

// Online image generators: the editor copies the prompt and opens one.
export const IMAGE_TOOLS = [
  { label: 'ChatGPT', url: 'https://chatgpt.com/' },
  { label: 'Gemini', url: 'https://gemini.google.com/app' },
];

const SECTION_FORMAT = `## ${DESCRIPTION}

<One to three paragraphs of prose: everything established about how they look, sound and move (for a place: layout, materials, light, sounds, smells). Only what the sources support.>

### ${IMAGE_PROMPT}

<One self-contained paragraph for an image generator: the subject, its appearance, clothing or materials, setting, light and mood, plus a style note if the book's codex has one. Visual detail only. No character names, no plot, no references to the book.>

### From the manuscript

- “<short quote>” (manuscript/<chapter>/<scene>.md)

### Open questions

- <contradictions between sources, and things a picture would need that nothing settles>`;

const KIND_FOCUS = {
  character: 'appearance (face, build, hair, scars, age), clothing, posture and movement, voice, habits and mannerisms',
  location: 'layout and size, materials, light at different times, weather, sounds, smells, and the objects in it',
  note: 'anything visual or sensory',
};

// Claude reads the whole manuscript and writes the entry's Description.
export function gatherPrompt(entry) {
  return `Gather a description of “${entry.title}” (${entry.path}) from the manuscript.

1. Find every passage in manuscript/ (every chapter and every narration mode) that describes ${entry.title}: ${KIND_FOCUS[entry.kind] ?? KIND_FOCUS.note}. Include indirect references (other names, titles, pronouns) when the scene makes clear who or what is meant. Also read ${entry.path} and the outline files for context.
2. In ${entry.path}, write a "## ${DESCRIPTION}" section in exactly this shape, replacing the section if it already exists (up to the next "## " heading). Put it after the entry's opening lines if it's new. Leave every other part of the file alone.

${SECTION_FORMAT}

Don't change anything in manuscript/ or outline/. In the panel, just say how many passages you used and list the open questions.`;
}

// Claude looks at lookbook images and folds what they settle into each
// linked entry's Description.
export function refinePrompt(entries, images) {
  const list = (items) => items.map((i) => `- ${i.title}: ${i.path}`).join('\n');
  return `Refine ${entries.length === 1 ? 'a codex description' : 'codex descriptions'} from ${images.length === 1 ? 'an image' : 'images'} in the lookbook.

Images (open each with the Read tool and look at it closely):
${list(images)}

Codex ${entries.length === 1 ? 'entry' : 'entries'}:
${list(entries)}

For each entry:
1. Compare what the image shows with its "## ${DESCRIPTION}" section. If the entry has none, write one first from the manuscript, in this shape:

${SECTION_FORMAT}

2. Add the concrete details the image settles that the text leaves open (colors, materials, proportions, wear, light, expression) to the description prose. Keep the writer's facts: where the image contradicts the text or the manuscript, don't change the text. Add the conflict to "### Open questions" instead, naming the image.
3. Update "### ${IMAGE_PROMPT}" so it would produce this look again.
4. Add the image to the section as a source: "- Image: lookbook/<file>".

Don't change anything in manuscript/ or outline/. In the panel, list what you added and the conflicts you found, briefly.`;
}

// Claude proposes manuscript changes from the entry's Description, without
// making them.
export function manuscriptPrompt(entry) {
  return `Using the "## ${DESCRIPTION}" section of ${entry.path}, suggest ways to enrich how the manuscript describes ${entry.title}.

1. Find the passages in manuscript/ where ${entry.title} appears or is described.
2. Pick the places where a detail from the description would help: a first appearance with little description, a scene that contradicts the description, or a moment where a sensory detail would land. Don't suggest more than one detail per scene unless the scene needs it, and keep the prose's voice and the scene's point of view.
3. Don't edit any files yet. In the panel, list numbered suggestions, each with the file path, the original sentence quoted, and the revised sentence.

I'll tell you which suggestions to apply.`;
}

// The image prompt in an entry's text: the "### Image prompt" paragraph of
// its Description, or else the Description's own prose. Null if it has none.
export function imagePromptFrom(markdown) {
  const section = sectionBody(markdown, 2, DESCRIPTION);
  if (section === null) return null;
  const prompt = sectionBody(section, 3, IMAGE_PROMPT);
  const text = (prompt ?? section.split(/^#{3,6}\s/m)[0]).trim();
  return text || null;
}

function sectionBody(markdown, level, title) {
  const lines = String(markdown).split(/\r?\n/);
  const heading = new RegExp(`^#{${level}}\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*#*\\s*$`, 'i');
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return null;
  const stop = new RegExp(`^#{1,${level}}\\s`);
  let end = start + 1;
  while (end < lines.length && !stop.test(lines[end])) end += 1;
  return lines.slice(start + 1, end).join('\n');
}
