import { describe, expect, it } from 'vitest';

import { appendDraft } from '../../../src/shared/lib/prompt-draft-text';

describe('appendDraft', () => {
  const draft = { text: 'Then the footer', selectionStart: 4, selectionEnd: 15 };

  it('puts the draft after the text on a line of its own, moving its cursor along', () => {
    expect(appendDraft('Fix the header', draft)).toEqual({
      text: 'Fix the header\n\nThen the footer',
      selectionStart: 20,
      selectionEnd: 31,
    });
  });

  it('takes the draft as it is after blank text', () => {
    expect(appendDraft('', draft)).toBe(draft);
    expect(appendDraft('  \n', draft)).toBe(draft);
  });
});
