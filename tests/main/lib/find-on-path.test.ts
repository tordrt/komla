import { describe, expect, it } from 'vitest';

import { findOnPath } from '../../../src/main/lib/find-on-path';

describe('findOnPath', () => {
  it('looks in each PATH directory', () => {
    const files = new Set(['/home/me/.local/bin/claude', '/usr/bin/codex']);

    const found = findOnPath(['claude', 'codex', 'amp'], '/usr/bin:/home/me/.local/bin', {
      platform: 'linux',
      isExecutable: (filePath) => files.has(filePath),
    });

    expect(found).toEqual(new Set(['claude', 'codex']));
  });

  it('tries each PATHEXT extension on Windows', () => {
    const files = new Set(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.CMD']);

    const found = findOnPath(
      ['claude', 'codex'],
      'C:\\Windows\\system32;C:\\Users\\me\\AppData\\Roaming\\npm',
      {
        platform: 'win32',
        pathExt: '.COM;.EXE;.BAT;.CMD',
        isExecutable: (filePath) => files.has(filePath),
      }
    );

    expect(found).toEqual(new Set(['claude']));
  });
});
