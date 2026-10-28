import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readUserJsonObjectFile,
  writeUserConfigFile,
} from '../../../src/main/lib/user-config-file';

describe('user config files', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'komla-user-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats missing and blank files as empty objects', () => {
    const path = join(dir, 'config.json');
    expect(readUserJsonObjectFile(path)).toEqual({});
    writeFileSync(path, '  \n');
    expect(readUserJsonObjectFile(path)).toEqual({});
  });

  // Root ignores directory permissions, so the check only applies to regular users.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'throws instead of reporting a file in an unreadable directory as missing',
    () => {
      const locked = join(dir, 'locked');
      const path = join(locked, 'config.json');
      mkdirSync(locked);
      writeFileSync(path, '{"keep":true}');
      chmodSync(locked, 0o000);
      try {
        expect(() => readUserJsonObjectFile(path)).toThrow(/EACCES/);
      } finally {
        chmodSync(locked, 0o700);
      }
    }
  );

  it.each(['{"a": 1,}', '[]', 'null', '42'])('rejects %s and names the file', (contents) => {
    const path = join(dir, 'config.json');
    writeFileSync(path, contents);
    expect(() => readUserJsonObjectFile(path)).toThrow(path);
  });

  // Creating symlinks on Windows needs elevated privileges.
  it.skipIf(process.platform === 'win32')('writes through symlinks and keeps file permissions', () => {
    const target = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, link);

    writeUserConfigFile(link, '{"a":1}');

    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('creates the target of a dangling symlink', () => {
    const target = join(dir, 'missing.json');
    const link = join(dir, 'link.json');
    symlinkSync(target, link);

    writeUserConfigFile(link, '{}');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('{}');
  });

  // Root can write read-only files, so the check only applies to regular users.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses to replace a read-only file',
    () => {
      const path = join(dir, 'locked.json');
      writeFileSync(path, '{"keep":true}');
      chmodSync(path, 0o444);

      expect(() => writeUserConfigFile(path, '{}')).toThrow(/EACCES/);
      expect(readFileSync(path, 'utf-8')).toBe('{"keep":true}');
    }
  );
});
