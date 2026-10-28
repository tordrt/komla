import { join } from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app, net } from 'electron';

// Mock electron modules
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/home'),
    getVersion: vi.fn(() => '1.0.0'),
    relaunch: vi.fn(),
    exit: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  net: { fetch: vi.fn() },
}));

// Mock window service
const mockBroadcastWhenReady = vi.fn();
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: {
    broadcastWhenReady: (...args: unknown[]) => mockBroadcastWhenReady(...args),
  },
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock paths
vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/komla'),
}));

// Track fs state for pending-update tests
const mockFs: Record<string, string> = {};
const markerPath = join('/mock/komla', 'pending-update.json');

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => p in mockFs),
    readFileSync: vi.fn((p: string) => {
      if (p in mockFs) return mockFs[p];
      throw new Error('ENOENT');
    }),
    writeFileSync: vi.fn((p: string, data: string) => {
      mockFs[p] = data;
    }),
    unlinkSync: vi.fn((p: string) => {
      delete mockFs[p];
    }),
    mkdirSync: vi.fn(),
  };
});

// Mock announcement service
vi.mock('../../../src/main/services/announcement.service', () => ({
  announcementService: {
    refresh: vi.fn(),
  },
}));

// Mock license service
vi.mock('../../../src/main/services/license.service', () => ({
  licenseService: {
    refreshValidation: vi.fn(),
  },
}));

// Mock logger
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => mockLogger,
}));

// Mock api-urls
vi.mock('../../../src/main/lib/api-urls', () => ({
  DOWNLOADS_BASE_URL: 'https://downloads.komla.dev',
}));

// Mock build info: an official build unless a test says otherwise
const buildInfo = vi.hoisted(() => ({
  getBuildDistribution: vi.fn(() => 'official'),
}));
vi.mock('../../../src/main/lib/build-info', () => buildInfo);

// Mock electron-updater
const mockAutoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: true,
  channel: undefined as string | undefined,
  on: vi.fn(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn().mockResolvedValue({}),
  downloadUpdate: vi.fn().mockResolvedValue({}),
  quitAndInstall: vi.fn(),
};

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: mockAutoUpdater,
  },
}));

// Mock @electron-toolkit/utils - moved to beforeEach

describe('UpdateService', () => {
  let UpdateService: any;
  let updateService: any;
  let eventHandlers: Record<string, Function> = {};

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.resetModules();

    // Clear mock filesystem
    for (const key of Object.keys(mockFs)) {
      delete mockFs[key];
    }

    eventHandlers = {};
    mockAutoUpdater.on.mockImplementation((event: string, handler: Function) => {
      eventHandlers[event] = handler;
      return mockAutoUpdater;
    });

    // Default: an install electron-updater can update, even on a Linux test machine
    vi.stubEnv('APPIMAGE', '/opt/Komla.AppImage');

    // Default: not in dev mode
    vi.doMock('@electron-toolkit/utils', () => ({
      is: { dev: false },
    }));

    const module = await import('../../../src/main/services/update.service');
    UpdateService = module.UpdateService;
    updateService = new UpdateService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('@electron-toolkit/utils');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe('on Linux without its AppImage file', () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    const manifest = (version: string) =>
      [
        `version: ${version}`,
        'files:',
        `  - url: komla-${version}-x86_64.AppImage`,
        '    sha512: abc==',
        `path: komla-${version}-x86_64.AppImage`,
        'sha512: abc==',
        'releaseNotes: |',
        '  # Changelog',
        '',
        '  - Open Folder',
        "releaseDate: '2026-10-19T00:00:00.000Z'",
      ].join('\n');
    const fetchMock = vi.mocked(net.fetch);

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      vi.stubEnv('APPIMAGE', undefined);
      vi.stubEnv('SNAP', undefined);
      fetchMock.mockReset();
      vi.mocked(app.getVersion).mockReturnValue('3.6.0');
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
      vi.mocked(app.getVersion).mockReturnValue('1.0.0');
    });

    it('offers a newer AppImage in the feed as a download instead of updating', async () => {
      fetchMock.mockResolvedValue(new Response(manifest('3.7.0')));

      updateService.init();
      await vi.waitFor(() =>
        expect(mockBroadcastWhenReady).toHaveBeenCalledWith('app:update-available', {
          version: '3.7.0',
          releaseNotes: '# Changelog\n\n- Open Folder',
          releaseName: null,
          downloadUrl: 'https://downloads.komla.dev/latest/komla-3.7.0-x86_64.AppImage',
        })
      );
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        'https://downloads.komla.dev/latest/latest-linux.yml'
      );
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('reads the arm64 manifest on arm64', async () => {
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      fetchMock.mockResolvedValue(new Response(manifest('3.6.0')));

      updateService.init();
      await vi.waitFor(() =>
        expect(mockBroadcastWhenReady).toHaveBeenCalledWith('app:update-not-available')
      );
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        'https://downloads.komla.dev/latest/latest-linux-arm64.yml'
      );
    });

    it('says when nothing newer is out, checking again every 4 hours', async () => {
      fetchMock.mockImplementation(async () => new Response(manifest('3.6.0')));

      updateService.init();
      await vi.waitFor(() =>
        expect(mockBroadcastWhenReady).toHaveBeenCalledWith('app:update-not-available')
      );
      vi.advanceTimersByTime(4 * 60 * 60 * 1000 + 100);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reports a failed check', async () => {
      fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));

      updateService.init();
      await vi.waitFor(() =>
        expect(mockBroadcastWhenReady).toHaveBeenCalledWith(
          'app:update-error',
          'Update check failed: HTTP 503'
        )
      );
    });

    it('offers the download even when started from a Snap app, which passes on SNAP', async () => {
      vi.stubEnv('SNAP', '/snap/code/1');
      fetchMock.mockResolvedValue(new Response(manifest('3.6.0')));
      updateService.init();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  describe('parseLinuxManifest', () => {
    it('reads a manifest without release notes, and rejects one without a version', async () => {
      const { parseLinuxManifest } = await import('../../../src/main/services/update.service');
      expect(parseLinuxManifest("version: '3.7.0'\npath: komla-3.7.0-x86_64.AppImage\n")).toEqual({
        version: '3.7.0',
        path: 'komla-3.7.0-x86_64.AppImage',
        releaseNotes: null,
      });
      expect(parseLinuxManifest('path: komla.AppImage\n')).toBeNull();
    });

    it('reads the other YAML forms electron-builder can write', async () => {
      const { parseLinuxManifest } = await import('../../../src/main/services/update.service');
      expect(
        parseLinuxManifest(
          [
            'version: 3.7.0',
            "path: 'Komla 3.7.0.AppImage'",
            'releaseNotes: |2-',
            '    indented first line',
            '  - Open Folder',
          ].join('\n')
        )
      ).toEqual({
        version: '3.7.0',
        path: 'Komla 3.7.0.AppImage',
        releaseNotes: '  indented first line\n- Open Folder',
      });
      expect(
        parseLinuxManifest("version: 3.7.0\npath: komla.AppImage\nreleaseNotes: 'Bug fixes'\n")
          ?.releaseNotes
      ).toBe('Bug fixes');
      expect(parseLinuxManifest('version: [3.7.0\n')).toBeNull();
    });
  });

  describe('init', () => {
    it('should skip initialization in dev mode', async () => {
      vi.resetModules();
      vi.doMock('@electron-toolkit/utils', () => ({
        is: { dev: true },
      }));
      const { UpdateService: DevUpdateService } =
        await import('../../../src/main/services/update.service');
      const devService = new DevUpdateService();
      devService.init();

      expect(mockAutoUpdater.on).not.toHaveBeenCalled();
    });

    it('should register event listeners and check for updates', () => {
      updateService.init();

      expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function));
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-not-available', expect.any(Function));
      expect(mockAutoUpdater.on).not.toHaveBeenCalledWith('download-progress', expect.any(Function));
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-downloaded', expect.any(Function));
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));

      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
    });

    it('should setup periodic checks', () => {
      updateService.init();

      vi.advanceTimersByTime(4 * 60 * 60 * 1000 + 100);
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2); // Initial + 1 periodic
    });

    it('should skip the auto-updater in a build from source but keep announcements and license checks', async () => {
      buildInfo.getBuildDistribution.mockReturnValueOnce('source');
      const { announcementService } =
        await import('../../../src/main/services/announcement.service');
      const { licenseService } = await import('../../../src/main/services/license.service');

      updateService.init();
      vi.advanceTimersByTime(4 * 60 * 60 * 1000 + 100);

      expect(mockAutoUpdater.on).not.toHaveBeenCalled();
      expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(announcementService.refresh).toHaveBeenCalledTimes(2); // Launch + 1 periodic
      expect(licenseService.refreshValidation).toHaveBeenCalledTimes(1);
    });

    it('should set channel to latest-arm64 on ARM64 Windows', async () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });

      try {
        vi.resetModules();
        vi.doMock('@electron-toolkit/utils', () => ({
          is: { dev: false },
        }));
        mockAutoUpdater.channel = undefined as any;

        const { UpdateService: ArmUpdateService } =
          await import('../../../src/main/services/update.service');
        const armService = new ArmUpdateService();
        armService.init();

        expect(mockAutoUpdater.channel).toBe('latest-arm64');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
      }
    });

    it('should set channel to latest on x64 Windows (not arm64 override)', async () => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });

      try {
        vi.resetModules();
        vi.doMock('@electron-toolkit/utils', () => ({
          is: { dev: false },
        }));
        mockAutoUpdater.channel = undefined as any;

        const { UpdateService: X64UpdateService } =
          await import('../../../src/main/services/update.service');
        const x64Service = new X64UpdateService();
        x64Service.init();

        expect(mockAutoUpdater.channel).toBe('latest');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
      }
    });
  });

  describe('event handlers', () => {
    beforeEach(() => {
      updateService.init();
    });

    it('should notify renderer when update is available', () => {
      const info = {
        version: '1.2.3',
        releaseNotes: 'New features!',
        releaseName: 'v1.2.3',
      };

      eventHandlers['update-available'](info);

      expect(mockBroadcastWhenReady).toHaveBeenCalledWith('app:update-available', {
        version: '1.2.3',
        releaseNotes: 'New features!',
        releaseName: 'v1.2.3',
      });
    });

    it('should format array release notes', () => {
      const info = {
        version: '1.2.3',
        releaseNotes: [
          { version: '1.2.3', note: 'Fix 1' },
          { version: '1.2.3', note: 'Fix 2' },
        ],
      };

      eventHandlers['update-available'](info);

      expect(mockBroadcastWhenReady).toHaveBeenCalledWith(
        'app:update-available',
        expect.objectContaining({
          releaseNotes: `Fix 1\n\nFix 2`,
        })
      );
    });

    it('should notify renderer when no updates are available', () => {
      eventHandlers['update-not-available']();
      expect(mockBroadcastWhenReady).toHaveBeenCalledWith('app:update-not-available');
    });

    it('should notify renderer when update is downloaded', () => {
      eventHandlers['update-downloaded']({ version: '1.2.3' });
      expect(mockBroadcastWhenReady).toHaveBeenCalledWith('app:update-downloaded', '1.2.3');
    });

    it('should notify renderer on error', () => {
      eventHandlers['error'](new Error('Update failed'));
      expect(mockBroadcastWhenReady).toHaveBeenCalledWith('app:update-error', 'Update failed');
    });

    it('should treat read-only volume updater errors as expected install friction', () => {
      const err = new Error(
        'Cannot update while running on a read-only volume. The application is on a read-only volume.'
      );

      eventHandlers['error'](err);

      expect(mockLogger.warn).toHaveBeenCalledWith('Auto-updater error', err);
      expect(mockLogger.error).not.toHaveBeenCalledWith('Auto-updater error', err);
      expect(mockBroadcastWhenReady).toHaveBeenCalledWith(
        'app:update-error',
        'Komla cannot update from this location. Move Komla to Applications, relaunch it, then try again.'
      );
    });
  });

  describe('manual actions', () => {
    it('should trigger manual update check', () => {
      updateService.checkForUpdates();
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
    });

    it('should not check for updates in a build from source', () => {
      buildInfo.getBuildDistribution.mockReturnValueOnce('source');

      updateService.checkForUpdates();

      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(mockBroadcastWhenReady).not.toHaveBeenCalled();
    });

    it('should trigger download', () => {
      updateService.downloadUpdate();
      expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalled();
    });

    it('should trigger install', () => {
      updateService.installUpdate();
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalled();
    });

    it('should write pending-update marker from downloaded version before quitAndInstall', () => {
      updateService.init();
      // Simulate update-downloaded event to set downloadedVersion
      eventHandlers['update-downloaded']({ version: '2.0.0' });

      updateService.installUpdate();

      expect(mockFs[markerPath]).toBeDefined();
      const marker = JSON.parse(mockFs[markerPath]);
      expect(marker.version).toBe('2.0.0');
      expect(marker.timestamp).toBeTypeOf('number');
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalled();
    });

    it('should use downloaded version not available version for marker', () => {
      updateService.init();
      // v2.0.0 downloaded, then v2.1.0 becomes available before user clicks restart
      eventHandlers['update-downloaded']({ version: '2.0.0' });
      eventHandlers['update-available']({ version: '2.1.0', releaseNotes: null });

      updateService.installUpdate();

      const marker = JSON.parse(mockFs[markerPath]);
      expect(marker.version).toBe('2.0.0');
    });

    it('should still call quitAndInstall if marker write fails', () => {
      // Make writeFileSync throw to simulate filesystem failure.
      // The mock stores to mockFs by default; temporarily make it throw.
      const fs = require('fs') as typeof import('fs');
      const origWrite = fs.writeFileSync;
      (fs as any).writeFileSync = vi.fn(() => {
        throw new Error('EACCES');
      });

      try {
        updateService.init();
        eventHandlers['update-downloaded']({ version: '2.0.0' });
        updateService.installUpdate();

        expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalled();
      } finally {
        (fs as any).writeFileSync = origWrite;
      }
    });
  });

  describe('handlePendingUpdateRelaunch', () => {
    let handlePendingUpdateRelaunch: typeof import('../../../src/main/services/update.service').handlePendingUpdateRelaunch;

    beforeEach(async () => {
      vi.resetModules();
      vi.doMock('@electron-toolkit/utils', () => ({
        is: { dev: false },
      }));
      const module = await import('../../../src/main/services/update.service');
      handlePendingUpdateRelaunch = module.handlePendingUpdateRelaunch;
    });

    it('should return false when no marker file exists', () => {
      expect(handlePendingUpdateRelaunch()).toBe(false);
    });

    it('should return false and clear marker on non-darwin platforms', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      mockFs[markerPath] = JSON.stringify({
        version: '2.0.0',
        timestamp: Date.now(),
      });

      try {
        expect(handlePendingUpdateRelaunch()).toBe(false);
        expect(mockFs[markerPath]).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should return false and clear marker when version matches (update succeeded)', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      vi.mocked(app.getVersion).mockReturnValue('2.0.0');
      mockFs[markerPath] = JSON.stringify({
        version: '2.0.0',
        timestamp: Date.now(),
      });

      try {
        expect(handlePendingUpdateRelaunch()).toBe(false);
        expect(mockFs[markerPath]).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        vi.mocked(app.getVersion).mockReturnValue('1.0.0');
      }
    });

    it('should return false and clear stale marker', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      vi.mocked(app.getVersion).mockReturnValue('1.0.0');
      mockFs[markerPath] = JSON.stringify({
        version: '2.0.0',
        timestamp: Date.now() - 60_000, // older than 30s
      });

      try {
        expect(handlePendingUpdateRelaunch()).toBe(false);
        expect(mockFs[markerPath]).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should return false and clear marker with future timestamp (clock skew)', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      vi.mocked(app.getVersion).mockReturnValue('1.0.0');
      mockFs[markerPath] = JSON.stringify({
        version: '2.0.0',
        timestamp: Date.now() + 60_000, // in the future
      });

      try {
        expect(handlePendingUpdateRelaunch()).toBe(false);
        expect(mockFs[markerPath]).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should return false and clear marker with invalid JSON', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockFs[markerPath] = 'not json at all';

      try {
        expect(handlePendingUpdateRelaunch()).toBe(false);
        expect(mockFs[markerPath]).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should return false and clear marker with valid JSON but wrong shape', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockFs[markerPath] = JSON.stringify({ foo: 'bar' });

      try {
        expect(handlePendingUpdateRelaunch()).toBe(false);
        expect(mockFs[markerPath]).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should return true and schedule relaunch when old version detected on macOS', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      vi.mocked(app.getVersion).mockReturnValue('1.0.0');
      mockFs[markerPath] = JSON.stringify({
        version: '2.0.0',
        timestamp: Date.now(),
      });

      try {
        expect(handlePendingUpdateRelaunch()).toBe(true);

        // Relaunch should not have been called yet
        expect(app.relaunch).not.toHaveBeenCalled();

        // Advance past the relaunch delay
        vi.advanceTimersByTime(2000);
        expect(app.relaunch).toHaveBeenCalled();
        expect(app.exit).toHaveBeenCalledWith(0);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        vi.mocked(app.getVersion).mockReturnValue('1.0.0');
      }
    });
  });
});
