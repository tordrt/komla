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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('native tests in npm test', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'komla-native-tests-'));
    mkdirSync(join(sandbox, 'bin'));
    writeExecutable(
      'rustc',
      [
        '#!/bin/sh',
        'printf "%s\\n" "${RUSTC_VERSION:-rustc 1.88.0}"',
        'if [ "$1" = -vV ]; then printf "host: %s\\n" "${RUSTC_HOST:-x86_64-unknown-linux-gnu}"; fi',
        '',
      ].join('\n')
    );
    writeExecutable(
      'cargo',
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$CARGO_LOG"',
        'if [ -n "${EDIT_DURING_TEST:-}" ]; then',
        '  printf "// edited\\n" >> "$EDIT_DURING_TEST"',
        'fi',
        'exit "${CARGO_EXIT:-0}"',
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
    for (const directory of ['scripts', 'src/shared', 'native/src', 'native/tests']) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const script of ['test-native.sh', 'native-inputs.sh']) {
      copyFileSync(resolve('scripts', script), join(root, 'scripts', script));
    }
    for (const input of [
      'native/Cargo.toml',
      'native/Cargo.lock',
      'native/rust-toolchain.toml',
      'native/tests/cli.rs',
      'src/shared/git-line-count-policy.json',
      'src/shared/automation-schedule-cases.json',
    ]) {
      writeFileSync(join(root, input), `${input}\n`);
    }
    writeFileSync(join(root, 'native/src/main.rs'), source);
    return root;
  }

  function runTests(checkout: string, env: NodeJS.ProcessEnv = {}): string {
    return execFileSync('bash', [join(checkout, 'scripts/test-native.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(sandbox, 'home'),
        XDG_CACHE_HOME: join(sandbox, 'cache'),
        PATH: `${join(sandbox, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        GIT_CEILING_DIRECTORIES: sandbox,
        GIT_DIR: undefined,
        CARGO_LOG: join(sandbox, 'cargo.log'),
        KOMLA_FORCE_NATIVE_TESTS: undefined,
        ...env,
      },
    });
  }

  function cargoRuns(): number {
    const log = join(sandbox, 'cargo.log');
    return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
  }

  function cacheEntries(): string[] {
    const cache = join(sandbox, 'cache', 'komla-native-tests');
    return existsSync(cache) ? readdirSync(cache) : [];
  }

  it('runs the whole suite quietly from the checkout', () => {
    const checkout = createCheckout('first');

    runTests(checkout);

    // Git for Windows' bash prints the checkout as a POSIX path such as /d/a/sandbox/first.
    expect(readFileSync(join(sandbox, 'cargo.log'), 'utf8')).toMatch(
      /^test --manifest-path \S*\/first\/native\/Cargo\.toml --quiet\n$/
    );
  });

  it('skips the tests in another checkout once they passed for the same sources', () => {
    const first = createCheckout('first');
    runTests(first);

    const output = runTests(createCheckout('second'));

    expect(cargoRuns()).toBe(1);
    expect(output).toContain('Skipped the native Rust tests');
    expect(output).toContain(`${join(sandbox, 'cache')}/komla-native-tests/`);
    expect(output).toContain('KOMLA_FORCE_NATIVE_TESTS=1');
    expect(output.trim().split('\n')).toHaveLength(1);
  });

  it('runs the tests when KOMLA_FORCE_NATIVE_TESTS=1, even after a pass', () => {
    const checkout = createCheckout('first');
    runTests(checkout);

    runTests(checkout, { KOMLA_FORCE_NATIVE_TESTS: '1' });

    expect(cargoRuns()).toBe(2);
  });

  it.each([
    ['a native source', 'native/src/main.rs'],
    ['a native test', 'native/tests/cli.rs'],
    ['Cargo.lock', 'native/Cargo.lock'],
    ['the pinned toolchain', 'native/rust-toolchain.toml'],
    ['the line count policy the crate includes', 'src/shared/git-line-count-policy.json'],
    ['the schedule cases the tests read', 'src/shared/automation-schedule-cases.json'],
  ])('runs the tests again when %s changes', (_name, input) => {
    const checkout = createCheckout('first');
    runTests(checkout);

    writeFileSync(join(checkout, input), 'changed\n');
    runTests(checkout);

    expect(cargoRuns()).toBe(2);
  });

  it('runs the tests again when a native test file is added', () => {
    const checkout = createCheckout('first');
    runTests(checkout);

    writeFileSync(join(checkout, 'native/tests/new.rs'), '#[test]\nfn new() {}\n');
    runTests(checkout);

    expect(cargoRuns()).toBe(2);
  });

  it('runs the tests again under another Rust version', () => {
    const checkout = createCheckout('first');
    runTests(checkout);

    runTests(checkout, { RUSTC_VERSION: 'rustc 1.89.0' });

    expect(cargoRuns()).toBe(2);
  });

  it('runs the tests again under a Rust toolchain for another host', () => {
    const checkout = createCheckout('first');
    runTests(checkout);

    runTests(checkout, { RUSTC_HOST: 'aarch64-apple-darwin' });

    expect(cargoRuns()).toBe(2);
  });

  it('ignores build output, gitignored files and hidden files', () => {
    const checkout = createCheckout('first');
    writeFileSync(join(checkout, '.gitignore'), '*.log\n');
    runTests(checkout);

    mkdirSync(join(checkout, 'native/target/debug'), { recursive: true });
    writeFileSync(join(checkout, 'native/target/debug/komla'), 'binary');
    mkdirSync(join(checkout, 'native/artifacts/x86_64-unknown-linux-musl'), {
      recursive: true,
    });
    writeFileSync(join(checkout, 'native/artifacts/x86_64-unknown-linux-musl/komla'), 'binary');
    writeFileSync(join(checkout, 'native/test.log'), 'log');
    writeFileSync(join(checkout, 'native/src/.main.rs.swp'), 'swap');
    runTests(checkout);

    expect(cargoRuns()).toBe(1);
  });

  it('does not record a failed run', () => {
    const checkout = createCheckout('first');

    expect(() => runTests(checkout, { CARGO_EXIT: '101' })).toThrow();
    runTests(checkout);

    expect(cargoRuns()).toBe(2);
  });

  it('does not record a pass when the sources changed while the tests ran', () => {
    const checkout = createCheckout('first');

    const output = runTests(checkout, {
      EDIT_DURING_TEST: join(checkout, 'native/src/main.rs'),
    });
    runTests(checkout);

    expect(output).toContain('not recorded');
    expect(cargoRuns()).toBe(2);
  });

  it('records a pass in place, leaving no temporary file', () => {
    runTests(createCheckout('first'));

    expect(cacheEntries()).toHaveLength(1);
    expect(cacheEntries()[0]).toMatch(/^[0-9a-f]{40}$/);
  });

  it('shares a pass with a checkout without git, such as an SSH Local copy', () => {
    runTests(createCheckout('worktree'));
    const localCopy = createCheckout('local-copy');
    rmSync(join(localCopy, '.git'), { recursive: true, force: true });

    const output = runTests(localCopy);

    expect(output).toContain('Skipped the native Rust tests');
    expect(cargoRuns()).toBe(1);
  });

  it('hashes the files of a checkout without git inside a repository that ignores it', () => {
    const home = join(sandbox, 'dotfiles');
    mkdirSync(home);
    execFileSync('git', ['init', '-q'], { cwd: home });
    writeFileSync(join(home, '.gitignore'), '*\n');
    const localCopy = createCheckout('dotfiles/local-copy');
    rmSync(join(localCopy, '.git'), { recursive: true, force: true });
    runTests(localCopy);

    writeFileSync(join(localCopy, 'native/src/main.rs'), 'fn main() { changed(); }\n');
    runTests(localCopy);

    expect(cargoRuns()).toBe(2);
  });

  it('fails rather than hashing part of the inputs when a checkout without git cannot be listed', () => {
    const localCopy = createCheckout('unlisted');
    rmSync(join(localCopy, '.git'), { recursive: true, force: true });
    rmSync(join(localCopy, 'native'), { recursive: true, force: true });

    expect(() => runTests(localCopy)).toThrow();
    expect(cargoRuns()).toBe(0);
  });
});
