import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { getMonacoThemeName, getShikiHighlighter, loadShikiLanguage } from '@/lib/monaco-loader';

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { BundledLanguage, BundledTheme, Highlighter, ThemedToken } from 'shiki';

/** Dispatch a transaction with this key as meta to recolor after the highlighter or theme changes. */
export const codeHighlightKey = new PluginKey<DecorationSet>('markdownCodeHighlight');

const MAX_CACHED_BLOCKS = 200;
const tokenCache = new Map<string, { grammar: unknown; tokens: ThemedToken[][] }>();

/** Colors fenced code blocks with the same Shiki grammars and theme as the Source view. */
export const MarkdownCodeHighlight = Extension.create({
  name: 'markdownCodeHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: codeHighlightKey,
        state: {
          init: (_, { doc }) => decorateCodeBlocks(doc),
          apply: (transaction, decorations) =>
            transaction.docChanged || transaction.getMeta(codeHighlightKey)
              ? decorateCodeBlocks(transaction.doc)
              : decorations,
        },
        props: {
          decorations: (state) => codeHighlightKey.getState(state),
        },
      }),
    ];
  },
});

function decorateCodeBlocks(doc: ProseMirrorNode): DecorationSet {
  const highlighter = getShikiHighlighter();
  if (!highlighter) return DecorationSet.empty;
  const theme = getMonacoThemeName();
  const foreground = highlighter.getTheme(theme).fg.toLowerCase();
  const decorations: Decoration[] = [];
  doc.descendants((node, position) => {
    if (node.type.name !== 'codeBlock') return true;
    const language = loadedLanguage(highlighter, node.attrs.language);
    if (!language) return false;
    for (const line of tokenize(highlighter, node.textContent, language, theme)) {
      for (const token of line) {
        if (!token.color || token.color.toLowerCase() === foreground) continue;
        // Offsets count from the start of the code, which sits one past the node's position.
        const from = position + 1 + token.offset;
        decorations.push(
          Decoration.inline(from, from + token.content.length, { style: `color: ${token.color}` })
        );
      }
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function loadedLanguage(highlighter: Highlighter, language: unknown): string | null {
  if (typeof language !== 'string' || !language) return null;
  const name = language.toLowerCase();
  if (highlighter.getLoadedLanguages().includes(name)) return name;
  // Grammars load on first use; the editor recolors when this one arrives.
  void loadShikiLanguage(name);
  return null;
}

function tokenize(
  highlighter: Highlighter,
  code: string,
  language: string,
  theme: string
): ThemedToken[][] {
  const key = `${theme}\0${language}\0${code}`;
  // Shiki rebuilds a grammar that embeds others when one of them loads, which colors more.
  const grammar = highlighter.getLanguage(language);
  let cached = tokenCache.get(key);
  if (cached) {
    // Re-insert so the most recently used blocks stay cached.
    tokenCache.delete(key);
  }
  if (cached?.grammar !== grammar) {
    let tokens: ThemedToken[][];
    try {
      // Both were checked against what's loaded: a grammar or alias, and Komla's own theme names.
      tokens = highlighter.codeToTokensBase(code, {
        lang: language as BundledLanguage,
        theme: theme as BundledTheme,
      });
    } catch {
      tokens = [];
    }
    cached = { grammar, tokens };
    if (tokenCache.size >= MAX_CACHED_BLOCKS) {
      tokenCache.delete(tokenCache.keys().next().value!);
    }
  }
  tokenCache.set(key, cached);
  return cached.tokens;
}
