/**
 * File-viewer deletes go to the OS trash (Electron shell.trashItem) instead of
 * a permanent recursive removal, and a trash failure is surfaced rather than
 * silently falling back to a hard delete.
 */
import { join } from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockChildProcess, createExecFileMock } from '../../mocks/child-process';
import { mockElectron, mockShell } from '../../mocks/electron';
import { createVirtualFs } from '../../mocks/fs';

const { trashItem } = vi.hoisted(() => ({ trashItem: vi.fn() }));
vi.mock('electron', () => mockElectron({ shell: { ...mockShell(), trashItem } }));

const vfs = createVirtualFs();
vi.mock('fs', () => vfs.mock);

const execFileMock = createExecFileMock();
vi.mock('child_process', () => mockChildProcess(undefined, undefined, execFileMock));

describe('gitRepoService.deleteFile', () => {
  beforeEach(() => {
    vi.resetModules();
    vfs.clear();
    execFileMock.clearMocks();
    trashItem.mockReset();
    trashItem.mockResolvedValue(undefined);
    (vfs.mock.rmSync as ReturnType<typeof vi.fn>).mockClear();
  });

  async function loadService() {
    const { gitRepoService } = await import('../../../src/main/services/git/git-repo');
    return gitRepoService;
  }

  it('moves a file to the trash instead of removing it', async () => {
    vfs.setFile('/repo/src/a.ts', 'content');
    const service = await loadService();

    await service.deleteFile('/repo', 'src/a.ts', 'modified');

    expect(trashItem).toHaveBeenCalledWith(join('/repo', 'src/a.ts'));
    expect(vfs.mock.rmSync).not.toHaveBeenCalled();
  });

  it('moves a folder (and its contents) to the trash in one step', async () => {
    vfs.mock.mkdirSync('/repo/src');
    vfs.setFile('/repo/src/nested/a.ts', 'content');
    const service = await loadService();

    await service.deleteFile('/repo', 'src', 'modified');

    expect(trashItem).toHaveBeenCalledTimes(1);
    expect(trashItem).toHaveBeenCalledWith(join('/repo', 'src'));
    expect(vfs.mock.rmSync).not.toHaveBeenCalled();
  });

  it('surfaces a trash failure without permanently deleting', async () => {
    vfs.setFile('/repo/src/a.ts', 'content');
    trashItem.mockRejectedValue(new Error('Trash is not available'));
    const service = await loadService();

    await expect(service.deleteFile('/repo', 'src/a.ts', 'modified')).rejects.toThrow(
      /could not move .*src\/a\.ts.* to the trash: Trash is not available/i
    );
    expect(vfs.mock.rmSync).not.toHaveBeenCalled();
    expect(vfs.getFile('/repo/src/a.ts')).toBeDefined();
  });

  it('does nothing for a path that no longer exists', async () => {
    const service = await loadService();

    await service.deleteFile('/repo', 'src/gone.ts', 'modified');

    expect(trashItem).not.toHaveBeenCalled();
  });
});
