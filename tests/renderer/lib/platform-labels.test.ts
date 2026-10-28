import { describe, expect, it } from 'vitest';

import { getRevealInFileManagerLabel } from '../../../src/renderer/lib/platform-labels';

describe('getRevealInFileManagerLabel', () => {
  it('names Finder on macOS', () => {
    expect(getRevealInFileManagerLabel('darwin')).toBe('Reveal in Finder');
  });

  it('names Explorer on Windows', () => {
    expect(getRevealInFileManagerLabel('win32')).toBe('Show in Explorer');
  });

  it('uses a generic file manager label on Linux', () => {
    expect(getRevealInFileManagerLabel('linux')).toBe('Show in File Manager');
  });
});
