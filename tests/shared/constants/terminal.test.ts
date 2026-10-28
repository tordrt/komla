import { describe, it, expect } from 'vitest';

import {
  BUNDLED_TERMINAL_FONT,
  DEFAULT_TERMINAL_FONT_FAMILY,
  buildTerminalFontFamily,
} from '../../../src/shared/constants/terminal';

describe('buildTerminalFontFamily', () => {
  it('returns DEFAULT_TERMINAL_FONT_FAMILY when userFont is empty', () => {
    expect(buildTerminalFontFamily('')).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it('prepends a simple font name without quotes', () => {
    const result = buildTerminalFontFamily('Menlo');
    expect(result).toBe(`Menlo, "${BUNDLED_TERMINAL_FONT}", monospace`);
  });

  it('quotes font names that contain spaces', () => {
    const result = buildTerminalFontFamily('Fira Code');
    expect(result).toBe(`"Fira Code", "${BUNDLED_TERMINAL_FONT}", monospace`);
  });
});
