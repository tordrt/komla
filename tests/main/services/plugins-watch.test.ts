import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const { base, setPluginItems, setPluginHooks } = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs');
  const { tmpdir } = require('os') as typeof import('os');
  const { join } = require('path') as typeof import('path');
  return {
    base: mkdtempSync(join(tmpdir(), 'komla-plugins-watch-')),
    setPluginItems: vi.fn(),
    setPluginHooks: vi.fn(),
  };
});

vi.mock('../../../src/main/services/paths', () => ({ getKomlaBasePath: () => base }));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({}) },
}));
vi.mock('../../../src/main/services/project.service', () => ({ projectService: {} }));
vi.mock('../../../src/main/services/ssh-host.service', () => ({ sshHostService: {} }));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({ sshWorkspaceService: {} }));
vi.mock('../../../src/main/services/workspace.service', () => ({ workspaceService: {} }));
vi.mock('../../../src/main/services/html-preview.service', () => ({ htmlPreviewService: {} }));
vi.mock('../../../src/main/services/file-watcher', () => ({
  FileWatcher: class {
    start = async () => {};
    stop = async () => {};
  },
}));
vi.mock('@parcel/watcher', () => ({
  subscribe: async () => ({ unsubscribe: async () => {} }),
}));
vi.mock('../../../src/main/services/status-commands.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  statusCommandsService: { setPluginItems },
}));
vi.mock('../../../src/main/services/hooks.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hooksService: { setPluginHooks },
}));

import {
  digestFolder,
  pluginsService,
  stopWatchingPlugins,
  watchPlugins,
} from '../../../src/main/services/plugins.service';

describe('watchPlugins', () => {
  afterEach(async () => {
    await stopWatchingPlugins();
    vi.clearAllMocks();
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('gives the running plugins to the status bar and hooks once, also when read', async () => {
    const dir = join(base, 'plugins', 'hello');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'komla-plugin.json'),
      JSON.stringify({
        id: 'hello',
        name: 'Hello',
        contributes: { statusItems: [{ id: 'greeting', command: 'echo hi' }] },
      })
    );
    mkdirSync(join(base, 'settings'), { recursive: true });
    const { digest } = await digestFolder(dir);
    writeFileSync(
      join(base, 'settings', 'plugins.json'),
      JSON.stringify({ _version: 1, enabled: [{ id: 'hello', digest }] })
    );
    const fed = [expect.objectContaining({ id: 'hello.greeting' })];

    await watchPlugins();
    expect(setPluginItems).toHaveBeenCalledTimes(1);
    expect(setPluginItems).toHaveBeenCalledWith(fed);
    expect(setPluginHooks).toHaveBeenCalledTimes(1);

    await stopWatchingPlugins();
    vi.clearAllMocks();
    // Already read, so the scan finds no change to tell of.
    await pluginsService.scan();

    await watchPlugins();
    expect(setPluginItems).toHaveBeenCalledTimes(1);
    expect(setPluginItems).toHaveBeenCalledWith(fed);
  });
});
