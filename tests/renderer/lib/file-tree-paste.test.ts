import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pasteFileTreeNode } from '../../../src/renderer/lib/file-tree-paste';

function mockApi() {
  const api = {
    renameFile: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    copyDirectory: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  };
  (globalThis as { window?: unknown }).window = { api };
  return api;
}

describe('pasteFileTreeNode', () => {
  let api: ReturnType<typeof mockApi>;

  beforeEach(() => {
    api = mockApi();
  });

  it('copies a copied node and keeps the original', async () => {
    await pasteFileTreeNode('/repo', {
      src: 'src/a.ts',
      dest: 'lib/a.ts',
      isDirectory: false,
      isCut: false,
    });

    expect(api.copyFile).toHaveBeenCalledWith('/repo', 'src/a.ts', 'lib/a.ts');
    expect(api.renameFile).not.toHaveBeenCalled();
    expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('replaces an existing destination of a cut with copy then delete', async () => {
    await pasteFileTreeNode('/repo', {
      src: 'src/a.ts',
      dest: 'lib/a.ts',
      isDirectory: false,
      isCut: true,
    });

    expect(api.copyFile).toHaveBeenCalledWith('/repo', 'src/a.ts', 'lib/a.ts');
    expect(api.deleteFile).toHaveBeenCalledWith('/repo', 'src/a.ts', 'modified');
    expect(api.renameFile).not.toHaveBeenCalled();
  });
});
