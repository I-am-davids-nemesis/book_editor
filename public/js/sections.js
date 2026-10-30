// Reading sections of codex Markdown. Shared by the browser and the server.

// The body of the first "## Title" (at `level`) heading, up to the next
// heading at that level or above. Null if there's no such heading.
export function sectionBody(markdown, level, title) {
  const lines = String(markdown).split(/\r?\n/);
  const heading = new RegExp(`^#{${level}}\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*#*\\s*$`, 'i');
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return null;
  const stop = new RegExp(`^#{1,${level}}\\s`);
  let end = start + 1;
  while (end < lines.length && !stop.test(lines[end])) end += 1;
  return lines.slice(start + 1, end).join('\n');
}

// Template guidance is written as HTML comments; it never counts as content.
export function stripComments(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, '');
}

// The non-empty bullets of a list: ["Scar across the right cheek", …]
export function bullets(text) {
  return stripComments(text).split(/\r?\n/)
    .map((l) => /^\s*[-*+]\s+(.*\S)\s*$/.exec(l)?.[1])
    .filter(Boolean);
}

// A section's prose with comments removed and whitespace tidied; '' if empty.
export function prose(text) {
  return stripComments(text).split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
}
