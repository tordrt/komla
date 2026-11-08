import { describe, expect, it, vi } from 'vitest';

import {
  getDroppedFileAtPathInput,
  isDroppedRegularFile,
} from '../../../src/renderer/lib/file-drop';

describe('dropped files', () => {
  it('detects dropped files by resolved native path', () => {
    expect(isDroppedRegularFile('/tmp/upload')).toBe(true);
    expect(isDroppedRegularFile('')).toBe(false);
  });

  it('imports dropped files and builds their @path references', async () => {
    const png = new File([''], 'cat.png', { type: 'image/png' });
    const text = new File([''], 'notes.txt', { type: 'text/plain' });
    const getPathForFile = vi.fn((file: File) =>
      file.name === 'cat.png' ? '/Users/ada/cat.png' : '/Users/ada/notes.txt'
    );
    const importExternalFile = vi
      .fn()
      .mockResolvedValueOnce('.komla-files/cat.png')
      .mockResolvedValueOnce('.komla-files/notes.txt');

    await expect(
      getDroppedFileAtPathInput([png, text], getPathForFile, (sourcePath, preferredName) =>
        importExternalFile('/Users/ada/project', sourcePath, preferredName)
      )
    ).resolves.toBe('@.komla-files/cat.png @.komla-files/notes.txt ');
    expect(importExternalFile).toHaveBeenCalledWith(
      '/Users/ada/project',
      '/Users/ada/cat.png',
      'cat.png'
    );
    expect(importExternalFile).toHaveBeenCalledWith(
      '/Users/ada/project',
      '/Users/ada/notes.txt',
      'notes.txt'
    );
  });

  it('returns null when no dropped file has a native path', async () => {
    const text = new File([''], 'notes.txt', { type: 'text/plain' });
    await expect(
      getDroppedFileAtPathInput(
        [text],
        () => '',
        vi.fn().mockResolvedValue('.komla-files/notes.txt')
      )
    ).resolves.toBeNull();
  });

  it('returns null without an importer', async () => {
    const png = new File([''], 'cat.png', { type: 'image/png' });
    await expect(
      getDroppedFileAtPathInput([png], () => '/tmp/cat.png', undefined)
    ).resolves.toBeNull();
  });

  it('lets the user reject an unusually large dropped-file transfer before importing', async () => {
    const largeFile = new File([''], 'archive.zip');
    Object.defineProperty(largeFile, 'size', { value: 150 * 1024 * 1024 });
    const importExternalFile = vi.fn().mockResolvedValue('.komla-files/archive.zip');
    const confirmLargeTransfer = vi.fn().mockResolvedValue(false);

    await expect(
      getDroppedFileAtPathInput(
        [largeFile],
        () => '/tmp/archive.zip',
        importExternalFile,
        confirmLargeTransfer
      )
    ).resolves.toBeNull();

    expect(confirmLargeTransfer).toHaveBeenCalledWith([largeFile], 150 * 1024 * 1024);
    expect(importExternalFile).not.toHaveBeenCalled();
  });

  it('imports an unusually large dropped file after the user confirms', async () => {
    const largeFile = new File([''], 'archive.zip');
    Object.defineProperty(largeFile, 'size', { value: 150 * 1024 * 1024 });
    const importExternalFile = vi.fn().mockResolvedValue('.komla-files/archive.zip');

    await expect(
      getDroppedFileAtPathInput(
        [largeFile],
        () => '/tmp/archive.zip',
        importExternalFile,
        vi.fn().mockResolvedValue(true)
      )
    ).resolves.toBe('@.komla-files/archive.zip ');

    expect(importExternalFile).toHaveBeenCalledWith('/tmp/archive.zip', 'archive.zip');
  });
});
