import { join } from 'path';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVirtualFs } from '../../mocks/fs';

// Create virtual filesystem before mocking
const vfs = createVirtualFs({
  '/mock/home/.komla/config.json': '{"existing": true}',
});

vi.mock('fs', () => vfs.mock);
vi.mock('fs/promises', () => vfs.mock.promises);
vi.mock('crypto', () => ({
  randomBytes: () => Buffer.from('aabbccddeeff', 'hex'),
}));

describe('atomic-write', () => {
  beforeEach(() => {
    vi.resetModules();
    vfs.clear();
    // Reset all mocks to default behavior
    vi.clearAllMocks();
  });

  describe('writeFileAtomicSync', () => {
    it('should write to temp file then rename to target', async () => {
      // Set up virtual filesystem
      vfs.setFile('/mock/home/.komla/config.json', '{"old": true}');

      const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');

      const data = '{"new": true}';
      writeFileAtomicSync('/mock/home/.komla/config.json', data);

      // Verify the temp file was created and then renamed
      expect(vfs.mock.mkdirSync).toHaveBeenCalledWith('/mock/home/.komla', { recursive: true });
      expect(vfs.mock.openSync).toHaveBeenCalledWith(
        '/mock/home/.komla/config.json.aabbccddeeff.tmp',
        'w'
      );
      expect(vfs.mock.writeFileSync).toHaveBeenCalledWith(expect.any(Number), data, 'utf-8');
      expect(vfs.mock.fsyncSync).toHaveBeenCalled();
      expect(vfs.mock.closeSync).toHaveBeenCalled();
      expect(vfs.mock.renameSync).toHaveBeenCalledWith(
        '/mock/home/.komla/config.json.aabbccddeeff.tmp',
        '/mock/home/.komla/config.json'
      );
    });

    it('should clean up temp file on write error', async () => {
      // Make writeFileSync throw an error
      const writeError = new Error('Write failed');
      vfs.mock.writeFileSync.mockImplementationOnce(() => {
        throw writeError;
      });
      vfs.mock.existsSync.mockReturnValue(true);

      const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');

      expect(() => writeFileAtomicSync('/mock/path/file.json', 'data')).toThrow('Write failed');

      // Verify cleanup was attempted
      expect(vfs.mock.unlinkSync).toHaveBeenCalledWith('/mock/path/file.json.aabbccddeeff.tmp');
    });

    it('should clean up temp file on rename error', async () => {
      // Make renameSync throw an error
      const renameError = new Error('Rename failed');
      vfs.mock.renameSync.mockImplementationOnce(() => {
        throw renameError;
      });
      vfs.mock.existsSync.mockReturnValue(true);

      const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');

      expect(() => writeFileAtomicSync('/mock/path/file.json', 'data')).toThrow('Rename failed');

      // Verify cleanup was attempted
      expect(vfs.mock.unlinkSync).toHaveBeenCalledWith('/mock/path/file.json.aabbccddeeff.tmp');
    });

    it('validates a guarded replacement after staging and before rename', async () => {
      vfs.mock.existsSync.mockReturnValue(true);
      const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');
      const validate = vi.fn(() => {
        expect(vfs.mock.fsyncSync).toHaveBeenCalled();
        expect(vfs.mock.renameSync).not.toHaveBeenCalled();
        throw new Error('revision changed');
      });

      expect(() =>
        writeFileAtomicSync('/mock/path/file.json', 'data', undefined, validate)
      ).toThrow('revision changed');

      expect(validate).toHaveBeenCalledOnce();
      expect(vfs.mock.renameSync).not.toHaveBeenCalled();
      expect(vfs.mock.unlinkSync).toHaveBeenCalledWith('/mock/path/file.json.aabbccddeeff.tmp');
    });

    it('should ignore EPERM fsync errors on Windows', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const epermError = Object.assign(new Error('EPERM: operation not permitted, fsync'), {
        code: 'EPERM',
      });
      vfs.mock.fsyncSync.mockImplementationOnce(() => {
        throw epermError;
      });

      const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');

      // Should not throw — EPERM from fsync is tolerated on Windows
      writeFileAtomicSync('/mock/home/.komla/config.json', '{"ok": true}');

      // Rename should still happen
      expect(vfs.mock.renameSync).toHaveBeenCalledWith(
        '/mock/home/.komla/config.json.aabbccddeeff.tmp',
        '/mock/home/.komla/config.json'
      );

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('should rethrow non-EPERM fsync errors on Windows', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const eioError = Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
      vfs.mock.fsyncSync.mockImplementationOnce(() => {
        throw eioError;
      });
      vfs.mock.existsSync.mockReturnValue(true);

      const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');

      expect(() => writeFileAtomicSync('/mock/path/file.json', 'data')).toThrow('EIO');

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    it('should rethrow EPERM fsync errors on non-Windows platforms', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      const epermError = Object.assign(new Error('EPERM: operation not permitted, fsync'), {
        code: 'EPERM',
      });
      vfs.mock.fsyncSync.mockImplementationOnce(() => {
        throw epermError;
      });
      vfs.mock.existsSync.mockReturnValue(true);

      const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');

      expect(() => writeFileAtomicSync('/mock/path/file.json', 'data')).toThrow('EPERM');

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
  });

  describe('writeFileAtomic', () => {
    it('should write to temp file then rename to target asynchronously', async () => {
      const { writeFileAtomic } = await import('../../../src/main/lib/atomic-write');

      const data = '{"async": true}';
      await writeFileAtomic('/mock/home/.komla/async.json', data);

      // Verify the temp file was created and then renamed
      expect(vfs.mock.promises.mkdir).toHaveBeenCalledWith('/mock/home/.komla', {
        recursive: true,
      });
      expect(vfs.mock.promises.open).toHaveBeenCalledWith(
        '/mock/home/.komla/async.json.aabbccddeeff.tmp',
        'w'
      );
      expect(vfs.mock.promises.rename).toHaveBeenCalledWith(
        '/mock/home/.komla/async.json.aabbccddeeff.tmp',
        '/mock/home/.komla/async.json'
      );
    });

    it('should clean up temp file on async write error', async () => {
      // Make handle.writeFile throw an error
      const writeError = new Error('Async write failed');
      vfs.mock.promises.open.mockResolvedValueOnce({
        writeFile: vi.fn(() => Promise.reject(writeError)),
        sync: vi.fn(() => Promise.resolve()),
        close: vi.fn(() => Promise.resolve()),
      });

      const { writeFileAtomic } = await import('../../../src/main/lib/atomic-write');

      await expect(writeFileAtomic('/mock/path/file.json', 'data')).rejects.toThrow(
        'Async write failed'
      );

      // Verify cleanup was attempted
      expect(vfs.mock.promises.unlink).toHaveBeenCalledWith(
        '/mock/path/file.json.aabbccddeeff.tmp'
      );
    });
  });

  describe('concurrent write safety', () => {
    it('should use distinct temp paths for concurrent async writes', async () => {
      // Use a counter-based mock so each call returns a different value
      let callCount = 0;
      const crypto = await import('crypto');
      Object.defineProperty(crypto, 'randomBytes', {
        value: () => Buffer.from(`00000000000${callCount++}`.slice(-12), 'hex'),
        configurable: true,
      });

      const openedPaths: string[] = [];
      vfs.mock.promises.open.mockImplementation((path: string) => {
        openedPaths.push(path);
        // Register the file in VFS so rename can find it
        vfs.setFile(path, '');
        return Promise.resolve({
          writeFile: vi.fn((data: string) => {
            vfs.setFile(path, data);
            return Promise.resolve();
          }),
          sync: vi.fn(() => Promise.resolve()),
          close: vi.fn(() => Promise.resolve()),
        });
      });

      const { writeFileAtomic } = await import('../../../src/main/lib/atomic-write');

      // Fire two concurrent writes to the same file
      await Promise.all([
        writeFileAtomic('/mock/home/.komla/data.json', '{"a":1}'),
        writeFileAtomic('/mock/home/.komla/data.json', '{"b":2}'),
      ]);

      // Both should have opened temp files, and they must be different
      const tmpPaths = openedPaths.filter((p) => p.endsWith('.tmp'));
      expect(tmpPaths).toHaveLength(2);
      expect(tmpPaths[0]).not.toBe(tmpPaths[1]);
    });
  });

  describe('cleanupTmpFilesRecursive', () => {
    it('should delete .tmp files in the directory', async () => {
      // Set up directory structure with .tmp files
      vfs.mock.existsSync.mockReturnValue(true);
      vfs.mock.readdirSync.mockReturnValue(['config.json', 'config.json.tmp', 'workspaces.json']);
      vfs.mock.statSync.mockImplementation(() => ({
        isDirectory: () => false,
        isFile: () => true,
        size: 100,
        mtime: new Date(),
      }));

      const { cleanupTmpFilesRecursive } = await import('../../../src/main/lib/atomic-write');

      cleanupTmpFilesRecursive('/mock/home/.komla');

      // Should only delete .tmp files
      const dir = '/mock/home/.komla';
      expect(vfs.mock.unlinkSync).toHaveBeenCalledWith(join(dir, 'config.json.tmp'));
      expect(vfs.mock.unlinkSync).not.toHaveBeenCalledWith(join(dir, 'config.json'));
      expect(vfs.mock.unlinkSync).not.toHaveBeenCalledWith(join(dir, 'workspaces.json'));
    });

    it('should recurse into subdirectories', async () => {
      vfs.mock.existsSync.mockReturnValue(true);
      vfs.mock.readdirSync
        .mockReturnValueOnce(['settings', 'orphaned.tmp'])
        .mockReturnValueOnce(['theme.json.tmp']);
      vfs.mock.statSync.mockImplementation((path: string) => ({
        isDirectory: () => path.endsWith('settings'),
        isFile: () => !path.endsWith('settings'),
        size: 100,
        mtime: new Date(),
      }));

      const { cleanupTmpFilesRecursive } = await import('../../../src/main/lib/atomic-write');

      cleanupTmpFilesRecursive('/mock/home/.komla');

      // Should clean up both the top-level .tmp and the nested one
      const dir = '/mock/home/.komla';
      expect(vfs.mock.unlinkSync).toHaveBeenCalledWith(join(dir, 'orphaned.tmp'));
      expect(vfs.mock.unlinkSync).toHaveBeenCalledWith(join(dir, 'settings', 'theme.json.tmp'));
    });

    it('should not fail if directory does not exist', async () => {
      vfs.mock.existsSync.mockReturnValue(false);

      const { cleanupTmpFilesRecursive } = await import('../../../src/main/lib/atomic-write');

      // Should not throw
      expect(() => cleanupTmpFilesRecursive('/nonexistent')).not.toThrow();
    });

    it('should continue on unlink errors', async () => {
      vfs.mock.existsSync.mockReturnValue(true);
      vfs.mock.readdirSync.mockReturnValue(['file1.tmp', 'file2.tmp']);
      vfs.mock.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 100,
        mtime: new Date(),
      });
      // First unlink fails, second succeeds
      vfs.mock.unlinkSync
        .mockImplementationOnce(() => {
          throw new Error('Permission denied');
        })
        .mockImplementationOnce(() => {});

      const { cleanupTmpFilesRecursive } = await import('../../../src/main/lib/atomic-write');

      // Should not throw, should continue to next file
      expect(() => cleanupTmpFilesRecursive('/mock/home/.komla')).not.toThrow();
      expect(vfs.mock.unlinkSync).toHaveBeenCalledTimes(2);
    });
  });
});
