/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileEditorState } from '../../../../../src/renderer/components/workspaces/file-viewer/useFileViewerState';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const api = {
  readFile: vi.fn(),
  readImageFile: vi.fn(),
  getFileMetadata: vi.fn(),
  getMediaFileMetadata: vi.fn(),
  readMediaFile: vi.fn(),
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  window.api = { ...window.api, ...api } as unknown as typeof window.api;
});

function renderEditor() {
  return renderHook(() => useFileEditorState('/repo'));
}

describe('useFileEditorState loading a file', () => {
  it('shows a text file once it is read, clean and on disk', async () => {
    const read = deferred<string>();
    api.readFile.mockReturnValueOnce(read.promise);
    const { result } = renderEditor();

    let opening: Promise<void> | undefined;
    act(() => {
      opening = result.current.openFile('src/a.ts');
    });
    expect(result.current).toMatchObject({
      filePath: 'src/a.ts',
      loadingFile: true,
      fileContent: null,
      error: null,
      language: 'typescript',
    });

    await act(async () => {
      read.resolve('text');
      await opening;
    });
    expect(result.current).toMatchObject({
      filePath: 'src/a.ts',
      loadingFile: false,
      fileContent: 'text',
      diskContent: 'text',
      isDirty: false,
      hasExternalChange: false,
      missingOnDisk: false,
      isImage: false,
      isMedia: false,
    });
  });

  it('shows an image as an image, without text', async () => {
    api.readImageFile.mockResolvedValueOnce({ data: 'aW1n', mimeType: 'image/png' });
    const { result } = renderEditor();

    await act(() => result.current.openFile('logo.png'));

    expect(result.current).toMatchObject({
      isImage: true,
      imageData: 'aW1n',
      imageMimeType: 'image/png',
      isMedia: false,
      fileContent: null,
      diskContent: null,
      loadingFile: false,
    });
  });

  it('shows media from its metadata, and its preview only once asked', async () => {
    api.getMediaFileMetadata.mockResolvedValueOnce({
      mimeType: 'video/mp4',
      kind: 'video',
      size: 10,
      mtimeMs: 5,
    });
    const { result } = renderEditor();
    await act(() => result.current.openFile('clip.mp4'));
    expect(result.current).toMatchObject({
      isMedia: true,
      isImage: false,
      mediaMimeType: 'video/mp4',
      mediaKind: 'video',
      mediaSize: 10,
      diskContent: '10:5',
      mediaData: null,
      mediaPreviewLoading: false,
    });

    const preview = deferred<{ data: string; mimeType: string; kind: 'video' }>();
    api.readMediaFile.mockReturnValueOnce(preview.promise);
    let loading: Promise<void> | undefined;
    act(() => {
      loading = result.current.loadMediaPreview();
    });
    expect(result.current.mediaPreviewLoading).toBe(true);
    await act(async () => {
      preview.resolve({ data: 'dmlk', mimeType: 'video/webm', kind: 'video' });
      await loading;
    });
    expect(result.current).toMatchObject({
      mediaData: 'dmlk',
      mediaMimeType: 'video/webm',
      mediaPreviewLoading: false,
      mediaPreviewError: null,
    });
  });

  it('says why a media preview failed', async () => {
    api.getMediaFileMetadata.mockResolvedValueOnce({
      mimeType: 'audio/mpeg',
      kind: 'audio',
      size: 3,
      mtimeMs: 1,
    });
    api.readMediaFile.mockRejectedValueOnce(new Error('too big'));
    const { result } = renderEditor();
    await act(() => result.current.openFile('song.mp3'));

    await act(() => result.current.loadMediaPreview());

    expect(result.current).toMatchObject({
      mediaPreviewLoading: false,
      mediaPreviewError: 'too big',
      mediaData: null,
    });
  });

  it('shows a PDF from its metadata, as a page rather than text', async () => {
    api.getFileMetadata.mockResolvedValueOnce({ size: 7, mtimeMs: 9 });
    const { result } = renderEditor();

    await act(() => result.current.openFile('doc.pdf'));

    expect(result.current).toMatchObject({
      isBrowserPreviewable: true,
      fileContent: null,
      diskContent: '7:9',
      isImage: false,
      isMedia: false,
    });
  });

  it('says a file is missing rather than failing to read it', async () => {
    api.readFile.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));
    const { result } = renderEditor();

    await act(() => result.current.openFile('gone.ts'));

    expect(result.current).toMatchObject({
      filePath: 'gone.ts',
      missingOnDisk: true,
      error: null,
      loadingFile: false,
      fileContent: null,
    });
  });

  it('says why a file could not be read', async () => {
    api.readFile.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const { result } = renderEditor();

    await act(() => result.current.openFile('secret.ts'));

    expect(result.current).toMatchObject({
      error: 'EACCES: permission denied',
      missingOnDisk: false,
      loadingFile: false,
      fileContent: null,
    });
  });

  it('shows only the file opened last when an earlier read finishes after it', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    api.readFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderEditor();

    let openings: Promise<void>[] = [];
    act(() => {
      openings = [result.current.openFile('a.ts'), result.current.openFile('b.ts')];
    });
    await act(async () => {
      second.resolve('b');
      first.resolve('a');
      await Promise.all(openings);
    });

    expect(result.current).toMatchObject({ filePath: 'b.ts', fileContent: 'b' });
  });

  it('starts the next file clean, whatever the last one was', async () => {
    api.readFile.mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    const { result } = renderEditor();
    await act(() => result.current.openFile('a.ts'));
    act(() => {
      result.current.setFileContent('a typed');
      result.current.setIsDirty(true);
      result.current.setExternalChange(true);
      result.current.setMissingOnDisk(true);
    });

    await act(() => result.current.openFile('b.ts'));

    expect(result.current).toMatchObject({
      fileContent: 'b',
      isDirty: false,
      hasExternalChange: false,
      missingOnDisk: false,
    });
  });

  it('lets go of the file on reset', async () => {
    api.readImageFile.mockResolvedValueOnce({ data: 'aW1n', mimeType: 'image/png' });
    const { result } = renderEditor();
    await act(() => result.current.openFile('logo.png'));

    act(() => result.current.reset());

    expect(result.current).toMatchObject({
      filePath: null,
      fileContent: null,
      diskContent: null,
      isDirty: false,
      isImage: false,
      imageData: null,
      isBrowserPreviewable: false,
      isUnsupportedBinary: false,
      loadingFile: false,
      error: null,
    });
  });
});

describe('useFileEditorState edits and the disk', () => {
  async function openText(content: string) {
    api.readFile.mockResolvedValueOnce(content);
    const hook = renderEditor();
    await act(() => hook.result.current.openFile('src/a.ts'));
    return hook;
  }

  it('flags a change on disk under unsaved edits until the user keeps them', async () => {
    const { result } = await openText('v1');
    act(() => {
      result.current.setFileContent('v1 typed');
      result.current.setIsDirty(true);
      result.current.setExternalChange(true);
    });
    expect(result.current).toMatchObject({ isDirty: true, hasExternalChange: true });

    act(() => result.current.setExternalChange(false));

    expect(result.current).toMatchObject({
      isDirty: true,
      hasExternalChange: false,
      fileContent: 'v1 typed',
    });
  });

  it("takes the disk's text and drops the conflict when the user reloads", async () => {
    const { result } = await openText('v1');
    act(() => {
      result.current.setFileContent('v1 typed');
      result.current.setIsDirty(true);
      result.current.setExternalChange(true);
    });
    api.readFile.mockResolvedValueOnce('v2');

    await act(() => result.current.reloadFromDisk());

    expect(result.current).toMatchObject({
      fileContent: 'v2',
      diskContent: 'v2',
      isDirty: false,
      hasExternalChange: false,
    });
  });

  it('keeps the shown text of a file deleted from disk, and says it is missing', async () => {
    const { result } = await openText('v1');

    act(() => result.current.setMissingOnDisk(true));

    expect(result.current).toMatchObject({ fileContent: 'v1', missingOnDisk: true });
    act(() => result.current.setMissingOnDisk(false));
    expect(result.current.missingOnDisk).toBe(false);
  });

  it('shows a reload that finds the file deleted as missing', async () => {
    const { result } = await openText('v1');
    api.readFile.mockRejectedValueOnce(new Error('ENOENT'));

    await act(() => result.current.reloadFromDisk());

    expect(result.current).toMatchObject({ missingOnDisk: true, fileContent: null });
  });

  it('counts the dirty flag of a diff editor even with no file open', () => {
    const { result } = renderEditor();

    act(() => result.current.setIsDirty(true));

    expect(result.current.isDirty).toBe(true);
  });
});

describe('useFileEditorState reads that finish late', () => {
  it('keeps a reset buffer empty when the read it dropped finishes', async () => {
    const read = deferred<string>();
    api.readFile.mockReturnValueOnce(read.promise);
    const { result } = renderEditor();
    let opening: Promise<void> | undefined;
    act(() => {
      opening = result.current.openFile('a.ts');
    });

    act(() => result.current.reset());
    await act(async () => {
      read.resolve('a');
      await opening;
    });

    expect(result.current).toMatchObject({
      filePath: null,
      fileContent: null,
      diskContent: null,
      loadingFile: false,
    });
  });
});
