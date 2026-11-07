import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { SecretFileStore } from '../../../src/main/services/secret-file-store';

import type { SecretCipher } from '../../../src/main/services/plugin-settings';

/** Reversible, so a test can tell the file holds ciphertext; `enc1:` is an older key's. */
function fakeCipher(available = true): SecretCipher & { available: () => Promise<boolean> } {
  return {
    available: vi.fn(async () => available),
    encrypt: async (text) => Buffer.from(`enc2:${text}`).toString('base64'),
    decrypt: async (base64) => {
      const text = Buffer.from(base64, 'base64').toString();
      const match = /^enc([12]):/.exec(text);
      if (!match) throw new Error('not ours');
      return { text: text.slice(5), reEncrypt: match[1] === '1' };
    },
  };
}

const CONTENTS = 'API_KEY=sk-live-123\nexport DATABASE_URL=postgres://x\n# NOT_A_NAME=1\n';

describe('SecretFileStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'komla-secret-files-'));
    path = join(dir, 'secret-files.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps contents encrypted, readable by the user alone, with only the names in the clear', async () => {
    const store = new SecretFileStore(path, fakeCipher());

    const status = await store.set('project-1', 'step-1', CONTENTS);

    expect(status).toEqual({ names: ['API_KEY', 'DATABASE_URL'], storage: 'keychain' });
    const file = readFileSync(path, 'utf-8');
    expect(file).not.toContain('sk-live-123');
    expect(file).toContain('API_KEY');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    // A new store reads what an earlier one saved.
    const reopened = new SecretFileStore(path, fakeCipher());
    expect(reopened.status('project-1')).toEqual({ 'step-1': status });
    await expect(reopened.read('project-1', 'step-1')).resolves.toBe(CONTENTS);
  });

  it('keeps contents in the file alone without a keychain, and encrypts them once there is one', async () => {
    await new SecretFileStore(path, fakeCipher(false)).set('project-1', 'step-1', CONTENTS);
    expect(readFileSync(path, 'utf-8')).toContain('sk-live-123');

    const store = new SecretFileStore(path, fakeCipher(true));
    expect(store.status('project-1')['step-1']?.storage).toBe('file');
    await expect(store.read('project-1', 'step-1')).resolves.toBe(CONTENTS);

    expect(readFileSync(path, 'utf-8')).not.toContain('sk-live-123');
    expect(store.status('project-1')['step-1']?.storage).toBe('keychain');
  });

  it('saves nothing when the keychain refuses, rather than keeping them in the clear', async () => {
    const cipher = fakeCipher();
    cipher.encrypt = async () => {
      throw new Error('User denied');
    };
    const store = new SecretFileStore(path, cipher);

    await expect(store.set('project-1', 'step-1', CONTENTS)).rejects.toThrow(/didn’t save/);

    expect(existsSync(path)).toBe(false);
    expect(store.status('project-1')).toEqual({});
  });

  it('encrypts contents again under the current key when the keychain asks', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        projects: {
          'project-1': {
            'step-1': { names: ['A'], keychain: Buffer.from('enc1:A=1').toString('base64') },
          },
        },
      })
    );
    const store = new SecretFileStore(path, fakeCipher());

    await expect(store.read('project-1', 'step-1')).resolves.toBe('A=1');

    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    expect(Buffer.from(saved.projects['project-1']['step-1'].keychain, 'base64').toString()).toBe(
      'enc2:A=1'
    );
  });

  it('refuses to read keychain contents while the keychain is unavailable', async () => {
    await new SecretFileStore(path, fakeCipher()).set('project-1', 'step-1', CONTENTS);

    await expect(
      new SecretFileStore(path, fakeCipher(false)).read('project-1', 'step-1')
    ).rejects.toThrow(/keychain isn’t available/);
  });

  it('says contents it can’t decrypt need setting again', async () => {
    writeFileSync(
      path,
      JSON.stringify({ projects: { p: { s: { names: [], keychain: 'garbage' } } } })
    );

    await expect(new SecretFileStore(path, fakeCipher()).read('p', 's')).rejects.toThrow(
      /Set its contents again/
    );
  });

  it('clears contents set to nothing, and forgets the project once it has none', async () => {
    const store = new SecretFileStore(path, fakeCipher());
    await store.set('project-1', 'step-1', CONTENTS);

    await expect(store.set('project-1', 'step-1', '')).resolves.toBeNull();

    expect(store.status('project-1')).toEqual({});
    await expect(store.read('project-1', 'step-1')).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(path, 'utf-8')).projects).toEqual({});
  });

  it('forgets the contents of steps a project no longer has, and of deleted projects', async () => {
    const store = new SecretFileStore(path, fakeCipher());
    await store.set('project-1', 'kept', 'A=1');
    await store.set('project-1', 'removed', 'B=2');
    await store.set('project-2', 'other', 'C=3');

    store.retain('project-1', new Set(['kept']));
    store.retain('project-2', new Set());

    expect(Object.keys(store.status('project-1'))).toEqual(['kept']);
    expect(store.status('project-2')).toEqual({});
    expect(readFileSync(path, 'utf-8')).not.toContain('removed');
  });

  it('rejects contents over its limit without saving them', async () => {
    const store = new SecretFileStore(path, fakeCipher());

    await expect(store.set('p', 's', 'x'.repeat(64 * 1024 + 1))).rejects.toThrow(/64 KB/);
    expect(existsSync(path)).toBe(false);
  });

  it('sets aside a file it can’t read, so saving doesn’t lose it', async () => {
    writeFileSync(path, '{ not json');
    const store = new SecretFileStore(path, fakeCipher());

    expect(store.status('p')).toEqual({});
    await store.set('p', 's', 'A=1');

    expect(readFileSync(`${path}.unreadable`, 'utf-8')).toBe('{ not json');
  });
});
