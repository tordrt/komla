import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { Marked } from 'marked';

import { longestCommonSubsequence } from '@/lib/longest-common-subsequence';

import { createMarkdownExtensions } from './markdown-extensions';

import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';

/** One top-level block of the file, as written and as the editor writes each node it became. */
interface MarkdownBlock {
  /** The block with LF line endings. */
  raw: string;
  /** The block's bytes in the file, line endings included. */
  written: string;
  canonical: string[];
}

/** The file as loaded, kept so a save can write untouched blocks back byte for byte. */
export interface MarkdownSnapshot {
  source: string;
  /** The line ending for new text: the file's most common one. */
  eol: '\n' | '\r\n';
  /** leading, trailing and separators are the file's bytes, line endings included. */
  leading: string;
  trailing: string;
  blocks: MarkdownBlock[];
  /** separators[i] is the text between blocks[i] and blocks[i + 1]. */
  separators: string[];
  /** Link reference definitions, appended when rendering a lone block. */
  definitions: string;
  /** The 1-based line each top-level node of the loaded document starts on. */
  nodeLines: number[];
}

export interface LoadedMarkdown {
  snapshot: MarkdownSnapshot;
  doc: JSONContent;
}

const FRONT_MATTER = /^(?:---\n[\s\S]*?\n(?:---|\.\.\.)|\+\+\+\n[\s\S]*?\n\+\+\+)[ \t]*(?=\n|$)/;
const FOOTNOTE = /\[\^[^\]\s]+\]/;
/**
 * Front matter, HTML, link definitions, text the lexer skipped (a second
 * definition of a link reference), and a whole file the lexer couldn't split.
 */
const SOURCE_TOKEN_TYPES = new Set(['frontMatter', 'html', 'def', 'skipped', 'file']);
/** Backslash escapes, entities and `[url](url)` links the serializer adds. */
const ESCAPES = /\\[!-/:-@[-`{-~]|&(?:lt|gt|amp);|\[(https?:\/\/[^\s\]()]+)\]\(\1\)/g;
const ALIGN_LIMIT = 250_000;
const LIST_MARKER = /^((?:[ \t]*>)*[ \t]*)([-*+]|\d{1,9}[.)])(?=[ \t]|$)/;

/**
 * Converts between Markdown files and rich editor documents.
 *
 * Each top-level block the editor can't round-trip without changing how it
 * renders becomes a `markdownSource` block instead. On save, blocks the user
 * didn't touch keep their original bytes and spacing, so editing one line
 * doesn't rewrite the rest of the file in the editor's own style.
 */
export class MarkdownCodec {
  readonly schema: Schema;
  private readonly manager: MarkdownManager;
  private readonly reference = new Marked({ gfm: true });
  private readonly canonicalCache = new WeakMap<ProseMirrorNode, string>();

  constructor() {
    const extensions = createMarkdownExtensions();
    this.schema = getSchema(extensions);
    this.manager = new MarkdownManager({ extensions, markedOptions: { gfm: true } });
  }

  load(source: string): LoadedMarkdown {
    const text = source.replace(/\r\n/g, '\n');
    const written = sourceOffsets(source);
    // A file the lexer can't map back to its bytes shows as one Markdown source block.
    const ranges = this.splitBlocks(text) ?? wholeFileRange(text);

    const definitions = ranges
      .filter((range) => range.type === 'def')
      .map((range) => range.raw)
      .join('\n');
    const blocks: MarkdownBlock[] = [];
    const content: JSONContent[] = [];
    const nodeLines: number[] = [];
    let line = 1;
    let lineOffset = 0;
    for (const range of ranges) {
      const block = this.loadBlock(range, definitions);
      blocks.push({
        raw: range.raw,
        written: source.slice(written(range.start), written(range.end)),
        canonical: block.canonical,
      });
      content.push(...block.nodes);
      line += countLines(text, lineOffset, range.start);
      lineOffset = range.start;
      nodeLines.push(...block.nodes.map(() => line));
    }

    const snapshot: MarkdownSnapshot = {
      source,
      eol: isMostlyCrlf(source) ? '\r\n' : '\n',
      leading: ranges.length ? source.slice(0, written(ranges[0].start)) : '',
      trailing: ranges.length ? source.slice(written(ranges[ranges.length - 1].end)) : source,
      blocks,
      separators: ranges
        .slice(1)
        .map((range, index) => source.slice(written(ranges[index].end), written(range.start))),
      definitions,
      nodeLines,
    };
    return {
      snapshot,
      doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] },
    };
  }

  /** Serializes an edited document, reusing the snapshot's bytes wherever a block is unchanged. */
  serialize(snapshot: MarkdownSnapshot, doc: ProseMirrorNode): string {
    const edited: string[] = [];
    const verbatim: boolean[] = [];
    doc.forEach((node) => {
      if (node.type.name === 'paragraph' && node.childCount === 0) return;
      edited.push(this.canonicalOf(node));
      // Markdown source is written as typed: front matter and HTML aren't Markdown to tidy.
      verbatim.push(node.type.name === 'markdownSource');
    });

    const { blocks, separators, definitions, eol } = snapshot;
    const fresh = (index: number) =>
      verbatim[index] ? edited[index] : this.tidy(edited[index], definitions);
    const parts = blocks.flatMap((block, index) =>
      block.canonical.map((canonical, part) => ({ block: index, part, canonical }))
    );
    const pairs = alignBlocks(
      parts.map((part) => part.canonical),
      edited
    );

    // Each unit is one original block written as is or merged, or one node written fresh.
    const units: { text: string; block: number | null }[] = [];
    for (let index = 0; index < edited.length; index++) {
      const pair = pairs[index];
      const part = pair.original === null ? null : parts[pair.original];
      const block = part ? blocks[part.block] : null;
      if (!part || !block) {
        units.push({ text: toEol(fresh(index), eol), block: null });
      } else if (pair.exact && isWholeBlock(pairs, index, part.part, block.canonical.length)) {
        units.push({ text: block.written, block: part.block });
        index += block.canonical.length - 1;
      } else if (!pair.exact && block.canonical.length === 1) {
        const text = verbatim[index]
          ? edited[index]
          : this.mergeBlock(block, edited[index], definitions);
        units.push({ text: toEol(text, eol), block: part.block });
      } else {
        units.push({ text: toEol(fresh(index), eol), block: null });
      }
    }
    let body = '';
    units.forEach((unit, index) => {
      const previous = units[index - 1];
      if (previous) {
        const adjacent =
          previous.block !== null && unit.block !== null && unit.block === previous.block + 1;
        body += adjacent ? separators[previous.block!] : eol + eol;
      }
      body += unit.text;
    });

    // Parts the user didn't touch keep their own line endings; new text gets the file's usual one.
    const trailing = snapshot.trailing || (snapshot.blocks.length || !body ? '' : eol);
    const result = snapshot.leading + body + trailing;
    const canonicalDocument = snapshot.leading + toEol(edited.join('\n\n'), eol) + trailing;
    if (result !== canonicalDocument && this.render(result) !== this.render(canonicalDocument)) {
      return canonicalDocument;
    }
    return result;
  }

  /** Writes copied content as Markdown, for pasting into prompts and terminals. */
  serializeFragment(content: JSONContent[]): string {
    return trimBlankLines(this.manager.serialize({ type: 'doc', content }));
  }

  /** Parses pasted Markdown into block content for the editor. */
  parseFragment(markdown: string): JSONContent[] {
    return wrapInlineNodes(this.manager.parse(markdown.replace(/\r\n/g, '\n')).content ?? []);
  }

  private splitBlocks(text: string) {
    const ranges: { raw: string; start: number; end: number; type: string }[] = [];
    const frontMatter = FRONT_MATTER.exec(text)?.[0];
    let offset = 0;
    if (frontMatter) {
      ranges.push({ raw: frontMatter, start: 0, end: frontMatter.length, type: 'frontMatter' });
      offset = frontMatter.length;
    }

    let tokens;
    try {
      tokens = this.manager.instance.lexer(text.slice(offset));
    } catch {
      return null;
    }
    const pushSkipped = (end: number) => {
      const range = trimmedRange(text.slice(offset, end), offset);
      if (range) ranges.push({ ...range, type: 'skipped' });
    };
    for (const token of tokens) {
      const start = text.indexOf(token.raw, offset);
      if (start === -1) return null;
      // The lexer passes over some text without a token, like a link reference defined twice.
      if (start > offset) pushSkipped(start);
      offset = start + token.raw.length;
      if (token.type === 'space') continue;
      const range = trimmedRange(token.raw, start);
      if (range) ranges.push({ ...range, type: token.type });
    }
    pushSkipped(text.length);
    // Every range must point at the file's own bytes, or a save could shift text.
    return ranges.every((range) => text.slice(range.start, range.end) === range.raw)
      ? ranges
      : null;
  }

  private loadBlock(
    range: { raw: string; type: string },
    definitions: string
  ): { nodes: JSONContent[]; canonical: string[] } {
    const source = { nodes: [sourceNode(range.raw)], canonical: [range.raw] };
    if (SOURCE_TOKEN_TYPES.has(range.type)) return source;
    if (FOOTNOTE.test(range.raw)) return source;
    try {
      const nodes = wrapInlineNodes(
        this.manager.parse(withDefinitions(range.raw, definitions)).content ?? []
      ).map((json) => {
        const node = this.schema.nodeFromJSON(json);
        node.check();
        return node;
      });
      // A list mixing plain and task items becomes two lists.
      const canonical = nodes.map((node) => this.canonicalOf(node));
      if (!canonical.length || canonical.some((text) => !text)) return source;
      if (
        this.render(withDefinitions(range.raw, definitions)) !==
        this.render(withDefinitions(canonical.join('\n\n'), definitions))
      ) {
        return source;
      }
      return { nodes: nodes.map((node) => node.toJSON() as JSONContent), canonical };
    } catch {
      return source;
    }
  }

  private canonicalOf(node: ProseMirrorNode): string {
    let canonical = this.canonicalCache.get(node);
    if (canonical === undefined) {
      canonical =
        node.type.name === 'markdownSource'
          ? node.textContent
          : trimBlankLines(
              this.manager.serialize({ type: 'doc', content: [node.toJSON() as JSONContent] })
            );
      this.canonicalCache.set(node, canonical);
    }
    return canonical;
  }

  /**
   * Keeps the original text of lines an edit didn't change, and around the
   * change in a line that did, when the block still renders the same.
   */
  private mergeBlock(block: MarkdownBlock, canonical: string, definitions: string): string {
    const tidy = this.tidy(canonical, definitions);
    const baseLines = block.canonical[0].split('\n');
    const rawLines = block.raw.split('\n');
    if (baseLines.length !== rawLines.length) return tidy;

    const editedLines = tidy.split('\n');
    const markers = listMarkerStyles(baseLines, rawLines);
    const merged = alignBlocks(baseLines, editedLines)
      .map(({ original, exact }, index) => {
        if (original !== null && exact) return rawLines[original];
        const line = editedLines[index];
        if (original === null) return applyListMarkerStyle(line, markers);
        return (
          mergeLine(baseLines[original], rawLines[original], line) ??
          applyListMarkerStyle(line, markers)
        );
      })
      .join('\n');
    if (merged === tidy) return tidy;
    return this.render(withDefinitions(merged, definitions)) ===
      this.render(withDefinitions(tidy, definitions))
      ? merged
      : tidy;
  }

  /**
   * The editor's serializer escapes more than Markdown needs (`snake\_case`,
   * `&lt;`, `[https://x](https://x)`); undo each escape that renders the same.
   */
  private tidy(markdown: string, definitions: string): string {
    const escapes = [...markdown.matchAll(ESCAPES)];
    if (!escapes.length) return markdown;
    const target = this.render(withDefinitions(markdown, definitions));
    const all = markdown.replace(ESCAPES, (whole: string, url?: string) => undoEscape(whole, url));
    if (this.render(withDefinitions(all, definitions)) === target) return all;

    // Undo one escape at a time, right to left so earlier offsets stay valid.
    let result = markdown;
    for (const match of escapes.slice(-40).reverse()) {
      const index = match.index;
      const next =
        result.slice(0, index) +
        undoEscape(match[0], match[1]) +
        result.slice(index + match[0].length);
      if (this.render(withDefinitions(next, definitions)) === target) result = next;
    }
    return result;
  }

  private render(markdown: string): string {
    const html = this.reference.parse(markdown, { async: false });
    return html
      .split(/(<pre[\s\S]*?<\/pre>)/)
      .map((part, index) => (index % 2 ? part : normalizeHtml(part)))
      .join('')
      .trim();
  }
}

/** Whether the edited nodes from `index` on are all of a block's nodes, unchanged and in order. */
function isWholeBlock(pairs: BlockPair[], index: number, part: number, count: number): boolean {
  if (part !== 0) return false;
  for (let offset = 1; offset < count; offset++) {
    const pair = pairs[index + offset];
    if (!pair?.exact || pair.original !== pairs[index].original! + offset) return false;
  }
  return true;
}

/** The text of a block without blank lines before it or white space after it. */
function trimmedRange(text: string, offset: number) {
  const body = text.replace(/^(?:[ \t]*\n)+/, '');
  const raw = body.replace(/\s+$/, '');
  if (!raw) return null;
  const start = offset + text.length - body.length;
  return { raw, start, end: start + raw.length };
}

function wholeFileRange(text: string) {
  const range = trimmedRange(text, 0);
  return range ? [{ ...range, type: 'file' }] : [];
}

function sourceNode(raw: string): JSONContent {
  return { type: 'markdownSource', content: [{ type: 'text', text: raw }] };
}

/** The parser lifts a paragraph's lone image to the top level, where the schema doesn't allow it. */
function wrapInlineNodes(nodes: JSONContent[]): JSONContent[] {
  const result: JSONContent[] = [];
  let paragraph: JSONContent | null = null;
  for (const node of nodes) {
    if (node.type === 'image' || node.type === 'text' || node.type === 'hardBreak') {
      if (!paragraph) {
        paragraph = { type: 'paragraph', content: [] };
        result.push(paragraph);
      }
      paragraph.content!.push(node);
    } else {
      paragraph = null;
      result.push(node);
    }
  }
  return result;
}

/** Drops differences that only change spacing, outside code blocks. */
function normalizeHtml(html: string): string {
  return (
    html
      // Tight and loose lists.
      .replace(/<li>\s*<p>([\s\S]*?)<\/p>/g, '<li>$1')
      .replace(/<\/p>\s*<\/li>/g, '</li>')
      // Indentation after a line break, which the editor writes its own way.
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/>\n+</g, '><')
  );
}

function withDefinitions(markdown: string, definitions: string): string {
  return definitions && markdown.includes('[') ? `${markdown}\n\n${definitions}` : markdown;
}

function countLines(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = text.indexOf('\n', from); index !== -1 && index < to;) {
    count++;
    index = text.indexOf('\n', index + 1);
  }
  return count;
}

function trimBlankLines(markdown: string): string {
  return markdown.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

/** The list markers a block writes where the editor writes `-` and `1.`, keyed by indent. */
function listMarkerStyles(baseLines: string[], rawLines: string[]): Map<string, string> {
  const styles = new Map<string, string>();
  baseLines.forEach((line, index) => {
    const base = LIST_MARKER.exec(line);
    const raw = LIST_MARKER.exec(rawLines[index]);
    if (!base || !raw || base[1] !== raw[1]) return;
    if (isOrderedMarker(base[2]) !== isOrderedMarker(raw[2])) return;
    styles.set(markerKey(base), raw[2].slice(-1));
  });
  return styles;
}

function applyListMarkerStyle(line: string, styles: Map<string, string>): string {
  const marker = LIST_MARKER.exec(line);
  const style = marker && styles.get(markerKey(marker));
  if (!marker || !style) return line;
  const written = marker[2].slice(0, -1) + style;
  return marker[1] + written + line.slice(marker[0].length);
}

function isOrderedMarker(marker: string): boolean {
  return /\d/.test(marker);
}

function markerKey(marker: RegExpExecArray): string {
  return `${marker[1]}${isOrderedMarker(marker[2]) ? '1' : '-'}`;
}

function undoEscape(escape: string, url?: string): string {
  if (url) return url;
  if (escape.startsWith('\\')) return escape.slice(1);
  return escape === '&lt;' ? '<' : escape === '&gt;' ? '>' : '&';
}

/**
 * Maps an offset in the file with LF line endings to the same place in the
 * file as written, which may have CRLF line endings.
 */
function sourceOffsets(source: string): (offset: number) => number {
  // The LF offset of each line break that was CRLF in the file.
  const crlf: number[] = [];
  for (
    let index = source.indexOf('\r\n');
    index !== -1;
    index = source.indexOf('\r\n', index + 2)
  ) {
    crlf.push(index - crlf.length);
  }
  return (offset) => {
    let low = 0;
    let high = crlf.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (crlf[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return offset + low;
  };
}

function toEol(text: string, eol: string): string {
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

function isMostlyCrlf(text: string): boolean {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > 0 && crlf >= lf;
}

interface BlockPair {
  original: number | null;
  exact: boolean;
}

/**
 * Pairs each edited block with the original block it came from: equal blocks
 * by longest common subsequence, then leftovers between two equal blocks by
 * position, as edits of each other.
 */
export function alignBlocks(original: string[], edited: string[]): BlockPair[] {
  const pairs: BlockPair[] = edited.map(() => ({ original: null, exact: false }));
  let prefix = 0;
  while (
    prefix < original.length &&
    prefix < edited.length &&
    original[prefix] === edited[prefix]
  ) {
    pairs[prefix] = { original: prefix, exact: true };
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < edited.length - prefix &&
    original[original.length - 1 - suffix] === edited[edited.length - 1 - suffix]
  ) {
    pairs[edited.length - 1 - suffix] = { original: original.length - 1 - suffix, exact: true };
    suffix++;
  }

  const anchors: [number, number][] = [[prefix - 1, prefix - 1]];
  const a = original.slice(prefix, original.length - suffix);
  const b = edited.slice(prefix, edited.length - suffix);
  if (a.length * b.length <= ALIGN_LIMIT) {
    for (const [i, j] of longestCommonSubsequence(a, b)) {
      pairs[prefix + j] = { original: prefix + i, exact: true };
      anchors.push([prefix + i, prefix + j]);
    }
  }
  anchors.push([original.length - suffix, edited.length - suffix]);

  for (let k = 1; k < anchors.length; k++) {
    const [fromI, fromJ] = anchors[k - 1];
    const [toI, toJ] = anchors[k];
    const count = Math.min(toI - fromI - 1, toJ - fromJ - 1);
    for (let n = 1; n <= count; n++) {
      pairs[fromJ + n] = { original: fromI + n, exact: false };
    }
  }
  return pairs;
}

/**
 * Applies the one change between `base` and `edited` to `raw`, which renders
 * like `base` but is written differently (`__strong__` for `**strong**`).
 */
function mergeLine(base: string, raw: string, edited: string): string | null {
  if (base === raw || base.length * raw.length > ALIGN_LIMIT) return null;
  let start = 0;
  while (start < base.length && start < edited.length && base[start] === edited[start]) start++;
  let end = 0;
  while (
    end < base.length - start &&
    end < edited.length - start &&
    base[base.length - 1 - end] === edited[edited.length - 1 - end]
  ) {
    end++;
  }

  // rawIndex[i] is where base[i] sits in raw, or -1 where they're written differently.
  const rawIndex = Array.from({ length: base.length }, () => -1);
  for (const [i, j] of longestCommonSubsequence(base.split(''), raw.split(''))) {
    rawIndex[i] = j;
  }
  const from = rawBoundary(rawIndex, start, raw.length, 'before');
  const to = rawBoundary(rawIndex, base.length - end, raw.length, 'after');
  if (from === null || to === null || from > to) return null;
  return raw.slice(0, from) + edited.slice(start, edited.length - end) + raw.slice(to);
}

/**
 * Where the gap before base[index] falls in raw: just after the character
 * before it, or just before the character after it, whichever lines up
 * (`side` picks first), since text next to the change may be written differently.
 */
function rawBoundary(
  rawIndex: number[],
  index: number,
  rawLength: number,
  side: 'before' | 'after'
): number | null {
  const afterBefore = index === 0 ? 0 : rawIndex[index - 1] === -1 ? null : rawIndex[index - 1] + 1;
  const beforeAfter =
    index === rawIndex.length ? rawLength : rawIndex[index] === -1 ? null : rawIndex[index];
  return side === 'before' ? (afterBefore ?? beforeAfter) : (beforeAfter ?? afterBefore);
}
