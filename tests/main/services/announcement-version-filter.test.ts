import { describe, it, expect, vi } from 'vitest';

// Mock electron and dependencies so the module can be imported
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
  net: { request: vi.fn() },
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({}), update: vi.fn() },
}));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/main/lib/api-urls', () => ({
  API_BASE_URL: 'https://test.komla.dev',
}));
vi.mock('../../../src/main/services/license.service', () => ({
  licenseService: { getStatus: () => ({ isLicensed: false }) },
}));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: { broadcastWhenReady: vi.fn() },
}));

import { matchesVersion, type Announcement } from '../../../src/main/services/announcement.service';

function createAnnouncement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'test',
    type: 'info',
    title: 'Test',
    body: '',
    date: '2026-01-01',
    displayMode: 'banner',
    ...overrides,
  };
}

describe('matchesVersion', () => {
  it('should match when no version constraints are set', () => {
    const a = createAnnouncement();
    expect(matchesVersion(a, '0.1.0')).toBe(true);
    expect(matchesVersion(a, '99.99.99')).toBe(true);
  });

  it('should match when app version meets minVersion', () => {
    const a = createAnnouncement({ minVersion: '1.0.0' });
    expect(matchesVersion(a, '1.0.0')).toBe(true); // exact match
    expect(matchesVersion(a, '1.0.1')).toBe(true); // above
    expect(matchesVersion(a, '2.0.0')).toBe(true); // well above
  });

  it('should not match when app version is below minVersion', () => {
    const a = createAnnouncement({ minVersion: '1.0.0' });
    expect(matchesVersion(a, '0.9.9')).toBe(false);
    expect(matchesVersion(a, '0.1.0')).toBe(false);
  });

  it('should match when app version meets maxVersion', () => {
    const a = createAnnouncement({ maxVersion: '2.0.0' });
    expect(matchesVersion(a, '2.0.0')).toBe(true); // exact match
    expect(matchesVersion(a, '1.9.9')).toBe(true); // below
    expect(matchesVersion(a, '0.1.0')).toBe(true); // well below
  });

  it('should not match when app version is above maxVersion', () => {
    const a = createAnnouncement({ maxVersion: '2.0.0' });
    expect(matchesVersion(a, '2.0.1')).toBe(false);
    expect(matchesVersion(a, '3.0.0')).toBe(false);
  });

  it('should match when app version is within minVersion and maxVersion range', () => {
    const a = createAnnouncement({ minVersion: '1.0.0', maxVersion: '2.0.0' });
    expect(matchesVersion(a, '1.0.0')).toBe(true);
    expect(matchesVersion(a, '1.5.0')).toBe(true);
    expect(matchesVersion(a, '2.0.0')).toBe(true);
  });

  it('places a staging build before its release', () => {
    expect(matchesVersion(createAnnouncement({ minVersion: '3.7.0' }), '3.7.0-staging.3')).toBe(
      false
    );
    expect(matchesVersion(createAnnouncement({ maxVersion: '3.6.9' }), '3.7.0-staging.3')).toBe(
      false
    );
    expect(
      matchesVersion(createAnnouncement({ minVersion: '3.7.0-staging.2' }), '3.7.0-staging.10')
    ).toBe(true);
  });

  it('should not match when app version is outside the range', () => {
    const a = createAnnouncement({ minVersion: '1.0.0', maxVersion: '2.0.0' });
    expect(matchesVersion(a, '0.9.9')).toBe(false);
    expect(matchesVersion(a, '2.0.1')).toBe(false);
  });
});
