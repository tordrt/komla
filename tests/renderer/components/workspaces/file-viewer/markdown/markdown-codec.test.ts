import { describe, expect, it } from 'vitest';

import {
  alignBlocks,
  MarkdownCodec,
} from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/markdown-codec';

import type { JSONContent } from '@tiptap/core';

const codec = new MarkdownCodec();

function load(source: string) {
  const loaded = codec.load(source);
  if (!loaded) throw new Error('load failed');
  return loaded;
}

/** Loads, lets `edit` change the document JSON, and serializes the result. */
function roundTrip(source: string, edit: (blocks: JSONContent[]) => void = () => {}): string {
  const { snapshot, doc } = load(source);
  const content = structuredClone(doc.content!);
  edit(content);
  return codec.serialize(snapshot, codec.schema.nodeFromJSON({ type: 'doc', content }));
}

function paragraph(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function setText(block: JSONContent, text: string) {
  block.content = [{ type: 'text', text }];
}

const AGENT_PLAN = `---
title: Plan
tags: [a, b]
---

Plan Title
==========

Some __strong__ and *emphasis* text
wrapped onto a second line.

* first item
* second item
  * nested item

<!-- keep this comment -->

1) one
2) two

- [ ] todo
- [x] done

| Name | Value |
|:-----|------:|
| a    |     1 |

Footnote here[^1] and a [reference][docs].

[docs]: https://example.com/docs
[^1]: The note.
`;

describe('MarkdownCodec', () => {
  it('returns the file unchanged when nothing was edited', () => {
    expect(roundTrip(AGENT_PLAN)).toBe(AGENT_PLAN);
    const crlf = AGENT_PLAN.replace(/\n/g, '\r\n');
    expect(roundTrip(crlf)).toBe(crlf);
    expect(roundTrip('no trailing newline')).toBe('no trailing newline');
    expect(roundTrip('\n\n# leading blank lines\n\n\n')).toBe('\n\n# leading blank lines\n\n\n');
  });

  it('keeps blocks it cannot render faithfully as Markdown source', () => {
    const { doc } = load(AGENT_PLAN);
    const sources = doc
      .content!.filter((node) => node.type === 'markdownSource')
      .map((node) => node.content![0].text);
    expect(sources).toEqual([
      '---\ntitle: Plan\ntags: [a, b]\n---',
      '<!-- keep this comment -->',
      'Footnote here[^1] and a [reference][docs].',
      '[docs]: https://example.com/docs',
      '[^1]: The note.',
    ]);
    expect(doc.content!.map((node) => node.type)).toEqual([
      'markdownSource',
      'heading',
      'paragraph',
      'bulletList',
      'markdownSource',
      'orderedList',
      'taskList',
      'table',
      'markdownSource',
      'markdownSource',
      'markdownSource',
    ]);
  });

  it('rewrites only the edited block', () => {
    const result = roundTrip(AGENT_PLAN, (blocks) => {
      setText(blocks[2], 'A plain paragraph now.');
    });
    expect(result).toBe(
      AGENT_PLAN.replace(
        'Some __strong__ and *emphasis* text\nwrapped onto a second line.',
        'A plain paragraph now.'
      )
    );
  });

  it('keeps the original separators around inserted and deleted blocks', () => {
    const source = '# Title\nIntro line.\n\n\nOutro.\n';
    expect(roundTrip(source, (blocks) => blocks.splice(2, 0, paragraph('Middle.')))).toBe(
      '# Title\nIntro line.\n\nMiddle.\n\nOutro.\n'
    );
    expect(roundTrip(source, (blocks) => blocks.splice(1, 1))).toBe('# Title\n\nOutro.\n');
  });

  it('keeps unchanged lines and list markers of an edited block as written', () => {
    const source = '* alpha\n* beta\n* gamma\n\n1) one\n2) two\n';
    const result = roundTrip(source, (blocks) => {
      setText(blocks[0].content![1].content![0], 'beta two');
      blocks[1].content!.push({ type: 'listItem', content: [paragraph('three')] });
    });
    expect(result).toBe('* alpha\n* beta two\n* gamma\n\n1) one\n2) two\n3) three\n');
  });

  it('keeps how the rest of an edited line is written', () => {
    const source = 'Some __strong__ and _soft_ text\nsecond line\n';
    const typed = roundTrip(source, (blocks) => {
      const text = blocks[0].content!;
      // The soft line break stays inside the last text node.
      text[text.length - 1] = { type: 'text', text: ' text more\nsecond line' };
    });
    expect(typed).toBe('Some __strong__ and _soft_ text more\nsecond line\n');
    const before = roundTrip(source, (blocks) => {
      blocks[0].content!.splice(0, 1, { type: 'text', text: 'Now ' });
    });
    expect(before).toBe('Now __strong__ and _soft_ text\nsecond line\n');

    // Offsets count UTF-16 units, which an emoji before the change shifts.
    const emoji = roundTrip('🚀 __a__ b\n', (blocks) => {
      blocks[0].content![0] = { type: 'text', text: '🚀 X ' };
    });
    expect(emoji).toBe('🚀 X __a__ b\n');
  });

  it("doesn't escape text that reads the same without escapes", () => {
    const result = roundTrip('', (blocks) => {
      blocks.splice(
        0,
        blocks.length,
        paragraph('Use snake_case when a < b & c, see https://x.dev')
      );
    });
    expect(result).toBe('Use snake_case when a < b & c, see https://x.dev\n');

    const emphasis = roundTrip('', (blocks) => {
      blocks.splice(0, blocks.length, paragraph('Literal *stars* stay escaped'));
    });
    // A lone `*` can't open emphasis, so only the first one needs its escape.
    expect(emphasis).toBe('Literal \\*stars* stay escaped\n');
  });

  it('keeps CRLF line endings when a block changes', () => {
    const result = roundTrip('# One\r\n\r\nTwo\r\n', (blocks) => setText(blocks[1], 'Three'));
    expect(result).toBe('# One\r\n\r\nThree\r\n');
  });

  it('writes edited Markdown source blocks verbatim', () => {
    const result = roundTrip('<div>old</div>\n', (blocks) => setText(blocks[0], '<div>new</div>'));
    expect(result).toBe('<div>new</div>\n');
  });

  it('writes an edited front matter block exactly as typed', () => {
    const source =
      '---\ntitle: "a \\"quoted\\" b"\npath: "C:\\\\Users\\\\me"\ndraft: true\n---\n\n# Plan\n';
    const result = roundTrip(source, (blocks) => {
      setText(blocks[0], blocks[0].content![0].text!.replace('draft: true', 'draft: false'));
    });
    expect(result).toBe(source.replace('draft: true', 'draft: false'));
  });

  it('fences a code block with more backticks than any fence inside it', () => {
    const code = 'before\n```\ninside\n```\nafter';
    const result = roundTrip('', (blocks) => {
      blocks.splice(0, blocks.length, {
        type: 'codeBlock',
        attrs: { language: 'md' },
        content: [{ type: 'text', text: code }],
      });
    });
    expect(result).toBe(`\`\`\`\`md\n${code}\n\`\`\`\`\n`);
    expect(load(result).doc.content).toEqual([
      { type: 'codeBlock', attrs: { language: 'md' }, content: [{ type: 'text', text: code }] },
    ]);
  });

  describe('keeps typed text from turning into other Markdown', () => {
    function write(content: JSONContent[]): string {
      return roundTrip('', (blocks) => blocks.splice(0, blocks.length, ...content));
    }

    it.each([
      '+ 1 vote',
      '- not a list',
      '2024. A year',
      '1) one',
      '# not a heading',
      '---',
      '~~~',
      'foo\n- bar',
      'foo\n---',
      'foo\n===',
      '| a | b |\n|---|---|',
    ])('%j', (text) => {
      const written = write([paragraph(text)]);
      expect(load(written).doc.content).toEqual([paragraph(text)]);
    });

    it('escapes only where needed', () => {
      expect(write([paragraph('+ 1 vote')])).toBe('\\+ 1 vote\n');
      expect(write([paragraph('-5 degrees, 1.5 liters')])).toBe('-5 degrees, 1.5 liters\n');
    });

    it('inside list items too', () => {
      const list = {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph('+ inner')] }],
      };
      expect(load(write([list])).doc.content).toEqual([list]);
    });

    it('drops leading spaces, which would make the paragraph code', () => {
      expect(load(write([paragraph('    not code')])).doc.content).toEqual([paragraph('not code')]);
    });

    it('in link and image paths with spaces', () => {
      const link = {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'doc', marks: [{ type: 'link', attrs: { href: 'my file.md' } }] },
        ],
      };
      const image = {
        type: 'paragraph',
        content: [{ type: 'image', attrs: { src: 'my image.png', alt: 'x' } }],
      };
      const written = write([link, image]);
      expect(written).toBe('[doc](<my file.md>)\n\n![x](<my image.png>)\n');
      const [linkBack, imageBack] = load(written).doc.content!;
      expect(linkBack.content![0].marks![0].attrs!.href).toBe('my file.md');
      expect(imageBack.content![0].attrs!.src).toBe('my image.png');
    });

    it("by not allowing what Markdown can't store: line breaks in headings, blocks in table cells", () => {
      const heading = codec.schema.nodeFromJSON({
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }],
      });
      expect(() => heading.check()).toThrow();
      const table = codec.schema.nodeFromJSON({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [
                  {
                    type: 'bulletList',
                    content: [{ type: 'listItem', content: [paragraph('x')] }],
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(() => table.check()).toThrow();
    });
  });

  it('keeps the line endings of lines an edit did not touch', () => {
    const result = roundTrip('a\r\n\r\nb\n\nc\r\n', (blocks) => setText(blocks[1], 'B'));
    expect(result).toBe('a\r\n\r\nB\n\nc\r\n');
  });

  it('shows the rest of a file that defines a link reference twice', () => {
    const source = '# Links\n\nSee [one][1].\n\n[1]: https://a\n\nMore text.\n\n[1]: https://b\n';
    const { doc } = load(source);
    expect(doc.content!.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'markdownSource',
      'paragraph',
      'markdownSource',
    ]);
    expect(roundTrip(source)).toBe(source);
    expect(roundTrip(source, (blocks) => setText(blocks[3], 'Changed.'))).toBe(
      source.replace('More text.', 'Changed.')
    );
  });

  it('drops empty paragraphs, which Markdown cannot store', () => {
    expect(
      roundTrip('# Title\n', (blocks) => blocks.push({ type: 'paragraph' }, { type: 'paragraph' }))
    ).toBe('# Title\n');
  });

  it('edits reference-style links as links and keeps their definitions', () => {
    const source = 'See [the docs][d].\n\nMore.\n\n[d]: https://example.com\n';
    const { doc } = load(source);
    expect(doc.content![0].content![1].marks![0]).toMatchObject({
      type: 'link',
      attrs: { href: 'https://example.com' },
    });
    expect(roundTrip(source, (blocks) => setText(blocks[1], 'Changed.'))).toBe(
      'See [the docs][d].\n\nChanged.\n\n[d]: https://example.com\n'
    );
  });

  it('wraps a lone image in a paragraph', () => {
    const { doc } = load('![diagram](./diagram.png)\n');
    expect(doc.content![0]).toMatchObject({
      type: 'paragraph',
      content: [{ type: 'image', attrs: { src: './diagram.png', alt: 'diagram' } }],
    });
    expect(roundTrip('![diagram](./diagram.png)\n')).toBe('![diagram](./diagram.png)\n');
  });

  it('records the line each block starts on', () => {
    const { snapshot } = load('---\na: 1\n---\n\n# Title\nText\n\n\n- a\n- b\n');
    expect(snapshot.nodeLines).toEqual([1, 5, 6, 9]);
  });

  it('copies selected content as Markdown', () => {
    expect(
      codec.serializeFragment([
        { type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }] },
      ])
    ).toBe('**bold**');
  });

  it('parses pasted Markdown into blocks', () => {
    expect(codec.parseFragment('## Heading\r\n\r\n- item').map((node) => node.type)).toEqual([
      'heading',
      'bulletList',
    ]);
  });
});

describe('alignBlocks', () => {
  it('pairs equal blocks and treats leftovers between them as edits', () => {
    expect(alignBlocks(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'x', 'd'])).toEqual([
      { original: 0, exact: true },
      { original: 1, exact: false },
      { original: 2, exact: true },
      { original: null, exact: false },
      { original: 3, exact: true },
    ]);
    expect(alignBlocks(['a', 'a'], ['a'])).toEqual([{ original: 0, exact: true }]);
  });
});
