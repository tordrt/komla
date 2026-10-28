import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const deps = require('../../../scripts/worktree-deps.cjs') as {
  depsKey(wtRoot: string): string;
  gc(wtRoot: string, storeDir: string, options?: { legacy?: boolean }): void;
  link(wtRoot: string, storeDir: string, prepare: (wtRoot: string) => void): boolean;
  postinstall(
    wtRoot: string,
    options: { storeDir: string; rebuild: (root: string) => void; worktree?: boolean }
  ): void;
};

const PLATFORM = 'testos-x64';
let parent: string;
let storeDir: string;
let rebuild: ReturnType<typeof vi.fn<(root: string) => void>>;
let prepare: ReturnType<typeof vi.fn<(root: string) => void>>;
let logs: string[];

function write(file: string, content: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

// A worktree whose node_modules looks like a finished `npm install`.
function makeWorktree(name: string, lockfile = 'lock-v1', installed = true): string {
  const wt = join(parent, name);
  write(join(wt, 'package.json'), JSON.stringify({ name: 'app', workspaces: ['packages/*'] }));
  write(join(wt, 'package-lock.json'), lockfile);
  write(join(wt, 'packages/proto/package.json'), JSON.stringify({ name: '@app/proto' }));
  if (installed) install(wt, lockfile);
  return wt;
}

function install(wt: string, lockfile: string): void {
  write(join(wt, 'package-lock.json'), lockfile);
  const nm = join(wt, 'node_modules');
  rmSync(nm, { recursive: true, force: true });
  write(join(nm, 'react/index.js'), `react for ${lockfile}`);
  write(join(nm, 'node-pty/build/pty.node'), 'unbuilt');
  write(join(nm, '.package-lock.json'), lockfile);
  mkdirSync(join(nm, '.bin'));
  symlinkSync('../react/index.js', join(nm, '.bin/react'));
  mkdirSync(join(nm, '@app'));
  symlinkSync('../../packages/proto', join(nm, '@app/proto'));
}

function entry(wt: string): string {
  return join(storeDir, deps.depsKey(wt));
}

function sameFile(a: string, b: string): boolean {
  return statSync(a).ino === statSync(b).ino;
}

// Whether `file` is the store's copy of `source`: the same file where the store hardlinks, and a
// copy-on-write clone, which has its own inode, on macOS.
function fromStore(file: string, source: string): boolean {
  if (process.platform !== 'darwin') return sameFile(file, source);
  return !sameFile(file, source) && readFileSync(file, 'utf8') === readFileSync(source, 'utf8');
}

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'komla-worktree-deps-'));
  storeDir = join(parent, '_deps', PLATFORM);
  // Writes in place, the way a native rebuild could.
  rebuild = vi.fn((root: string) => {
    writeFileSync(join(root, 'node_modules/node-pty/build/pty.node'), `built in ${root}`);
  });
  prepare = vi.fn();
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((message: string) => logs.push(message));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(parent, { recursive: true, force: true });
});

describe('worktree dependency store', () => {
  it('publishes a fresh install with native modules rebuilt', () => {
    const a = makeWorktree('a');

    deps.postinstall(a, { storeDir, rebuild });

    expect(rebuild).toHaveBeenCalledOnce();
    const stored = join(entry(a), 'node_modules');
    expect(readFileSync(join(stored, 'node-pty/build/pty.node'), 'utf8')).toBe(`built in ${a}`);
    expect(fromStore(join(stored, 'react/index.js'), join(a, 'node_modules/react/index.js'))).toBe(
      true
    );
    // npm rewrites its hidden lockfile in place, so it is never shared.
    expect(
      sameFile(join(stored, '.package-lock.json'), join(a, 'node_modules/.package-lock.json'))
    ).toBe(false);
    expect(existsSync(join(stored, '.komla-deps'))).toBe(false);
  });

  it('clones a sibling with the same lockfile from the store', () => {
    const a = makeWorktree('a');
    deps.postinstall(a, { storeDir, rebuild });
    const b = makeWorktree('b', 'lock-v1', false);

    expect(deps.link(b, storeDir, prepare)).toBe(true);

    const nm = join(b, 'node_modules');
    expect(fromStore(join(nm, 'react/index.js'), join(a, 'node_modules/react/index.js'))).toBe(
      true
    );
    expect(readFileSync(join(nm, '.bin/react'), 'utf8')).toBe('react for lock-v1');
    expect(realpathSync(join(nm, '@app/proto'))).toBe(realpathSync(join(b, 'packages/proto')));
    expect(readFileSync(join(nm, '.komla-deps'), 'utf8')).toBe(`${PLATFORM}/${deps.depsKey(b)}\n`);
    // npm install would have built the workspaces' dist types.
    expect(prepare).toHaveBeenCalledWith(b);

    expect(deps.link(b, storeDir, prepare)).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('leaves the store and siblings alone when one worktree changes its dependencies', () => {
    const a = makeWorktree('a');
    deps.postinstall(a, { storeDir, rebuild });
    const oldEntry = entry(a);
    const b = makeWorktree('b', 'lock-v1', false);
    deps.link(b, storeDir, prepare);

    // npm only replaces the packages that changed, so pty.node is still a
    // hardlink into the store when the rebuild runs.
    write(join(b, 'package-lock.json'), 'lock-v2');
    rmSync(join(b, 'node_modules/react'), { recursive: true });
    write(join(b, 'node_modules/react/index.js'), 'react for lock-v2');
    deps.postinstall(b, { storeDir, rebuild });

    const stored = join(oldEntry, 'node_modules');
    expect(readFileSync(join(stored, 'node-pty/build/pty.node'), 'utf8')).toBe(`built in ${a}`);
    expect(readFileSync(join(stored, 'react/index.js'), 'utf8')).toBe('react for lock-v1');
    expect(readFileSync(join(a, 'node_modules/node-pty/build/pty.node'), 'utf8')).toBe(
      `built in ${a}`
    );
    expect(readFileSync(join(entry(b), 'node_modules/react/index.js'), 'utf8')).toBe(
      'react for lock-v2'
    );
  });

  it('swaps a fresh install for the store copy instead of rebuilding it', () => {
    const a = makeWorktree('a');
    deps.postinstall(a, { storeDir, rebuild });
    const c = makeWorktree('c');
    const installed = statSync(join(c, 'node_modules/react/index.js')).ino;

    deps.postinstall(c, { storeDir, rebuild });

    expect(rebuild).toHaveBeenCalledOnce();
    expect(statSync(join(c, 'node_modules/react/index.js')).ino).not.toBe(installed);
    expect(
      fromStore(join(c, 'node_modules/react/index.js'), join(a, 'node_modules/react/index.js'))
    ).toBe(true);
    expect(realpathSync(join(c, 'node_modules/@app/proto'))).toBe(
      realpathSync(join(c, 'packages/proto'))
    );
  });

  it('keeps a fresh install that has packages beyond the lockfile', () => {
    const a = makeWorktree('a');
    deps.postinstall(a, { storeDir, rebuild });
    const c = makeWorktree('c');
    // What `npm install --no-save` leaves behind.
    write(join(c, 'node_modules/watcher-win32-x64/index.js'), 'prebuild');
    write(join(c, 'node_modules/.package-lock.json'), 'lock-v1 + watcher-win32-x64');

    deps.postinstall(c, { storeDir, rebuild });

    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(existsSync(join(c, 'node_modules/watcher-win32-x64/index.js'))).toBe(true);
    expect(readFileSync(join(c, 'node_modules/.komla-deps'), 'utf8')).toBe(
      `${PLATFORM}/${deps.depsKey(c)}\n`
    );
    expect(existsSync(join(entry(a), 'node_modules/watcher-win32-x64'))).toBe(false);
  });

  it('reruns workspace prepare after a clone whose prepare failed', () => {
    const a = makeWorktree('a');
    deps.postinstall(a, { storeDir, rebuild });
    const b = makeWorktree('b', 'lock-v1', false);
    prepare.mockImplementationOnce(() => {
      throw new Error('tsc failed');
    });

    expect(() => deps.link(b, storeDir, prepare)).toThrow('tsc failed');
    expect(existsSync(join(b, 'node_modules/.komla-deps'))).toBe(false);

    expect(deps.link(b, storeDir, prepare)).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(existsSync(join(b, 'node_modules/.komla-deps'))).toBe(true);
  });

  it('takes over a lock whose holder has exited', () => {
    const a = makeWorktree('a');
    deps.postinstall(a, { storeDir, rebuild });
    const b = makeWorktree('b', 'lock-v1', false);
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const lock = join(storeDir, 'locks', createHash('sha1').update(b).digest('hex').slice(0, 16));
    writeFileSync(lock, `${deadPid}@${hostname()}`);

    expect(deps.link(b, storeDir, prepare)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('rebuilds a worktree already on the store copy without touching the store', () => {
    const a = makeWorktree('a');
    deps.postinstall(a, { storeDir, rebuild });
    const b = makeWorktree('b', 'lock-v1', false);
    deps.link(b, storeDir, prepare);

    deps.postinstall(b, { storeDir, rebuild });

    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(entry(a), 'node_modules/node-pty/build/pty.node'), 'utf8')).toBe(
      `built in ${a}`
    );
    expect(readFileSync(join(b, 'node_modules/node-pty/build/pty.node'), 'utf8')).toBe(
      `built in ${b}`
    );
  });

  it('warns about a stale install the store cannot replace', () => {
    const a = makeWorktree('a');
    deps.postinstall(a, { storeDir, rebuild });
    write(join(a, 'package-lock.json'), 'lock-v2');

    expect(deps.link(a, storeDir, prepare)).toBe(false);

    expect(logs.join('\n')).toContain('does not match package-lock.json. Run `npm install`.');
    expect(readFileSync(join(a, 'node_modules/react/index.js'), 'utf8')).toBe('react for lock-v1');
  });

  it('fails when a worktree has no install and the store has no entry', () => {
    const b = makeWorktree('b', 'lock-v1', false);

    expect(() => deps.link(b, storeDir, prepare)).toThrow('Run `npm install`');
  });

  it('only rebuilds outside a worktree', () => {
    const a = makeWorktree('a');

    deps.postinstall(a, { storeDir, rebuild, worktree: false });

    expect(rebuild).toHaveBeenCalledOnce();
    expect(existsSync(storeDir)).toBe(false);
  });

  it('does not share an install whose workspaces have their own packages', () => {
    const a = makeWorktree('a');
    write(join(a, 'packages/proto/node_modules/.vite/cache.json'), '{}');
    write(join(a, 'packages/proto/node_modules/zod/index.js'), 'pinned zod');

    deps.postinstall(a, { storeDir, rebuild });

    expect(existsSync(entry(a))).toBe(false);
    expect(logs.join('\n')).toContain('@app/proto has its own node_modules');
  });

  it('removes store entries no sibling uses', () => {
    const a = makeWorktree('a');
    deps.postinstall(a, { storeDir, rebuild });
    const used = entry(a);
    install(a, 'lock-v2');
    deps.postinstall(a, { storeDir, rebuild });
    const b = makeWorktree('b', 'lock-v3', false);
    install(b, 'lock-v3');
    deps.postinstall(b, { storeDir, rebuild });

    // Nothing references lock-v1 once a moves to lock-v2.
    expect(existsSync(used)).toBe(false);
    expect(existsSync(entry(a))).toBe(true);
    expect(existsSync(entry(b))).toBe(true);
    expect(readFileSync(join(a, 'node_modules/react/index.js'), 'utf8')).toBe('react for lock-v2');
  });

  it('keeps the old shared node_modules until no worktree links to it', () => {
    const { type, machine } = require('node:os') as typeof import('node:os');
    const legacyRoot = join(parent, `_${type().toLowerCase()}_${machine()}`);
    write(join(legacyRoot, 'node_modules/react/index.js'), 'legacy react');
    const a = makeWorktree('a', 'lock-v1', false);
    symlinkSync(
      join('..', `_${type().toLowerCase()}_${machine()}`, 'node_modules'),
      join(a, 'node_modules')
    );

    deps.gc(a, storeDir, { legacy: true });
    expect(existsSync(legacyRoot)).toBe(true);

    rmSync(join(a, 'node_modules'));
    deps.gc(a, storeDir, { legacy: true });
    expect(existsSync(legacyRoot)).toBe(false);
  });

  it('replaces a node_modules symlink from the old shared layout', () => {
    const a = makeWorktree('a');
    deps.postinstall(a, { storeDir, rebuild });
    const b = makeWorktree('b', 'lock-v1', false);
    symlinkSync(join('..', 'a', 'node_modules'), join(b, 'node_modules'));

    deps.link(b, storeDir, prepare);

    expect(() => readlinkSync(join(b, 'node_modules'))).toThrow();
    expect(readFileSync(join(a, 'node_modules/react/index.js'), 'utf8')).toBe('react for lock-v1');
    expect(readFileSync(join(b, 'node_modules/react/index.js'), 'utf8')).toBe('react for lock-v1');
  });
});
