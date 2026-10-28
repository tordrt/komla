import { describe, expect, it } from 'vitest';

import {
  normalizeVirtualDesktops,
  virtualDesktopDisplay,
  virtualDesktopViewerPort,
} from '../../../src/shared/lib/virtual-desktops';

describe('virtual desktops', () => {
  it('keeps the saved desktops as saved, the first of each port', () => {
    const desktop = {
      vncPort: 5901,
      vncPassword: 'pa55word',
      url: 'http://127.0.0.1:6081/vnc.html?password=pa55word',
      app: 'xterm',
      vncApp: 'Screen Sharing',
      shownAt: 1_000,
    };
    expect(
      normalizeVirtualDesktops([desktop, { vncPort: 5901, app: 'gedit', shownAt: 2_000 }])
    ).toEqual([desktop]);
  });

  it('drops what a hand-edited file got wrong', () => {
    expect(
      normalizeVirtualDesktops([
        { vncPort: 70000, shownAt: 1 },
        { vncPort: '5901', shownAt: 1 },
        { vncPort: 5903 },
        { vncPort: 5904, shownAt: -1 },
        null,
        {
          vncPort: 5902,
          shownAt: 1,
          vncPassword: 'far too long',
          url: 'javascript:alert(1)',
          app: '',
          vncApp: 7,
          extra: true,
        },
      ])
    ).toEqual([{ vncPort: 5902, shownAt: 1 }]);
    expect(normalizeVirtualDesktops([{ vncPort: 0, shownAt: 1 }])).toBeUndefined();
    expect(normalizeVirtualDesktops('5901')).toBeUndefined();
  });

  it("names a desktop's display and the port of its page", () => {
    const desktop = { vncPort: 5903, url: 'http://127.0.0.1:6083/vnc.html', shownAt: 0 };
    expect(virtualDesktopDisplay(desktop)).toBe(':3');
    expect(virtualDesktopViewerPort(desktop)).toBe(6083);
    expect(virtualDesktopViewerPort({ vncPort: 5903, shownAt: 0 })).toBeUndefined();
  });
});
