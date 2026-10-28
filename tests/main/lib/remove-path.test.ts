import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rm: vi.fn(() => Promise.resolve()),
  rmSync: vi.fn(),
  originalRm: vi.fn(() => Promise.resolve()),
  originalRmSync: vi.fn(),
  requireModule: vi.fn(),
}));

vi.mock('fs', () => ({ rmSync: mocks.rmSync }));
vi.mock('fs/promises', () => ({ rm: mocks.rm }));
vi.mock('module', () => ({ createRequire: () => mocks.requireModule }));

const versions = process.versions as Record<string, string | undefined>;
const options = { recursive: true, force: true };

describe('removePath', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.requireModule.mockReturnValue({
      rmSync: mocks.originalRmSync,
      promises: { rm: mocks.originalRm },
    });
  });

  afterEach(() => {
    delete versions.electron;
  });

  it('uses node fs outside Electron', async () => {
    const { removePath, removePathSync } = await import('../../../src/main/lib/remove-path');

    await removePath('/tmp/tree', options);
    removePathSync('/tmp/tree', options);

    expect(mocks.rm).toHaveBeenCalledWith('/tmp/tree', options);
    expect(mocks.rmSync).toHaveBeenCalledWith('/tmp/tree', options);
    expect(mocks.requireModule).not.toHaveBeenCalled();
  });

  it('bypasses Electron asar patching inside Electron', async () => {
    versions.electron = '40.8.3';
    const { removePath, removePathSync } = await import('../../../src/main/lib/remove-path');

    await removePath('/tmp/tree', options);
    removePathSync('/tmp/tree', options);

    expect(mocks.requireModule).toHaveBeenCalledWith('original-fs');
    expect(mocks.originalRm).toHaveBeenCalledWith('/tmp/tree', options);
    expect(mocks.originalRmSync).toHaveBeenCalledWith('/tmp/tree', options);
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });
});
