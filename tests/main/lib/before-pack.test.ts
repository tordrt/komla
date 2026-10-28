import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoot = join(tmpdir(), `komla-before-pack-${process.pid}`);

describe('Komla packaging preflight', () => {
  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('rejects packaging when the bundled CLI matrix is incomplete', async () => {
    const { default: beforePack } = await import('../../../scripts/beforePack.cjs');

    await expect(beforePack({ packager: { projectDir: temporaryRoot } })).rejects.toThrow(
      'Run npm run build:native:matrix'
    );
  });

  it('accepts packaging when every bundled CLI artifact exists', async () => {
    const artifacts = [
      ['x86_64-unknown-linux-musl', 'komla'],
      ['aarch64-unknown-linux-musl', 'komla'],
      ['x86_64-apple-darwin', 'komla'],
      ['aarch64-apple-darwin', 'komla'],
      ['x86_64-pc-windows-msvc', 'komla.exe'],
      ['aarch64-pc-windows-msvc', 'komla.exe'],
    ];
    await Promise.all(
      artifacts.map(async ([target, executable]) => {
        const directory = join(temporaryRoot, 'native', 'artifacts', target);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, executable), 'binary');
      })
    );
    const { default: beforePack } = await import('../../../scripts/beforePack.cjs');

    await expect(beforePack({ packager: { projectDir: temporaryRoot } })).resolves.toBeUndefined();
  });
});
