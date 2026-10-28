import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A minimal PE image: DOS header, PE signature and an optional header with 16 data directories. */
function peImage({ pe32Plus = true, signed = false } = {}) {
  const peOffset = 0x80;
  const optionalHeader = peOffset + 24;
  const directories = optionalHeader + (pe32Plus ? 112 : 96);
  const image = Buffer.alloc(directories + 16 * 8);
  image.write('MZ', 0, 'latin1');
  image.writeUInt32LE(peOffset, 0x3c);
  image.write('PE\0\0', peOffset, 'latin1');
  image.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, optionalHeader);
  image.writeUInt32LE(16, directories - 4);
  if (signed) {
    image.writeUInt32LE(0x2000, directories + 4 * 8);
    image.writeUInt32LE(0x200, directories + 4 * 8 + 4);
  }
  return image;
}

describe('Windows signing hook', () => {
  let directory: string;
  let record: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'komla-windows-sign-'));
    record = join(directory, 'jsign-calls.txt');
    const jsign = join(directory, 'jsign');
    await writeFile(
      jsign,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${record}'\necho "storepass=$WIN_SIGN_STOREPASS" >> '${record}'\nexit "\${JSIGN_STUB_EXIT:-0}"\n`
    );
    await chmod(jsign, 0o755);
    vi.stubEnv('JSIGN', jsign);
    vi.stubEnv('WIN_SIGN_STORETYPE', 'ESIGNER');
    vi.stubEnv('WIN_SIGN_KEYSTORE', '');
    vi.stubEnv('WIN_SIGN_STOREPASS', 'user|secret');
    vi.stubEnv('WIN_SIGN_KEYPASS', '');
    vi.stubEnv('WIN_SIGN_ALIAS', 'certificate-id');
    vi.stubEnv('WIN_SIGN_CERTFILE', '');
    vi.stubEnv('WIN_SIGN_TSA_URL', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function signFile(name: string, contents: Buffer) {
    const file = join(directory, name);
    await writeFile(file, contents);
    const { default: hook } = await import('../../../scripts/windows-sign.cjs');
    await hook.sign({ path: file, name: 'Komla' });
    return file;
  }

  async function jsignCalls() {
    return readFile(record, 'utf8').catch(() => '');
  }

  it('does nothing when no signing store is configured', async () => {
    vi.stubEnv('WIN_SIGN_STORETYPE', '');

    await signFile('Komla.exe', peImage());

    expect(await jsignCalls()).toBe('');
  });

  // The jsign stub is a sh script, which Windows can't run as a command. Releases sign
  // Windows builds from macOS (see docs/RELEASING.md).
  it.skipIf(process.platform === 'win32')(
    'signs an unsigned binary without putting the password on the command line',
    async () => {
      const file = await signFile('Komla.exe', peImage({ pe32Plus: false }));

      const calls = await jsignCalls();
      expect(calls.split('\n')).toEqual([
        '--storetype',
        'ESIGNER',
        '--storepass',
        'env:WIN_SIGN_STOREPASS',
        '--alias',
        'certificate-id',
        '--alg',
        'SHA-256',
        '--tsaurl',
        'http://timestamp.digicert.com,http://timestamp.sectigo.com',
        '--tsmode',
        'RFC3161',
        '--name',
        'Komla',
        file,
        'storepass=user|secret',
        '',
      ]);
    }
  );

  it('keeps the signature of a binary that is already signed', async () => {
    await signFile('conpty.dll', peImage({ signed: true }));

    expect(await jsignCalls()).toBe('');
  });

  it('skips files that are not Windows binaries', async () => {
    await signFile('pty.node', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]));

    expect(await jsignCalls()).toBe('');
  });

  // The jsign stub is a sh script, which Windows can't run as a command.
  it.skipIf(process.platform === 'win32')('fails the build when jsign fails', async () => {
    vi.stubEnv('JSIGN_STUB_EXIT', '2');

    await expect(signFile('Komla.exe', peImage())).rejects.toThrow('exited with 2');
  });
});
