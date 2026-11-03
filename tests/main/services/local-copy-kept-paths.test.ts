import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildKeptPathsCommand,
  keptPathRules,
  parseKeptPaths,
  rsyncPattern,
} from '../../../src/main/services/local-copy-kept-paths';

const hasRsync = (() => {
  try {
    execFileSync('rsync', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('local copy kept paths', () => {
  const roots: string[] = [];
  const tempRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-local-copy-kept-'));
    roots.push(root);
    return root;
  };
  const write = (path: string, content = '') => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, stdio: 'ignore' });
  const readRules = (directory: string) => {
    const kept = parseKeptPaths(
      execFileSync('sh', ['-c', buildKeptPathsCommand(directory)], { encoding: 'utf8', env })
    );
    return kept && keptPathRules(kept);
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reads Git's output after whatever a login shell prints first", () => {
    const match = (pattern: string, path: string) => `.gitignore\x002\x00${pattern}\x00${path}\x00`;
    expect(
      parseKeptPaths(
        `Welcome\nkomla-git-paths\n${match('*.key', 'config/master.key')}\0\0\0\0${match('deps/', 'deps')}${match('!/tmp/pids/', 'tmp/pids')}`
      )
    ).toEqual({
      files: ['config/master.key'],
      folders: [
        { path: 'deps', ignored: true },
        { path: 'tmp/pids', ignored: false },
      ],
    });
    expect(parseKeptPaths('komla-git-paths\n\0\0\0\0')).toEqual({ files: [], folders: [] });
    expect(parseKeptPaths('')).toBeUndefined();
    expect(parseKeptPaths('Welcome, komla-git-paths\n')).toBeUndefined();
  });

  it('includes each kept path and the folders above it, and excludes the rest of an ignored folder', () => {
    expect(
      keptPathRules({
        files: ['deps/x/file', 'tmp/pids/.keep'],
        folders: [
          { path: 'deps', ignored: true },
          { path: 'deps/x', ignored: true },
          { path: 'tmp/pids', ignored: false },
        ],
      })
    ).toEqual({
      include: ['/deps/', '/deps/x/', '/tmp/', '/tmp/pids/', '/deps/x/file', '/tmp/pids/.keep'],
      exclude: ['/deps/*', '/deps/x/*'],
    });
  });

  it('escapes a path only where rsync would read a wildcard', () => {
    expect(rsyncPattern('node_modules', '/')).toBe('/node_modules/');
    expect(rsyncPattern('back\\slash')).toBe('/back\\slash');
    expect(rsyncPattern('back\\slash', '/*')).toBe('/back\\\\slash/*');
    expect(rsyncPattern('a[1]\\*?.log')).toBe('/a\\[1]\\\\\\*\\?.log');
    expect(rsyncPattern('line\nbreak\\')).toBe('/line?break\\\\');
  });

  it('has no rules outside a Git work tree', () => {
    expect(readRules(tempRoot())).toBeUndefined();
  });

  it.skipIf(!hasRsync || process.platform === 'win32')(
    'copies what Git tracks or re-includes, and leaves out what it ignores',
    () => {
      const source = join(tempRoot(), 'source');
      write(
        join(source, '.gitignore'),
        [
          '/tmp/*',
          '!/tmp/pids/',
          '/tmp/pids/*',
          '!/tmp/pids/.keep',
          // Only the folder is re-included, and what's in it isn't ignored.
          '!/tmp/sockets/',
          '*.key',
          '.env*',
          '!.env.example',
          'deps/',
          '',
        ].join('\n')
      );
      write(join(source, 'tmp/pids/.keep'));
      write(join(source, 'tmp/pids/server.pid'));
      write(join(source, 'tmp/cache'));
      write(join(source, 'tmp/sockets/.keep'));
      write(join(source, 'tmp/sockets/dev.sock'));
      write(join(source, 'config/master.key'));
      write(join(source, 'config/other.key'));
      write(join(source, 'config/app.yml'));
      write(join(source, '.env.example'));
      write(join(source, '.env'));
      write(join(source, 'deps/vendored/index.js'));
      write(join(source, 'deps/vendored/build.log'));
      write(join(source, 'deps/installed/index.js'));
      write(join(source, 'deps/a[1]*?.key'));
      // An unescaped pattern for the name above would also match this one.
      write(join(source, 'deps/a1 x.key'));
      // Names Git would quote in a listing of lines.
      for (const name of ['tab\tname.js', 'quote"name.js', 'line\nbreak.js']) {
        write(join(source, 'deps/odd', name));
      }
      // A nested repository's own .gitignore still applies.
      write(join(source, 'nested/.gitignore'), 'secret.env\n');
      write(join(source, 'nested/secret.env'));
      write(join(source, 'nested/visible.txt'));
      git(join(source, 'nested'), 'init', '-q');
      git(source, 'init', '-q');
      git(source, 'add', '.gitignore', 'tmp/pids/.keep', 'tmp/sockets/.keep', 'config/app.yml');
      git(source, 'add', '-f', 'config/master.key', 'deps/vendored/index.js');
      git(source, 'add', '-f', ':(literal)deps/a[1]*?.key', 'deps/odd');

      const rules = readRules(source);
      expect(rules).toBeDefined();
      const ruleDir = tempRoot();
      writeFileSync(join(ruleDir, 'include'), rules!.include.map((rule) => `${rule}\n`).join(''));
      writeFileSync(join(ruleDir, 'exclude'), rules!.exclude.map((rule) => `${rule}\n`).join(''));
      const copy = join(tempRoot(), 'copy');
      // In the order the local copy sync passes them.
      execFileSync('rsync', [
        '-a',
        '--exclude=/.git',
        `--include-from=${join(ruleDir, 'include')}`,
        `--exclude-from=${join(ruleDir, 'exclude')}`,
        '--filter=:- .gitignore',
        `${source}/`,
        `${copy}/`,
      ]);

      for (const copied of [
        'tmp/pids/.keep',
        'tmp/sockets/.keep',
        'tmp/sockets/dev.sock',
        'config/master.key',
        'config/app.yml',
        '.env.example',
        'deps/vendored/index.js',
        'deps/a[1]*?.key',
        'deps/odd/tab\tname.js',
        'deps/odd/quote"name.js',
        'deps/odd/line\nbreak.js',
        'nested/visible.txt',
      ]) {
        expect(existsSync(join(copy, copied)), copied).toBe(true);
      }
      for (const left of [
        'tmp/pids/server.pid',
        'tmp/cache',
        'config/other.key',
        '.env',
        'deps/vendored/build.log',
        'deps/installed',
        'deps/a1 x.key',
        'nested/secret.env',
      ]) {
        expect(existsSync(join(copy, left)), left).toBe(false);
      }
    }
  );
});
