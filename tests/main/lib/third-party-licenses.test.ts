import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = join(tmpdir(), `komla-third-party-licenses-${process.pid}`);
const nodeModules = join(root, 'node_modules');

async function writePackage(
  directory: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {}
): Promise<void> {
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content);
  }
}

function chunk(moduleIds: string[]) {
  return {
    type: 'chunk',
    modules: Object.fromEntries(moduleIds.map((id) => [id, { renderedLength: 1 }])),
  };
}

async function generate(bundle: Record<string, unknown>) {
  const { thirdPartyLicenses } = await import('../../../scripts/third-party-licenses.mjs');
  const plugin = thirdPartyLicenses();
  const emitFile = vi.fn();
  plugin.generateBundle.call({ emitFile }, {}, bundle);
  return emitFile;
}

describe('third-party license notices for bundled packages', () => {
  beforeEach(async () => {
    await writePackage(
      join(nodeModules, 'react'),
      { name: 'react', version: '19.3.0', license: 'MIT' },
      { LICENSE: 'MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.' }
    );
    await writePackage(
      join(nodeModules, '@pierre', 'trees'),
      { name: '@pierre/trees', version: '1.0.0', license: 'Apache-2.0' },
      { 'LICENSE.md': 'Apache License 2.0 text', NOTICE: 'Copyright Pierre' }
    );
    await writePackage(
      join(nodeModules, '@pierre', 'trees', 'node_modules', 'preact'),
      { name: 'preact', version: '10.0.0', license: 'MIT' },
      { LICENSE: 'The MIT License (MIT) Copyright (c) Jason Miller' }
    );
    await writePackage(
      join(nodeModules, 'monaco-editor'),
      { name: 'monaco-editor', version: '0.55.1', license: 'MIT' },
      {
        LICENSE: 'Copyright (c) Microsoft Corporation',
        'ThirdPartyNotices.txt': 'TypeScript notice',
      }
    );
    await writePackage(join(nodeModules, 'no-license-file'), {
      name: 'no-license-file',
      version: '2.0.0',
      licenses: [{ type: 'ISC' }],
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes each bundled package once, with its license text', async () => {
    const emitFile = await generate({
      'index.js': chunk([
        join(nodeModules, 'react', 'index.js'),
        join(nodeModules, 'react', 'cjs', 'react.production.js'),
        // Rollup's commonjs wrappers use a \0 prefix and a query.
        `\0${join(nodeModules, 'react', 'index.js')}?commonjs-module`,
        join(nodeModules, '@pierre', 'trees', 'dist', 'index.js'),
        join(nodeModules, '@pierre', 'trees', 'node_modules', 'preact', 'dist', 'preact.mjs'),
        join(root, 'src', 'renderer', 'App.tsx'),
        // Workspace packages resolve outside node_modules; they are Komla's own code.
        join(root, 'packages', 'remote-protocol', 'src', 'index.ts'),
      ]),
      'style.css': { type: 'asset', source: '' },
    });

    expect(emitFile).toHaveBeenCalledTimes(1);
    const { fileName, source, type } = emitFile.mock.calls[0][0];
    expect(type).toBe('asset');
    expect(fileName).toBe('THIRD_PARTY_LICENSES.txt');
    expect(source.match(/^react 19\.3\.0 \(MIT\)$/gm)).toHaveLength(1);
    expect(source).toContain('Copyright (c) Meta Platforms, Inc. and affiliates.');
    expect(source).toContain('@pierre/trees 1.0.0 (Apache-2.0)');
    expect(source).toContain('Apache License 2.0 text');
    expect(source).toContain('Copyright Pierre');
    expect(source).toContain('preact 10.0.0 (MIT)');
    expect(source).not.toContain('remote-protocol');
  });

  it('includes third-party notice files that packages carry for their own bundled code', async () => {
    const emitFile = await generate({
      'editor.js': chunk([join(nodeModules, 'monaco-editor', 'esm', 'editor.api.js')]),
    });

    expect(emitFile.mock.calls[0][0].source).toContain('TypeScript notice');
  });

  it('names packages that publish no license file', async () => {
    const emitFile = await generate({
      'index.js': chunk([join(nodeModules, 'no-license-file', 'index.js')]),
    });

    expect(emitFile.mock.calls[0][0].source).toContain(
      'no-license-file 2.0.0 (ISC)\n' + '-'.repeat(80) + '\n\nNo license file in the package.'
    );
  });

  it('writes nothing for a bundle without third-party packages', async () => {
    const emitFile = await generate({
      'preload.cjs': chunk([join(root, 'src', 'preload', 'index.ts')]),
    });

    expect(emitFile).not.toHaveBeenCalled();
  });
});
