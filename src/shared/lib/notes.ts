/** Names the folder that holds one workspace's notes: the workspace's id. */
export const NOTES_SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A note's file name, as Komla names them. */
export const NOTE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,100}\.md$/;

const MAX_TITLE_LENGTH = 80;

// Lines that are Markdown syntax rather than text: front matter and thematic
// break dashes, setext underlines, code fences.
const SYNTAX_ONLY_LINE = /^(?:[-*_=]{3,}|`{3,}.*|~{3,}.*)$/;
// Markers that start a line, also alone, as in an empty heading or list item.
const LINE_PREFIX =
  /^(?:#{1,6}(?:\s+|$)|>\s*|[-*+](?:\s+|$)(?:\[[ xX]\](?:\s+|$))?|\d+[.)](?:\s+|$))+/;

/** A note's title: its first line of text, without Markdown syntax. Empty when the note is blank. */
export function getNoteTitle(content: string): string {
  const lines = content.split(/\r?\n/);
  // Skip front matter.
  const frontMatterEnd =
    lines[0]?.trim() === '---' ? lines.findIndex((line, i) => i > 0 && line.trim() === '---') : -1;
  for (const rawLine of lines.slice(frontMatterEnd + 1)) {
    const trimmed = rawLine.trim();
    if (!trimmed || SYNTAX_ONLY_LINE.test(trimmed)) continue;
    const text = trimmed
      .replace(LINE_PREFIX, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
      .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
      .trim();
    if (!text) continue;
    return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
  }
  return '';
}
