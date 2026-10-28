import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron modules
const mockGetVersion = vi.fn(() => '0.9.1');

vi.mock('electron', () => ({
  app: {
    getVersion: (...args: unknown[]) => mockGetVersion(...args),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  net: {
    request: vi.fn(),
  },
}));

// Mock window service
const mockBroadcastWhenReady = vi.fn();
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: {
    broadcastWhenReady: (...args: unknown[]) => mockBroadcastWhenReady(...args),
  },
}));

// Mock config service
const mockConfigGet = vi.fn(() => ({
  dismissedAnnouncementIds: [] as string[],
}));
const mockConfigUpdate = vi.fn();

vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: (...args: unknown[]) => mockConfigGet(...args),
    update: (...args: unknown[]) => mockConfigUpdate(...args),
  },
}));

// Mock license service
const mockGetStatus = vi.fn(() => ({ isLicensed: false }));
vi.mock('../../../src/main/services/license.service', () => ({
  licenseService: {
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
  },
}));

// Mock logger
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock api-urls
vi.mock('../../../src/main/lib/api-urls', () => ({
  API_BASE_URL: 'https://test.komla.dev',
}));

describe('AnnouncementService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetVersion.mockReturnValue('0.9.1');
    mockConfigGet.mockReturnValue({ dismissedAnnouncementIds: [] });
    mockGetStatus.mockReturnValue({ isLicensed: false });
  });

  function makeAnnouncement(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ann-1',
      type: 'info',
      title: 'Test',
      body: 'Body',
      date: '2026-01-01',
      dismissible: true,
      displayMode: 'banner',
      audience: 'all',
      platform: 'all',
      ...overrides,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setAnnouncements(service: any, list: unknown[]) {
    service.announcements = list;
  }

  describe('getActive', () => {
    it('should return empty list when no announcements are loaded', async () => {
      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      expect(announcementService.getActive()).toEqual([]);
    });

    it('should handle undefined dismissedAnnouncementIds in config', async () => {
      mockConfigGet.mockReturnValue({});

      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      expect(announcementService.getActive()).toEqual([]);
    });

    it('should filter by audience for unlicensed users', async () => {
      mockGetStatus.mockReturnValue({ isLicensed: false });
      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      setAnnouncements(announcementService, [
        makeAnnouncement({ id: 'all', audience: 'all' }),
        makeAnnouncement({ id: 'unlicensed', audience: 'unlicensed' }),
        makeAnnouncement({ id: 'licensed', audience: 'licensed' }),
      ]);

      const active = announcementService.getActive();
      expect(active.map((a) => a.id)).toEqual(['all', 'unlicensed']);
    });

    it('should filter by audience for licensed users', async () => {
      mockGetStatus.mockReturnValue({ isLicensed: true });
      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      setAnnouncements(announcementService, [
        makeAnnouncement({ id: 'all', audience: 'all' }),
        makeAnnouncement({ id: 'unlicensed', audience: 'unlicensed' }),
        makeAnnouncement({ id: 'licensed', audience: 'licensed' }),
      ]);

      const active = announcementService.getActive();
      expect(active.map((a) => a.id)).toEqual(['all', 'licensed']);
    });

    it('should filter by platform', async () => {
      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      setAnnouncements(announcementService, [
        makeAnnouncement({ id: 'all', platform: 'all' }),
        makeAnnouncement({ id: 'match', platform: process.platform }),
        makeAnnouncement({ id: 'other', platform: 'win32_fake' }),
      ]);

      const active = announcementService.getActive();
      expect(active.map((a) => a.id)).toEqual(['all', 'match']);
    });

    it('should apply dismissed + audience + platform filters together', async () => {
      mockGetStatus.mockReturnValue({ isLicensed: true });
      mockConfigGet.mockReturnValue({ dismissedAnnouncementIds: ['dismissed-1'] });

      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      setAnnouncements(announcementService, [
        makeAnnouncement({ id: 'dismissed-1', audience: 'all', platform: 'all' }),
        makeAnnouncement({ id: 'wrong-audience', audience: 'unlicensed', platform: 'all' }),
        makeAnnouncement({ id: 'wrong-platform', audience: 'all', platform: 'win32_fake' }),
        makeAnnouncement({ id: 'survives', audience: 'licensed', platform: process.platform }),
      ]);

      const active = announcementService.getActive();
      expect(active.map((a) => a.id)).toEqual(['survives']);
    });

    it('should apply version + audience filters together', async () => {
      mockGetVersion.mockReturnValue('1.5.0');
      mockGetStatus.mockReturnValue({ isLicensed: false });

      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      setAnnouncements(announcementService, [
        makeAnnouncement({ id: 'too-old', minVersion: '2.0.0', audience: 'unlicensed' }),
        makeAnnouncement({ id: 'wrong-audience', minVersion: '1.0.0', audience: 'licensed' }),
        makeAnnouncement({ id: 'survives', minVersion: '1.0.0', audience: 'unlicensed' }),
      ]);

      const active = announcementService.getActive();
      expect(active.map((a) => a.id)).toEqual(['survives']);
    });

    it('should exclude announcement that fails all filters', async () => {
      mockGetVersion.mockReturnValue('1.0.0');
      mockGetStatus.mockReturnValue({ isLicensed: false });
      mockConfigGet.mockReturnValue({ dismissedAnnouncementIds: ['doomed'] });

      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      setAnnouncements(announcementService, [
        makeAnnouncement({
          id: 'doomed',
          audience: 'licensed',
          platform: 'win32_fake',
          minVersion: '9.0.0',
        }),
      ]);

      const active = announcementService.getActive();
      expect(active).toEqual([]);
    });
  });

  describe('dismiss', () => {
    it('should add id to dismissed list in config', async () => {
      mockConfigGet.mockReturnValue({ dismissedAnnouncementIds: ['old-1'] });

      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      announcementService.dismiss('new-1');

      expect(mockConfigUpdate).toHaveBeenCalledWith({
        dismissedAnnouncementIds: ['old-1', 'new-1'],
      });
    });

    it('should not duplicate dismissed ids', async () => {
      mockConfigGet.mockReturnValue({ dismissedAnnouncementIds: ['already-dismissed'] });

      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      announcementService.dismiss('already-dismissed');

      expect(mockConfigUpdate).not.toHaveBeenCalled();
    });

    it('should handle undefined dismissedAnnouncementIds', async () => {
      mockConfigGet.mockReturnValue({});

      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      announcementService.dismiss('new-id');

      expect(mockConfigUpdate).toHaveBeenCalledWith({
        dismissedAnnouncementIds: ['new-id'],
      });
    });

    it('should broadcast to all windows after dismissing', async () => {
      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      announcementService.dismiss('some-id');

      expect(mockBroadcastWhenReady).toHaveBeenCalledWith('announcements:updated', []);
    });
  });

  describe('refresh', () => {
    it('should not throw when called (fetch fails silently)', async () => {
      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      // refresh triggers a network call that will fail since net.request is mocked
      // but it should not throw
      expect(() => announcementService.refresh()).not.toThrow();
    });
  });
});
