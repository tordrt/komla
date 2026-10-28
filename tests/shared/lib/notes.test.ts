import { describe, expect, it } from 'vitest';

import { getNoteTitle } from '../../../src/shared/lib/notes';

describe('getNoteTitle', () => {
  it.each([
    ['# Fix the login bug\n\nSteps…', 'Fix the login bug'],
    ['\n\n  Plain first line  \nsecond', 'Plain first line'],
    ['- [ ] **Refactor** the `codec`', 'Refactor the codec'],
    ['> Read [the spec](https://example.com) first', 'Read the spec first'],
    ['1. *Step one* ~~maybe~~', 'Step one maybe'],
    ['fix_login_bug notes', 'fix_login_bug notes'],
    ['---\ntitle: Plan\n---\n\n## After front matter', 'After front matter'],
    ['```ts\nconst x = 1;\n```', 'const x = 1;'],
    ['Title\n=====\n', 'Title'],
  ])('titles %j as %j', (content, title) => {
    expect(getNoteTitle(content)).toBe(title);
  });

  it.each([[''], ['   \n\n\t'], ['#\n---\n'], ['- [ ]\n1.\n> ']])(
    'is empty for a note with no text: %j',
    (content) => {
      expect(getNoteTitle(content)).toBe('');
    }
  );

  it('shortens a long first line', () => {
    const title = getNoteTitle('a'.repeat(200));
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });
});
