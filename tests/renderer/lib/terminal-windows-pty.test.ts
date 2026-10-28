import { describe, it, expect } from 'vitest';

import { terminalWindowsPtyOptions } from '@/lib/terminal-windows-pty';

describe('terminalWindowsPtyOptions', () => {
  it('reports ConPTY with the build number on Windows', () => {
    expect(terminalWindowsPtyOptions('win32', '10.0.22631', false)).toEqual({
      windowsPty: { backend: 'conpty', buildNumber: 22631 },
    });
    expect(terminalWindowsPtyOptions('win32', '10.0.19045', false)).toEqual({
      windowsPty: { backend: 'conpty', buildNumber: 19045 },
    });
  });

  it('reports ConPTY without a build number when the version is unreadable', () => {
    for (const version of [undefined, '', '10.0', '10.0.abc', 'garbage']) {
      expect(terminalWindowsPtyOptions('win32', version, false)).toEqual({
        windowsPty: { backend: 'conpty' },
      });
    }
  });

  it("reflows the cursor line with Komla's ConPTY", () => {
    expect(terminalWindowsPtyOptions('win32', '10.0.22631', true)).toEqual({
      windowsPty: { backend: 'conpty', buildNumber: 22631 },
      reflowCursorLine: true,
    });
  });

  it('leaves other platforms alone', () => {
    expect(terminalWindowsPtyOptions('darwin', '15.4.0', true)).toEqual({});
    expect(terminalWindowsPtyOptions('linux', '6.12.0', false)).toEqual({});
    expect(terminalWindowsPtyOptions(undefined, undefined, false)).toEqual({});
  });
});
