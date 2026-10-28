import { beforeEach, describe, expect, it, vi } from 'vitest';

const config: { recentFolders?: string[] } = {};
const existing = new Set<string>();
// Folders whose check never answers, as on a network drive that went away.
const hanging = new Set<string>();

vi.mock('electron', () => ({
  app: { addRecentDocument: vi.fn(), clearRecentDocuments: vi.fn() },
}));
vi.mock('fs/promises', () => ({
  stat: vi.fn((path: string) => {
    if (hanging.has(path)) return new Promise(() => {});
    return existing.has(path)
      ? Promise.resolve({ isDirectory: () => true })
      : Promise.reject(new Error('ENOENT'));
  }),
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: vi.fn(() => config),
    update: vi.fn((updates: typeof config) => Object.assign(config, updates)),
  },
}));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: { broadcastToAll: vi.fn() },
}));

const { app } = await import('electron');
const { windowService } = await import('../../../src/main/services/window.service');
const {
  clearRecentFolders,
  getRecentFolders,
  onRecentFoldersChanged,
  recordOpenedFolder,
  refreshRecentFolders,
} = await import('../../../src/main/services/recent-folders.service');

// Lets the check a change starts finish.
const settle = () => new Promise((done) => setTimeout(done, 0));

describe('recent folders', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    config.recentFolders = [];
    existing.clear();
    hanging.clear();
    await refreshRecentFolders();
  });

  const folders = (...paths: string[]) => paths.forEach((path) => existing.add(path));

  it('puts an opened folder first, once, and tells windows and listeners', async () => {
    folders('/a', '/b');
    config.recentFolders = ['/a', '/b'];
    const listener = vi.fn();
    const stop = onRecentFoldersChanged(listener);

    recordOpenedFolder('/b/');
    await settle();

    expect(getRecentFolders()).toEqual(['/b', '/a']);
    expect(windowService.broadcastToAll).toHaveBeenCalledWith(expect.any(String), config);
    expect(listener).toHaveBeenCalledOnce();
    stop();
  });

  it('keeps the ten opened last, and folders that are gone, which may come back', async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/f${i}`);
    folders('/new', ...paths);
    config.recentFolders = ['/gone', ...paths];

    recordOpenedFolder('/new');
    await settle();

    expect(config.recentFolders).toEqual(['/new', '/gone', ...paths.slice(0, 8)]);
    expect(getRecentFolders()).toEqual(['/new', ...paths.slice(0, 8)]);

    folders('/gone');
    await expect(refreshRecentFolders()).resolves.toEqual(['/new', '/gone', ...paths.slice(0, 8)]);
  });

  it('leaves out a folder whose check takes too long', async () => {
    vi.useFakeTimers();
    try {
      folders('/a');
      hanging.add('/network');
      config.recentFolders = ['/network', '/a'];
      const found = refreshRecentFolders();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(found).resolves.toEqual(['/a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['darwin', 1],
    ['linux', 0],
  ] as const)("adds it to the Dock's recent items on %s %i times", (platform, times) => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      recordOpenedFolder('/a');
      clearRecentFolders();
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
    expect(app.addRecentDocument).toHaveBeenCalledTimes(times);
    expect(app.clearRecentDocuments).toHaveBeenCalledTimes(times);
  });

  it('clears the list', async () => {
    folders('/a');
    config.recentFolders = ['/a'];
    await refreshRecentFolders();
    clearRecentFolders();
    await settle();
    expect(getRecentFolders()).toEqual([]);
  });
});
