import type { IBuffer, IBufferCell } from '@xterm/xterm';

const TERMINAL_URL = /https?:\/\/[^\s<>"'`]+/g;
const URL_TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const URL_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function countOf(text: string, char: string): number {
  let count = 0;
  for (const candidate of text) if (candidate === char) count++;
  return count;
}

/**
 * A URL as it appeared in prose: without the punctuation a sentence puts after it, or a closing
 * bracket it didn't open, as in "(see https://example.com)." Undefined when nothing is left.
 */
export function trimTerminalUrl(url: string): string | undefined {
  let trimmed = url;
  for (;;) {
    let next = trimmed.replace(URL_TRAILING_PUNCTUATION, '');
    const closer = next.at(-1) ?? '';
    const opener = URL_BRACKETS[closer];
    if (opener && countOf(next, closer) > countOf(next, opener)) next = next.slice(0, -1);
    if (next === trimmed) break;
    trimmed = next;
  }
  return /^https?:\/\/[^/]/i.test(trimmed) ? trimmed : undefined;
}

/** The web addresses in a line of terminal text, each with where it starts. */
export function terminalUrls(text: string): Array<{ index: number; url: string }> {
  const urls: Array<{ index: number; url: string }> = [];
  for (const match of text.matchAll(TERMINAL_URL)) {
    const url = trimTerminalUrl(match[0]);
    if (url) urls.push({ index: match.index, url });
  }
  return urls;
}

export interface TerminalLogicalLine {
  text: string;
  // The 1-based cell each UTF-16 unit of `text` came from, so string offsets map to link ranges.
  cells: Array<{ x: number; y: number }>;
}

/**
 * Buffer line `y` (1-based) and the rows wrapped into or out of it, as one string: a URL the
 * terminal wrapped over several rows is still one URL.
 */
export function readTerminalLogicalLine(
  buffer: IBuffer,
  y: number,
  cell: IBufferCell = buffer.getNullCell()
): TerminalLogicalLine {
  const line: TerminalLogicalLine = { text: '', cells: [] };
  if (!buffer.getLine(y - 1)) return line;
  let start = y - 1;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let end = y - 1;
  while (buffer.getLine(end + 1)?.isWrapped) end++;
  for (let row = start; row <= end; row++) {
    const bufferLine = buffer.getLine(row);
    if (!bufferLine) break;
    for (let col = 0; col < bufferLine.length; col++) {
      bufferLine.getCell(col, cell);
      // The second half of a wide character.
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let unit = 0; unit < chars.length; unit++) line.cells.push({ x: col + 1, y: row + 1 });
      line.text += chars;
    }
  }
  return line;
}

export interface TerminalSelectionText {
  text: string;
  // Offsets of the newlines in `text` that end a row the terminal wrapped, not a real line.
  softWraps: Set<number>;
}

/** The whole buffer as plain rows, for the native selection to work on. */
export function terminalSelectionText(buffer: IBuffer): TerminalSelectionText {
  const rows: string[] = [];
  const softWraps = new Set<number>();
  let offset = 0;
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    const wrapsOn = buffer.getLine(row + 1)?.isWrapped === true;
    // A wrapped row keeps its trailing blanks: they are part of the line it continues.
    const text = line.translateToString(!wrapsOn);
    rows.push(text);
    offset += text.length;
    if (wrapsOn) softWraps.add(offset);
    offset += 1;
  }
  return { text: rows.join('\n'), softWraps };
}

/** `text`, which starts at `from` in the selection text, with its soft-wrap newlines removed. */
export function joinSoftWraps(text: string, from: number, softWraps: Set<number>): string {
  let joined = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n' && softWraps.has(from + index)) continue;
    joined += text[index];
  }
  return joined;
}

/**
 * The run of non-blank text around `offset` (a path, a hash, a flag), as start and end offsets;
 * just the URL when the run starts with one. Undefined on a blank.
 */
export function terminalWordAt(
  text: string,
  offset: number,
  softWraps: Set<number>
): { start: number; end: number } | undefined {
  const isBreak = (index: number) => {
    const char = text[index] ?? '';
    return /\s/.test(char) && !(char === '\n' && softWraps.has(index));
  };
  if (offset >= text.length || isBreak(offset)) return undefined;
  let start = offset;
  while (start > 0 && !isBreak(start - 1)) start--;
  let end = offset;
  while (end < text.length && !isBreak(end)) end++;
  const [url] = terminalUrls(joinSoftWraps(text.slice(start, end), start, softWraps));
  if (url?.index === 0) {
    let remaining = url.url.length;
    end = start;
    while (remaining > 0 && end < text.length) {
      if (!(text[end] === '\n' && softWraps.has(end))) remaining--;
      end++;
    }
  }
  return { start, end };
}
