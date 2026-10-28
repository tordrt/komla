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
    expect(page.indexOf('</script>')).toBeLessThan(page.indexOf('<style>body{padding:0}'));
  });

  it('leaves out colors that are not OKLCH channels', () => {
    const page = buildStatusPopoverPage('', {
      scheme: 'light',
      colors: { foreground: '0 0 0; } body { display: none', primary: '0.5 0.1 250' },
    });
    expect(page).toContain(':root { --primary: oklch(0.5 0.1 250); }');
    expect(page).toContain("dataset.theme = 'light'");
    expect(page).not.toContain('display: none');
  });
});
