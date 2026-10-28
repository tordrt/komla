import { describe, expect, it } from 'vitest';

interface Advisory {
  title: string;
  severity: string;
  url: string;
}

function advisory(name: string, severity: string, nodes: string[]) {
  const via: Advisory[] = [
    { title: `${name} is vulnerable`, severity, url: `https://example.test/${name}` },
  ];
  return { name, severity, isDirect: false, via, effects: [], range: '*', nodes };
}

const packageJson = {
  dependencies: { 'node-pty': '^1.0.0', '@komla/remote-protocol': '*' },
  optionalDependencies: { 'optional-native': '^3.0.0' },
  devDependencies: {
    vite: '^7.0.0',
    dompurify: '^3.0.0',
    '@xterm/xterm': '^6.0.0',
    'monaco-editor': '^0.55.0',
    '@pierre/trees': '^1.0.0',
    'type-only-lib': '^1.0.0',
    electron: '^44.0.0',
    'commented-lib': '^1.0.0',
    'dynamic-comment-lib': '^1.0.0',
    'backtick-lib': '^1.0.0',
    'same-line-lib': '^1.0.0',
    'css-lib': '^1.0.0',
  },
};

const lockfile = {
  packages: {
    '': packageJson,
    'node_modules/node-pty': { dependencies: { 'node-addon-api': '^7.0.0' } },
    'node_modules/node-addon-api': {},
    'node_modules/@komla/remote-protocol': { resolved: 'packages/remote-protocol', link: true },
    'packages/remote-protocol': { dependencies: { 'workspace-only-dep': '^1.0.0' } },
    'node_modules/workspace-only-dep': {},
    'node_modules/vite': { dependencies: { esbuild: '^0.25.0' } },
    'node_modules/esbuild': {},
    'node_modules/dompurify': {},
    'node_modules/@xterm/xterm': {},
    'node_modules/monaco-editor': {},
    'node_modules/@pierre/trees': { dependencies: { preact: '^10.0.0', 'tiny-hoisted': '^1.0.0' } },
    'node_modules/@pierre/trees/node_modules/preact': {},
    'node_modules/preact': {},
    'node_modules/tiny-hoisted': {},
    'node_modules/type-only-lib': {},
    'node_modules/commented-lib': {},
    'node_modules/dynamic-comment-lib': {},
    'node_modules/backtick-lib': {},
    'node_modules/same-line-lib': {},
    'node_modules/css-lib': {},
    'node_modules/electron': { dependencies: { '@electron/get': '^4.0.0' } },
    'node_modules/@electron/get': {},
    'node_modules/optional-native': { dependencies: { 'prebuild-install': '^7.0.0' } },
    'node_modules/prebuild-install': {},
    // A workspace no root dependency names, such as the remote-control web app.
    'node_modules/remote-app': { resolved: 'remote-app', link: true },
    'remote-app': {
      dependencies: { 'remote-app-dep': '^1.0.0' },
      devDependencies: { 'remote-app-tooling': '^1.0.0' },
    },
    'node_modules/remote-app-dep': {},
    'node_modules/remote-app-tooling': {},
  },
};

const sources = [
  {
    path: 'src/renderer/lib/sanitize.ts',
    content: [
      "import DOMPurify from 'dompurify';",
      "import '@xterm/xterm/css/xterm.css';",
      "import { Button } from '@/components/ui/button';",
      "import type { Options } from 'type-only-lib';",
      "const worker = import('monaco-editor/esm/vs/editor/editor.worker?worker');",
    ].join('\n'),
  },
  {
    path: 'src/renderer/components/FileTree.tsx',
    content: "import { FileTree } from '@pierre/trees';\nimport fs from 'node:fs';",
  },
  { path: 'src/main/index.ts', content: "import { app } from 'electron';" },
  {
    path: 'src/renderer/lib/edge-cases.ts',
    content: [
      'import {',
      "  // don't touch: the apostrophe must not end the import",
      '  thing,',
      "} from 'commented-lib';",
      "const lazy = import(/* @vite-ignore */ 'dynamic-comment-lib');",
      'const tick = import(`backtick-lib`);',
      "import a from 'react'; import b from 'same-line-lib';",
      "const url = 'https://example.test/path'; // import('not-a-package')",
    ].join('\n'),
  },
  { path: 'src/renderer/styles/extra.css', content: "@import 'css-lib/dist/style.css';" },
];

async function findShipped(vulnerabilities: Record<string, ReturnType<typeof advisory>>) {
  const { findShippedVulnerabilities } = await import('../../../scripts/audit-shipped-deps.mjs');
  return findShippedVulnerabilities({
    packageJson,
    lockfile,
    sources,
    auditReport: { auditReportVersion: 2, vulnerabilities },
  });
}

describe('release audit of shipped dependencies', () => {
  it('blocks a high advisory in a runtime dependency', async () => {
    const result = await findShipped({
      'node-pty': advisory('node-pty', 'high', ['node_modules/node-pty']),
    });

    expect(result.blocking.map((finding: { name: string }) => finding.name)).toEqual(['node-pty']);
  });

  it('blocks a high advisory in a devDependency that src/ imports, since it is bundled', async () => {
    const result = await findShipped({
      dompurify: advisory('dompurify', 'high', ['node_modules/dompurify']),
      'monaco-editor': advisory('monaco-editor', 'critical', ['node_modules/monaco-editor']),
      '@xterm/xterm': advisory('@xterm/xterm', 'high', ['node_modules/@xterm/xterm']),
    });

    expect(result.blocking.map((finding: { name: string }) => finding.name).sort()).toEqual([
      '@xterm/xterm',
      'dompurify',
      'monaco-editor',
    ]);
  });

  it("blocks a high advisory in a shipped package's own dependencies, nested or hoisted", async () => {
    const result = await findShipped({
      preact: advisory('preact', 'high', ['node_modules/@pierre/trees/node_modules/preact']),
      'tiny-hoisted': advisory('tiny-hoisted', 'high', ['node_modules/tiny-hoisted']),
      'node-addon-api': advisory('node-addon-api', 'high', ['node_modules/node-addon-api']),
    });

    expect(result.blocking.map((finding: { name: string }) => finding.name).sort()).toEqual([
      'node-addon-api',
      'preact',
      'tiny-hoisted',
    ]);
  });

  it('follows workspace links to the linked package dependencies', async () => {
    const result = await findShipped({
      'workspace-only-dep': advisory('workspace-only-dep', 'high', [
        'node_modules/workspace-only-dep',
      ]),
    });

    expect(result.blocking.map((finding: { name: string }) => finding.name)).toEqual([
      'workspace-only-dep',
    ]);
  });

  it('keeps covering optional dependencies and their dependencies', async () => {
    const result = await findShipped({
      'prebuild-install': advisory('prebuild-install', 'high', ['node_modules/prebuild-install']),
    });

    expect(result.blocking.map((finding: { name: string }) => finding.name)).toEqual([
      'prebuild-install',
    ]);
  });

  it("covers workspace packages' runtime dependencies but not their tooling", async () => {
    const result = await findShipped({
      'remote-app-dep': advisory('remote-app-dep', 'high', ['node_modules/remote-app-dep']),
      'remote-app-tooling': advisory('remote-app-tooling', 'high', [
        'node_modules/remote-app-tooling',
      ]),
    });

    expect(result.blocking.map((finding: { name: string }) => finding.name)).toEqual([
      'remote-app-dep',
    ]);
    expect(result.ignored.map((finding: { name: string }) => finding.name)).toEqual([
      'remote-app-tooling',
    ]);
  });

  it('ignores advisories in build tooling that src/ never imports', async () => {
    const result = await findShipped({
      esbuild: advisory('esbuild', 'high', ['node_modules/esbuild']),
      // The hoisted copy is unreachable: @pierre/trees resolves its nested preact.
      preact: advisory('preact', 'high', ['node_modules/preact']),
    });

    expect(result.blocking).toEqual([]);
    expect(result.ignored.map((finding: { name: string }) => finding.name).sort()).toEqual([
      'esbuild',
      'preact',
    ]);
  });

  it("counts Electron's own advisories but not its downloader's dependencies", async () => {
    const result = await findShipped({
      electron: advisory('electron', 'high', ['node_modules/electron']),
      '@electron/get': advisory('@electron/get', 'high', ['node_modules/@electron/get']),
    });

    expect(result.blocking.map((finding: { name: string }) => finding.name)).toEqual(['electron']);
    expect(result.ignored.map((finding: { name: string }) => finding.name)).toEqual([
      '@electron/get',
    ]);
  });

  it('ignores packages that src/ imports only as types', async () => {
    const result = await findShipped({
      'type-only-lib': advisory('type-only-lib', 'high', ['node_modules/type-only-lib']),
    });

    expect(result.blocking).toEqual([]);
  });

  it('ignores moderate and low advisories, even in shipped packages', async () => {
    const result = await findShipped({
      dompurify: advisory('dompurify', 'moderate', ['node_modules/dompurify']),
      'node-pty': advisory('node-pty', 'low', ['node_modules/node-pty']),
    });

    expect(result.blocking).toEqual([]);
    expect(result.ignored).toEqual([]);
  });

  it('judges a package by its own advisories, not the ones it inherits', async () => {
    const result = await findShipped({
      '@pierre/trees': {
        ...advisory('@pierre/trees', 'moderate', ['node_modules/@pierre/trees']),
        severity: 'high',
        via: [
          { title: 'trees is vulnerable', severity: 'moderate', url: 'https://example.test/t' },
          'preact',
        ] as unknown as Advisory[],
      },
    });

    expect(result.blocking).toEqual([]);
  });

  it('finds imports that comments, backticks, shared lines and CSS would hide', async () => {
    const names = [
      'commented-lib',
      'dynamic-comment-lib',
      'backtick-lib',
      'same-line-lib',
      'css-lib',
    ];
    const result = await findShipped(
      Object.fromEntries(
        names.map((name) => [name, advisory(name, 'high', [`node_modules/${name}`])])
      )
    );

    expect(result.blocking.map((finding: { name: string }) => finding.name).sort()).toEqual(
      [...names].sort()
    );
  });

  it('asks npm to audit devDependencies even when npm is configured to omit them', async () => {
    const { NPM_AUDIT_ARGS } = await import('../../../scripts/audit-shipped-deps.mjs');

    expect(NPM_AUDIT_ARGS).toContain('--include=dev');
  });

  it('refuses an audit report it cannot read, so the release stops', async () => {
    const { findShippedVulnerabilities } = await import('../../../scripts/audit-shipped-deps.mjs');

    expect(() =>
      findShippedVulnerabilities({
        packageJson,
        lockfile,
        sources,
        // npm's shape when the registry is unreachable.
        auditReport: {
          message: 'request to https://registry.example/-/npm/v1/security/advisories/bulk failed',
          error: { summary: '', detail: '' },
        },
      })
    ).toThrow('npm audit did not return a report: request to https://registry.example/');
  });
});
