import { describe, expect, it } from 'vitest';

import { deriveDefaultDeviceLabel } from '../device-label';

describe('default paired-device label', () => {
  it('identifies iPhone Safari as iOS despite its Mac OS compatibility token', () => {
    const userAgent =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

    expect(deriveDefaultDeviceLabel(userAgent)).toBe('Safari on iOS');
  });

  it('still identifies desktop Safari as macOS', () => {
    const userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';

    expect(deriveDefaultDeviceLabel(userAgent)).toBe('Safari on macOS');
  });
});
