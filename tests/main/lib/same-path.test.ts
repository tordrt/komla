import { afterEach, describe, expect, it, vi } from 'vitest';

import { isSamePath, samePathKey } from '../../../src/main/lib/same-path';

describe('samePathKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const onPlatform = (platform: NodeJS.Platform) =>
    vi.stubGlobal('process', { ...process, platform });

  it('gives two spellings of one path the same key, ignoring case where the system does', () => {
    onPlatform('darwin');
    expect(samePathKey('/Users/me/Repo/')).toBe(samePathKey('/users/me/repo'));
    expect(isSamePath('/Users/me/Repo/', '/users/me/repo')).toBe(true);

    onPlatform('linux');
    expect(samePathKey('/home/me/repo/')).toBe(samePathKey('/home/me/repo'));
    expect(samePathKey('/home/me/Repo')).not.toBe(samePathKey('/home/me/repo'));
    expect(isSamePath('/home/me/Repo', '/home/me/repo')).toBe(false);
  });
});
