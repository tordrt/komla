import { copyFileSync, existsSync, readFileSync } from 'fs';

import { z } from 'zod';

import { MAX_SECRET_FILE_CONTENTS, secretFileNames } from '../../shared/lib/secret-file';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';

import type { SecretCipher } from './plugin-settings';
import type { SecretFileStatus } from '../../shared/types/project';

const logger = createLogger('SecretFiles');

const FILE_VERSION = 1;
const FILE_MODE = 0o600;

const storedSecretSchema = z.union([
  z.object({ names: z.array(z.string()), keychain: z.string() }),
  z.object({ names: z.array(z.string()), file: z.string() }),
]);

const storedFileSchema = z.object({
  _version: z.number().optional(),
  projects: z.record(z.string(), z.record(z.string(), storedSecretSchema)),
});

type StoredSecret = z.infer<typeof storedSecretSchema>;
type StoredFile = z.infer<typeof storedFileSchema>;

/** Thrown when a Secret file's contents can't be read, as when the keychain refuses. */
export class SecretFileError extends Error {
  override name = 'SecretFileError';
}

/**
 * The contents of each project's Secret file steps, by project and then step, in one file in
 * Komla's settings folder, encrypted by the OS keychain where there is one, and in that file alone
 * where there isn't. Settings gets only the names they set, which stay readable so it can list them
 * without asking the keychain. Only the main process decrypts the contents, as a step writes them.
 */
export class SecretFileStore {
  private stored: StoredFile | undefined;

  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher
  ) {}

  /** Each Secret file of the project that has contents, by step. */
  status(projectId: string): Record<string, SecretFileStatus> {
    const steps = this.file().projects[projectId] ?? {};
    return Object.fromEntries(
      Object.entries(steps).map(([stepId, secret]) => [stepId, statusOf(secret)])
    );
  }

  /** Keeps `contents` for a step, encrypted where the keychain can; '' clears them. */
  async set(projectId: string, stepId: string, contents: string): Promise<SecretFileStatus | null> {
    if (contents.length > MAX_SECRET_FILE_CONTENTS) {
      throw new SecretFileError('A Secret file holds at most 64 KB');
    }
    if (contents === '') {
      this.clear(projectId, stepId);
      return null;
    }
    const secret = await this.seal(contents);
    this.update((projects) => {
      projects[projectId] = { ...projects[projectId], [stepId]: secret };
    });
    return statusOf(secret);
  }

  clear(projectId: string, stepId: string): void {
    if (!this.file().projects[projectId]?.[stepId]) return;
    this.update((projects) => {
      const { [stepId]: _, ...rest } = projects[projectId] ?? {};
      if (Object.keys(rest).length > 0) projects[projectId] = rest;
      else delete projects[projectId];
    });
  }

  /** Forgets the contents of the project's steps that aren't among `stepIds`. */
  retain(projectId: string, stepIds: ReadonlySet<string>): void {
    const steps = this.file().projects[projectId];
    if (!steps || Object.keys(steps).every((stepId) => stepIds.has(stepId))) return;
    this.update((projects) => {
      const kept = Object.entries(steps).filter(([stepId]) => stepIds.has(stepId));
      if (kept.length > 0) projects[projectId] = Object.fromEntries(kept);
      else delete projects[projectId];
    });
  }

  /**
   * A step's contents, or undefined when it has none. Rejects when the keychain can't decrypt
   * them. Contents kept in the file alone, or under a key the keychain has since changed, are
   * encrypted again once the keychain can.
   */
  async read(projectId: string, stepId: string): Promise<string | undefined> {
    const secret = this.file().projects[projectId]?.[stepId];
    if (!secret) return undefined;
    if ('file' in secret) {
      await this.encryptAgain(projectId, stepId, secret, secret.file);
      return secret.file;
    }
    if (!(await this.keychainAvailable())) {
      throw new SecretFileError(
        'The keychain isn’t available, so Komla can’t decrypt this Secret file'
      );
    }
    let decrypted: { text: string; reEncrypt: boolean };
    try {
      decrypted = await this.cipher.decrypt(secret.keychain);
    } catch (error) {
      logger.warn('Could not decrypt a Secret file', error);
      throw new SecretFileError(
        'The keychain couldn’t decrypt this Secret file. Set its contents again in Settings.'
      );
    }
    if (decrypted.reEncrypt) await this.encryptAgain(projectId, stepId, secret, decrypted.text);
    return decrypted.text;
  }

  private async encryptAgain(
    projectId: string,
    stepId: string,
    current: StoredSecret,
    contents: string
  ): Promise<void> {
    try {
      if (!(await this.keychainAvailable())) return;
      const sealed: StoredSecret = {
        names: current.names,
        keychain: await this.cipher.encrypt(contents),
      };
      // Not over contents set while it encrypted.
      if (this.file().projects[projectId]?.[stepId] !== current) return;
      this.update((projects) => {
        projects[projectId] = { ...projects[projectId], [stepId]: sealed };
      });
    } catch (error) {
      logger.warn('Could not encrypt a Secret file again', error);
    }
  }

  private async seal(contents: string): Promise<StoredSecret> {
    const names = secretFileNames(contents);
    // Only a computer without a keychain keeps them in the file alone, never one whose keychain
    // refused, as when the user denies its prompt.
    if (!(await this.keychainAvailable())) return { names, file: contents };
    try {
      return { names, keychain: await this.cipher.encrypt(contents) };
    } catch (error) {
      logger.warn('Could not encrypt a Secret file', error);
      throw new SecretFileError('The keychain couldn’t encrypt them, so Komla didn’t save them');
    }
  }

  /** Whether this computer's keychain can encrypt contents; false where it has none. */
  async keychainAvailable(): Promise<boolean> {
    try {
      return await this.cipher.available();
    } catch (error) {
      logger.warn('Could not tell whether the keychain can encrypt Secret files', error);
      return false;
    }
  }

  private update(change: (projects: StoredFile['projects']) => void): void {
    const projects = structuredClone(this.file().projects);
    change(projects);
    const next: StoredFile = { _version: FILE_VERSION, projects };
    writeFileAtomicSync(this.path, `${JSON.stringify(next, null, 2)}\n`, FILE_MODE);
    this.stored = next;
  }

  private file(): StoredFile {
    this.stored ??= this.readFile();
    return this.stored;
  }

  /** What the file holds; one Komla can't read is set aside first, so the next save keeps it. */
  private readFile(): StoredFile {
    if (!existsSync(this.path)) return { projects: {} };
    try {
      const parsed = storedFileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf-8')));
      if (parsed.success) return parsed.data;
      logger.warn('The Secret files file holds something Komla can’t read', parsed.error);
    } catch (error) {
      logger.warn('Could not read the Secret files file', error);
    }
    try {
      copyFileSync(this.path, `${this.path}.unreadable`);
    } catch (error) {
      logger.warn('Could not set the unreadable Secret files file aside', error);
    }
    return { projects: {} };
  }
}

function statusOf(secret: StoredSecret): SecretFileStatus {
  return { names: secret.names, storage: 'keychain' in secret ? 'keychain' : 'file' };
}
