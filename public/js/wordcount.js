// Shared by the server (tree totals) and the browser (live count), so both
// always agree.

const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

export function stripMarkdown(text) {
  return text
    .replace(/^---\n[\s\S]*?\n---\n/, '')          // front matter
    .replace(/```[\s\S]*?```/g, ' ')                // fenced code
    .replace(/<!--[\s\S]*?-->/g, ' ')               // comments
    .replace(/<[^>]+>/g, ' ')                       // html tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // links -> text
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2') // wikilinks -> label
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '') // block markers
    .replace(/[*_~`]+/g, '');                       // emphasis, code ticks
}

export function countWords(text) {
  if (!text) return 0;
  const m = stripMarkdown(text).match(WORD);
  return m ? m.length : 0;
}
