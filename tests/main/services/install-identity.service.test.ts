import { generateKeyPairSync } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
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
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

const dataDir = '/tmp/komla-install-identity-test';
const identityPath = join(dataDir, 'install-identity.json');

interface InstallIdentityModule {
  installIdentityService: {
    getPublicKey(): Promise<Buffer>;
    getFingerprint(): Promise<string>;
    sign(data: Buffer): Promise<Buffer>;
    verify(data: Buffer, signature: Buffer, publicKey: Buffer): boolean;
  };
  verifySignature(data: Buffer, signature: Buffer, publicKey: Buffer): boolean;
}

let storedFiles: Record<string, string>;

// Both modules are imported under the same vi.resetModules() so test code can
// touch the service singleton and the standalone pure verifier in the same
// expression. The verifier has no module-level state — re-importing it is
// effectively free.
async function freshService(): Promise<InstallIdentityModule> {
  vi.resetModules();
  const service = (await import('../../../src/main/services/install-identity.service')) as {
    installIdentityService: InstallIdentityModule['installIdentityService'];
  };
  const cryptoLib = (await import('../../../src/main/lib/identity-crypto')) as {
    verifySignature: InstallIdentityModule['verifySignature'];
  };
  return {
    installIdentityService: service.installIdentityService,
    verifySignature: cryptoLib.verifySignature,
  };
}

describe('InstallIdentityService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KOMLA_DATA_DIR = dataDir;
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

    mockExistsSync.mockImplementation((p) => String(p) in storedFiles);
    mockReadFileSync.mockImplementation((p) => {
      const value = storedFiles[String(p)];
      if (value === undefined) {
        throw new Error(`missing file: ${String(p)}`);
      }
      return value;
    });
    // writeFileAtomicSync opens a tmp fd then renames into place. The mocked
    // openSync returns fd=42 and renameSync is a no-op, so we capture the
    // payload directly under the final identity path when the write hits the fd.
    mockWriteFileSync.mockImplementation((target, data) => {
      if (typeof target === 'number') {
        storedFiles[identityPath] = String(data);
        return;
      }
      storedFiles[String(target)] = String(data);
    });
  });

  it('generates a fresh keypair on first access and persists an envelope', async () => {
    const { installIdentityService } = await freshService();

    const publicKey = await installIdentityService.getPublicKey();
    const fingerprint = await installIdentityService.getFingerprint();

    expect(publicKey).toBeInstanceOf(Buffer);
    expect(publicKey.length).toBeGreaterThan(0);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(storedFiles[identityPath]).toBeDefined();
    const file = JSON.parse(storedFiles[identityPath]) as {
      version: number;
      encryptedKeyPair: string;
    };
    expect(file.version).toBe(1);
    expect(typeof file.encryptedKeyPair).toBe('string');
    expect(file.encryptedKeyPair.length).toBeGreaterThan(0);
    expect(electronMock.safeStorage.encryptStringAsync).toHaveBeenCalledTimes(1);
  });

  it('round-trips: persisted keypair reloads to same fingerprint after restart', async () => {
    const { installIdentityService: first } = await freshService();
    const fingerprint1 = await first.getFingerprint();
    const publicKey1 = await first.getPublicKey();

    // Simulate a process restart by re-importing the module (drops the
    // singleton's in-memory cache) while keeping the persisted file on "disk".
    const { installIdentityService: second } = await freshService();
    const fingerprint2 = await second.getFingerprint();
    const publicKey2 = await second.getPublicKey();

    expect(fingerprint2).toBe(fingerprint1);
    expect(publicKey2.equals(publicKey1)).toBe(true);
    expect(electronMock.safeStorage.encryptStringAsync).toHaveBeenCalledTimes(1);
    expect(electronMock.safeStorage.decryptStringAsync).toHaveBeenCalledTimes(1);
  });

  it('re-encrypts the persisted keypair when safeStorage asks, keeping the identity', async () => {
    const { installIdentityService: first } = await freshService();
    const fingerprint1 = await first.getFingerprint();
    const envelope1 = storedFiles[identityPath];

    electronMock.safeStorage.decryptStringAsync.mockImplementationOnce(async (value: Buffer) => ({
      result: value.toString('utf8').replace(/^enc:/, ''),
      shouldReEncrypt: true,
    }));
    electronMock.safeStorage.encryptStringAsync.mockImplementationOnce(async (value: string) =>
      Buffer.from(`enc2:${value}`, 'utf8')
    );
    const { installIdentityService: second } = await freshService();

    expect(await second.getFingerprint()).toBe(fingerprint1);
    expect(storedFiles[identityPath]).not.toBe(envelope1);
    const file = JSON.parse(storedFiles[identityPath]) as { encryptedKeyPair: string };
    expect(Buffer.from(file.encryptedKeyPair, 'base64').toString('utf8')).toMatch(/^enc2:/);
  });

  it('does not recreate an identity file deleted while it was being re-encrypted', async () => {
    const { installIdentityService: first } = await freshService();
    await first.getFingerprint();

    electronMock.safeStorage.decryptStringAsync.mockImplementationOnce(async (value: Buffer) => ({
      result: value.toString('utf8').replace(/^enc:/, ''),
      shouldReEncrypt: true,
    }));
    electronMock.safeStorage.encryptStringAsync.mockImplementationOnce(async (value: string) => {
      delete storedFiles[identityPath];
      return Buffer.from(`enc2:${value}`, 'utf8');
    });
    const { installIdentityService: second } = await freshService();

    await second.getFingerprint();
    expect(storedFiles[identityPath]).toBeUndefined();
  });

  it('caches in memory: subsequent reads do not re-hit safeStorage', async () => {
    const { installIdentityService } = await freshService();

    await installIdentityService.getPublicKey();
    await installIdentityService.getFingerprint();
    await installIdentityService.sign(Buffer.from('hello'));

    expect(electronMock.safeStorage.encryptStringAsync).toHaveBeenCalledTimes(1);
    expect(electronMock.safeStorage.decryptStringAsync).toHaveBeenCalledTimes(0);
  });

  it('signs and verifies a payload', async () => {
    const { installIdentityService } = await freshService();
    const data = Buffer.from('the payload to be signed');

    const signature = await installIdentityService.sign(data);
    const publicKey = await installIdentityService.getPublicKey();

    // P-256 IEEE-P1363 signatures are exactly 64 bytes.
    expect(signature).toBeInstanceOf(Buffer);
    expect(signature.length).toBe(64);
    expect(installIdentityService.verify(data, signature, publicKey)).toBe(true);
  });

  it('verify rejects modified data', async () => {
    const { installIdentityService } = await freshService();
    const data = Buffer.from('original payload');
    const signature = await installIdentityService.sign(data);
    const publicKey = await installIdentityService.getPublicKey();

    expect(
      installIdentityService.verify(Buffer.from('tampered payload'), signature, publicKey)
    ).toBe(false);
  });

  it('verify rejects modified signature', async () => {
    const { installIdentityService } = await freshService();
    const data = Buffer.from('signed payload');
    const signature = await installIdentityService.sign(data);
    const publicKey = await installIdentityService.getPublicKey();

    const tampered = Buffer.from(signature);
    tampered[0] ^= 0xff;

    expect(installIdentityService.verify(data, tampered, publicKey)).toBe(false);
  });

  it('verify rejects an unrelated public key', async () => {
    const { installIdentityService, verifySignature } = await freshService();
    const data = Buffer.from('signed payload');
    const signature = await installIdentityService.sign(data);

    const { publicKey: otherPub } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const otherDer = otherPub.export({ format: 'der', type: 'spki' });

    expect(verifySignature(data, signature, otherDer)).toBe(false);
  });

  it('verify gracefully rejects garbage public-key bytes', async () => {
    const { installIdentityService, verifySignature } = await freshService();
    const data = Buffer.from('signed payload');
    const signature = await installIdentityService.sign(data);

    expect(verifySignature(data, signature, Buffer.from('not-a-key'))).toBe(false);
  });

  it('verifySignature works as a pure function without touching the local identity', async () => {
    const { verifySignature } = await freshService();

    // Use a fresh keypair generated outside the service entirely.
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
    const data = Buffer.from('out-of-band payload');
    const { sign: cryptoSign } = await import('crypto');
    const signature = cryptoSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });

    expect(verifySignature(data, signature, publicKeyDer)).toBe(true);
    // The verify path should not have triggered any storage I/O.
    expect(electronMock.safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(electronMock.safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('concurrent first-access calls share a single generated keypair', async () => {
    const { installIdentityService } = await freshService();
    const data = Buffer.from('parallel');

    const [pubA, fp, sig, pubB] = await Promise.all([
      installIdentityService.getPublicKey(),
      installIdentityService.getFingerprint(),
      installIdentityService.sign(data),
      installIdentityService.getPublicKey(),
    ]);

    expect(pubA.equals(pubB)).toBe(true);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(installIdentityService.verify(data, sig, pubA)).toBe(true);
    // Only one generation across all concurrent callers.
    expect(electronMock.safeStorage.encryptStringAsync).toHaveBeenCalledTimes(1);
  });

  it('clears inFlight after a failed first load so a later retry can succeed', async () => {
    // First call throws inside generateAndPersist with a unique sentinel so we
    // can also assert the throw is sanitized (sentinel must not leak into the
    // operator-facing message). Subsequent calls fall back to the default
    // (working) implementation set in beforeEach.
    const RAW_SENTINEL = 'transient-keychain-sentinel-XYZ-do-not-leak';
    electronMock.safeStorage.encryptStringAsync.mockRejectedValueOnce(new Error(RAW_SENTINEL));

    const { installIdentityService } = await freshService();

    let caught: Error | null = null;
    try {
      await installIdentityService.getPublicKey();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Failed to encrypt new install identity/i);
    expect(caught!.message).not.toContain(RAW_SENTINEL);

    // Retry: the .finally() in load() should have cleared inFlight, so this
    // call enters loadOrGenerate() afresh and succeeds.
    const publicKey = await installIdentityService.getPublicKey();
    expect(publicKey).toBeInstanceOf(Buffer);
    expect(publicKey.length).toBeGreaterThan(0);
    expect(storedFiles[identityPath]).toBeDefined();
    // 1 failed attempt + 1 successful attempt
    expect(electronMock.safeStorage.encryptStringAsync).toHaveBeenCalledTimes(2);
  });

  it('fails closed when safeStorage is unavailable: no key generated, no file written', async () => {
    electronMock.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);

    const { installIdentityService } = await freshService();

    await expect(installIdentityService.getPublicKey()).rejects.toThrow(
      /safeStorage|secure storage/i
    );
    await expect(installIdentityService.getFingerprint()).rejects.toThrow(
      /safeStorage|secure storage/i
    );
    await expect(installIdentityService.sign(Buffer.from('x'))).rejects.toThrow(
      /safeStorage|secure storage/i
    );

    expect(storedFiles[identityPath]).toBeUndefined();
    expect(electronMock.safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it('fails closed when safeStorage selected the unprotected basic_text backend', async () => {
    // isAsyncEncryptionAvailable() resolves true on Linux even when Electron has
    // fallen back to the basic_text backend (hardcoded password). The service
    // must additionally reject this case.
    electronMock.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(true);
    electronMock.safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');

    const { installIdentityService } = await freshService();

    await expect(installIdentityService.getPublicKey()).rejects.toThrow(
      /basic_text|safeStorage|secure storage/i
    );
    expect(storedFiles[identityPath]).toBeUndefined();
    expect(electronMock.safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it('verify still works when safeStorage is unavailable (pure function, no Electron coupling)', async () => {
    electronMock.safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);

    const { verifySignature } = await freshService();
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
    const data = Buffer.from('verify still works');
    const { sign: cryptoSign } = await import('crypto');
    const signature = cryptoSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });

    expect(verifySignature(data, signature, publicKeyDer)).toBe(true);
  });

  it('throws a sanitized error when the persisted file is malformed JSON', async () => {
    storedFiles[identityPath] = '{ this is not json';

    const { installIdentityService } = await freshService();

    let caught: Error | null = null;
    try {
      await installIdentityService.getPublicKey();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/unreadable/i);
    // The thrown message must not interpolate the underlying JSON parser
    // text — that detail is logged separately. Match phrases JS engines emit
    // ("Unexpected token", "Unexpected end of JSON input", "at position N"),
    // but not the literal substring "json" which appears in the file path.
    expect(caught!.message).not.toMatch(/Unexpected token|Unexpected end|at position \d+/i);
    expect(electronMock.safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it('throws a clear error when the persisted file has an unsupported version', async () => {
    storedFiles[identityPath] = JSON.stringify({ version: 99, encryptedKeyPair: 'AAAA' });

    const { installIdentityService } = await freshService();

    await expect(installIdentityService.getPublicKey()).rejects.toThrow(
      /malformed|unsupported version/i
    );
    expect(electronMock.safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it('throws a sanitized error when safeStorage cannot decrypt the persisted blob', async () => {
    // Seed a record from a previous "session" using the default mock encoding.
    const { installIdentityService: priming } = await freshService();
    await priming.getPublicKey();
    expect(storedFiles[identityPath]).toBeDefined();

    // New "session" that can no longer decrypt (e.g. user changed OS keychain).
    // The mock throws a recognizable string; the service must NOT include
    // that platform-native text in the thrown message.
    const RAW_NATIVE_MESSAGE = 'keychain-native-error-XYZ-do-not-leak';
    electronMock.safeStorage.decryptStringAsync.mockRejectedValue(new Error(RAW_NATIVE_MESSAGE));

    const { installIdentityService } = await freshService();

    let caught: Error | null = null;
    try {
      await installIdentityService.getPublicKey();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Failed to decrypt install identity/i);
    expect(caught!.message).not.toContain(RAW_NATIVE_MESSAGE);
  });

  it('throws a sanitized error when decrypted plaintext is not a valid PKCS8 EC key', async () => {
    // Seed a record where decryption succeeds but yields garbage that
    // createPrivateKey will reject. The default decryptStringAsync mock strips an
    // 'enc:' prefix, so we craft an envelope whose decrypted form is the
    // base64 of a 9-byte string that is definitely not a PKCS8 EC key.
    const fakeDecryptedPkcs8Base64 = Buffer.from('not-a-key').toString('base64');
    storedFiles[identityPath] = JSON.stringify({
      version: 1,
      encryptedKeyPair: Buffer.from(`enc:${fakeDecryptedPkcs8Base64}`, 'utf8').toString('base64'),
    });

    const { installIdentityService } = await freshService();

    let caught: Error | null = null;
    try {
      await installIdentityService.getPublicKey();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/corrupted or incompatible/i);
    // The thrown message must not leak the raw OpenSSL prefix
    // (`error:0680006C:...`) — that detail is logged separately.
    expect(caught!.message).not.toMatch(/error:[0-9a-f]{8}/i);
  });

  it('verifySignature rejects an RSA key + RSA signature (algorithm pinning)', async () => {
    const { verifySignature } = await freshService();

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const data = Buffer.from('attacker-controlled payload');
    const { sign: cryptoSign } = await import('crypto');
    const rsaSig = cryptoSign('sha256', data, rsa.privateKey);
    const rsaPubDer = rsa.publicKey.export({ format: 'der', type: 'spki' });

    expect(verifySignature(data, rsaSig, rsaPubDer)).toBe(false);
  });

  it('verifySignature rejects a P-384 key + P-384 signature (curve pinning)', async () => {
    const { verifySignature } = await freshService();

    const ec384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const data = Buffer.from('cross-curve payload');
    const { sign: cryptoSign } = await import('crypto');
    const ec384Sig = cryptoSign('sha256', data, {
      key: ec384.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    const ec384PubDer = ec384.publicKey.export({ format: 'der', type: 'spki' });

    expect(verifySignature(data, ec384Sig, ec384PubDer)).toBe(false);
  });

  it('throws on load when the persisted PKCS8 is a valid key but on the wrong curve', async () => {
    // Generate a real P-384 PKCS8, base64 it, and seed it as the "encrypted"
    // payload. Decryption succeeds, createPrivateKey succeeds (P-384 PKCS8 is
    // structurally valid), but expand() must reject because the curve is wrong.
    const ec384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const pkcs8Base64 = ec384.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    storedFiles[identityPath] = JSON.stringify({
      version: 1,
      encryptedKeyPair: Buffer.from(`enc:${pkcs8Base64}`, 'utf8').toString('base64'),
    });

    const { installIdentityService } = await freshService();

    await expect(installIdentityService.getPublicKey()).rejects.toThrow(
      /ECDSA-P256|prime256v1|secp384r1/i
    );
  });
});
