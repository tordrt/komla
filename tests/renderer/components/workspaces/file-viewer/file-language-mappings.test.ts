import { describe, expect, it } from 'vitest';

import {
  getFileLanguage,
  getShikiLanguage,
  hasBuiltInLanguageIntelligence,
  SHIKI_BUNDLED_LANGUAGES,
} from '../../../../../src/renderer/components/workspaces/file-viewer/file-viewer-utils';

describe('getFileLanguage', () => {
  it('keeps worker-backed JSON service mapping stable for jsonc files', () => {
    expect(getFileLanguage('config/settings.jsonc')).toBe('json');
  });

  it('maps Vue and Svelte files to the existing Monaco service language', () => {
    expect(getFileLanguage('components/App.vue')).toBe('html');
    expect(getFileLanguage('components/App.svelte')).toBe('html');
  });

  it('maps shell and TOML files to Monaco service languages', () => {
    expect(getFileLanguage('scripts/build.sh')).toBe('shell');
    expect(getFileLanguage('config/settings.toml')).toBe('ini');
  });
});

describe('getShikiLanguage', () => {
  it('returns jsonc for jsonc files', () => {
    expect(getShikiLanguage('config/settings.jsonc', 'json')).toBe('jsonc');
  });

  it.each([
    'tsconfig.json',
    'packages/app/tsconfig.build.json',
    'jsconfig.json',
    '.vscode/settings.json',
    '.vscode/launch.json',
    '.devcontainer/devcontainer.json',
    '.devcontainer.json',
  ])('treats %s as JSON with Comments', (path) => {
    expect(getShikiLanguage(path, 'json')).toBe('jsonc');
  });

  it('colors TSX with the TSX grammar, which understands JSX text', () => {
    expect(getShikiLanguage('src/App.tsx', 'typescript')).toBe('tsx');
    expect(SHIKI_BUNDLED_LANGUAGES).toContain('tsx');
  });

  it('keeps JSX on the JavaScript grammar, which already understands JSX', () => {
    expect(getShikiLanguage('src/App.jsx', 'javascript')).toBe('javascript');
  });

  it('keeps plain JSON and INI files on their native grammars', () => {
    expect(getShikiLanguage('package.json', 'json')).toBe('json');
    expect(getShikiLanguage('src/vscode/settings.json', 'json')).toBe('json');
    expect(getShikiLanguage('config/settings.json', 'json')).toBe('json');
    expect(getShikiLanguage('config/settings.ini', 'ini')).toBe('ini');
  });

  it('returns dedicated grammar ids for framework files', () => {
    expect(getShikiLanguage('components/App.vue', 'html')).toBe('vue');
    expect(getShikiLanguage('components/App.svelte', 'html')).toBe('svelte');
  });

  it('returns dedicated grammar ids for shell-family files', () => {
    expect(getShikiLanguage('scripts/build.sh', 'shell')).toBe('shellscript');
    expect(getShikiLanguage('shell/config.fish', 'shell')).toBe('fish');
  });

  it('returns dedicated grammar ids for TOML, Solidity, and assembly files', () => {
    expect(getShikiLanguage('config/settings.toml', 'ini')).toBe('toml');
    expect(getShikiLanguage('contracts/Token.sol', 'sol')).toBe('solidity');
    expect(getShikiLanguage('src/startup.asm', 'mips')).toBe('asm');
  });

  it('falls back to the Monaco language id when no override is needed', () => {
    expect(getShikiLanguage('src/index.ts', 'typescript')).toBe('typescript');
    expect(getShikiLanguage('README.md', 'markdown')).toBe('markdown');
  });
});

describe('editor language', () => {
  const editorLanguage = (path: string) => getShikiLanguage(path, getFileLanguage(path));

  it.each([
    ['src/env.mts', 'typescript'],
    ['vite.config.cts', 'typescript'],
    ['docs/intro.mdx', 'mdx'],
    ['styles/main.sass', 'sass'],
    ['src/pages/index.astro', 'astro'],
    ['infra/main.tf', 'terraform'],
    ['infra/prod.tfvars', 'terraform'],
    ['.env', 'dotenv'],
    ['.env.local', 'dotenv'],
    ['apps/web/.env.example', 'dotenv'],
    ['.envrc', 'shellscript'],
    ['changes.diff', 'diff'],
    ['0001-fix-login.patch', 'diff'],
    ['flake.nix', 'nix'],
    ['prisma/schema.prisma', 'prisma'],
    ['CMakeLists.txt', 'cmake'],
    ['cmake/deps.cmake', 'cmake'],
    ['app/build.gradle', 'groovy'],
    ['Jenkinsfile', 'groovy'],
    ['lib/parser.ml', 'ocaml'],
    ['lib/parser.mli', 'ocaml'],
    ['shaders/blur.glsl', 'glsl'],
    ['shaders/blur.frag', 'glsl'],
    ['shaders/blur.vert', 'glsl'],
    ['shaders/blur.wgsl', 'wgsl'],
    ['config.json5', 'json5'],
    ['events.jsonl', 'jsonl'],
    ['events.ndjson', 'jsonl'],
    ['data.csv', 'csv'],
    ['data.tsv', 'tsv'],
    ['server.log', 'log'],
    ['src/main/resources/application.properties', 'ini'],
    ['.zshrc', 'shellscript'],
    ['.bashrc', 'shellscript'],
    ['.bash_profile', 'shellscript'],
    ['.profile', 'shellscript'],
    ['.editorconfig', 'ini'],
    ['Dockerfile.dev', 'dockerfile'],
    ['Containerfile', 'dockerfile'],
    ['docker/api.Dockerfile', 'dockerfile'],
    ['Brewfile', 'ruby'],
    ['ios/Podfile', 'ruby'],
    ['Vagrantfile', 'ruby'],
    ['komla.gemspec', 'ruby'],
    ['lib/tasks/db.rake', 'ruby'],
    ['Cargo.lock', 'toml'],
    ['uv.lock', 'toml'],
    ['poetry.lock', 'toml'],
    ['deploy/nginx.conf', 'nginx'],
  ])('colors %s with the %s grammar', (path, language) => {
    expect(editorLanguage(path)).toBe(language);
  });

  it('leaves files without a grammar as plain text', () => {
    expect(editorLanguage('notes.txt')).toBe('plaintext');
    expect(editorLanguage('LICENSE')).toBe('plaintext');
    expect(editorLanguage('package-lock.lock')).toBe('plaintext');
  });

  it('registers every grammar a file can resolve to', async () => {
    const { bundledLanguages } = await import('shiki');
    for (const language of SHIKI_BUNDLED_LANGUAGES) {
      expect(Object.hasOwn(bundledLanguages, language), language).toBe(true);
    }
  });
});

describe('hasBuiltInLanguageIntelligence', () => {
  it('only reports Monaco worker-backed service ids', () => {
    expect(hasBuiltInLanguageIntelligence('json')).toBe(true);
    expect(hasBuiltInLanguageIntelligence('html')).toBe(true);
    expect(hasBuiltInLanguageIntelligence('jsonc')).toBe(false);
    expect(hasBuiltInLanguageIntelligence('vue')).toBe(false);
  });
});
