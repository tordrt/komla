import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

import type { MarkdownCodec } from './markdown-codec';
import type { Editor } from '@tiptap/core';
import type { Slice } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';

const MARKDOWN_SYNTAX =
  /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~|\|)|\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)/m;

/**
 * Markdown pasted as plain text (an agent's reply, a terminal copy) pastes as
 * formatted blocks, and a copy carries Markdown as its plain text, for pasting
 * into prompts and terminals.
 */
export const MarkdownClipboard = Extension.create<{ codec: MarkdownCodec | null }>({
  name: 'markdownClipboard',
  addOptions() {
    return { codec: null };
  },
  addProseMirrorPlugins() {
    const { editor } = this;
    const { codec } = this.options;
    if (!codec) return [];
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => pasteMarkdown(view, event, editor, codec),
          clipboardTextSerializer: (slice) => copyAsMarkdown(slice, codec),
        },
      }),
    ];
  },
});

function pasteMarkdown(
  view: EditorView,
  event: ClipboardEvent,
  editor: Editor,
  codec: MarkdownCodec
): boolean {
  const data = event.clipboardData;
  if (!data || data.files.length) return false;
  // Monaco (the Source view) copies colored HTML alongside the Markdown text.
  if (data.types.includes('text/html') && !data.types.includes('vscode-editor-data')) return false;
  const text = data.getData('text/plain');
  if (!text || view.state.selection.$from.parent.type.spec.code) return false;
  if (!text.includes('\n') && !MARKDOWN_SYNTAX.test(text)) return false;
  const content = codec.parseFragment(text);
  return content.length > 0 && editor.commands.insertContent(content);
}

function copyAsMarkdown(slice: Slice, codec: MarkdownCodec): string {
  try {
    return codec.serializeFragment(slice.content.toJSON() ?? []);
  } catch {
    return slice.content.textBetween(0, slice.content.size, '\n\n');
  }
}
