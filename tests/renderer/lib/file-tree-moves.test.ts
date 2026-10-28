import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  moveFileTreePaths,
  pathAfterMove,
  renameFileTreePath,
} from '../../../src/renderer/lib/file-tree-moves';
import { useToastStore } from '../../../src/renderer/stores/toast.store';

const api = {
  fileExists: vi.fn(),
  renameFile: vi.fn(),
};

const lastToast = () => useToastStore.getState().toasts.at(-1);

describe('file tree moves', () => {
  beforeEach(() => {
    api.fileExists.mockReset().mockResolvedValue(false);
    api.renameFile.mockReset().mockResolvedValue(undefined);
    (globalThis as { window: unknown }).window = { api };
    useToastStore.setState({ toasts: [] });
  });

  const options = (...unsavedPaths: string[]) => ({
    getUnsavedPaths: () => unsavedPaths,
    onMoved: vi.fn(),
  });

  it('moves a multi-file drop with one toast, whose Undo puts every file back', async () => {
    const opts = options();

    const moved = await moveFileTreePaths(
      '/repo',
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      'lib',
      opts
    );

    expect(moved).toBe(true);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(lastToast()?.message).toBe('Moved 3 items to lib');
    expect(opts.onMoved).toHaveBeenCalledWith([
      { from: 'src/a.ts', to: 'lib/a.ts' },
      { from: 'src/b.ts', to: 'lib/b.ts' },
      { from: 'src/c.ts', to: 'lib/c.ts' },
    ]);

    api.renameFile.mockClear();
    lastToast()?.action?.onClick();

    await vi.waitFor(() => expect(opts.onMoved).toHaveBeenCalledTimes(2));
    expect(api.renameFile.mock.calls).toEqual([
      ['/repo', 'lib/c.ts', 'src/c.ts'],
      ['/repo', 'lib/b.ts', 'src/b.ts'],
      ['/repo', 'lib/a.ts', 'src/a.ts'],
    ]);
  });

  it('names a single moved file in its toast', async () => {
    await moveFileTreePaths('/repo', ['src/a.ts'], '', options());

    expect(lastToast()).toMatchObject({ message: 'Moved a.ts to root', action: { label: 'Undo' } });
  });

  it('refuses to move a file with unsaved edits, or the folder holding it', async () => {
    const opts = options('src/components/Button.tsx');

    const moved = await moveFileTreePaths('/repo', ['src/components', 'src/index.ts'], 'lib', opts);

    expect(moved).toBe(false);
    expect(api.renameFile.mock.calls).toEqual([['/repo', 'src/index.ts', 'lib/index.ts']]);
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      type: 'error',
      message: 'Save or discard your changes to Button.tsx first',
    });
  });

  it('refuses to move any of several files with unsaved edits', async () => {
    const opts = options('README.md', 'src/a.ts');

    const renamed = await renameFileTreePath('/repo', { from: 'src', to: 'lib' }, opts);

    expect(renamed).toBe(false);
    expect(api.renameFile).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({ message: 'Save or discard your changes to a.ts first' });
  });

  it('refuses to rename onto an existing name', async () => {
    api.fileExists.mockResolvedValue(true);
    const opts = options();

    const renamed = await renameFileTreePath('/repo', { from: 'a.ts', to: 'b.ts' }, opts);

    expect(renamed).toBe(false);
    expect(api.renameFile).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({ type: 'error' });
    expect(opts.onMoved).not.toHaveBeenCalled();
  });

  it('leaves both paths alone when the original path is taken again', async () => {
    const opts = options();
    await renameFileTreePath('/repo', { from: 'a.ts', to: 'b.ts' }, opts);
    api.fileExists.mockResolvedValue(true);
    api.renameFile.mockClear();

    lastToast()?.action?.onClick();

    await vi.waitFor(() => expect(lastToast()).toMatchObject({ type: 'error' }));
    expect(api.renameFile).not.toHaveBeenCalled();
    expect(opts.onMoved).toHaveBeenCalledTimes(1);
  });

  it('reports a failed undo', async () => {
    await renameFileTreePath('/repo', { from: 'a.ts', to: 'b.ts' }, options());
    api.renameFile.mockRejectedValue(new Error('EACCES'));

    lastToast()?.action?.onClick();

    await vi.waitFor(() => expect(lastToast()?.message).toContain('EACCES'));
  });

  it('finds where a path is after a move, including inside a moved folder', () => {
    const move = { from: 'src/foo', to: 'lib/foo' };
    expect(pathAfterMove('src/foo', move)).toBe('lib/foo');
    expect(pathAfterMove('src/foo/a.ts', move)).toBe('lib/foo/a.ts');
    expect(pathAfterMove('src/foobar.ts', move)).toBeNull();
  });
});
