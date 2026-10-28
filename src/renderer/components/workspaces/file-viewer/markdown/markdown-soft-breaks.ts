import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * A line break inside a paragraph (a file wrapped at some width) reads as a
 * space in rendered Markdown. The editor keeps the break in the text, so saving
 * leaves the wrapping alone, but shows it as a space: the `markdown-soft-break`
 * class makes its white space collapsible.
 */
export const MarkdownSoftBreaks = Extension.create({
  name: 'markdownSoftBreaks',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        state: {
          init: (_, { doc }) => decorateSoftBreaks(doc),
          apply: (transaction, decorations) =>
            transaction.docChanged ? decorateSoftBreaks(transaction.doc) : decorations,
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

function decorateSoftBreaks(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, position) => {
    if (node.type.spec.code) return false;
    if (!node.isText) return true;
    const text = node.text ?? '';
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
      decorations.push(
        Decoration.inline(position + index, position + index + 1, { class: 'markdown-soft-break' })
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}
