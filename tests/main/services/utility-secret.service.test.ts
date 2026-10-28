import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

const electronMock = mockElectron({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(`enc:${value}`, 'utf8')),
    decryptStringAsync: vi.fn(async (value: Buffer) => ({
      result: value.toString('utf8').replace(/^enc:/, ''),
      shouldReEncrypt: false,
    })),
  },
});

vi.mock('electron', () => electronMock);

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSyncAtomic: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockOpenSync = vi.mocked(openSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
let storedFiles: Record<string, string>;
const secretPath = join('/tmp/komla-secret-test', 'utility-openrouter-key.json');

describe('UtilitySecretService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.KOMLA_DATA_DIR = '/tmp/komla-secret-test';
    storedFiles = {};
    electronMock.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(true);
    electronMock.safeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
    electronMock.safeStorage.encryptStringAsync.mockImplementation(async (value: string) =>
      Buffer.from(`enc:${value}`, 'utf8')
    );
    electronMock.safeStorage.decryptStringAsync.mockImplementation(async (value: Buffer) => ({
      result: value.toString('utf8').replace(/^enc:/, ''),
      shouldReEncrypt: false,
    }));
    mockExistsSync.mockImplementation((path) => {
      return String(path) in storedFiles;
    });
    mockReadFileSync.mockImplementation((path) => {
      const value = storedFiles[String(path)];
      if (value === undefined) {
        throw new Error(`missing file: ${String(path)}`);
      }
      return value;
    });
    mockWriteFileSync.mockImplementation((target, data) => {
      if (typeof target === 'number') {
        storedFiles[secretPath] = String(data);
        return;
      }
      storedFiles[String(target)] = String(data);
    });
    mockUnlinkSync.mockImplementation((path) => {
      delete storedFiles[String(path)];
    });
  });

  it('stores and retrieves the API key with secure storage when available', async () => {
    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    const result = await utilitySecretService.setOpenRouterApiKey('sk-or-test');
    const value = await utilitySecretService.getOpenRouterApiKey();
    const status = await utilitySecretService.getStatus();

    expect(result).toEqual({ storage: 'secure' });
    expect(value).toBe('sk-or-test');
    expect(status).toEqual({ hasKey: true, storage: 'secure' });
    expect(storedFiles[secretPath]).toBe(
      JSON.stringify({ storage: 'secure', encryptedValue: 'ZW5jOnNrLW9yLXRlc3Q=' }, null, 2)
    );
    expect(electronMock.safeStorage.encryptStringAsync).toHaveBeenCalledWith('sk-or-test');
  });

  it('falls back to file storage when secure storage is unavailable', async () => {
    electronMock.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);

    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    const result = await utilitySecretService.setOpenRouterApiKey('sk-or-file');

    expect(result).toEqual({ storage: 'file' });
    expect(storedFiles[secretPath]).toBe(
      JSON.stringify({ storage: 'file', openRouterApiKey: 'sk-or-file' }, null, 2)
    );

    const value = await utilitySecretService.getOpenRouterApiKey();
    const status = await utilitySecretService.getStatus();

    expect(value).toBe('sk-or-file');
    expect(status).toEqual({ hasKey: true, storage: 'file' });
    expect(mockOpenSync).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^${secretPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]+\\.tmp$`)
      ),
      'w',
      0o600
    );
  });

  it('clears both secure and fallback file storage', async () => {
    electronMock.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);

    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    await utilitySecretService.setOpenRouterApiKey('sk-or-clear');
    await utilitySecretService.clearOpenRouterApiKey();

    expect(mockUnlinkSync).toHaveBeenCalledWith(
      join('/tmp/komla-secret-test', 'utility-openrouter-key.json')
    );

    const value = await utilitySecretService.getOpenRouterApiKey();
    const status = await utilitySecretService.getStatus();

    expect(value).toBeNull();
    expect(status).toEqual({ hasKey: false, storage: 'none' });
  });

  it('reports fallback status when secure storage write fails', async () => {
    electronMock.safeStorage.encryptStringAsync.mockRejectedValue(new Error('keychain locked'));

    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    const result = await utilitySecretService.setOpenRouterApiKey('sk-or-fallback');

    expect(result).toEqual({ storage: 'file' });
    expect(storedFiles[secretPath]).toBe(
      JSON.stringify({ storage: 'file', openRouterApiKey: 'sk-or-fallback' }, null, 2)
    );

    const status = await utilitySecretService.getStatus();
    expect(status).toEqual({ hasKey: true, storage: 'file' });
  });

  it('falls back to file storage when the selected secure backend is basic_text', async () => {
    electronMock.safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');

    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    const result = await utilitySecretService.setOpenRouterApiKey('sk-or-basic');
    const status = await utilitySecretService.getStatus();

    expect(result).toEqual({ storage: 'file' });
    expect(status).toEqual({ hasKey: true, storage: 'file' });
    expect(electronMock.safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(storedFiles[secretPath]).toBe(
      JSON.stringify({ storage: 'file', openRouterApiKey: 'sk-or-basic' }, null, 2)
    );
  });

  it('re-encrypts a stored key when secure storage asks for it', async () => {
    storedFiles[secretPath] = JSON.stringify(
      { storage: 'secure', encryptedValue: Buffer.from('old:sk-or-test').toString('base64') },
      null,
      2
    );
    electronMock.safeStorage.decryptStringAsync.mockResolvedValueOnce({
      result: 'sk-or-test',
      shouldReEncrypt: true,
    });

    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    expect(await utilitySecretService.getOpenRouterApiKey()).toBe('sk-or-test');
    expect(electronMock.safeStorage.encryptStringAsync).toHaveBeenCalledWith('sk-or-test');
    expect(storedFiles[secretPath]).toBe(
      JSON.stringify({ storage: 'secure', encryptedValue: 'ZW5jOnNrLW9yLXRlc3Q=' }, null, 2)
    );
  });

  it('keeps a key saved while a stored key was being re-encrypted', async () => {
    storedFiles[secretPath] = JSON.stringify(
      { storage: 'secure', encryptedValue: Buffer.from('old:sk-or-test').toString('base64') },
      null,
      2
    );
    electronMock.safeStorage.decryptStringAsync.mockResolvedValueOnce({
      result: 'sk-or-test',
      shouldReEncrypt: true,
    });
    const saved = JSON.stringify({ storage: 'file', openRouterApiKey: 'sk-or-new' }, null, 2);
    electronMock.safeStorage.encryptStringAsync.mockImplementationOnce(async (value: string) => {
      storedFiles[secretPath] = saved;
      return Buffer.from(`enc:${value}`, 'utf8');
    });

    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    expect(await utilitySecretService.getOpenRouterApiKey()).toBe('sk-or-test');
    expect(storedFiles[secretPath]).toBe(saved);
  });

  it('keeps a key cleared while it was being re-encrypted cleared', async () => {
    storedFiles[secretPath] = JSON.stringify(
      { storage: 'secure', encryptedValue: Buffer.from('old:sk-or-test').toString('base64') },
      null,
      2
    );
    electronMock.safeStorage.decryptStringAsync.mockResolvedValueOnce({
      result: 'sk-or-test',
      shouldReEncrypt: true,
    });
    electronMock.safeStorage.encryptStringAsync.mockImplementationOnce(async (value: string) => {
      delete storedFiles[secretPath];
      return Buffer.from(`enc:${value}`, 'utf8');
    });

    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    await utilitySecretService.getOpenRouterApiKey();
    expect(storedFiles[secretPath]).toBeUndefined();
  });

  it('reports no usable key once a secure record fails to decrypt', async () => {
    storedFiles[secretPath] = JSON.stringify(
      { storage: 'secure', encryptedValue: 'ZW5jOnNrLW9yLXRlc3Q=' },
      null,
      2
    );
    electronMock.safeStorage.decryptStringAsync.mockRejectedValue(
      new Error('decryption unavailable')
    );

    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    const value = await utilitySecretService.getOpenRouterApiKey();
    const status = await utilitySecretService.getStatus();

    expect(value).toBeNull();
    expect(status).toEqual({ hasKey: false, storage: 'none' });

    await utilitySecretService.setOpenRouterApiKey('sk-or-new');
    expect(await utilitySecretService.getStatus()).toEqual({ hasKey: true, storage: 'secure' });
  });

  it('reports no usable key once a secure record is read while encryption is unavailable', async () => {
    storedFiles[secretPath] = JSON.stringify(
      { storage: 'secure', encryptedValue: 'ZW5jOnNrLW9yLXRlc3Q=' },
      null,
      2
    );
    electronMock.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);

    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    const value = await utilitySecretService.getOpenRouterApiKey();
    const status = await utilitySecretService.getStatus();

    expect(value).toBeNull();
    expect(electronMock.safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    expect(status).toEqual({ hasKey: false, storage: 'none' });
  });

  it('reports a secure key without touching secure storage', async () => {
    // Settings loads this status on launch; decrypting here is a Keychain
    // prompt on macOS even when the key is never used.
    storedFiles[secretPath] = JSON.stringify(
      { storage: 'secure', encryptedValue: 'ZW5jOnNrLW9yLXRlc3Q=' },
      null,
      2
    );

    const { utilitySecretService } =
      await import('../../../src/main/services/utility-secret.service');

    const status = await utilitySecretService.getStatus();

    expect(status).toEqual({ hasKey: true, storage: 'secure' });
    expect(electronMock.safeStorage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    expect(electronMock.safeStorage.decryptStringAsync).not.toHaveBeenCalled();
  });
});
