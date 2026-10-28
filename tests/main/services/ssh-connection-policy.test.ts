import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;
const originalTmpdir = process.env.TMPDIR;
let testRoot: string | undefined;

describe('SSH connection policy', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    if (testRoot) rmSync(testRoot, { recursive: true, force: true });
    testRoot = undefined;
    vi.resetModules();
  });

  it('keeps control paths short enough for the macOS OpenSSH listener suffix', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    testRoot = mkdtempSync('/tmp/komla-ssh-policy-');
    const longTmpdir = join(testRoot, 'a'.repeat(64));
    mkdirSync(longTmpdir);
    process.env.TMPDIR = longTmpdir;
    vi.resetModules();

    const { sshControlPath } = await import('../../../src/main/services/ssh-connection/policy');
    const controlPath = sshControlPath(
      {
        id: 'ssh-dev',
        name: 'Devbox',
        hostname: 'example.com',
        user: 'dev',
        basePath: '~/.komla',
      },
      { kind: 'background' }
    );

    expect(controlPath).toBeDefined();
    expect(Buffer.byteLength(`${controlPath}.1234567890123456`)).toBeLessThanOrEqual(103);
  });
});
