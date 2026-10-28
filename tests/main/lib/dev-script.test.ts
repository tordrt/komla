import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const devScript = resolve('scripts/dev.sh');
const companionScript = resolve('scripts/ensure-dev-companion.sh');
const testHome = resolve('.test-home');

function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: testHome,
      KOMLA_DEV_DRY_RUN: '1',
      KOMLA_DIAGNOSTICS: undefined,
      ...env,
    },
  });
}

describe('development launcher', () => {
  it.each(['default', 'sandbox', 'sandbox-clean', 'sandbox-fresh'])(
    'allows diagnostics to be explicitly disabled in %s mode',
    (mode) => {
      expect(run(devScript, [mode], { KOMLA_DIAGNOSTICS: '0' })).toContain(
        'KOMLA_DIAGNOSTICS=0 electron-vite dev'
      );
    }
  );

  it.each(['default', 'sandbox', 'sandbox-clean', 'sandbox-fresh'])(
    'enables diagnostics by default in %s mode',
    (mode) => {
      expect(run(devScript, [mode])).toContain('KOMLA_DIAGNOSTICS=1 electron-vite dev');
    }
  );

  it('builds the companion before starting and does not forward the opt-in flag to Vite', () => {
    const output = run(devScript, ['sandbox', '--companion', '--host', '127.0.0.1']);

    expect(output).toContain('prepare companion\nprepare dependencies\n');
    expect(output).toContain(
      'launch KOMLA_DATA_DIR=/tmp/komla-dev KOMLA_DIAGNOSTICS=1 electron-vite dev --host 127.0.0.1\n'
    );
    expect(output.match(/--companion/g)).toBeNull();
  });

  it('restores cached companion artifacts without building in normal development startup', () => {
    const output = run(devScript, ['default']);
    // Git for Windows' bash turns HOME into a POSIX path such as /d/a/komla/.test-home.
    const home = execFileSync('bash', ['-c', 'printf %s "$HOME"'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: testHome },
    });

    expect(output).toBe(
      `restore companion\nprepare dependencies\nlaunch KOMLA_DATA_DIR=${home}/.komla-dev KOMLA_DIAGNOSTICS=1 electron-vite dev\n`
    );
  });
});

describe('development companion artifacts', () => {
  it('prepares both Linux SSH architectures and both native macOS architectures on macOS', () => {
    expect(
      run(companionScript, [], {
        KOMLA_DEV_HOST_OS: 'Darwin',
        KOMLA_DEV_HOST_ARCH: 'arm64',
      })
    ).toContain(
      'targets x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-apple-darwin aarch64-apple-darwin\n'
    );
  });

  it('prepares both supported Linux SSH architectures on Linux', () => {
    expect(
      run(companionScript, [], {
        KOMLA_DEV_HOST_OS: 'Linux',
        KOMLA_DEV_HOST_ARCH: 'x86_64',
      })
    ).toContain('targets x86_64-unknown-linux-musl aarch64-unknown-linux-musl\n');
  });
});

describe('shared development companion cache', () => {
  const linuxTargets = ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl'];
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'komla-companion-cache-'));
    mkdirSync(join(sandbox, 'bin'));
    writeFileSync(join(sandbox, 'bin/docker'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(sandbox, 'bin/docker'), 0o755);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function createCheckout(name: string, source = 'fn main() {}\n'): string {
    const root = join(sandbox, name);
    for (const directory of ['scripts', 'src/shared', 'native/src']) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    copyFileSync(companionScript, join(root, 'scripts/ensure-dev-companion.sh'));
    writeFileSync(
      join(root, 'scripts/build-native-matrix.sh'),
      [
        'set -eu',
        'root=$(cd "$(dirname "$0")/.." && pwd -P)',
        'if [ -n "${EDIT_DURING_BUILD:-}" ]; then',
        '  printf "// edited\\n" >> "$root/native/src/main.rs"',
        'fi',
        'for target in "$@"; do',
        '  printf "%s\\n" "$target" >> "$BUILD_LOG"',
        '  mkdir -p "$root/native/artifacts/$target"',
        '  cat "$root/native/src/main.rs" > "$root/native/artifacts/$target/komla"',
        'done',
        '',
      ].join('\n')
    );
    for (const input of [
      'native/Cargo.toml',
      'native/Cargo.lock',
      'native/rust-toolchain.toml',
      'src/shared/git-line-count-policy.json',
    ]) {
      writeFileSync(join(root, input), `${input}\n`);
    }
    writeFileSync(join(root, 'native/src/main.rs'), source);
    return root;
  }

  function ensure(checkout: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): string {
    return execFileSync('bash', [join(checkout, 'scripts/ensure-dev-companion.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(sandbox, 'home'),
        XDG_CACHE_HOME: join(sandbox, 'cache'),
        PATH: `${join(sandbox, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        GIT_CEILING_DIRECTORIES: sandbox,
        GIT_DIR: undefined,
        KOMLA_DEV_HOST_OS: 'Linux',
        KOMLA_DEV_HOST_ARCH: 'x86_64',
        KOMLA_DEV_DRY_RUN: undefined,
        BUILD_LOG: join(sandbox, 'builds.log'),
        ...env,
      },
    });
  }

  function builds(): string[] {
    const log = join(sandbox, 'builds.log');
    return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  }

  function artifact(checkout: string, target: string): string {
    return join(checkout, 'native/artifacts', target, 'komla');
  }

  function writeArtifact(checkout: string, target: string, contents: string): void {
    mkdirSync(join(checkout, 'native/artifacts', target), { recursive: true });
    writeFileSync(artifact(checkout, target), contents);
  }

  it('reuses artifacts built in another checkout with the same companion sources', () => {
    const first = createCheckout('first');
    ensure(first);
    expect(builds()).toEqual(linuxTargets);

    const second = createCheckout('second');
    const output = ensure(second);
    const third = createCheckout('third');
    ensure(third, ['--restore-only']);

    expect(builds()).toEqual(linuxTargets);
    expect(output).toContain(`${join(sandbox, 'cache')}/komla-companion-artifacts`);
    for (const target of linuxTargets) {
      expect(readFileSync(artifact(second, target), 'utf8')).toBe('fn main() {}\n');
      expect(readFileSync(artifact(third, target), 'utf8')).toBe('fn main() {}\n');
    }
  });

  it('restores into a checkout without git, such as an SSH Local copy', () => {
    ensure(createCheckout('worktree'));
    const localCopy = createCheckout('local-copy');
    rmSync(join(localCopy, '.git'), { recursive: true, force: true });

    ensure(localCopy, ['--restore-only']);

    expect(builds()).toEqual(linuxTargets);
    for (const target of linuxTargets) {
      expect(readFileSync(artifact(localCopy, target), 'utf8')).toBe('fn main() {}\n');
    }
  });

  it('fails rather than hashing part of the inputs when a checkout without git cannot be listed', () => {
    const localCopy = createCheckout('unlisted');
    rmSync(join(localCopy, '.git'), { recursive: true, force: true });
    rmSync(join(localCopy, 'native'), { recursive: true, force: true });

    expect(() => ensure(localCopy, ['--restore-only'])).toThrow();
  });

  it('rebuilds when the companion sources differ from every cached build', () => {
    ensure(createCheckout('first'));
    const changed = createCheckout('changed', 'fn main() { println!("changed"); }\n');

    ensure(changed);

    expect(builds()).toEqual([...linuxTargets, ...linuxTargets]);
    expect(readFileSync(artifact(changed, linuxTargets[0]), 'utf8')).toContain('changed');
  });

  it('treats a new companion build file as a source change', () => {
    ensure(createCheckout('first'));
    const withBuildScript = createCheckout('build-script');
    writeFileSync(join(withBuildScript, 'native/build.rs'), 'fn main() {}\n');

    ensure(withBuildScript);

    expect(builds()).toEqual([...linuxTargets, ...linuxTargets]);
  });

  it('ignores gitignored files in a git checkout', () => {
    ensure(createCheckout('first'));
    const withLog = createCheckout('with-log');
    writeFileSync(join(withLog, '.gitignore'), '*.log\n');
    writeFileSync(join(withLog, 'native/build.log'), 'log');

    ensure(withLog);

    expect(builds()).toEqual(linuxTargets);
  });

  it('ignores hidden files such as editor swap files', () => {
    ensure(createCheckout('first'));
    const editing = createCheckout('editing');
    writeFileSync(join(editing, 'native/src/.main.rs.swp'), 'swap');

    ensure(editing);

    expect(builds()).toEqual(linuxTargets);
  });

  it('replaces out-of-date local artifacts with the cached build for the current sources', () => {
    ensure(createCheckout('first'));
    const stale = createCheckout('stale');
    writeArtifact(stale, linuxTargets[0], 'old binary');
    utimesSync(artifact(stale, linuxTargets[0]), new Date(2000, 0), new Date(2000, 0));

    ensure(stale, ['--restore-only']);

    expect(readFileSync(artifact(stale, linuxTargets[0]), 'utf8')).toBe('fn main() {}\n');
  });

  it('keeps a current local build instead of the cached one', () => {
    ensure(createCheckout('first'));
    const custom = createCheckout('custom');
    writeArtifact(custom, linuxTargets[0], 'custom build');

    ensure(custom, ['--restore-only']);

    expect(readFileSync(artifact(custom, linuxTargets[0]), 'utf8')).toBe('custom build');
  });

  it('does not rebuild a current local build that is not cached', () => {
    const checkout = createCheckout('built-before-cache');
    for (const target of linuxTargets) writeArtifact(checkout, target, 'local build');

    const output = ensure(checkout);

    expect(builds()).toEqual([]);
    expect(output).toContain('current');
  });

  it('does not cache a build whose sources changed while it ran', () => {
    const output = ensure(createCheckout('first'), [], { EDIT_DURING_BUILD: '1' });

    ensure(createCheckout('second'));

    expect(output).toContain('not caching');
    expect(builds()).toEqual([...linuxTargets, ...linuxTargets]);
  });

  // Eleven script runs take 12–17 s on a Windows runner, where Git Bash starts slowly.
  it(
    'keeps only the ten most recently used builds',
    () => {
      for (let index = 0; index < 11; index += 1) {
        ensure(createCheckout(`checkout-${index}`, `fn main() { ${index}; }\n`));
      }

      expect(readdirSync(join(sandbox, 'cache', 'komla-companion-artifacts'))).toHaveLength(10);
    },
    process.platform === 'win32' ? 60_000 : undefined
  );

  it('does not build on a cache miss when only restoring', () => {
    const checkout = createCheckout('fresh');

    const output = ensure(checkout, ['--restore-only']);

    expect(builds()).toEqual([]);
    expect(existsSync(artifact(checkout, linuxTargets[0]))).toBe(false);
    expect(output).toContain('npm run dev -- --companion');
  });
});
