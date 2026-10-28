import { afterEach, describe, expect, it } from 'vitest';

import { hostToolEnv } from '../../../src/main/lib/host-tool-env';

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('hostToolEnv', () => {
  it('preserves semicolon-delimited Windows PATH entries', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const env = hostToolEnv({ PATH: String.raw`C:\Windows\System32;C:\Program Files\Git\cmd` });

    expect(env.PATH?.split(';')).toContain(String.raw`C:\Program Files\Git\cmd`);
    expect(env.PATH).toContain(';');
  });
});
