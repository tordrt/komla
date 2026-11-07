import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canStepQuickLook,
  quickLookSidebar,
  useQuickLookStore,
  type QuickLookItem,
} from '../../../src/renderer/stores/quick-look.store';

import type { ViewerFolderFile } from '../../../src/shared/types/viewer-file';

const listViewerFolder = vi.fn();

const terminalItem = (fullPath: string, terminalId = 'term-1'): QuickLookItem => ({
  path: fullPath,
  terminalId,
  source: { kind: 'terminal', fullPath },
  hostPath: fullPath,
});

/** A folder listing of these files, newest first, a minute apart. */
const listing = (...names: string[]): ViewerFolderFile[] =>
  names.map((name, index) => ({ name, modifiedMs: Date.UTC(2026, 9, 13, 12, 0) - index * 60_000 }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('quick-look.store', () => {
  beforeEach(() => {
    listViewerFolder.mockReset().mockResolvedValue([]);
    vi.stubGlobal('window', { api: { listViewerFolder } });
    useQuickLookStore.setState(useQuickLookStore.getInitialState(), true);
  });

  it('lists the recent files, then the rest of the folder on screen', async () => {
    listViewerFolder.mockResolvedValue(listing('b.png', 'a.png'));
    const listed = [
      terminalItem('/tmp/out/a.png'),
      terminalItem('/tmp/out/build.zip'),
      terminalItem('/tmp/other/x.png'),
    ];
    const { open } = useQuickLookStore.getState();
    open('ws-1', terminalItem('/tmp/out/a.png'));
    await vi.waitFor(() => expect(useQuickLookStore.getState().folder?.status).toBe('loaded'));

    const paths = () => {
      const sections = quickLookSidebar(useQuickLookStore.getState(), listed);
      return {
        recent: sections?.recent.map((item) => item.path),
        folder: sections?.folder.files.map((item) => item.path),
      };
    };
    // The folder lists what the sections above don't.
    expect(paths()).toEqual({
      recent: ['/tmp/out/a.png', '/tmp/out/build.zip', '/tmp/other/x.png'],
      folder: ['/tmp/out/b.png'],
    });

    // A file on screen that its folder's listing leaves out, such as a type it skips, comes first.
    open('ws-1', terminalItem('/tmp/out/build.tar'));
    expect(paths().folder).toEqual(['/tmp/out/build.tar', '/tmp/out/b.png']);
  });

  it('lists the files from terminals each once', () => {
    useQuickLookStore.getState().open('ws-1', terminalItem('/tmp/other/x.png'));

    const sections = quickLookSidebar(useQuickLookStore.getState(), [
      terminalItem('/tmp/out/a.png'),
      terminalItem('/tmp/other/x.png'),
      terminalItem('/tmp/other/x.png'),
      terminalItem('/tmp/out/b.png'),
    ]);

    expect(sections?.recent.map((item) => item.path)).toEqual([
      '/tmp/out/a.png',
      '/tmp/other/x.png',
      '/tmp/out/b.png',
    ]);
    // The file on screen is listed above, so its folder doesn't list it again.
    expect(sections?.folder.files).toEqual([]);
  });

  it('names folder files the way their folder printed its path', async () => {
    listViewerFolder.mockResolvedValue(listing('b $&.png'));
    const { open } = useQuickLookStore.getState();
    open('ws-1', {
      path: 'out\\a.png',
      terminalId: 'term-1',
      source: { kind: 'workspace', filePath: 'out/a.png' },
      hostPath: 'C:\\repo/out/a.png',
    });

    await vi.waitFor(() => expect(useQuickLookStore.getState().folder?.status).toBe('loaded'));
    expect(useQuickLookStore.getState().folder?.items).toEqual([
      {
        path: 'out\\b $&.png',
        terminalId: 'term-1',
        source: { kind: 'workspace', filePath: 'out/b $&.png' },
        hostPath: 'C:\\repo/out/b $&.png',
        modifiedMs: Date.UTC(2026, 9, 13, 12, 0),
      },
    ]);
  });

  it('ignores a folder listing that arrives after another file took the screen', async () => {
    const slow = deferred<ViewerFolderFile[]>();
    listViewerFolder.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(listing('b.png'));
    const { open } = useQuickLookStore.getState();
    open('ws-1', terminalItem('/tmp/one/a.png'));
    open('ws-1', terminalItem('/tmp/two/b.png'));
    await vi.waitFor(() => expect(useQuickLookStore.getState().folder?.status).toBe('loaded'));

    slow.resolve(listing('a.png'));
    await slow.promise;

    expect(useQuickLookStore.getState().folder?.items.map((item) => item.path)).toEqual([
      '/tmp/two/b.png',
    ]);
  });
  it('lists a folder opened from a link, its subfolders apart from its files', async () => {
    listViewerFolder.mockResolvedValue(listing('before/', 'after/', 'grid.png'));
    useQuickLookStore.getState().open('ws-1', terminalItem('/tmp/shots/'));
    await vi.waitFor(() => expect(useQuickLookStore.getState().folder?.status).toBe('loaded'));

    expect(listViewerFolder).toHaveBeenCalledWith('ws-1', 'term-1', {
      kind: 'terminal',
      fullPath: '/tmp/shots/',
    });
    const sections = quickLookSidebar(useQuickLookStore.getState());
    expect(sections?.folder.folder.path).toBe('/tmp/shots/');
    expect(sections?.folder.files.map((item) => item.path)).toEqual(['/tmp/shots/grid.png']);
    expect(sections?.folder.folders.map((item) => item.path)).toEqual([
      '/tmp/shots/before/',
      '/tmp/shots/after/',
    ]);
  });

  it('keeps an opened folder listed after showing one of its subfolders', async () => {
    listViewerFolder.mockResolvedValue(listing('before/'));
    const { open, show } = useQuickLookStore.getState();
    open('ws-1', terminalItem('/tmp/shots/'));
    await vi.waitFor(() => expect(useQuickLookStore.getState().folder?.status).toBe('loaded'));
    listViewerFolder.mockResolvedValue(listing('a.png'));
    show(useQuickLookStore.getState().folder!.items[0]);
    await vi.waitFor(() =>
      expect(useQuickLookStore.getState().folder?.items[0]?.path).toBe('/tmp/shots/before/a.png')
    );

    const sections = quickLookSidebar(useQuickLookStore.getState(), [terminalItem('/tmp/shots/')]);
    expect(sections?.recent.map((item) => item.path)).toEqual(['/tmp/shots/']);
    expect(sections?.folder.folder.path).toBe('/tmp/shots/before/');
    expect(sections?.folder.files.map((item) => item.path)).toEqual(['/tmp/shots/before/a.png']);
  });

  it('goes up from a folder as its path was printed, and stops at the top', () => {
    const { open } = useQuickLookStore.getState();
    const parentOf = (item: QuickLookItem) => {
      open('ws-1', item);
      return quickLookSidebar(useQuickLookStore.getState())?.folder.parent;
    };
    const workspaceItem = (path: string, filePath: string): QuickLookItem => ({
      path,
      terminalId: 'term-1',
      source: { kind: 'workspace', filePath },
    });

    expect(parentOf({ ...terminalItem('/tmp/out/a.png'), path: '~/out/a.png' })).toEqual({
      path: '~/',
      terminalId: 'term-1',
      source: { kind: 'terminal', fullPath: '/tmp/' },
      hostPath: '/tmp/',
    });
    // A relative path that runs out of folders goes on with the full one.
    expect(parentOf({ ...terminalItem('/tmp/out/a.png'), path: 'out/a.png' })?.path).toBe('/tmp/');
    expect(parentOf(terminalItem('/a.png'))).toBeNull();
    // A terminal keeps ~/ as printed, so the home folder is as far up as it goes.
    expect(parentOf({ ...terminalItem('~/a.png'), path: '~/a.png' })).toBeNull();
    // A printed Windows path goes up by its own separators.
    expect(parentOf(workspaceItem('src\\app\\a.ts', 'src/app/a.ts'))).toEqual(
      workspaceItem('src\\', 'src/')
    );
    // The workspace is no folder path, so a top-level folder has nowhere to go up to.
    expect(parentOf(workspaceItem('src/a.ts', 'src/a.ts'))).toBeNull();
  });

  it('steps through the files only, from a folder on screen to its first file', async () => {
    listViewerFolder.mockResolvedValue(listing('before/', 'b.png', 'a.png'));
    useQuickLookStore.getState().open('ws-1', terminalItem('/tmp/shots/'));
    await vi.waitFor(() => expect(useQuickLookStore.getState().folder?.status).toBe('loaded'));
    const { step } = useQuickLookStore.getState();

    expect(canStepQuickLook(useQuickLookStore.getState(), -1)).toBe(false);
    step(1);
    expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/shots/b.png');
    step(1);
    step(1);
    expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/shots/a.png');
    step(-1);
    step(-1);
    expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/shots/b.png');
  });

  it('steps into a folder opened from a link, as its section lists it above its files', async () => {
    listViewerFolder.mockResolvedValue(listing('before/', 'b.png', 'a.png'));
    const listed = [
      terminalItem('/tmp/out/x.png'),
      terminalItem('/tmp/shots/'),
      terminalItem('/tmp/other/y.png'),
    ];
    useQuickLookStore.getState().open('ws-1', terminalItem('/tmp/shots/'));
    await vi.waitFor(() => expect(useQuickLookStore.getState().folder?.status).toBe('loaded'));
    const { step } = useQuickLookStore.getState();
    const onScreen = () => useQuickLookStore.getState().session?.item.path;

    // Above it, the last recent file, as Recent is drawn above the folder's section.
    expect(canStepQuickLook(useQuickLookStore.getState(), -1, listed)).toBe(true);
    step(1, listed);
    expect(onScreen()).toBe('/tmp/shots/b.png');
    step(1, listed);
    expect(onScreen()).toBe('/tmp/shots/a.png');
    expect(canStepQuickLook(useQuickLookStore.getState(), 1, listed)).toBe(false);
    // Back up its files, then up the sidebar past the folders to the last recent file.
    step(-1, listed);
    step(-1, listed);
    expect(onScreen()).toBe('/tmp/other/y.png');
  });

  it('steps on down Recent from a recent folder with no files to step into', async () => {
    const listed = [terminalItem('/tmp/shots/'), terminalItem('/tmp/other/y.png')];
    const { open, step } = useQuickLookStore.getState();
    const nextFrom = async (listingResult: Promise<ViewerFolderFile[]>) => {
      listViewerFolder.mockReturnValue(listingResult);
      open('ws-1', terminalItem('/tmp/other/y.png'));
      open('ws-1', terminalItem('/tmp/shots/'));
      await vi.waitFor(() =>
        expect(useQuickLookStore.getState().folder?.status).not.toBe('loading')
      );
      step(1, listed);
      return useQuickLookStore.getState().session?.item.path;
    };

    // Only subfolders, then a listing that failed.
    expect(await nextFrom(Promise.resolve(listing('before/')))).toBe('/tmp/other/y.png');
    expect(await nextFrom(Promise.reject(new Error('gone')))).toBe('/tmp/other/y.png');
  });

  it('steps from a file in a recent folder down the sidebar, not into that folder', async () => {
    listViewerFolder.mockResolvedValue(listing('b.png', 'a.png'));
    const listed = [terminalItem('/tmp/shots/'), terminalItem('/tmp/shots/a.png')];
    useQuickLookStore.getState().open('ws-1', terminalItem('/tmp/shots/a.png'));
    await vi.waitFor(() => expect(useQuickLookStore.getState().folder?.status).toBe('loaded'));

    expect(canStepQuickLook(useQuickLookStore.getState(), -1, listed)).toBe(false);
    useQuickLookStore.getState().step(1, listed);
    expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/shots/b.png');
  });

  it('steps from a file opened from a link to the recent files around it', async () => {
    listViewerFolder.mockResolvedValue(listing('b.png', 'a.png'));
    const listed = [terminalItem('/tmp/shots/a.png'), terminalItem('/tmp/other/y.png')];
    useQuickLookStore.getState().open('ws-1', terminalItem('/tmp/shots/a.png'));
    await vi.waitFor(() => expect(useQuickLookStore.getState().folder?.status).toBe('loaded'));

    useQuickLookStore.getState().step(1, listed);
    expect(useQuickLookStore.getState().session?.item.path).toBe('/tmp/other/y.png');
  });
});
