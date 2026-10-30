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

  async function writeArtifacts(): Promise<void> {
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
  }

  it('rejects packaging a development build of the bundled CLI', async () => {
    await writeArtifacts();
    await writeFile(
      join(temporaryRoot, 'native', 'artifacts', 'x86_64-unknown-linux-musl', '.dev-build'),
      ''
    );
    const { default: beforePack } = await import('../../../scripts/beforePack.cjs');

    await expect(beforePack({ packager: { projectDir: temporaryRoot } })).rejects.toThrow(
      /development builds[\s\S]*x86_64-unknown-linux-musl[\s\S]*Run npm run build:native:matrix/
    );
  });

  it('accepts packaging when every bundled CLI artifact exists', async () => {
    await writeArtifacts();
    const { default: beforePack } = await import('../../../scripts/beforePack.cjs');

    await expect(beforePack({ packager: { projectDir: temporaryRoot } })).resolves.toBeUndefined();
  });
});
