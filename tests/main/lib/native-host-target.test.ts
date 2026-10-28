import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const script = resolve('scripts/native-host-target.sh');

describe('remote companion host target', () => {
  it.each([
    ['Linux', 'x86_64', 'x86_64-unknown-linux-musl'],
    ['Linux', 'amd64', 'x86_64-unknown-linux-musl'],
    ['Linux', 'aarch64', 'aarch64-unknown-linux-musl'],
    ['Linux', 'arm64', 'aarch64-unknown-linux-musl'],
  ])('maps %s %s to %s', (operatingSystem, architecture, expected) => {
    expect(
      execFileSync('bash', [script, operatingSystem, architecture], { encoding: 'utf8' }).trim()
    ).toBe(expected);
  });

  it('rejects unsupported fixture architectures', () => {
    expect(() =>
      execFileSync('bash', [script, 'Linux', 'riscv64'], { encoding: 'utf8', stdio: 'pipe' })
    ).toThrow();
  });
});
