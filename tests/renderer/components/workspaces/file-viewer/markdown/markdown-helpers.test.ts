import { describe, expect, it } from 'vitest';

import { resolveMarkdownImagePath } from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/markdown-image-view';
import { filterSlashCommands } from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/markdown-slash-commands';
import { isMarkdownFile } from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/markdown-view-mode';

describe('resolveMarkdownImagePath', () => {
  it.each([
    ['docs/plan.md', './img/a.png', 'docs/img/a.png'],
    ['docs/plan.md', 'img/a.png', 'docs/img/a.png'],
    ['docs/plan.md', '../shots/a%20b.png', 'shots/a b.png'],
    ['docs/plan.md', '/assets/a.png?raw#top', 'assets/a.png'],
    ['plan.md', 'a.png', 'a.png'],
  ])('resolves %s + %s to %s', (markdownPath, src, expected) => {
    expect(resolveMarkdownImagePath(markdownPath, src)).toBe(expected);
  });

  it.each([
    ['https://example.com/a.png'],
    ['//cdn.example.com/a.png'],
    ['C:\\images\\a.png'],
    ['../../outside.png'],
  ])("doesn't read %s", (src) => {
    expect(resolveMarkdownImagePath('docs/plan.md', src)).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  const titles = (query: string) => filterSlashCommands(query).map((command) => command.title);

  it('matches any word of a title or its keywords', () => {
    expect(titles('h2')).toEqual(['Heading 2']);
    expect(titles('list')).toEqual(['Bullet list', 'Numbered list', 'Task list']);
    expect(titles('todo')).toEqual(['Task list']);
    expect(titles('')).toHaveLength(11);
    expect(titles('zzz')).toEqual([]);
  });
});

describe('isMarkdownFile', () => {
  it('recognizes Markdown extensions but not MDX', () => {
    expect(isMarkdownFile('docs/PLAN.md')).toBe(true);
    expect(isMarkdownFile('README.MARKDOWN')).toBe(true);
    expect(isMarkdownFile('page.mdx')).toBe(false);
    expect(isMarkdownFile('md.ts')).toBe(false);
  });
});
