import { describe, expect, it } from 'vitest';

import {
  LAB_STATUS_BARS,
  TODAY_STATUS_BAR_ID,
  statusBarCss,
} from '../../../src/renderer/lib/theme-lab';

describe('statusBarCss', () => {
  it("adds nothing for today's status bar or an unknown one", () => {
    expect(statusBarCss(TODAY_STATUS_BAR_ID)).toBe('');
    expect(statusBarCss('gone')).toBe('');
  });

  it("paints the status bar the card's color while a workspace is open", () => {
    expect(statusBarCss('card')).toBe(
      '.work-column:not(:has(.empty-work-area)) [data-status-bar] {\n  background-color: oklch(var(--card)) !important;\n}\n'
    );
  });

  it('gives every option but today a background', () => {
    for (const bar of LAB_STATUS_BARS) {
      expect(bar.background === '').toBe(bar.id === TODAY_STATUS_BAR_ID);
    }
  });
});
