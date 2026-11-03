import {
  LAB_PANE_CORNERS,
  LAB_PANE_GAPS,
  LAB_STATUS_BAR_LINES,
  LAB_STATUS_BARS,
  LAB_TAB_CORNERS,
  TODAY_OPTION_ID,
  TODAY_STATUS_BAR_ID,
  optionCss,
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

describe('optionCss', () => {
  it("adds nothing for today's lines or an unknown one", () => {
    expect(optionCss(LAB_STATUS_BAR_LINES, TODAY_OPTION_ID)).toBe('');
    expect(optionCss(LAB_STATUS_BAR_LINES, 'gone')).toBe('');
  });

  it("draws a line along the whole top of the status bar in place of the panel's", () => {
    expect(optionCss(LAB_STATUS_BAR_LINES, 'soft')).toBe(
      '.work-column:not(:has(.empty-work-area)) [data-status-bar] {\n  box-shadow: inset 0 1px 0 oklch(var(--foreground) / 0.06) !important;\n}\n' +
        '.file-panel-chrome {\n  box-shadow: none !important;\n}\n'
    );
    expect(optionCss(LAB_STATUS_BAR_LINES, 'faint')).toContain('/ 0.1)');
  });

  it("can drop the file panel's line", () => {
    expect(optionCss(LAB_STATUS_BAR_LINES, 'none')).toBe(
      '.file-panel-chrome {\n  box-shadow: none !important;\n}\n'
    );
  });
});

describe('pane and tab options', () => {
  it("starts each picker with today's look, which adds nothing", () => {
    for (const options of [LAB_PANE_CORNERS, LAB_PANE_GAPS, LAB_TAB_CORNERS]) {
      expect(options[0].id).toBe(TODAY_OPTION_ID);
      expect(optionCss(options, TODAY_OPTION_ID)).toBe('');
      expect(new Set(options.map((option) => option.id)).size).toBe(options.length);
    }
  });

  it('sets the pane corner and gap through their root variables', () => {
    expect(LAB_PANE_CORNERS.map((option) => option.name)).toEqual([
      '12px',
      '8px',
      '10px',
      '14px',
      '16px',
    ]);
    expect(optionCss(LAB_PANE_CORNERS, '16')).toBe(
      ':root {\n  --pane-radius: 16px !important;\n}\n'
    );
    expect(optionCss(LAB_PANE_GAPS, '4')).toBe(':root {\n  --pane-gap: 4px !important;\n}\n');
  });

  it('rounds the terminal tabs', () => {
    expect(optionCss(LAB_TAB_CORNERS, 'round')).toBe(
      '[data-testid="terminal-tab-row"] [data-tab-id] > [role="button"] {\n  border-radius: 9999px !important;\n}\n'
    );
  });
});
