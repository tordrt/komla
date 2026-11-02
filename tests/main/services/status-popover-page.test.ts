import { describe, expect, it } from 'vitest';

import { buildStatusPopoverPage } from '../../../src/main/services/status-popover-page';

describe('buildStatusPopoverPage', () => {
  it("puts Komla's theme and fonts before the page's own HTML", () => {
    const page = buildStatusPopoverPage('<style>body{padding:0}</style><p>hi</p>', {
      scheme: 'dark',
      colors: { foreground: '0.95 0 0', primary: '0.65 0.15 245 / 90%' },
    });
    expect(page).toContain(
      ':root { --foreground: oklch(0.95 0 0); --primary: oklch(0.65 0.15 245 / 90%); }'
    );
    expect(page).toContain("document.documentElement.dataset.theme = 'dark';");
    expect(page).toContain("url('/__komla/fonts/geist.woff2')");
    // Code in Komla's monospace font, from the file the icons load anyway.
    expect(page).toMatch(/code \{ font: [^}]*'Komla Mono'/);
    expect(page.indexOf('</script>')).toBeLessThan(page.indexOf('<style>body{padding:0}'));
  });

  it("has komla.css's classes, as a sidebar panel's page does", () => {
    const page = buildStatusPopoverPage('<p class="k-muted">hi</p>', undefined);
    expect(page).toContain('.k-badge');
    expect(page).toContain('.k-button.k-primary');
    expect(page.indexOf('.k-badge')).toBeLessThan(page.indexOf('<p class="k-muted">'));
  });

  it("pads the page by komla.css's variables, which k-header's margins follow", () => {
    const page = buildStatusPopoverPage('<header class="k-header"></header>', undefined);
    expect(page).toContain('body { padding: var(--k-page-y) var(--k-page-x); }');
    // Nothing after komla.css pads the body otherwise.
    expect(page).not.toMatch(/body \{[^}]*padding: \d/);
  });

  it('hides a hidden element even when a k- class shows it', () => {
    const page = buildStatusPopoverPage('<div class="k-banner" hidden>…</div>', undefined);
    expect(page).toContain("[hidden]:not([hidden='until-found']) { display: none !important; }");
  });

  it('leaves out colors that are not OKLCH channels', () => {
    const page = buildStatusPopoverPage('', {
      scheme: 'light',
      colors: { foreground: '0 0 0; } body { display: none', primary: '0.5 0.1 250' },
    });
    expect(page).toContain(':root { --primary: oklch(0.5 0.1 250); }');
    expect(page).toContain("dataset.theme = 'light'");
    expect(page).not.toContain('body { display: none');
  });
});
