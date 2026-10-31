// Claude prompts for codex entries: gathering a description from the
// manuscript, refining it from lookbook images, and carrying it back into the
// prose. They all work on one section of the entry, so reruns replace it.
// Fixed traits are the writer's: Claude drafts them once, then only proposes.

import { prose, sectionBody } from './sections.js';

export const DESCRIPTION = 'Description';
export const IMAGE_PROMPT = 'Image prompt';
export const FIXED_TRAITS = 'Fixed traits';
export const VISUAL_STYLE = 'codex/visual-style.md';

// Online image generators: the editor copies the prompt and opens one.
export const IMAGE_TOOLS = [
  { label: 'ChatGPT', url: 'https://chatgpt.com/' },
  { label: 'Gemini', url: 'https://gemini.google.com/app' },
];

// What a "### Look" says: the entry's appearance in a few lines, for prompts
// that put it in a scene with others (the Stage dialog).
const LOOK_FORMAT = 'Two to four sentences, under 600 characters, on appearance only, as a picture of any scene would need it: for a person, build and height next to others, face, hair, and the clothing they usually wear; for a place, size, materials, fixtures and light. No setting, action, mood, voice or habits, and no names.';

const SECTION_FORMAT = `## ${DESCRIPTION}

<One to three paragraphs of prose: everything established about how they look, sound and move (for a place: layout, materials, light, sounds, smells). Only what the sources support.>

### Look

<${LOOK_FORMAT}>

### ${IMAGE_PROMPT}

<One self-contained paragraph for an image generator: the subject, its appearance, clothing or materials, setting, light and mood. Visual detail only. No character names, no plot, no references to the book. No medium or rendering style (photograph, painterly, illustration, film stock, palette): the editor adds ${VISUAL_STYLE} to every prompt it prepares, so a style here would repeat it or fight it.>

### From the manuscript

- “<short quote>” (manuscript/<chapter>/<scene>.md)

### Open questions

- <contradictions between sources, and things a picture would need that nothing settles>`;

const KIND_FOCUS = {
  character: 'appearance (face, build, hair, scars, age), clothing, posture and movement, voice, habits and mannerisms',
  location: 'layout and size, materials, light at different times, weather, sounds, smells, and the objects in it',
  note: 'anything visual or sensory',
};

// Where Gather looks. With `found` (the editor's search for the entry's names,
// from /mentions), Claude reads only those scenes; without it, or when the
// search found nothing, Claude searches the whole manuscript.
function gatherSources(entry, found) {
  const focus = KIND_FOCUS[entry.kind] ?? KIND_FOCUS.note;
  if (!found?.scenes?.length) {
    return `Find every passage in manuscript/ (every chapter and every narration mode) that describes ${entry.title}: ${focus}. Search for its other names too: the \`aliases:\` list in the entry's front matter, if it has one.`;
  }
  const scenes = found.scenes.map((s) => `   - ${s.chapter}, “${s.title}”${s.hits ? '' : ' (next to a scene that names it)'}: ${s.files.join(', ')}`).join('\n');
  const read = found.scenes.some((s) => s.files.length > 1)
    ? 'Where a scene has several files, they are the same scene in different narration modes; read them all.'
    : 'Read each file.';
  return `The editor searched the manuscript for ${found.names.map((n) => `“${n}”`).join(', ')}. These scenes name ${entry.title}, or come right before or after one that does${found.mode ? ` (the ${found.mode} version where a scene has one)` : ''}. ${read}
${scenes}

   Find every passage in them that describes ${entry.title}: ${focus}. Don't search the rest of the manuscript; open another scene only to check a doubtful passage. If these scenes say little, say so under Open questions.`;
}

// Claude reads the manuscript (or the scenes in `found`) and writes the
// entry's Description.
export function gatherPrompt(entry, found = null) {
  return `Gather a description of “${entry.title}” (${entry.path}) from the manuscript.

1. ${gatherSources(entry, found)} Include indirect references (other names, titles, pronouns) when the scene makes clear who or what is meant. Also read ${entry.path} and the outline files for context, and ${VISUAL_STYLE} if the book has one: keep what you describe within its period and setting, and away from what it says to avoid.
2. In ${entry.path}, write a "## ${DESCRIPTION}" section in exactly this shape, replacing the section if it already exists (up to the next "## " heading). Put it after the entry's opening lines if it's new. Leave every other part of the file alone.

${SECTION_FORMAT}

   If the sources establish nothing visual about ${entry.title}, say so in the prose and leave "### Look" and "### ${IMAGE_PROMPT}" empty (just the headings): a placeholder sentence there would be used as a prompt.
3. Don't touch a "## ${FIXED_TRAITS}" section. If the entry has none, or it has no bullets, add a line to Open questions for each visual fact that should never change between pictures: "- Proposed fixed trait: <trait>".

Don't change anything in manuscript/ or outline/. In the panel, just say how many passages you used and list the open questions.`;
}

// Claude writes the entry's Fixed traits once, from its description.
export function fixedTraitsPrompt(entry) {
  return `Draft the fixed traits of “${entry.title}” (${entry.path}): the few visual facts that must be the same in every picture of ${entry.title}.

1. Read ${entry.path}, especially its "## ${DESCRIPTION}" section and its quotes. Check anything doubtful against manuscript/.
2. If the entry already has a "## ${FIXED_TRAITS}" section with bullets in it, don't change it. In the panel, list the traits you would add and any that conflict with the manuscript.
3. Otherwise write the section: 4 to 8 bullets, each concrete enough to check by looking at a picture (for example "Scar across the right cheek, from jaw to ear", not "scarred"). ${entry.kind === 'location' ? 'Layout, materials, landmarks and anything that marks the place.' : 'Face, build, height next to others, hair, marks, and clothing they always wear.'} No personality, nothing that changes during the book. Fill an empty "## ${FIXED_TRAITS}" section where it is; if there's none, put it right after "## ${DESCRIPTION}" (or after the entry's opening lines).

Don't change anything else in ${entry.path}, and nothing in manuscript/ or outline/.`;
}

// Claude writes the "### Look" of an entry's Description: the short
// appearance-only text the Stage dialog puts in prompts.
export function lookPrompt(entry) {
  return `Draft a short look for “${entry.title}” (${entry.path}), for image prompts that place ${entry.title} in a scene with others.

1. Read ${entry.path}: its "## ${DESCRIPTION}" section and its "## ${FIXED_TRAITS}", if any.
2. Write a "### Look" subsection inside "## ${DESCRIPTION}": ${LOOK_FORMAT} Use only what the entry already says; where it gives the person several outfits or the place several states, use the usual one. Put it right after the Description's prose, before any other "###" subsection, replacing an existing "### Look".

Don't change anything else in ${entry.path}, and nothing in manuscript/ or outline/. In the panel, show the look you wrote.`;
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

2. Add the concrete details the image settles that the text leaves open (colors, materials, proportions, wear, light, expression) to the description prose. Keep the writer's facts: where the image contradicts the text, the manuscript or the entry's "## ${FIXED_TRAITS}", don't change the text. Add the conflict to "### Open questions" instead, naming the image. Never edit "## ${FIXED_TRAITS}".
3. Update "### ${IMAGE_PROMPT}" so it would produce this look again, and "### Look" if the entry has one. Describe the subject, not the image's medium or style: the editor adds ${VISUAL_STYLE} itself.
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
  const text = prose(prompt ?? section.split(/^#{3,6}\s/m)[0]);
  return text || null;
}

// A one-off question (not a panel run): turn a moment of the story into a
// visual brief for one picture. The answer goes back into the Stage dialog.
//   shot: { moment: { text, source }, framing: { shot, time, notes } }
//   people, setting: [{ title, path }] and { title, path } | null
export function briefPrompt({ moment, framing = {} }, { people = [], setting = null } = {}) {
  const cast = people.length ? people.map((p) => `${p.title} (${p.path})`).join(', ') : 'no one in particular';
  const frame = [framing.shot && `${framing.shot} shot`, framing.time && `time: ${framing.time}`, framing.notes].filter(Boolean).join('; ');
  return `Write a visual brief for one illustration of a moment in this book.

The moment${moment.source ? ` (from ${moment.source})` : ''}:
"""
${moment.text.trim()}
"""

In the picture: ${cast}.${setting ? ` Setting: ${setting.title} (${setting.path}).` : ''}${frame ? `\nFraming asked for: ${frame}.` : ''}

If you need context (who is where, what they hold, the weather, the light, what just happened), read the scene file around the moment and the codex entries. Then answer with only the brief: 3 to 6 sentences in the present tense, saying what the picture shows: where each person is and what they're doing, their expressions and gestures, the key objects, the light and the mood. Refer to people by name. Don't describe how people or places look (faces, build, clothing, architecture): the prompt adds that from the codex. Don't add events that aren't in the moment, and don't name the book. No preamble, no headings, no quotation marks around the brief.`;
}
