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
    writeExecutable('docker', '#!/bin/sh\nexit 1\n');
    writeExecutable('rustup', '#!/bin/sh\nexit 0\n');
    writeExecutable(
      'cargo',
      [
        '#!/bin/sh',
        'set -eu',
        'target=',
        'previous=',
        'for argument in "$@"; do',
        '  if [ "$previous" = --target ]; then target=$argument; fi',
        '  previous=$argument',
        'done',
        'if [ -n "$target" ] && [ "$target" = "${FAIL_TARGET:-}" ]; then exit 1; fi',
        'printf "%s\\n" "$target" >> "$BUILD_LOG"',
        'printf "%s x64=%s arm64=%s\\n" "$*" \\',
        '  "${CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER:-}" \\',
        '  "${CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER:-}" >> "$CARGO_LOG"',
        'case "$target" in *-windows-msvc) executable=komla.exe ;; *) executable=komla ;; esac',
        'mkdir -p "$CARGO_TARGET_DIR/$target/companion-dev"',
        'cat src/main.rs > "$CARGO_TARGET_DIR/$target/companion-dev/$executable"',
        'if [ -n "${EDIT_DURING_BUILD:-}" ]; then',
        '  printf "// edited\\n" >> src/main.rs',
        'fi',
        '',
      ].join('\n')
    );
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function writeExecutable(name: string, contents: string): void {
    writeFileSync(join(sandbox, 'bin', name), contents);
    chmodSync(join(sandbox, 'bin', name), 0o755);
  }

  function createCheckout(name: string, source = 'fn main() {}\n'): string {
    const root = join(sandbox, name);
    for (const directory of ['scripts', 'src/shared', 'native/src']) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    copyFileSync(companionScript, join(root, 'scripts/ensure-dev-companion.sh'));
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
        CARGO_LOG: join(sandbox, 'cargo.log'),
        CARGO_TARGET_DIR: undefined,
        ...env,
      },
    });
  }

  function builds(): string[] {
    const log = join(sandbox, 'builds.log');
    return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  }

  function cargoCalls(): string[] {
    return readFileSync(join(sandbox, 'cargo.log'), 'utf8').split('\n').filter(Boolean);
  }

  function artifact(checkout: string, target: string): string {
    return join(checkout, 'native/artifacts', target, 'komla');
  }

  function writeArtifact(checkout: string, target: string, contents: string): void {
    mkdirSync(join(checkout, 'native/artifacts', target), { recursive: true });
    writeFileSync(artifact(checkout, target), contents);
  }

  it('builds Linux artifacts with the dev profile and rust-lld, without Docker', () => {
    const checkout = createCheckout('first');

    ensure(checkout);

    expect(cargoCalls()).toEqual([
      'build --profile companion-dev --locked --target x86_64-unknown-linux-musl x64=rust-lld arm64=',
      'build --profile companion-dev --locked --target aarch64-unknown-linux-musl x64= arm64=rust-lld',
    ]);
    for (const target of linuxTargets) {
      expect(readFileSync(artifact(checkout, target), 'utf8')).toBe('fn main() {}\n');
    }
  });

  it('links macOS artifacts with the default linker', () => {
    ensure(createCheckout('first'), [], {
      KOMLA_DEV_HOST_OS: 'Darwin',
      KOMLA_DEV_HOST_ARCH: 'arm64',
    });

    expect(cargoCalls()).toContain(
      'build --profile companion-dev --locked --target aarch64-apple-darwin x64= arm64='
    );
  });

  it('builds Windows artifacts with cargo-xwin', () => {
    const checkout = createCheckout('first');

    ensure(checkout, [], { KOMLA_DEV_HOST_OS: 'Windows_NT', KOMLA_DEV_HOST_ARCH: 'x86_64' });

    expect(cargoCalls()).toContain(
      'xwin build --profile companion-dev --locked --target x86_64-pc-windows-msvc x64= arm64='
    );
    expect(
      readFileSync(join(checkout, 'native/artifacts/x86_64-pc-windows-msvc/komla.exe'), 'utf8')
    ).toBe('fn main() {}\n');
  });

  it('keeps build output in the checkout when CARGO_TARGET_DIR points elsewhere', () => {
    const checkout = createCheckout('first');

    ensure(checkout, [], { CARGO_TARGET_DIR: join(sandbox, 'shared-target') });

    expect(existsSync(join(sandbox, 'shared-target'))).toBe(false);
    expect(readFileSync(artifact(checkout, linuxTargets[0]), 'utf8')).toBe('fn main() {}\n');
  });

  it('marks built and restored artifacts as development builds', () => {
    const built = createCheckout('built');
    ensure(built);
    const restored = createCheckout('restored');
    ensure(restored, ['--restore-only']);

    for (const checkout of [built, restored]) {
      for (const target of linuxTargets) {
        expect(existsSync(join(checkout, 'native/artifacts', target, '.dev-build'))).toBe(true);
      }
    }
  });

  it('does not mark a current local build it kept', () => {
    const checkout = createCheckout('local');
    for (const target of linuxTargets) writeArtifact(checkout, target, 'local build');

    ensure(checkout);

    expect(existsSync(join(checkout, 'native/artifacts', linuxTargets[0], '.dev-build'))).toBe(
      false
    );
  });

  it('marks an artifact when the sources changed during the build', () => {
    const checkout = createCheckout('first');

    ensure(checkout, [], { EDIT_DURING_BUILD: '1' });

    expect(existsSync(join(checkout, 'native/artifacts', linuxTargets[0], '.dev-build'))).toBe(
      true
    );
  });

  it('marks an artifact before putting it in place, so an interrupted install stays marked', () => {
    writeExecutable('mv', '#!/bin/sh\nexit 1\n');
    const checkout = createCheckout('first');

    expect(() => ensure(checkout)).toThrow();

    expect(existsSync(join(checkout, 'native/artifacts', linuxTargets[0], '.dev-build'))).toBe(
      true
    );
  });

  it('rebuilds an artifact whose sources changed during its build', () => {
    const checkout = createCheckout('first');
    ensure(checkout, [], { EDIT_DURING_BUILD: '1' });

    const output = ensure(checkout);

    expect(output).toContain('Building');
    const source = readFileSync(join(checkout, 'native/src/main.rs'), 'utf8');
    for (const target of linuxTargets) {
      expect(readFileSync(artifact(checkout, target), 'utf8')).toBe(source);
    }
  });

  it('rebuilds an artifact when a later target failed after its sources changed', () => {
    const checkout = createCheckout('first');
    expect(() =>
      ensure(checkout, [], { EDIT_DURING_BUILD: '1', FAIL_TARGET: linuxTargets[1] })
    ).toThrow();

    ensure(checkout);

    expect(readFileSync(artifact(checkout, linuxTargets[0]), 'utf8')).toBe(
      readFileSync(join(checkout, 'native/src/main.rs'), 'utf8')
    );
  });

  it('rebuilds when a build input is deleted, which leaves no newer file', () => {
    const checkout = createCheckout('first');
    writeFileSync(join(checkout, 'native/build.rs'), 'fn main() {}\n');
    ensure(checkout);

    rmSync(join(checkout, 'native/build.rs'));
    ensure(checkout);

    expect(builds()).toEqual([...linuxTargets, ...linuxTargets]);
  });

  it('replaces a development build when the sources move to another version', () => {
    const checkout = createCheckout('first');
    ensure(checkout);
    const original = join(checkout, 'native/src/main.rs');
    writeFileSync(original, 'fn main() { println!("other"); }\n');
    utimesSync(original, new Date(2000, 0), new Date(2000, 0));

    ensure(checkout);

    expect(readFileSync(artifact(checkout, linuxTargets[0]), 'utf8')).toContain('other');
  });

  it('caches a target that a failed run built, once a later run succeeds', () => {
    const checkout = createCheckout('first');
    expect(() => ensure(checkout, [], { FAIL_TARGET: linuxTargets[1] })).toThrow();
    ensure(checkout);

    ensure(createCheckout('second'), ['--restore-only']);

    expect(builds()).toEqual(linuxTargets);
    expect(readFileSync(artifact(join(sandbox, 'second'), linuxTargets[0]), 'utf8')).toBe(
      'fn main() {}\n'
    );
  });

  it('treats an interrupted install as out of date', () => {
    const checkout = createCheckout('first');
    ensure(checkout);
    writeArtifact(checkout, linuxTargets[0], 'old binary');
    writeFileSync(join(checkout, 'native/artifacts', linuxTargets[0], '.dev-build'), '');

    ensure(checkout, ['--restore-only']);

    expect(readFileSync(artifact(checkout, linuxTargets[0]), 'utf8')).toBe('fn main() {}\n');
  });

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

    expect(output).toContain('not cached');
    expect(output).toContain('out of date');
    expect(output).toContain('npm run dev -- --companion');
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
