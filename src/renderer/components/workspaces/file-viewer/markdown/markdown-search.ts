import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

export interface SearchMatch {
  from: number;
  to: number;
}

export interface MarkdownSearchState {
  query: string;
  caseSensitive: boolean;
  /** Whether the find bar is open, so the matches show. The query outlives it. */
  active: boolean;
  matches: SearchMatch[];
  /** Index of the current match, or -1 when there is none. */
  current: number;
  decorations: DecorationSet;
}

type SearchMeta =
  | { type: 'search'; query: string; caseSensitive: boolean }
  | { type: 'close' }
  | { type: 'select'; index: number }
  /** After a replace, the next match is the first one past the replacement. */
  | { type: 'resume'; at: number };

export const markdownSearchKey = new PluginKey<MarkdownSearchState>('markdownSearch');

/** Stands in for an image or other inline node, so a match never spans one. */
export const INLINE_NODE = '￼';

/** Highlights find-bar matches with decorations, so searching never changes the file. */
export const MarkdownSearch = Extension.create({
  name: 'markdownSearch',
  addProseMirrorPlugins() {
    return [
      new Plugin<MarkdownSearchState>({
        key: markdownSearchKey,
        state: {
          init: () => ({
            query: '',
            caseSensitive: false,
            active: false,
            matches: [],
            current: -1,
            decorations: DecorationSet.empty,
          }),
          apply: applySearch,
        },
        props: {
          decorations: (state) => markdownSearchKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});

function applySearch(transaction: Transaction, state: MarkdownSearchState): MarkdownSearchState {
  const meta = transaction.getMeta(markdownSearchKey) as SearchMeta | undefined;
  switch (meta?.type) {
    case 'search':
      return withMatches(
        transaction.doc,
        { ...state, query: meta.query, caseSensitive: meta.caseSensitive, active: true },
        transaction.selection.from
      );
    case 'close':
      return {
        ...state,
        active: false,
        matches: [],
        current: -1,
        decorations: DecorationSet.empty,
      };
    case 'select':
      return moveCurrent(transaction.doc, state, meta.index);
    case 'resume':
      return updateMatches(transaction, state, meta.at);
  }
  if (!transaction.docChanged || !state.active) return state;
  const current = state.matches[state.current];
  const at = current ? transaction.mapping.map(current.from, -1) : transaction.selection.from;
  return updateMatches(transaction, state, at);
}

/** Past this many steps or changed blocks, finding every match again is quicker. */
const MAX_INCREMENTAL_CHANGES = 20;

/**
 * After an edit, searches again only the textblocks it touched and maps the other matches,
 * since a large file can have tens of thousands of them.
 */
function updateMatches(
  transaction: Transaction,
  state: MarkdownSearchState,
  at: number
): MarkdownSearchState {
  const { doc, mapping } = transaction;
  const blocks = changedTextblocks(transaction);
  if (!blocks || !state.query) return withMatches(doc, state, at);
  const inChangedBlock = (position: number) =>
    blocks.some((block) => position >= block.from && position <= block.to);

  const matches: SearchMatch[] = [];
  for (const match of state.matches) {
    const start = mapping.mapResult(match.from, 1);
    const end = mapping.mapResult(match.to, -1);
    if (start.deleted || end.deleted || end.pos - start.pos !== match.to - match.from) continue;
    if (!inChangedBlock(start.pos)) matches.push({ from: start.pos, to: end.pos });
  }
  const pattern = searchPattern(state.query, state.caseSensitive);
  const found = blocks.flatMap((block) => blockMatches(block.node, block.from, pattern));
  matches.push(...found);
  matches.sort((a, b) => a.from - b.from);

  let decorations = state.decorations.map(mapping, doc);
  for (const block of blocks)
    decorations = decorations.remove(decorations.find(block.from, block.to));
  decorations = decorations.add(
    doc,
    found.map((match) => decorateMatch(match, false))
  );
  const next = matches.findIndex((match) => match.from >= at);
  const current = matches.length === 0 ? -1 : Math.max(next, 0);
  // The current match may have changed: mark it alone as current.
  decorations = decorations.remove(decorations.find(undefined, undefined, (spec) => spec.current));
  const currentMatch = matches[current];
  if (currentMatch) {
    const plain = decorations.find(currentMatch.from, currentMatch.to);
    decorations = decorations
      .remove(plain.filter(({ from, to }) => from === currentMatch.from && to === currentMatch.to))
      .add(doc, [decorateMatch(currentMatch, true)]);
  }
  return { ...state, matches, current, decorations };
}

interface ChangedTextblock {
  node: ProseMirrorNode;
  from: number;
  to: number;
}

/** The textblocks an edit touched, or null when it touched too many to search them one by one. */
function changedTextblocks(transaction: Transaction): ChangedTextblock[] | null {
  const { doc, mapping } = transaction;
  if (mapping.maps.length > MAX_INCREMENTAL_CHANGES) return null;
  const blocks = new Map<number, ChangedTextblock>();
  mapping.maps.forEach((map, index) => {
    const rest = mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      // One position either side, so a change at a block's edge still finds the block.
      const from = Math.max(0, rest.map(newStart, -1) - 1);
      const to = Math.min(doc.content.size, rest.map(newEnd, 1) + 1);
      doc.nodesBetween(from, to, (node, position) => {
        if (!node.isTextblock) return true;
        blocks.set(position, { node, from: position, to: position + node.nodeSize });
        return false;
      });
    });
  });
  return blocks.size > MAX_INCREMENTAL_CHANGES ? null : [...blocks.values()];
}

/** Finds the matches again, with the first one at or after `at` as the current one. */
function withMatches(
  doc: ProseMirrorNode,
  state: MarkdownSearchState,
  at: number
): MarkdownSearchState {
  const matches = findMatches(doc, state.query, state.caseSensitive);
  const next = matches.findIndex((match) => match.from >= at);
  return withCurrent(doc, { ...state, matches }, matches.length === 0 ? -1 : Math.max(next, 0));
}

function withCurrent(
  doc: ProseMirrorNode,
  state: MarkdownSearchState,
  current: number
): MarkdownSearchState {
  const decorations = state.matches.map((match, index) => decorateMatch(match, index === current));
  return { ...state, current, decorations: DecorationSet.create(doc, decorations) };
}

/** Swaps only the two decorations that change, since a file can have thousands of matches. */
function moveCurrent(
  doc: ProseMirrorNode,
  state: MarkdownSearchState,
  current: number
): MarkdownSearchState {
  let { decorations } = state;
  for (const [index, isCurrent] of [
    [state.current, false],
    [current, true],
  ] as const) {
    const match = state.matches[index];
    if (!match) continue;
    const stale = decorations.find(match.from, match.to, (spec) => spec.current !== isCurrent);
    decorations = decorations
      .remove(stale.filter(({ from, to }) => from === match.from && to === match.to))
      .add(doc, [decorateMatch(match, isCurrent)]);
  }
  return { ...state, current, decorations };
}

function decorateMatch({ from, to }: SearchMatch, current: boolean): Decoration {
  const attributes = { class: current ? 'markdown-search-match current' : 'markdown-search-match' };
  return Decoration.inline(from, to, attributes, { current });
}

export function findMatches(
  doc: ProseMirrorNode,
  query: string,
  caseSensitive: boolean
): SearchMatch[] {
  if (!query) return [];
  const pattern = searchPattern(query, caseSensitive);
  const matches: SearchMatch[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return true;
    matches.push(...blockMatches(node, position, pattern));
    return false;
  });
  return matches;
}

function searchPattern(query: string, caseSensitive: boolean): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
}

function blockMatches(block: ProseMirrorNode, position: number, pattern: RegExp): SearchMatch[] {
  // One character per position inside the block, so an index is an offset from its start.
  let text = '';
  block.forEach((child) => {
    text += child.isText ? (child.text ?? '') : INLINE_NODE.repeat(child.nodeSize);
  });
  // A line break in a paragraph reads as a space, so a search for the space finds it.
  if (!block.type.spec.code) text = text.replace(/\n/g, ' ');
  return [...text.matchAll(pattern)].map((match) => {
    const from = position + 1 + match.index;
    return { from, to: from + match[0].length };
  });
}

export function getMarkdownSearch(editor: Editor): MarkdownSearchState | undefined {
  return markdownSearchKey.getState(editor.state);
}

/** Searches for `query` and selects the first match from the cursor on. */
export function searchMarkdown(editor: Editor, query: string, caseSensitive: boolean): void {
  const meta: SearchMeta = { type: 'search', query, caseSensitive };
  editor.view.dispatch(editor.state.tr.setMeta(markdownSearchKey, meta));
  selectCurrentMatch(editor);
}

/** Moves to the next match, or the previous one, wrapping around the file. */
export function stepMarkdownSearch(editor: Editor, direction: 1 | -1): void {
  const search = getMarkdownSearch(editor);
  if (!search || search.matches.length === 0) return;
  const count = search.matches.length;
  const meta: SearchMeta = { type: 'select', index: (search.current + direction + count) % count };
  editor.view.dispatch(editor.state.tr.setMeta(markdownSearchKey, meta));
  selectCurrentMatch(editor);
}

export function closeMarkdownSearch(editor: Editor): void {
  const meta: SearchMeta = { type: 'close' };
  editor.view.dispatch(editor.state.tr.setMeta(markdownSearchKey, meta));
}

/** Replaces the current match and moves on to the next one. */
export function replaceMarkdownMatch(editor: Editor, replacement: string): void {
  const search = getMarkdownSearch(editor);
  const match = search?.matches[search.current];
  if (!match || !editor.isEditable) return;
  const transaction = replaceRange(editor.state.tr, match, replacement);
  const meta: SearchMeta = { type: 'resume', at: match.from + replacement.length };
  editor.view.dispatch(transaction.setMeta(markdownSearchKey, meta));
  selectCurrentMatch(editor);
}

/** Replaces every match in one step, so one undo brings them all back. */
export function replaceAllMarkdownMatches(editor: Editor, replacement: string): void {
  const search = getMarkdownSearch(editor);
  if (!search || search.matches.length === 0 || !editor.isEditable) return;
  const transaction = editor.state.tr;
  for (const match of [...search.matches].reverse()) replaceRange(transaction, match, replacement);
  editor.view.dispatch(transaction);
}

function replaceRange(transaction: Transaction, match: SearchMatch, text: string): Transaction {
  // insertText('') would delete a whole paragraph the match fills.
  return text
    ? transaction.insertText(text, match.from, match.to)
    : transaction.delete(match.from, match.to);
}

function selectCurrentMatch(editor: Editor): void {
  const search = getMarkdownSearch(editor);
  const match = search?.matches[search.current];
  if (!match) return;
  const { tr } = editor.state;
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, match.from, match.to)));
}
