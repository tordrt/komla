import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Whitespace collapsed, since the formatter wraps long selectors.
const globalsCss = readFileSync(
  new URL('../../src/renderer/styles/globals.css', import.meta.url),
  'utf8'
).replace(/\s+/g, ' ');

const EDGE_PAGES =
  '.window-chrome:has(:is(.empty-work-area:not(.overview-surface), .workspace-status-page))';
const SELECTOR = `${EDGE_PAGES} > .sidebar-surface::after`;

/** The declarations of the rule with exactly this selector. */
function declarations(selector: string): string | undefined {
  const start = globalsCss.indexOf(` ${selector} {`);
  if (start === -1) return undefined;
  const body = start + selector.length + 3;
  return globalsCss.slice(body, globalsCss.indexOf('}', body));
}

describe("the line at the sidebar's edge", () => {
  // The empty page shares the sidebar's chrome, so nothing else marks where the sidebar ends. A
  // workspace that restarts or sets up shows its status page there first, so the line stays on
  // until the panes take over. The Overview hides the sidebar.
  it('runs down the sidebar edge on the empty page and the status page, not on the Overview', () => {
    const rule = declarations(SELECTOR);
    expect(rule).toBeDefined();
    expect(rule).toContain('width: 1px;');
  });

  // The sidebar's panels run to 2px from its edge, and the panes sit a gutter past it, so the line
  // stands where a pane's edge would: as far from the panels as the panes are. The footer's short
  // line stays at the sidebar's edge, clear of the status bar's first item.
  it("sits where a pane's edge would, the footer's short line left at the sidebar's edge", () => {
    expect(declarations(SELECTOR)).toContain('right: calc(-1px - var(--pane-gap));');
    // No rule moves it while the status bar shows.
    expect(globalsCss).not.toContain(`} ${EDGE_PAGES} [data-sidebar-footer]::after {`);
  });

  // The title bar's line would run past the edge line into the gutter, as the empty page's would.
  it('drops the title bar line on the status page, as on the empty page', () => {
    expect(
      declarations('.work-column:has(.workspace-status-page) [data-komla-title-bar]')
    ).toContain('border-color: transparent;');
  });

  it("stops at the status bar's line", () => {
    expect(declarations(SELECTOR)).toContain('bottom: var(--status-bar-height, 0px);');
    // Set only while the status bar shows, so without one the line runs to the window's bottom.
    expect(declarations(':root:has([data-status-bar])')).toContain(
      '--status-bar-height: var(--status-bar-row-height);'
    );
    expect(globalsCss.match(/--status-bar-height:/g)).toHaveLength(1);
  });

  // With the status bar off, the footer's top line ends at the sidebar's edge, so the short line
  // carries it over the gutter to the edge line.
  it("runs to the window's bottom with the status bar off, the footer's line carried over to it", () => {
    const stub = declarations(
      `:root:not(:has([data-status-bar])) ${EDGE_PAGES} [data-sidebar-footer]::after`
    );
    expect(stub).toContain('top: 0;');
    expect(stub).toContain('right: calc(-1px - var(--pane-gap));');
    expect(stub).toContain('width: calc(var(--pane-gap) + 1px);');
    expect(stub).toContain('height: 1px;');
    expect(stub).toContain('transform: none;');
  });
});
