import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Whitespace collapsed, since the formatter wraps long selectors.
const globalsCss = readFileSync(
  new URL('../../src/renderer/styles/globals.css', import.meta.url),
  'utf8'
).replace(/\s+/g, ' ');

const SELECTOR =
  '.window-chrome:has(:is(.empty-work-area:not(.overview-surface), .workspace-status-page)) > .sidebar-surface::after';

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

  // The sidebar's panels run to 2px from its edge, so a line on its last pixel would crowd their
  // outlines.
  it("sits just past the sidebar, the footer's short line moved over to meet it", () => {
    expect(declarations(SELECTOR)).toContain('right: -1px;');
    expect(
      declarations(
        '.window-chrome:has(:is(.empty-work-area:not(.overview-surface), .workspace-status-page)) [data-sidebar-footer]::after'
      )
    ).toContain('right: -1px;');
  });

  it("stops at the status bar, where the footer's short line carries it on", () => {
    expect(declarations(SELECTOR)).toContain('bottom: var(--status-bar-height, 0px);');
    // Set only while the status bar shows, so without one the line runs to the window's bottom.
    expect(declarations(':root:has([data-status-bar])')).toContain(
      '--status-bar-height: var(--status-bar-row-height);'
    );
    expect(globalsCss.match(/--status-bar-height:/g)).toHaveLength(1);
  });

  it("runs to the window's bottom with the status bar off, in place of the footer's short line", () => {
    expect(
      declarations(
        ':root:not(:has([data-status-bar])) .window-chrome:has(:is(.empty-work-area:not(.overview-surface), .workspace-status-page)) [data-sidebar-footer]::after'
      )
    ).toContain('content: none;');
  });
});
