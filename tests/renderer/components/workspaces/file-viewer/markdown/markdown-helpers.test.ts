import { describe, expect, it } from 'vitest';

import { resolveMarkdownImagePath } from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/markdown-image-view';
import {
  headingSlug,
  resolveMarkdownLink,
} from '../../../../../../src/renderer/components/workspaces/file-viewer/markdown/markdown-links';
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

describe('resolveMarkdownLink', () => {
  it.each([
    ['https://example.com/a', { kind: 'web', url: 'https://example.com/a' }],
    ['mailto:team@example.com', { kind: 'web', url: 'mailto:team@example.com' }],
    ['#next-steps', { kind: 'heading', slug: 'next-steps' }],
    ['#Caf%C3%A9', { kind: 'heading', slug: 'café' }],
    ['../setup.md#install', { kind: 'file', path: 'setup.md' }],
    ['./api/auth.ts', { kind: 'file', path: 'docs/api/auth.ts' }],
    ['/README.md', { kind: 'file', path: 'README.md' }],
  ])('sends %s to %o', (href, expected) => {
    expect(resolveMarkdownLink('docs/plan.md', href)).toEqual(expected);
  });

  it.each([['ftp://example.com/a'], ['file:///etc/hosts'], ['#'], [''], ['../../outside.md']])(
    "can't open %s",
    (href) => {
      expect(resolveMarkdownLink('docs/plan.md', href)).toBeNull();
    }
  );
});

describe('headingSlug', () => {
  it.each([
    ['Next steps', 'next-steps'],
    ["What's new?", 'whats-new'],
    ['  Café — 2.0  ', 'café--20'],
    ['snake_case and kebab-case', 'snake_case-and-kebab-case'],
  ])('makes %s into %s, as GitHub does', (text, slug) => {
    expect(headingSlug(text)).toBe(slug);
  });
});
