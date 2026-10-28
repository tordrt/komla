import { safeStorage } from 'electron';

import { createLogger } from './logger';

const logger = createLogger('SecureStorage');

/**
 * On Linux, Electron falls back to the `basic_text` backend when there is no
 * keyring. It uses a hardcoded password and offers no real protection, so
 * treat it as unavailable and let callers pick a stronger fallback (e.g.
 * machineId-keyed AES) instead of storing plaintext-equivalent data.
 */
function selectedBasicTextBackend(): boolean {
  const getSelectedStorageBackend = (
    safeStorage as typeof safeStorage & {
      getSelectedStorageBackend?: () => string;
    }
  ).getSelectedStorageBackend;
  return getSelectedStorageBackend?.() === 'basic_text';
}

/**
 * Whether the deprecated synchronous `safeStorage` methods protect data.
 * Electron 46 removes them.
 */
export function canUseSecureStorage(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return !selectedBasicTextBackend();
}

/**
 * Whether `encryptStringAsync`/`decryptStringAsync` protect data. On Linux
 * without a keyring, `isAsyncEncryptionAvailable()` resolves true while the
 * backend is `basic_text`, so that check stays.
 */
export async function canUseSecureStorageAsync(): Promise<boolean> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  return !selectedBasicTextBackend();
}

/** Where a caller keeps one base64 ciphertext. */
export interface StoredCiphertext {
  /** The ciphertext stored now, or null once it's gone or holds something else. */
  read(): string | null;
  write(encrypted: string): void;
}

/**
 * Decrypts `encrypted` (base64), and when Electron asks for it (the key rotated
 * or a stronger one became available) stores it again under the current key.
 * Decrypt errors reject; re-encrypt errors are only logged, since the caller
 * already has the plaintext.
 *
 * Re-encrypting awaits, so a save or clear can land in between. The rewrite is
 * skipped unless `store` still holds the ciphertext that was decrypted.
 */
export async function decryptStoredString(
  encrypted: string,
  store: StoredCiphertext,
  what: string
): Promise<string> {
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
    Buffer.from(encrypted, 'base64')
  );
  if (shouldReEncrypt) {
    try {
      const reEncrypted = (await safeStorage.encryptStringAsync(result)).toString('base64');
      if (store.read() === encrypted) store.write(reEncrypted);
    } catch (error) {
      logger.warn(`Failed to re-encrypt the ${what}`, error);
    }
  }
  return result;
}
