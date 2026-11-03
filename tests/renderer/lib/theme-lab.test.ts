import {
  LAB_ACTIVE_TABS,
  LAB_ALL_LINES,
  LAB_BOTTOM_BARS,
  LAB_BOTTOM_ROW_DIVIDERS,
  LAB_FILE_PANEL_TOPS,
  LAB_FILE_PANELS,
  LAB_FILE_TREE_DIVIDERS,
  LAB_NEW_WORKSPACE_BUTTONS,
  LAB_PANE_BORDERS,
  LAB_FOCUSED_PANES,
  LAB_PANE_CORNERS,
  LAB_PANE_GAPS,
  LAB_QUICK_COMMANDS,
  LAB_SELECTED_WORKSPACES,
  LAB_SIDEBAR_PANELS,
  LAB_STATUS_BARS,
  LAB_TAB_CORNERS,
  LAB_TOP_ROW_DIVIDERS,
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
  it("adds nothing for today's option or an unknown one", () => {
    expect(optionCss(LAB_FILE_PANELS, TODAY_OPTION_ID)).toBe('');
    expect(optionCss(LAB_FILE_PANELS, 'gone')).toBe('');
  });
});

describe('file panel options', () => {
  it("takes away today's line, corners and gutter for the panel on the chrome", () => {
    const chrome = optionCss(LAB_FILE_PANELS, 'chrome');
    expect(chrome).toContain('.file-panel-body {\n  border-width: 0 !important;');
    expect(chrome).toContain('padding-bottom: 0 !important;');
    expect(chrome).toContain('box-shadow: inset 0 -1px 0 oklch(var(--foreground) / 0.08);');
  });

  it('can make the panel a card like a pane, filled or not', () => {
    expect(optionCss(LAB_FILE_PANELS, 'card')).toContain(
      'border-radius: var(--pane-radius) !important;'
    );
    expect(optionCss(LAB_FILE_PANELS, 'card')).not.toContain('sidebar-muted');
    expect(optionCss(LAB_FILE_PANELS, 'card-fill')).toContain(
      'background-color: oklch(var(--sidebar-muted)) !important;'
    );
  });
});

describe('pane and tab options', () => {
  it("gives each picker one option for today's look, which adds nothing", () => {
    for (const options of [
      LAB_PANE_CORNERS,
      LAB_PANE_GAPS,
      LAB_TAB_CORNERS,
      LAB_PANE_BORDERS,
      LAB_FOCUSED_PANES,
      LAB_ACTIVE_TABS,
      LAB_SIDEBAR_PANELS,
      LAB_NEW_WORKSPACE_BUTTONS,
      LAB_SELECTED_WORKSPACES,
      LAB_QUICK_COMMANDS,
      LAB_ALL_LINES,
      LAB_FILE_PANELS,
      LAB_FILE_PANEL_TOPS,
      LAB_FILE_TREE_DIVIDERS,
      LAB_TOP_ROW_DIVIDERS,
      LAB_BOTTOM_BARS,
      LAB_BOTTOM_ROW_DIVIDERS,
    ]) {
      expect(options.filter((option) => option.id === TODAY_OPTION_ID)).toHaveLength(1);
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

  it("tries the focused pane's outline with more accent, wider, or with a glow", () => {
    expect(optionCss(LAB_FOCUSED_PANES, 'soft')).toContain('var(--brand))) 45%');
    expect(optionCss(LAB_FOCUSED_PANES, 'accent')).toContain(
      'border-color: oklch(var(--komla, var(--brand))) !important;'
    );
    expect(optionCss(LAB_FOCUSED_PANES, 'accent')).not.toContain('border-width');
    expect(optionCss(LAB_FOCUSED_PANES, 'accent-wide')).toContain('border-width: 2px !important;');
    expect(optionCss(LAB_FOCUSED_PANES, 'glow')).toContain('box-shadow: inset 0 0 14px');
  });
});

describe('line options', () => {
  it("offers each strength, today's as today's option", () => {
    expect(LAB_PANE_BORDERS.map((option) => [option.id, option.name])).toEqual([
      ['none', 'None'],
      ['hairline', 'Hairline'],
      ['soft', 'Soft'],
      [TODAY_OPTION_ID, 'Clear'],
    ]);
    expect(LAB_SELECTED_WORKSPACES.map((option) => option.id)).toEqual([
      'none',
      TODAY_OPTION_ID,
      'soft',
      'clear',
    ]);
  });

  it('changes only the line around panes without focus or a notification', () => {
    expect(optionCss(LAB_PANE_BORDERS, 'soft')).toBe(
      ".pane-outline:not([data-focused='true']):not([data-attention='true']) {\n  border-color: oklch(var(--foreground) / 0.1) !important;\n}\n"
    );
    expect(optionCss(LAB_PANE_BORDERS, 'none')).toContain('border-color: transparent');
  });

  it('recolors the outline drawn around the active tab, quick commands and the sidebar', () => {
    for (const [options, selector] of [
      [
        LAB_ACTIVE_TABS,
        '[data-testid="terminal-tab-row"] [data-tab-id] > [role="button"][data-active]',
      ],
      [LAB_QUICK_COMMANDS, '.quick-commands-control'],
      [LAB_SIDEBAR_PANELS, '.dark .sidebar-panel'],
      [LAB_NEW_WORKSPACE_BUTTONS, '.dark [data-new-workspace-controls]'],
    ] as const) {
      expect(optionCss(options, 'hairline')).toBe(
        `${selector} {\n  outline-color: oklch(var(--foreground) / 0.06) !important;\n}\n`
      );
    }
    expect(optionCss(LAB_SELECTED_WORKSPACES, 'clear')).toBe(
      '.dark .sidebar-selected-card {\n  --tw-ring-color: oklch(var(--foreground) / 0.14) !important;\n}\n'
    );
  });

  it('can set every line to one strength', () => {
    const soft = optionCss(LAB_ALL_LINES, 'soft');
    for (const options of [
      LAB_PANE_BORDERS,
      LAB_ACTIVE_TABS,
      LAB_QUICK_COMMANDS,
      LAB_SIDEBAR_PANELS,
      LAB_NEW_WORKSPACE_BUTTONS,
      LAB_SELECTED_WORKSPACES,
    ]) {
      expect(soft).toContain(optionCss(options, 'soft'));
    }
  });
});

describe('file panel top and divider options', () => {
  it("can run the panel's line on up past its header, as before", () => {
    const open = optionCss(LAB_FILE_PANEL_TOPS, 'open');
    expect(open).toContain('border-top-width: 0 !important;');
    expect(open).toContain(
      '[data-testid="file-panel-header"] {\n  border-left: 1px solid oklch(var(--foreground) / 0.14);\n}\n'
    );
  });

  it("changes the line under the file tree's header inside the panel", () => {
    expect(optionCss(LAB_FILE_TREE_DIVIDERS, 'hairline')).toBe(
      '.file-panel-body .file-tree-header {\n  border-bottom-color: oklch(var(--foreground) / 0.06) !important;\n}\n'
    );
    expect(optionCss(LAB_FILE_TREE_DIVIDERS, 'border')).toContain('oklch(var(--border))');
  });

  it('can change or take away the short line between the tabs and the file panel header', () => {
    expect(optionCss(LAB_TOP_ROW_DIVIDERS, 'short-clear')).toBe(
      '[data-testid="file-panel-header"]::before {\n  height: 16px !important;\n  background-color: oklch(var(--foreground) / 0.14) !important;\n}\n'
    );
    expect(optionCss(LAB_TOP_ROW_DIVIDERS, 'none')).toContain('content: none !important;');
  });
});

describe('bottom row options', () => {
  it('changes the line along the top of the whole bottom row', () => {
    expect(optionCss(LAB_BOTTOM_BARS, 'soft')).toBe(
      '[data-sidebar-footer], [data-status-bar] {\n  box-shadow: inset 0 1px 0 oklch(var(--foreground) / 0.1) !important;\n}\n'
    );
  });

  it("can keep the line above the sidebar's footer only", () => {
    expect(optionCss(LAB_BOTTOM_BARS, 'footer')).toBe(
      '[data-status-bar] {\n  box-shadow: inset 0 1px 0 transparent !important;\n}\n'
    );
  });

  it("can take away the line between the sidebar's footer and the status bar", () => {
    expect(optionCss(LAB_BOTTOM_ROW_DIVIDERS, 'none')).toBe(
      '[data-sidebar-footer]::after {\n  content: none !important;\n}\n'
    );
  });
});
