import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

import { safeStorage } from 'electron';

import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';
import { canUseSecureStorageAsync, decryptStoredString } from '../lib/secure-storage';

import { configService } from './config.service';

const logger = createLogger('UtilitySecretService');
const SECRET_FILE_NAME = 'utility-openrouter-key.json';
const SECRET_FILE_MODE = 0o600;

type SecretRecord =
  | {
      storage: 'secure';
      encryptedValue: string;
    }
  | {
      storage: 'file';
      openRouterApiKey: string;
    };

class UtilitySecretService {
  private readonly secretPath = join(configService.getSettingsPath(), SECRET_FILE_NAME);
  // Set when the secure key could not be read, so status stops claiming a key
  // without decrypting it again.
  private secureKeyUnreadable = false;

  async getOpenRouterApiKey(): Promise<string | null> {
    const record = this.readRecord();
    if (!record) {
      return null;
    }

    if (record.storage === 'file') {
      return record.openRouterApiKey || null;
    }

    if (!(await canUseSecureStorageAsync())) {
      logger.warn('Secure utility key exists but secure storage is currently unavailable');
      this.secureKeyUnreadable = true;
      return null;
    }

    try {
      const result = await decryptStoredString(
        record.encryptedValue,
        {
          read: () => {
            const current = this.readRecord();
            return current?.storage === 'secure' ? current.encryptedValue : null;
          },
          write: (encryptedValue) => this.writeRecord({ storage: 'secure', encryptedValue }),
        },
        'stored utility API key'
      );
      this.secureKeyUnreadable = false;
      return result;
    } catch (error) {
      logger.warn('Failed to decrypt stored utility API key', error);
      this.secureKeyUnreadable = true;
      return null;
    }
  }

  async setOpenRouterApiKey(value: string): Promise<{ storage: 'secure' | 'file' }> {
    this.secureKeyUnreadable = false;
    try {
      if (await canUseSecureStorageAsync()) {
        const encryptedValue = (await safeStorage.encryptStringAsync(value)).toString('base64');
        this.writeRecord({ storage: 'secure', encryptedValue });
        return { storage: 'secure' };
      }
    } catch (error) {
      logger.warn('Failed to store utility API key with secure storage, using fallback', error);
    }

    this.writeRecord({ storage: 'file', openRouterApiKey: value });
    return { storage: 'file' };
  }

  async clearOpenRouterApiKey(): Promise<void> {
    try {
      unlinkSync(this.secretPath);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code !== 'ENOENT') {
        logger.warn('Failed to clear utility API key file', error);
      }
    }
  }

  async getStatus(): Promise<{ hasKey: boolean; storage: 'secure' | 'file' | 'none' }> {
    const record = this.readRecord();
    if (!record) {
      return { hasKey: false, storage: 'none' };
    }

    if (record.storage === 'file') {
      return { hasKey: record.openRouterApiKey.length > 0, storage: 'file' };
    }

    // Don't decrypt to report status: Settings loads it on launch, and on
    // macOS any secure storage read can show a Keychain prompt.
    if (this.secureKeyUnreadable) {
      return { hasKey: false, storage: 'none' };
    }

    return { hasKey: true, storage: 'secure' };
  }

  private readRecord(): SecretRecord | null {
    try {
      if (!existsSync(this.secretPath)) {
        return null;
      }

      const raw = JSON.parse(readFileSync(this.secretPath, 'utf8')) as Partial<SecretRecord>;
      if (
        raw.storage === 'secure' &&
        typeof raw.encryptedValue === 'string' &&
        raw.encryptedValue.length > 0
      ) {
        return { storage: 'secure', encryptedValue: raw.encryptedValue };
      }

      if (
        raw.storage === 'file' &&
        typeof raw.openRouterApiKey === 'string' &&
        raw.openRouterApiKey.length > 0
      ) {
        return { storage: 'file', openRouterApiKey: raw.openRouterApiKey };
      }
    } catch (error) {
      logger.warn('Failed to read utility API key file', error);
    }

    return null;
  }

  private writeRecord(record: SecretRecord): void {
    writeFileAtomicSync(this.secretPath, JSON.stringify(record, null, 2), SECRET_FILE_MODE);
  }
}

export const utilitySecretService = new UtilitySecretService();
