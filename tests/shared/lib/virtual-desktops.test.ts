import { describe, expect, it } from 'vitest';

import {
  normalizeVirtualDesktops,
  virtualDesktopAppName,
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

  it("names the desktop's app by its program, without its folder or arguments", () => {
    const named = (app?: string) => virtualDesktopAppName({ vncPort: 5901, shownAt: 0, app });
    expect(named('electron .')).toBe('electron');
    expect(named('firefox-esr http://localhost:5173/')).toBe('firefox-esr');
    expect(named('/usr/bin/xterm -fa Monospace')).toBe('xterm');
    expect(named('C:\\Tools\\app.exe --flag')).toBe('app.exe');
    expect(named('"/opt/My App/bin/app" --flag')).toBe('app');
    expect(named("'/usr/bin/xterm'")).toBe('xterm');
    expect(named('  ')).toBeUndefined();
    expect(named()).toBeUndefined();
  });
});
