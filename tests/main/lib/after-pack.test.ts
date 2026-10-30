import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import afterPack from '../../../scripts/afterPack.cjs';

// electron-builder's Arch enum.
const X64 = 1;
const ARM64 = 3;

describe('afterPack ripgrep check', () => {
  let appOutDir: string;

  beforeEach(async () => {
    appOutDir = await mkdtemp(join(tmpdir(), 'komla-after-pack-'));
    // release.sh exports this, and it makes the hook swap in a cached native module.
    vi.stubEnv('NATIVE_MODULES_CACHE', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(appOutDir, { recursive: true, force: true });
  });

  function pack(electronPlatformName: string, arch: number) {
    return afterPack({
      appOutDir,
      arch,
      electronPlatformName,
      packager: { appInfo: { productFilename: 'Komla' } },
    });
  }

  async function shipRipgrep(resources: string, platformPackage: string, binary: string) {
    const file = join(
      appOutDir,
      resources,
      'app.asar.unpacked/node_modules/@vscode',
      platformPackage,
      'bin',
      binary
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '');
  }

  it.each([
    ['x64', X64],
    ['arm64', ARM64],
  ])('accepts a macOS %s app that ships its ripgrep', async (name, arch) => {
    await shipRipgrep('Komla.app/Contents/Resources', `ripgrep-darwin-${name}`, 'rg');

    await expect(pack('darwin', arch)).resolves.toBeUndefined();
  });

  it('rejects an Intel macOS app that only ships the Apple Silicon ripgrep', async () => {
    await shipRipgrep('Komla.app/Contents/Resources', 'ripgrep-darwin-arm64', 'rg');

    await expect(pack('darwin', X64)).rejects.toThrow(/ripgrep-darwin-x64/);
  });

  it('rejects an Apple Silicon macOS app that only ships the Intel ripgrep', async () => {
    await shipRipgrep('Komla.app/Contents/Resources', 'ripgrep-darwin-x64', 'rg');

    await expect(pack('darwin', ARM64)).rejects.toThrow(/ripgrep-darwin-arm64/);
  });

  it('accepts a Windows app that ships its ripgrep', async () => {
    await shipRipgrep('resources', 'ripgrep-win32-x64', 'rg.exe');

    await expect(pack('win32', X64)).resolves.toBeUndefined();
  });

  it('rejects a Windows app without its ripgrep', async () => {
    await shipRipgrep('resources', 'ripgrep-win32-arm64', 'rg.exe');

    await expect(pack('win32', X64)).rejects.toThrow(/ripgrep-win32-x64/);
  });
});
