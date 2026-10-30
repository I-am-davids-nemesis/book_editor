// How a generated image was made, kept at the end of its lookbook note:
//
//   ## How it was made
//
//   ```json
//   { "provider": "comfyui", "model": "flux2-klein-9b", "seed": 12, … }
//   ```
//
// Shared by the browser (Stage again) and the server (writing notes).

export const MADE_HEADING = 'How it was made';
const MADE_RE = /^##[ \t]+How it was made[ \t]*#*[ \t]*$/m;

// The note body split at the section: { rest, raw, made }. `raw` is the
// section's text as written ('' if there is none); `made` is its JSON, or
// null if it's missing or unreadable.
export function splitMade(body) {
  const text = String(body ?? '');
  const m = MADE_RE.exec(text);
  if (!m) return { rest: text, raw: '', made: null };
  const raw = text.slice(m.index).trim();
  let made = null;
  const json = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(raw);
  if (json) {
    try {
      made = JSON.parse(json[1]);
    } catch {
      made = null;
    }
  }
  return { rest: text.slice(0, m.index), raw, made };
}

export const formatMade = (made) => `## ${MADE_HEADING}\n\n\`\`\`json\n${JSON.stringify(made, null, 2)}\n\`\`\``;
