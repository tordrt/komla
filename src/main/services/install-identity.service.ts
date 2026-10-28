import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { safeStorage } from 'electron';

import { fingerprintFromPublicKey } from '@komla/remote-protocol';

import { writeFileAtomicSync } from '../lib/atomic-write';
import { IDENTITY_SIGNATURE_ENCODING, isP256Key, verifySignature } from '../lib/identity-crypto';
import { createLogger } from '../lib/logger';
import { canUseSecureStorageAsync, decryptStoredString } from '../lib/secure-storage';

import { ensureKomlaBasePath } from './paths';

const logger = createLogger('InstallIdentity');

const IDENTITY_FILE_NAME = 'install-identity.json';
const IDENTITY_FILE_MODE = 0o600;
const IDENTITY_FILE_VERSION = 1;

interface IdentityFileV1 {
  version: 1;
  // base64(safeStorage.encryptStringAsync(base64(PKCS8-DER private key)))
  encryptedKeyPair: string;
}

interface CachedIdentity {
  privateKey: KeyObject;
  publicKeyDer: Buffer;
  fingerprint: string;
}

/**
 * Per-install ECDSA-P256 cryptographic identity. Generated lazily on first
 * access, persisted to `<komla-data-dir>/install-identity.json`, encrypted at
 * rest with Electron's `safeStorage`.
 *
 * Fingerprint derivation: SHA-256 over the SPKI-DER public key, lowercase hex
 * (full 64 characters). Deterministic across platforms and process restarts;
 * callers may truncate for display without losing the canonical form.
 *
 * Fail-closed when secure storage is unavailable: if either
 * `safeStorage.isAsyncEncryptionAvailable()` resolves false (e.g. headless Linux
 * with no keyring) **or** Electron has selected the Linux `basic_text` backend
 * (which "encrypts" with a hardcoded password and offers no real protection),
 * the service refuses to generate or load a key and throws a clear error. We
 * don't fall back to plaintext — an unencrypted identity key is worse than
 * none, since callers would assume it carries the same trust.
 *
 * In-memory cache: after the first successful load, subsequent reads do not
 * re-hit the keychain or disk. If the on-disk file is deleted out from under a
 * running process, this process keeps using the cached key; the next process
 * restart will generate a fresh keypair.
 *
 * Pure verification: see {@link verifySignature} in `lib/identity-crypto`. That
 * module imports nothing from Electron, so it is reusable from non-Electron
 * Node contexts (e.g. a future relay verifier). The {@link verify} method on
 * this class is a thin convenience wrapper.
 */
export class InstallIdentityService {
  private readonly identityPath: string;
  private cached: CachedIdentity | null = null;
  private inFlight: Promise<CachedIdentity> | null = null;

  constructor(identityPath?: string) {
    this.identityPath = identityPath ?? join(ensureKomlaBasePath(), IDENTITY_FILE_NAME);
  }

  /** Returns the raw SPKI-DER encoded public key. */
  async getPublicKey(): Promise<Buffer> {
    return (await this.load()).publicKeyDer;
  }

  /** Returns the lowercase hex SHA-256 fingerprint of the SPKI public key. */
  async getFingerprint(): Promise<string> {
    return (await this.load()).fingerprint;
  }

  /** ECDSA-P256 / SHA-256 signature in IEEE-P1363 (r||s) format. */
  async sign(data: Buffer): Promise<Buffer> {
    const id = await this.load();
    return cryptoSign('sha256', data, {
      key: id.privateKey,
      dsaEncoding: IDENTITY_SIGNATURE_ENCODING,
    });
  }

  /** Pure verification — does not touch the local keypair. See {@link verifySignature}. */
  verify(data: Buffer, signature: Buffer, publicKey: Buffer): boolean {
    return verifySignature(data, signature, publicKey);
  }

  private load(): Promise<CachedIdentity> {
    if (this.cached) return Promise.resolve(this.cached);
    if (this.inFlight) return this.inFlight;
    // .finally clears inFlight on both success and rejection, so a failed
    // first call (e.g. transient encryptStringAsync failure) does not poison the
    // cache — a subsequent caller will retry from scratch.
    this.inFlight = this.loadOrGenerate()
      .then((cached) => {
        this.cached = cached;
        return cached;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async loadOrGenerate(): Promise<CachedIdentity> {
    if (!(await canUseSecureStorageAsync())) {
      throw new Error(
        'Cannot access install identity: OS secure storage (Electron safeStorage) is unavailable ' +
          'or has selected the unprotected basic_text backend. On Linux this typically means no ' +
          'keyring (libsecret/kwallet) is configured for the current session.'
      );
    }

    const file = this.readFile();
    if (file) {
      return this.decryptAndExpand(file);
    }
    return this.generateAndPersist();
  }

  private readFile(): IdentityFileV1 | null {
    if (!existsSync(this.identityPath)) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.identityPath, 'utf8'));
    } catch (error) {
      // Mirror the PKCS8 sanitization pattern: log the underlying parser/fs
      // error for debugging, throw a stable operator-facing message that
      // doesn't depend on the JS engine's parser text.
      logger.warn('Install identity file is unreadable', error);
      throw new Error(
        `Install identity file is unreadable at ${this.identityPath}. ` +
          `Delete the file to regenerate (this will rotate the install identity).`
      );
    }

    const raw = parsed as Partial<IdentityFileV1>;
    if (
      raw.version === IDENTITY_FILE_VERSION &&
      typeof raw.encryptedKeyPair === 'string' &&
      raw.encryptedKeyPair.length > 0
    ) {
      return { version: IDENTITY_FILE_VERSION, encryptedKeyPair: raw.encryptedKeyPair };
    }

    throw new Error(
      `Install identity file is malformed or has unsupported version (got ${String(raw.version)}, expected ${IDENTITY_FILE_VERSION}).`
    );
  }

  private async decryptAndExpand(file: IdentityFileV1): Promise<CachedIdentity> {
    let pkcs8Base64: string;
    try {
      pkcs8Base64 = await decryptStoredString(
        file.encryptedKeyPair,
        {
          read: () => this.readFile()?.encryptedKeyPair ?? null,
          write: (encryptedKeyPair) => this.persist(encryptedKeyPair),
        },
        'install identity'
      );
    } catch (error) {
      // safeStorage.decryptStringAsync rejects with platform-native messages
      // (Keychain on macOS, DPAPI on Windows, libsecret on Linux). Log the raw
      // text for debugging but keep the throw stable across platforms.
      logger.warn('Install identity safeStorage.decryptStringAsync failed', error);
      throw new Error(
        `Failed to decrypt install identity. The OS keychain may have changed, ` +
          `or the file may have been written by a different OS user. ` +
          `Delete ${this.identityPath} to regenerate (this will rotate the install identity).`
      );
    }

    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({
        key: Buffer.from(pkcs8Base64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    } catch (error) {
      // Decryption succeeded but the plaintext is not a valid PKCS8 key. Log
      // the raw OpenSSL message for debugging, but keep it out of the thrown
      // error so the operator sees a stable, actionable message instead of
      // platform-dependent text like "error:0680006C:asn1 encoding routines".
      logger.warn('Install identity PKCS8 parse failed', error);
      throw new Error(
        `Install identity file is corrupted or incompatible (decrypted plaintext is not a valid PKCS8 private key). ` +
          `Delete ${this.identityPath} to regenerate (this will rotate the install identity).`
      );
    }

    const cached = await this.expand(privateKey);
    logger.info('Loaded install identity', { fingerprint: cached.fingerprint });
    return cached;
  }

  private async generateAndPersist(): Promise<CachedIdentity> {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pkcs8Der = privateKey.export({ format: 'der', type: 'pkcs8' });

    let encrypted: Buffer;
    try {
      encrypted = await safeStorage.encryptStringAsync(pkcs8Der.toString('base64'));
    } catch (error) {
      // safeStorage.encryptStringAsync can reject with platform-native messages
      // (Keychain on macOS, DPAPI on Windows, libsecret on Linux). Mirror the
      // load-path pattern: log raw text, throw stable cross-platform message.
      logger.warn('Install identity safeStorage.encryptStringAsync failed', error);
      throw new Error(
        `Failed to encrypt new install identity. The OS keychain may be locked or unavailable. ` +
          `Unlock the keychain (or restart the session that owns it) and retry.`
      );
    }

    try {
      this.persist(encrypted.toString('base64'));
    } catch (error) {
      logger.warn('Install identity persistence failed', error);
      throw new Error(
        `Failed to persist install identity at ${this.identityPath}. ` +
          `Check filesystem permissions and available disk space.`
      );
    }

    const cached = await this.expand(privateKey);
    logger.info('Generated new install identity', { fingerprint: cached.fingerprint });
    return cached;
  }

  private persist(encryptedKeyPair: string): void {
    const file: IdentityFileV1 = { version: IDENTITY_FILE_VERSION, encryptedKeyPair };
    writeFileAtomicSync(this.identityPath, JSON.stringify(file, null, 2), IDENTITY_FILE_MODE);
  }

  private async expand(privateKey: KeyObject): Promise<CachedIdentity> {
    // Defense in depth: enforce the P-256 contract on every cached identity.
    // The generate path always produces P-256 (we ask for it explicitly), but
    // the load path runs through whatever PKCS8 was on disk — a different
    // curve or algorithm there must not silently change the primitive under
    // future remote-control admission code.
    if (!isP256Key(privateKey)) {
      throw new Error(
        `Install identity must be ECDSA-P256, got asymmetricKeyType=${String(privateKey.asymmetricKeyType)} ` +
          `namedCurve=${String(privateKey.asymmetricKeyDetails?.namedCurve)}. ` +
          `Delete ${this.identityPath} to regenerate (this will rotate the install identity).`
      );
    }
    const publicKey = createPublicKey(privateKey);
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
    // Single source of truth for the fingerprint convention — same WebCrypto
    // derivation the worker and the future browser/RN client use. Async on
    // Node 20+ via globalThis.crypto.subtle.digest; the prior sync Node hash
    // is gone so any divergence in the algorithm is impossible by construction.
    const fingerprint = await fingerprintFromPublicKey(publicKeyDer);
    return { privateKey, publicKeyDer, fingerprint };
  }
}

export const installIdentityService = new InstallIdentityService();
