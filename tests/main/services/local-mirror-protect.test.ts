import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectGitignoreProtectRules,
  gitignoreToProtectRules,
} from '../../../src/main/services/local-mirror-protect';

const hasRsync = (() => {
  try {
    execFileSync('rsync', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('local mirror protect rules', () => {
  const roots: string[] = [];
  const tempRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-mirror-protect-'));
    roots.push(root);
    return root;
  };
  const write = (path: string, content: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('translates gitignore patterns relative to their directory', () => {
    const content =
      '# comment\n\n.env\n*.log\ndependencies/\n/build\nsrc/generated\n!keep.log\n**/cache\n';

    expect(gitignoreToProtectRules(content, '')).toEqual([
      'P .env',
      'P *.log',
      'P dependencies/',
      'P /build',
      'P /src/generated',
      'P cache',
    ]);
    expect(gitignoreToProtectRules('.env\n/build\n', 'packages/app')).toEqual([
      'P /packages/app/.env',
      'P /packages/app/**/.env',
      'P /packages/app/build',
    ]);
  });

  it('keeps git depth semantics for ** patterns', () => {
    expect(gitignoreToProtectRules('**/foo/bar\na/**/b\n', '')).toEqual([
      'P /foo/bar',
      'P /**/foo/bar',
      'P /a/**/b',
      'P /a/b',
    ]);
    expect(gitignoreToProtectRules('**/foo/bar\n', 'pkg')).toEqual([
      'P /pkg/foo/bar',
      'P /pkg/**/foo/bar',
    ]);
    expect(gitignoreToProtectRules('/**/foo\nc/**/**/d\n', '')).toEqual([
      'P foo',
      'P /c/**/d',
      'P /c/d',
    ]);
    expect(gitignoreToProtectRules('/**/foo\n', 'pkg')).toEqual(['P /pkg/foo', 'P /pkg/**/foo']);
  });

  it('collects nested gitignore files without descending into ignored directories', async () => {
    const root = tempRoot();
    write(join(root, '.gitignore'), 'node_modules/\n');
    write(join(root, 'packages/app/.gitignore'), '.env\n');
    write(join(root, 'node_modules/pkg/.gitignore'), 'should-not-be-read\n');
    write(join(root, '.git/.gitignore'), 'skipped\n');

    await expect(collectGitignoreProtectRules(root, new Set(['.git']))).resolves.toEqual([
      'P node_modules/',
      'P /packages/app/.env',
      'P /packages/app/**/.env',
    ]);
  });

  it.skipIf(!hasRsync)('keeps local ignored files while deleting stale ones', async () => {
    const source = tempRoot();
    const mirror = tempRoot();
    write(join(source, '.gitignore'), '.env\ndependencies/\n');
    write(join(source, 'visible.txt'), 'remote');
    write(join(mirror, '.gitignore'), '.env\ndependencies/\n');
    write(join(mirror, '.env'), 'local secret');
    write(join(mirror, 'dependencies/local-only/file'), 'local');
    write(join(mirror, 'stale.txt'), 'stale');

    const rules = await collectGitignoreProtectRules(mirror, new Set());
    execFileSync('rsync', [
      '-a',
      '--delete-after',
      '--filter=:- .gitignore',
      ...rules.map((rule) => `--filter=${rule}`),
      `${source}/`,
      `${mirror}/`,
    ]);

    expect(existsSync(join(mirror, '.env'))).toBe(true);
    expect(existsSync(join(mirror, 'dependencies/local-only/file'))).toBe(true);
    expect(existsSync(join(mirror, 'visible.txt'))).toBe(true);
    expect(existsSync(join(mirror, 'stale.txt'))).toBe(false);
  });

  it.skipIf(!hasRsync)('protects ** patterns without per-directory merge rules', async () => {
    const source = tempRoot();
    const mirror = tempRoot();
    const gitignore = '**/foo/bar\na/**/b\n/**/env\nc/**/**/d\n';
    write(join(source, '.gitignore'), gitignore);
    write(join(mirror, '.gitignore'), gitignore);
    const kept = ['foo/bar', 'x/foo/bar', 'a/b', 'a/x/b', 'env', 'x/env', 'c/d', 'c/x/d'];
    for (const path of [...kept, 'stale.txt']) {
      write(join(mirror, path), 'local');
    }

    // Protect rules alone, as macOS openrsync ignores the merge rule when deleting.
    const rules = await collectGitignoreProtectRules(mirror, new Set());
    execFileSync('rsync', [
      '-a',
      '--delete-after',
      ...rules.map((rule) => `--filter=${rule}`),
      `${source}/`,
      `${mirror}/`,
    ]);

    for (const path of kept) {
      expect(existsSync(join(mirror, path)), path).toBe(true);
    }
    expect(existsSync(join(mirror, 'stale.txt'))).toBe(false);
  });
});
