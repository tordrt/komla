import { Node } from '@tiptap/core';
import Blockquote from '@tiptap/extension-blockquote';
import { Code } from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Heading from '@tiptap/extension-heading';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Paragraph from '@tiptap/extension-paragraph';
import { TableCell, TableHeader, TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';

import type { AnyExtension, JSONContent, NodeViewRenderer } from '@tiptap/core';

/**
 * A block the rich editor can't show faithfully (HTML, footnotes, link
 * definitions, ...), kept as editable Markdown source so saving never drops it.
 */
export const MarkdownSource = Node.create({
  name: 'markdownSource',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  parseHTML() {
    return [{ tag: 'pre[data-markdown-source]', preserveWhitespace: 'full' }];
  },
  renderHTML() {
    return [
      'pre',
      { 'data-markdown-source': '', spellcheck: 'false', title: 'Markdown source' },
      ['code', 0],
    ];
  },
  renderMarkdown(node: JSONContent) {
    return (node.content ?? []).map((child) => child.text ?? '').join('');
  },
});

/** Text at the start of a line that Markdown would read as a list, heading, rule or table. */
const BLOCK_START = /^([ \t]*)([-+=#|])/gm;
const ORDERED_LIST_START = /^([ \t]*\d{1,9})([.)])/gm;

/**
 * Escapes what would start a block at the start of a paragraph's lines. The
 * codec drops each escape that turns out to read the same without it.
 */
function escapeBlockStarts(markdown: string): string {
  return markdown
    .replace(/^[ \t]+/, '')
    .replace(BLOCK_START, '$1\\$2')
    .replace(ORDERED_LIST_START, '$1\\$2');
}

/** A link or image path, in angle brackets when it has spaces that would end it. */
function markdownDestination(url: string): string {
  return /\s/.test(url) ? `<${url.replace(/[<>]/g, '\\$&')}>` : url;
}

/** The longest run of backticks that could close a fence, at the start of a line of code. */
function longestFence(code: string): number {
  return Math.max(0, ...[...code.matchAll(/^ {0,3}(`{3,})/gm)].map((match) => match[1].length));
}

const MarkdownParagraph = Paragraph.extend({
  renderMarkdown(node, helpers, context) {
    return escapeBlockStarts(this.parent?.(node, helpers, context) ?? '');
  },
});

/** A Markdown heading is one line, so a line break can't go in one. */
const MarkdownHeading = Heading.extend({
  // Ahead of HardBreak's shortcuts, which would split the heading to fit the break.
  priority: 101,
  content: '(text | image)*',
  addKeyboardShortcuts() {
    const inHeading = () => this.editor.isActive(this.name);
    return { ...this.parent?.(), 'Shift-Enter': inHeading, 'Mod-Enter': inHeading };
  },
});

const MarkdownCodeBlock = CodeBlock.extend({
  renderMarkdown(node, helpers, context) {
    const markdown = this.parent?.(node, helpers, context) ?? '';
    const longest = longestFence((node.content ?? []).map((child) => child.text ?? '').join(''));
    if (longest < 3) return markdown;
    // A fence inside the code would otherwise end the block early.
    const fence = '`'.repeat(longest + 1);
    return fence + markdown.slice(3, -3) + fence;
  },
});

const MarkdownLink = Link.extend({
  renderMarkdown(node, helpers, context) {
    const href = markdownDestination(node.attrs?.href ?? '');
    return this.parent?.({ ...node, attrs: { ...node.attrs, href } }, helpers, context) ?? '';
  },
});

const MarkdownImage = Image.extend({
  renderMarkdown(node, helpers, context) {
    const src = markdownDestination(node.attrs?.src ?? '');
    return this.parent?.({ ...node, attrs: { ...node.attrs, src } }, helpers, context) ?? '';
  },
});

interface MarkdownExtensionOptions {
  /** Editor-only node view for images; it doesn't change the schema. */
  imageNodeView?: NodeViewRenderer;
  extra?: AnyExtension[];
}

/**
 * The schema shared by the rich editor and the Markdown codec. Both must use
 * the same set, or the codec could accept a block the editor then mangles.
 */
export function createMarkdownExtensions({
  imageNodeView,
  extra = [],
}: MarkdownExtensionOptions = {}): AnyExtension[] {
  const image = imageNodeView
    ? MarkdownImage.extend({
        addNodeView: () => imageNodeView,
        // A relative src on a plain <img> loads from Komla's own folder, which fails;
        // the node view reads the file from the workspace instead.
        renderHTML: ({ HTMLAttributes }) => {
          const { src, ...attributes } = HTMLAttributes;
          return ['img', { ...attributes, 'data-src': src }];
        },
        parseHTML: () => [
          { tag: 'img[src]' },
          { tag: 'img[data-src]', getAttrs: (element) => ({ src: element.dataset.src }) },
        ],
      })
    : MarkdownImage;
  return [
    StarterKit.configure({
      // Markdown has no underline syntax.
      underline: false,
      code: false,
      blockquote: false,
      paragraph: false,
      heading: false,
      codeBlock: false,
      link: false,
    }),
    MarkdownParagraph,
    MarkdownHeading,
    MarkdownCodeBlock,
    MarkdownLink.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
    // Its Mod-Shift-B would also toggle the file tree on Windows and Linux.
    Blockquote.extend({ addKeyboardShortcuts: () => ({}) }),
    // Markdown allows code inside bold, italic and link text.
    Code.extend({ excludes: '' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false }, tableCell: false, tableHeader: false }),
    // A Markdown table cell holds one line of text.
    TableCell.extend({ content: 'paragraph' }),
    TableHeader.extend({ content: 'paragraph' }),
    // Markdown images sit inside paragraphs, so a block image would make the parsed document invalid.
    image.configure({ inline: true }),
    MarkdownSource,
    ...extra,
  ];
}
