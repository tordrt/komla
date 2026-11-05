import { execFileSync } from 'child_process';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { tarArchive } from '../../../src/main/lib/tar-archive';

const folders: string[] = [];

function extract(archive: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'komla-tar-'));
  folders.push(dir);
  writeFileSync(join(dir, '.archive.tar'), archive);
  execFileSync('tar', ['-xf', '.archive.tar'], { cwd: dir });
  rmSync(join(dir, '.archive.tar'));
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('tarArchive', () => {
  // Windows has no executable bit, and links need its Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'holds folders, files with their executable bit, and links',
    () => {
      const dir = extract(
        tarArchive([
          { kind: 'directory', path: 'bin' },
          { kind: 'file', path: 'bin/run.sh', content: Buffer.from('echo hi\n'), executable: true },
          { kind: 'file', path: 'komla-plugin.json', content: Buffer.from('{}') },
          { kind: 'link', path: 'run.sh', target: 'bin/run.sh' },
        ])
      );

      expect(readFileSync(join(dir, 'bin/run.sh'), 'utf8')).toBe('echo hi\n');
      expect(lstatSync(join(dir, 'bin/run.sh')).mode & 0o100).toBe(0o100);
      expect(lstatSync(join(dir, 'komla-plugin.json')).mode & 0o100).toBe(0);
      expect(readlinkSync(join(dir, 'run.sh'))).toBe('bin/run.sh');
      expect(readFileSync(join(dir, 'run.sh'), 'utf8')).toBe('echo hi\n');
    }
  );

  it("keeps paths too long for a tar header's name, and ones that aren't ASCII", () => {
    const deep = `${'a'.repeat(120)}/${'b'.repeat(120)}/${'c'.repeat(80)}.js`;
    const dir = extract(
      tarArchive([
        { kind: 'directory', path: 'a'.repeat(120) },
        { kind: 'directory', path: `${'a'.repeat(120)}/${'b'.repeat(120)}` },
        { kind: 'file', path: deep, content: Buffer.from('deep') },
        { kind: 'file', path: 'grüße.txt', content: Buffer.from('hallo') },
      ])
    );

    expect(readFileSync(join(dir, deep), 'utf8')).toBe('deep');
    expect(readFileSync(join(dir, 'grüße.txt'), 'utf8')).toBe('hallo');
  });

  it('keeps an empty file and one that fills its last block exactly', () => {
    const dir = extract(
      tarArchive([
        { kind: 'file', path: 'empty', content: Buffer.alloc(0) },
        { kind: 'file', path: 'block', content: Buffer.alloc(1024, 'x') },
      ])
    );

    expect(readFileSync(join(dir, 'empty'))).toHaveLength(0);
    expect(readFileSync(join(dir, 'block'), 'utf8')).toBe('x'.repeat(1024));
  });
});
