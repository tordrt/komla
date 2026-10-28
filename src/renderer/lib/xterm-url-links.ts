import type {
  IBufferLine,
  IDisposable,
  ILink,
  ILinkProvider,
  ITerminalAddon,
  Terminal,
} from '@xterm/xterm';

const URL_CHAR = `[^\\s<>"'\`]`;
const URL_REGEX = new RegExp(`(https?|HTTPS?):\\/\\/${URL_CHAR}+`, 'g');
const URL_TOKEN_AT_END_REGEX = new RegExp(`https?:\\/\\/${URL_CHAR}+$`, 'i');
const TRAILING_PUNCT_REGEX = /[.,;:!?)\]'"`]+$/;
const FILE_PATH_REGEX =
  /(^|[\s([{"'`])((?:(?:[A-Za-z]:)?[\\/]|\.{1,2}[\\/]|~[\\/])?(?:[A-Za-z0-9_@+.-]+[\\/])*[A-Za-z0-9_@+.-]+\.[A-Za-z0-9_+-]+)(?::([1-9]\d*)(?::([1-9]\d*))?)?/g;
// A folder path ends in a separator, such as /tmp/shots/ or src/components/. A dot after it
// ends a sentence only when no path follows, as /.claude/ continues one.
const FOLDER_PATH_REGEX =
  /(^|[\s([{"'`])((?:(?:[A-Za-z]:)?[\\/]|\.{1,2}[\\/]|~[\\/])?(?:[A-Za-z0-9_@+.-]+[\\/])+)(?=$|[\s)\]}"'`,;:!?]|\.(?![A-Za-z0-9_@+.\\/-]))/g;
// A first folder named like a domain, as in github.com/user/repo/.
const DOMAIN_START_REGEX = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[\\/]/;
const CONTINUATION_START_REGEX = /[/?#&=._~:%+-]/;
const URL_STRUCTURE_REGEX = /[/?#&=%]|\.[A-Za-z0-9]/;
const LEADING_TOKEN_REGEX = new RegExp(`^${URL_CHAR}+`);
const TRAILING_TOKEN_REGEX = new RegExp(`${URL_CHAR}+$`);
const URL_SCHEME_START_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const QUERY_SEPARATOR_AT_END_REGEX = /[?&=]$/;
const PARTIAL_URL_SCHEME_AT_END_REGEX = /https?:?\/{0,2}$/i;
const FILE_PATH_TOKEN_REGEX = /^[([{]?(?:[A-Za-z]:)?[\w@+.~-]*(?:[\\/][\w@+.~-]*)+(?::\d*){0,2}$/;
const FILE_EXTENSION_AT_END_REGEX = /[^\\/.]\.([A-Za-z0-9_+-]+)$/;
const FILE_PATH_START_REGEX = /^(?:\.{1,2}|~|[A-Za-z]:)[\\/]/;
// Two characters after a dot, so abbreviations such as "e.g." do not read as file names.
const FILE_PATH_STRUCTURE_REGEX = /[\\/]|\.[A-Za-z0-9]{2}|:\d/;
const MAX_FILE_EXTENSION_LENGTH = 4;
const MAX_WINDOW_CHARS = 2048;
// TUIs such as Claude Code pad their content, so wrapped rows can stop short of the edge.
const MAX_RIGHT_MARGIN_CELLS = 2;

type LinkHandler = (event: MouseEvent, uri: string) => void;
type FileLinkHandler = (
  event: MouseEvent,
  filePath: string,
  lineNumber?: number,
  columnNumber?: number
) => void;
export type TerminalDetectedLink =
  | { type: 'url'; url: string }
  | { type: 'file'; filePath: string; lineNumber?: number; columnNumber?: number };
type LinkHoverHandler = (link: TerminalDetectedLink | null) => void;

interface BufferPosition {
  x: number;
  y: number;
}

interface IndexedChar {
  start: BufferPosition;
  end: BufferPosition;
}

interface IndexedLine {
  y: number;
  text: string;
  chars: IndexedChar[];
  isWrapped: boolean;
  trailingBlankCells: number;
}

interface LogicalWindow {
  text: string;
  chars: IndexedChar[];
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

interface HardWrapJoin {
  indent: number;
  fillsRow: boolean;
}

interface HardWrapChain {
  /** Token running into the end of the window, across earlier wraps. */
  token: string;
  /** The last row joined as a full-width middle row of a split token. */
  lastRowFilled: boolean;
}

interface BufferLike {
  getLine(y: number): IBufferLine | undefined;
  getNullCell?: Terminal['buffer']['active']['getNullCell'];
}

interface TerminalLike {
  cols?: number;
  buffer: {
    active: BufferLike;
  };
  registerLinkProvider(provider: ILinkProvider): IDisposable;
}

export class WrappedUrlLinksAddon implements ITerminalAddon {
  private disposable: IDisposable | undefined;

  constructor(
    private readonly handler: LinkHandler,
    private readonly onHover?: LinkHoverHandler
  ) {}

  activate(terminal: Terminal): void {
    this.disposable = terminal.registerLinkProvider(
      new WrappedUrlLinkProvider(terminal, this.handler, this.onHover)
    );
  }

  dispose(): void {
    this.disposable?.dispose();
  }
}

export class WrappedFileLinksAddon implements ITerminalAddon {
  private disposable: IDisposable | undefined;

  constructor(
    private readonly handler: FileLinkHandler,
    private readonly onHover?: LinkHoverHandler
  ) {}

  activate(terminal: Terminal): void {
    this.disposable = terminal.registerLinkProvider(
      new WrappedFileLinkProvider(terminal, this.handler, this.onHover)
    );
  }

  dispose(): void {
    this.disposable?.dispose();
  }
}

export class WrappedUrlLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: TerminalLike,
    private readonly handler: LinkHandler,
    private readonly onHover?: LinkHoverHandler
  ) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    callback(
      computeWrappedUrlLinks(this.terminal, bufferLineNumber - 1, this.handler, this.onHover)
    );
  }
}

export class WrappedFileLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: TerminalLike,
    private readonly handler: FileLinkHandler,
    private readonly onHover?: LinkHoverHandler
  ) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    callback(
      computeWrappedFileLinks(this.terminal, bufferLineNumber - 1, this.handler, this.onHover)
    );
  }
}

export function computeWrappedUrlLinks(
  terminal: TerminalLike,
  lineIndex: number,
  activate: LinkHandler,
  onHover?: LinkHoverHandler
): ILink[] {
  const logicalWindow = buildLogicalWindow(terminal.buffer.active, lineIndex, terminal.cols);
  if (!logicalWindow) return [];

  const links: ILink[] = [];
  URL_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = URL_REGEX.exec(logicalWindow.text)) !== null) {
    const text = stripTrailingPunctuation(match[0]);
    if (!isUrl(text)) continue;
    if (logicalWindow.truncatedStart && match.index === 0) continue;
    if (logicalWindow.truncatedEnd && match.index + match[0].length === logicalWindow.text.length) {
      continue;
    }

    const startIndex = match.index;
    const endIndex = startIndex + text.length - 1;
    const start = logicalWindow.chars[startIndex]?.start;
    const end = logicalWindow.chars[endIndex]?.end;
    if (!start || !end) continue;

    const link: ILink = {
      range: {
        start: { x: start.x + 1, y: start.y + 1 },
        end: { x: end.x + 1, y: end.y + 1 },
      },
      text,
      activate,
    };
    if (onHover) {
      link.hover = () => onHover({ type: 'url', url: text });
      link.leave = () => onHover(null);
    }
    links.push(link);
  }

  return links;
}

/** A file or folder path found in a line of text; a folder's path ends in a separator. */
export interface TextFileLink {
  /** Where the path starts in the text. */
  index: number;
  /** The path as printed, without its line and column. */
  path: string;
  /** The path with its line and column, as the text shows it. */
  text: string;
  lineNumber?: number;
  columnNumber?: number;
}

/**
 * The folder paths, then the file paths, that a line of text shows, as the terminal links them.
 * A path that runs into the end of the text is left to `endsTruncated`, which says whether the
 * text may go on past it.
 */
export function findFileLinksInText(
  text: string,
  { startsTruncated = false, endsTruncated = false } = {}
): TextFileLink[] {
  const links: TextFileLink[] = [];
  const folderSpans: Array<[number, number]> = [];
  FOLDER_PATH_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FOLDER_PATH_REGEX.exec(text)) !== null) {
    const folderPath = match[2];
    if (!isPlausibleFolderPath(folderPath)) continue;

    const startIndex = match.index + match[1].length;
    if (startsTruncated && startIndex === 0) continue;
    if (endsTruncated && match.index + match[0].length === text.length) continue;
    if (isInsideUrl(text, startIndex)) continue;

    folderSpans.push([startIndex, startIndex + folderPath.length - 1]);
    links.push({ index: startIndex, path: folderPath, text: folderPath });
  }

  FILE_PATH_REGEX.lastIndex = 0;
  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    const delimiter = match[1] ?? '';
    const filePath = stripTrailingPunctuation(match[2]);
    const lineNumber = match[3] ? Number.parseInt(match[3], 10) : undefined;
    const columnNumber = match[4] ? Number.parseInt(match[4], 10) : undefined;
    if (!isPlausibleFilePath(filePath, lineNumber)) continue;

    const startIndex = match.index + delimiter.length;
    if (startsTruncated && startIndex === 0) continue;
    if (endsTruncated && match.index + match[0].length === text.length) continue;
    if (isInsideUrl(text, startIndex)) continue;

    const linkText = `${filePath}${lineNumber ? `:${lineNumber}` : ''}${columnNumber ? `:${columnNumber}` : ''}`;
    const endIndex = startIndex + linkText.length - 1;
    // A dotted folder name inside a folder path, such as site.d in /out/site.d/assets/.
    if (folderSpans.some(([first, last]) => startIndex >= first && endIndex <= last)) continue;

    links.push({ index: startIndex, path: filePath, text: linkText, lineNumber, columnNumber });
  }

  return links;
}

export function computeWrappedFileLinks(
  terminal: TerminalLike,
  lineIndex: number,
  activate: FileLinkHandler,
  onHover?: LinkHoverHandler
): ILink[] {
  const logicalWindow = buildLogicalWindow(terminal.buffer.active, lineIndex, terminal.cols);
  if (!logicalWindow) return [];

  const links: ILink[] = [];
  for (const found of findFileLinksInText(logicalWindow.text, {
    startsTruncated: logicalWindow.truncatedStart,
    endsTruncated: logicalWindow.truncatedEnd,
  })) {
    const { path, lineNumber, columnNumber } = found;
    const isFolder = /[\\/]$/.test(path);
    const start = logicalWindow.chars[found.index]?.start;
    const end = logicalWindow.chars[found.index + found.text.length - 1]?.end;
    if (!start || !end) continue;

    const link: ILink = {
      range: {
        start: { x: start.x + 1, y: start.y + 1 },
        end: { x: end.x + 1, y: end.y + 1 },
      },
      text: found.text,
      activate: (event) =>
        isFolder ? activate(event, path) : activate(event, path, lineNumber, columnNumber),
    };
    if (onHover) {
      link.hover = () =>
        onHover(
          isFolder
            ? { type: 'file', filePath: path }
            : { type: 'file', filePath: path, lineNumber, columnNumber }
        );
      link.leave = () => onHover(null);
    }
    links.push(link);
  }

  return links;
}

/**
 * Reads the target of an OSC 8 hyperlink. Applications such as Claude Code mark every row of a
 * file path with one, so the link carries the whole path however the visible text wraps.
 */
export function terminalHyperlinkTarget(uri: string): TerminalDetectedLink | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return { type: 'url', url: uri };
  if (url.protocol !== 'file:') return null;

  // The path belongs to the terminal's own environment, so any host name is ignored.
  let filePath: string;
  try {
    filePath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
  if (filePath === '/' || filePath.includes('\0')) return null;
  return { type: 'file', filePath };
}

function buildLogicalWindow(
  buffer: BufferLike,
  lineIndex: number,
  terminalColumns: number | undefined
): LogicalWindow | null {
  const currentLine = readIndexedLine(buffer, lineIndex, terminalColumns);
  if (!currentLine) return null;

  // Gather rows above that could continue into this one, then confirm hard wraps
  // top-down so every row of a wrapped URL resolves to the same window.
  const candidates = [currentLine];
  let charCount = currentLine.text.length;
  let truncatedStart = false;
  while (candidates[0].y > 0) {
    const first = candidates[0];
    const previous = readIndexedLine(buffer, first.y - 1, terminalColumns);
    if (!previous || !(first.isWrapped || hardWrapJoin(previous, first))) break;
    if (charCount >= MAX_WINDOW_CHARS) {
      truncatedStart = true;
      break;
    }
    candidates.unshift(previous);
    charCount += previous.text.length;
  }

  let lines: IndexedLine[] = [];
  let chain: HardWrapChain = { token: '', lastRowFilled: false };
  const append = (line: IndexedLine, fillsRow: boolean) => {
    lines.push(line);
    const tail = line.text.match(TRAILING_TOKEN_REGEX)?.[0] ?? '';
    const token = tail.length === line.text.length ? chain.token + tail : tail;
    chain = { token, lastRowFilled: fillsRow };
  };
  const join = (line: IndexedLine): boolean => {
    if (line.isWrapped) {
      append(line, false);
      return true;
    }
    const hardWrap = hardWrapJoin(lines[lines.length - 1], line, chain);
    if (!hardWrap) return false;
    append(withoutIndent(line, hardWrap.indent), hardWrap.fillsRow);
    return true;
  };

  for (const line of candidates) {
    if (lines.length && join(line)) continue;
    lines = [];
    chain = { token: '', lastRowFilled: false };
    if (line !== candidates[0]) truncatedStart = false;
    append(line, false);
  }
  charCount = lines.reduce((count, line) => count + line.text.length, 0);

  let truncatedEnd = false;
  for (let y = lineIndex + 1; ; y++) {
    const next = readIndexedLine(buffer, y, terminalColumns);
    if (!next) break;
    if (charCount >= MAX_WINDOW_CHARS) {
      truncatedEnd = next.isWrapped || hardWrapJoin(lines[lines.length - 1], next, chain) !== null;
      break;
    }
    if (!join(next)) break;
    charCount += next.text.length;
  }

  return {
    text: lines.map((line) => line.text).join(''),
    chars: lines.flatMap((line) => line.chars),
    truncatedStart,
    truncatedEnd,
  };
}

/**
 * Decides whether `below` continues a URL or file path that an application
 * hard-wrapped at the end of `above`. Without `chain` it checks layout only, which is
 * enough to collect candidate rows while walking up.
 */
function hardWrapJoin(
  above: IndexedLine,
  below: IndexedLine,
  chain?: HardWrapChain
): HardWrapJoin | null {
  if (above.trailingBlankCells > MAX_RIGHT_MARGIN_CELLS) return null;

  const tail = above.text.match(TRAILING_TOKEN_REGEX)?.[0];
  const indent = below.text.length - below.text.trimStart().length;
  const rest = below.text.slice(indent);
  const head = rest.match(LEADING_TOKEN_REGEX)?.[0];
  if (!tail || !head) return null;
  if (URL_SCHEME_START_REGEX.test(head) && !QUERY_SEPARATOR_AT_END_REGEX.test(tail)) return null;
  // Without a chain the token could still be a file path.
  let filePath = !chain;
  if (chain) {
    if (URL_TOKEN_AT_END_REGEX.test(chain.token) || continuesUrlScheme(chain.token, head)) {
      if (isRootUrlFollowedByPathStart(chain.token, head)) return null;
    } else {
      if (!continuesFilePath(chain, head)) return null;
      filePath = true;
    }
  }

  // Continuation rows align with the wrapped block, never right of where the token began.
  const tailStartX = above.chars[above.text.length - tail.length].start.x;
  const headStartX = below.chars[indent].start.x;
  if (headStartX > tailStartX) return null;

  // Middle rows of a split token fill the wrap width, ending where the row above ends.
  const headFillsRow = head === rest;
  const aboveEndX = above.chars[above.text.length - 1].end.x;
  const belowEndX = below.chars[below.text.length - 1].end.x;
  if (headFillsRow && belowEndX === aboveEndX && /[A-Za-z0-9]/.test(head)) {
    return { indent, fillsRow: true };
  }

  // After a full middle row, the next aligned row holds the token's remainder.
  const lastRowFilled = chain ? chain.lastRowFilled : tail === above.text.trimStart();
  if (lastRowFilled && headStartX === tailStartX) return { indent, fillsRow: false };

  // Flush character wrapping (e.g. tmux redraws) continuing with URL punctuation.
  if (above.trailingBlankCells === 0 && indent === 0 && CONTINUATION_START_REGEX.test(head[0])) {
    return { indent, fillsRow: false };
  }

  // A short remainder alone on its row that still reads as part of a URL.
  if (headFillsRow && URL_STRUCTURE_REGEX.test(head) && /[A-Za-z0-9]/.test(head)) {
    return { indent, fillsRow: false };
  }

  // A file path cut before its name continues with the rest of it, even when text follows.
  if (filePath && FILE_PATH_STRUCTURE_REGEX.test(head)) return { indent, fillsRow: false };
  return null;
}

function continuesUrlScheme(token: string, head: string): boolean {
  return PARTIAL_URL_SCHEME_AT_END_REGEX.test(token) && URL_TOKEN_AT_END_REGEX.test(token + head);
}

function continuesFilePath(chain: HardWrapChain, head: string): boolean {
  const { token } = chain;
  if (!FILE_PATH_TOKEN_REGEX.test(token) || FILE_PATH_START_REGEX.test(head)) return false;
  if (/[\\/]$/.test(token) && /^[\\/]/.test(head)) return false;
  if (/:\d*$/.test(token)) return /^:?\d/.test(head);

  const extension = token.match(FILE_EXTENSION_AT_END_REGEX)?.[1];
  if (!extension || chain.lastRowFilled || /^[.:]/.test(head)) return true;
  // A path that already ends in a file name only continues its extension, unless the
  // row above was a full row of it.
  const more = head.match(/^[A-Za-z0-9_+-]*/)?.[0] ?? '';
  return !/[\\/]/.test(head) && extension.length + more.length <= MAX_FILE_EXTENSION_LENGTH;
}

function withoutIndent(line: IndexedLine, indent: number): IndexedLine {
  if (!indent) return line;
  return { ...line, text: line.text.slice(indent), chars: line.chars.slice(indent) };
}

function isRootUrlFollowedByPathStart(textBeforeWrap: string, nextText: string): boolean {
  if (!nextText.startsWith('/')) return false;

  const match = textBeforeWrap.match(URL_TOKEN_AT_END_REGEX);
  if (!match) return false;

  try {
    const url = new URL(match[0]);
    return url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function readIndexedLine(
  buffer: BufferLike,
  y: number,
  terminalColumns: number | undefined
): IndexedLine | null {
  const line = buffer.getLine(y);
  if (!line) return null;

  const text = line.translateToString(false);
  const trimmedLength = text.trimEnd().length;
  const trimmedText = text.slice(0, trimmedLength);
  const chars: IndexedChar[] = [];
  const lineColumns = terminalColumns ?? line.length;

  if (buffer.getNullCell) {
    const cell = buffer.getNullCell();
    for (let x = 0; x < lineColumns; x++) {
      if (!line.getCell(x, cell)) continue;
      const width = cell.getWidth();
      if (!width) continue;

      const cellText = cell.getChars() || ' ';
      for (let i = 0; i < cellText.length; i++) {
        if (chars.length >= trimmedLength) break;
        chars.push({ start: { x, y }, end: { x: x + width - 1, y } });
      }
    }
  }

  while (chars.length < trimmedLength) {
    const x = chars.length;
    chars.push({ start: { x, y }, end: { x, y } });
  }

  const lastChar = chars[trimmedLength - 1];
  return {
    y,
    text: trimmedText,
    chars,
    isWrapped: line.isWrapped,
    trailingBlankCells: lastChar ? lineColumns - 1 - lastChar.end.x : lineColumns,
  };
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(TRAILING_PUNCT_REGEX, '');
}

function isUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isPlausibleFilePath(value: string, lineNumber: number | undefined): boolean {
  if (!value || value.includes('..')) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (!value.includes('.') || /\s/.test(value)) return false;

  return Number.isFinite(lineNumber) || /[\\/]/.test(value);
}

/**
 * A folder path with a folder before its last one, or one that starts at a root, `./` or `~/`,
 * and not a web address without its scheme.
 */
function isPlausibleFolderPath(value: string): boolean {
  if (value.split(/[\\/]/).some((segment) => segment === '..')) return false;
  if (DOMAIN_START_REGEX.test(value)) return false;
  return (value.match(/[\\/]/g) ?? []).length >= 2;
}

function isInsideUrl(text: string, startIndex: number): boolean {
  const prefix = text.slice(Math.max(0, startIndex - 16), startIndex);
  return /https?:\/\/[^\s]*$/i.test(prefix);
}
