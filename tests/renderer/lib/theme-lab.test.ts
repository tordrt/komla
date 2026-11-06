import {
  LAB_EMPTY_PAGES,
  LAB_PANE_COLOR_VARIABLE,
  TODAY_OPTION_ID,
  optionCss,
  paneColorCss,
} from '../../../src/renderer/lib/theme-lab';

describe('optionCss', () => {
  it("adds nothing for today's option or an unknown one", () => {
    for (const options of [LAB_EMPTY_PAGES]) {
      expect(optionCss(options, TODAY_OPTION_ID)).toBe('');
      expect(optionCss(options, 'gone')).toBe('');
    }
  });

  it("gives each picker one option for today's look, and a stylesheet for every other", () => {
    for (const options of [LAB_EMPTY_PAGES]) {
      expect(options[0].id).toBe(TODAY_OPTION_ID);
      for (const option of options) {
        expect(option.css === '').toBe(option.id === TODAY_OPTION_ID);
      }
    }
  });
});

describe('empty page options', () => {
  it("puts the empty page in a card like a pane, in the terminal's color", () => {
    const card = optionCss(LAB_EMPTY_PAGES, 'card');
    expect(card).toContain('padding: 0 var(--pane-gap) var(--pane-gap) var(--pane-gap);');
    expect(card).toContain(`background-color: var(${LAB_PANE_COLOR_VARIABLE}) !important;`);
    expect(card).toContain('border-radius: var(--pane-radius);');
    expect(paneColorCss('#13171b')).toBe(`:root {\n  ${LAB_PANE_COLOR_VARIABLE}: #13171b;\n}\n`);
  });

  it('holds a starting workspace in the same card, so it leads into the panes', () => {
    const card = optionCss(LAB_EMPTY_PAGES, 'card');
    expect(card).toContain(
      '.work-column:has(:is(.empty-work-area:not(.overview-surface), .workspace-status-page)) main {'
    );
    expect(card).toContain(
      ':is(.empty-work-area:not(.overview-surface), .workspace-status-page) {\n  background-color:'
    );
    expect(card).toContain('[data-komla-title-bar] {\n  border-color: transparent !important;');
  });

  it('leaves the Overview, which hides the sidebar, alone', () => {
    for (const id of ['none', 'card']) {
      expect(optionCss(LAB_EMPTY_PAGES, id)).toContain('.empty-work-area:not(.overview-surface)');
    }
  });

  it("can take away today's line at the sidebar's edge, which the card does too", () => {
    for (const id of ['none', 'card']) {
      expect(optionCss(LAB_EMPTY_PAGES, id)).toContain(
        '> .sidebar-surface::after {\n  content: none !important;\n}'
      );
    }
  });

  it('can tint the sidebar a step off the chrome', () => {
    expect(optionCss(LAB_EMPTY_PAGES, 'tint')).toContain('background: oklch(var(--sidebar));');
  });
});
