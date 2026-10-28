import { join, win32 } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteReleasingOpenCodeLocation } from '../../../src/main/lib/opencode-service';
import { OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX } from '../../../src/shared/types/workspace';

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  removePath: vi.fn(() => Promise.resolve()),
  isWslMode: vi.fn(() => false),
  fetch: vi.fn(),
}));

vi.mock('fs', () => ({ readFileSync: mocks.readFileSync }));
vi.mock('os', () => ({ homedir: () => 'C:/Users/me' }));
vi.mock('../../../src/main/lib/remove-path', () => ({ removePath: mocks.removePath }));
vi.mock('../../../src/main/lib/wsl', () => ({ isWslMode: mocks.isWslMode }));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const DIRECTORY = win32.join('C:/', 'worktrees', 'repo', 'ws');
const SERVICE = { url: 'http://127.0.0.1:45278', pid: 4242, password: 'secret' };
const AUTH = { Authorization: `Basic ${Buffer.from('opencode:secret').toString('base64')}` };
const originalPlatform = process.platform;

function busy(): NodeJS.ErrnoException {
  return Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${DIRECTORY}'`), {
    code: 'EBUSY',
  });
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

/** The service lists `loaded` (one list per call, the last repeating) and answers releases. */
function serve(loaded: string[][], releaseOk = true): void {
  let listCall = 0;
  mocks.fetch.mockImplementation((_url: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') {
      return Promise.resolve({ ok: releaseOk, status: releaseOk ? 204 : 401 });
    }
    const directories = loaded[Math.min(listCall++, loaded.length - 1)];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(directories.map((directory) => ({ directory }))),
    });
  });
}

function releases(): string[] {
  return mocks.fetch.mock.calls
    .filter(([, init]) => init?.method === 'DELETE')
    .map(([url]) => decodeURIComponent(String(url).split('location[directory]=')[1]));
}

describe('deleteReleasingOpenCodeLocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('win32');
    mocks.isWslMode.mockReturnValue(false);
    mocks.readFileSync.mockReturnValue(JSON.stringify(SERVICE));
    mocks.removePath.mockResolvedValue(undefined);
    serve([[DIRECTORY]]);
    vi.stubGlobal('fetch', mocks.fetch);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    delete process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('leaves opencode alone when the delete succeeds', async () => {
    const remove = vi.fn(() => Promise.resolve());

    await deleteReleasingOpenCodeLocation(DIRECTORY, remove);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rethrows errors other than a folder in use', async () => {
    const error = new Error('uncommitted changes');

    await expect(
      deleteReleasingOpenCodeLocation(DIRECTORY, () => Promise.reject(error))
    ).rejects.toBe(error);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rethrows a folder in use off native Windows', async () => {
    for (const setUp of [
      () => setPlatform('darwin'),
      () => mocks.isWslMode.mockReturnValue(true),
    ]) {
      setPlatform('win32');
      mocks.isWslMode.mockReturnValue(false);
      setUp();
      const error = busy();

      await expect(
        deleteReleasingOpenCodeLocation(DIRECTORY, () => Promise.reject(error))
      ).rejects.toBe(error);
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rethrows a folder in use when no opencode service is running', async () => {
    const error = busy();
    mocks.readFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await expect(
      deleteReleasingOpenCodeLocation(DIRECTORY, () => Promise.reject(error))
    ).rejects.toBe(error);

    vi.mocked(process.kill).mockImplementationOnce(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    await expect(
      deleteReleasingOpenCodeLocation(DIRECTORY, () => Promise.reject(error))
    ).rejects.toBe(error);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('keeps the original error when opencode has not loaded the folder', async () => {
    serve([[win32.join('C:/', 'worktrees', 'repo', 'ws-other'), win32.join('C:/', 'Users', 'me')]]);
    const error = busy();

    await expect(
      deleteReleasingOpenCodeLocation(DIRECTORY, () => Promise.reject(error))
    ).rejects.toBe(error);
    expect(releases()).toEqual([]);
    expect(mocks.removePath).not.toHaveBeenCalled();
  });

  it('releases the folder from the opencode service, then finishes the delete', async () => {
    const remove = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);

    await deleteReleasingOpenCodeLocation(DIRECTORY, remove);

    expect(mocks.fetch).toHaveBeenCalledWith(
      `${SERVICE.url}/api/debug/location`,
      expect.objectContaining({ headers: AUTH })
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      `${SERVICE.url}/api/debug/location?location[directory]=${encodeURIComponent(DIRECTORY)}`,
      expect.objectContaining({ method: 'DELETE', headers: AUTH })
    );
    // A short retry rides out a handle that closes just after the release, but gives up
    // before opencode can load the folder again, about 0.5 s later.
    expect(mocks.removePath).toHaveBeenCalledWith(DIRECTORY, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    });
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('releases the locations opencode loaded inside the worktree, however it spells them', async () => {
    const inside = win32.join('C:/', 'Worktrees', 'Repo', 'WS', 'packages', 'app').toLowerCase();
    serve([[inside, win32.join('C:/', 'worktrees', 'repo', 'ws-other')]]);
    const remove = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);

    await deleteReleasingOpenCodeLocation(DIRECTORY, remove);

    expect(releases()).toEqual([inside]);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('reads the service from XDG_STATE_HOME when it is set', async () => {
    process.env.XDG_STATE_HOME = win32.join('D:/', 'state');
    const remove = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);

    await deleteReleasingOpenCodeLocation(DIRECTORY, remove);

    expect(mocks.readFileSync).toHaveBeenCalledWith(
      join(process.env.XDG_STATE_HOME, 'opencode', 'service.json'),
      'utf-8'
    );
  });

  it('releases the folder again when opencode reloads it before the delete', async () => {
    mocks.removePath.mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);
    const remove = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);

    await deleteReleasingOpenCodeLocation(DIRECTORY, remove);

    expect(releases()).toEqual([DIRECTORY, DIRECTORY]);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('reports opencode as the holder when it keeps loading the folder', async () => {
    mocks.removePath.mockRejectedValue(busy());

    await expect(
      deleteReleasingOpenCodeLocation(DIRECTORY, () => Promise.reject(busy()))
    ).rejects.toThrow(OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX);
    expect(releases()).toHaveLength(3);
  });

  it('keeps the original error when the folder stays in use after opencode let it go', async () => {
    serve([[DIRECTORY], []]);
    mocks.removePath.mockRejectedValue(busy());
    const error = busy();

    await expect(
      deleteReleasingOpenCodeLocation(DIRECTORY, () => Promise.reject(error))
    ).rejects.toBe(error);
    expect(releases()).toEqual([DIRECTORY]);
  });

  it('keeps the original error when the service refuses the release', async () => {
    serve([[DIRECTORY]], false);
    const error = busy();

    await expect(
      deleteReleasingOpenCodeLocation(DIRECTORY, () => Promise.reject(error))
    ).rejects.toBe(error);
    expect(mocks.removePath).not.toHaveBeenCalled();
  });

  it('keeps the original error when the service cannot be reached', async () => {
    mocks.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const error = busy();

    await expect(
      deleteReleasingOpenCodeLocation(DIRECTORY, () => Promise.reject(error))
    ).rejects.toBe(error);
  });

  it('releases the folder when the delete is denied rather than busy', async () => {
    const denied = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    mocks.removePath.mockRejectedValueOnce(denied).mockResolvedValueOnce(undefined);
    const remove = vi.fn().mockRejectedValueOnce(denied).mockResolvedValueOnce(undefined);

    await deleteReleasingOpenCodeLocation(DIRECTORY, remove);

    expect(releases()).toHaveLength(2);
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
