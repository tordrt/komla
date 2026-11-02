import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';

import { z } from 'zod';

import {
  PLUGIN_SETTING_TYPES,
  type PluginSecretStorage,
  type PluginSettingField,
  type PluginSettingInfo,
  type PluginSettingValue,
  MAX_PLUGIN_SECRET,
  MAX_PLUGIN_SETTING_ID,
} from '../../shared/types/plugins';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';

const logger = createLogger('PluginSettings');

const MAX_TEXT = 2000;
const FILE_VERSION = 1;
const FILE_MODE = 0o600;
const SETTING_ID = new RegExp(`^[a-z][a-z0-9_]{0,${MAX_PLUGIN_SETTING_ID - 1}}$`);

/** The variable a plugin's commands get a setting in, such as `KOMLA_SETTING_API_URL`. */
export const settingVariable = (id: string) => `KOMLA_SETTING_${id.toUpperCase()}`;

/**
 * A value for the setting as the user gives it, or undefined to clear it; throws, naming the
 * setting, for one of the wrong kind.
 */
export function settingValue(
  field: PluginSettingField,
  value: unknown
): PluginSettingValue | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const wrong = (what: string) => new Error(`${field.title} must be ${what}`);
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') throw wrong('text');
      if (value.length > MAX_TEXT) throw wrong(`at most ${MAX_TEXT} characters`);
      return value;
    case 'secret':
      if (typeof value !== 'string') throw wrong('text');
      if (value.length > MAX_PLUGIN_SECRET) throw wrong(`at most ${MAX_PLUGIN_SECRET} characters`);
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw wrong('a number');
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw wrong('on or off');
      return value;
    case 'choice':
      if (typeof value !== 'string' || !field.options?.includes(value)) {
        throw wrong(`one of ${(field.options ?? []).join(', ')}`);
      }
      return value;
  }
}

// The descriptions are what `komla settings schema plugins` tells agents.
export const pluginSettingFieldSchema = z
  .object({
    id: z
      .string()
      .regex(
        SETTING_ID,
        `setting ids are up to ${MAX_PLUGIN_SETTING_ID} lowercase letters, digits and underscores`
      )
      .meta({
        description:
          "Its name in `komla.settings` for the plugin's code, and `KOMLA_SETTING_<ID>`, uppercase, for its commands, such as `api_url` and `KOMLA_SETTING_API_URL`.",
      }),
    title: z.string().trim().min(1).max(60).meta({ description: 'Shown in Settings.' }),
    description: z.string().trim().min(1).max(300).optional(),
    type: z.enum(PLUGIN_SETTING_TYPES).meta({
      description:
        "`text`, `number`, `boolean`, `choice` (one of `options`) or `secret`, such as an API token: the user types it into Settings, Komla encrypts it with the OS keychain, and only the plugin's code and its commands on this computer get it. Agents can't read or set a secret.",
    }),
    options: z.array(z.string().trim().min(1).max(60)).min(1).max(30).optional(),
    default: z.union([z.string().max(MAX_TEXT), z.number(), z.boolean()]).optional(),
    placeholder: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (field.type === 'choice' && !field.options) {
      context.addIssue({ code: 'custom', path: ['options'], message: 'a choice needs options' });
    }
    if (field.type !== 'choice' && field.options) {
      context.addIssue({ code: 'custom', path: ['options'], message: 'only a choice has options' });
    }
    if (field.default === undefined) return;
    if (field.type === 'secret') {
      context.addIssue({ code: 'custom', path: ['default'], message: 'a secret has no default' });
      return;
    }
    try {
      settingValue(field, field.default);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['default'],
        message: `the default: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

/** Encrypts secrets with the OS keychain, as Electron's safeStorage does. */
export interface SecretCipher {
  /** Whether the keychain protects what it encrypts; without one, secrets stay in a file only. */
  available(): Promise<boolean>;
  /** To base64. */
  encrypt(text: string): Promise<string>;
  /** With whether to encrypt it again, as after the keychain's key changed. */
  decrypt(base64: string): Promise<{ text: string; reEncrypt: boolean }>;
}

type StaleSecret = { pluginId: string; id: string; text: string };

/** Told the plugin whose settings changed, or undefined for every plugin, as once they load. */
type SettingsListener = (pluginId: string | undefined) => void;

type StoredSecret = { keychain: string } | { file: string };

const storedFileSchema = z.object({
  _version: z.number().optional(),
  plugins: z.record(
    z.string(),
    z.object({
      values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      secrets: z
        .record(
          z.string(),
          z.union([z.object({ keychain: z.string() }), z.object({ file: z.string() })])
        )
        .optional(),
    })
  ),
});

type StoredFile = z.infer<typeof storedFileSchema>;

/**
 * What the user set for each plugin's settings, in one file in Komla's settings folder, with
 * secrets encrypted by the OS keychain where there is one. Komla holds them decrypted only in the
 * main process, and Settings gets only whether a secret is set.
 */
export class PluginSettingsStore {
  private stored: StoredFile = { plugins: {} };
  /** The secrets, decrypted, by plugin and then setting. */
  private readonly secrets = new Map<string, Map<string, string>>();
  private storage: PluginSecretStorage | undefined;
  /** Until the secrets are decrypted. */
  private loading: Promise<void> | undefined;
  /** The last save, which the next one waits for. */
  private saving: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<SettingsListener>();

  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher
  ) {}

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reads the file now, then decrypts its secrets and tells listeners once, for every plugin. A
   * secret Komla can't decrypt reads as not set, and stays in the file as it was. Secrets kept in
   * the file alone, or under a key the keychain has since changed, are encrypted again once the
   * keychain can. Reads only once.
   */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.stored = this.read();
    this.loading = this.decryptAll().then(() => this.changed(undefined));
    return this.loading;
  }

  private async decryptAll(): Promise<void> {
    let keychain = false;
    try {
      keychain = await this.cipher.available();
    } catch (error) {
      logger.warn('Could not tell whether the keychain can encrypt secrets', error);
    }
    const stale: StaleSecret[] = [];
    const secrets = new Map<string, Map<string, string>>();
    await Promise.all(
      Object.entries(this.stored.plugins).map(async ([pluginId, { secrets: saved = {} }]) => {
        const decrypted = new Map<string, string>();
        secrets.set(pluginId, decrypted);
        for (const [id, secret] of Object.entries(saved)) {
          if ('file' in secret) {
            decrypted.set(id, secret.file);
            if (keychain) stale.push({ pluginId, id, text: secret.file });
            continue;
          }
          try {
            const { text, reEncrypt } = await this.cipher.decrypt(secret.keychain);
            decrypted.set(id, text);
            // Only into a keychain that protects it, not Linux's basic_text.
            if (reEncrypt && keychain) stale.push({ pluginId, id, text });
          } catch (error) {
            logger.warn(`Could not decrypt plugin ${pluginId}'s secret ${id}`, error);
          }
        }
      })
    );
    this.storage = keychain ? 'keychain' : 'file';
    this.secrets.clear();
    for (const [pluginId, decrypted] of secrets) this.secrets.set(pluginId, decrypted);
    if (stale.length > 0) await this.encryptAgain(stale);
  }

  private async encryptAgain(stale: StaleSecret[]): Promise<void> {
    try {
      const plugins = structuredClone(this.stored.plugins);
      for (const { pluginId, id, text } of stale) {
        plugins[pluginId].secrets![id] = { keychain: await this.cipher.encrypt(text) };
      }
      const next = { ...this.stored, plugins };
      this.write(next);
      this.stored = next;
    } catch (error) {
      logger.warn("Could not encrypt plugins' secrets again", error);
    }
  }

  /**
   * Where new secrets go: the keychain's encryption, or the file alone on a computer without; not
   * yet known while the secrets load.
   */
  secretStorage(): PluginSecretStorage | undefined {
    return this.storage;
  }

  /** Each setting's value, the user's or its default, secrets included, for the plugin's code. */
  values(pluginId: string, fields: PluginSettingField[]): Record<string, PluginSettingValue> {
    const values: Record<string, PluginSettingValue> = {};
    for (const field of fields) {
      const value = this.value(pluginId, field);
      if (value !== undefined) values[field.id] = value;
    }
    return values;
  }

  /** The settings as Settings shows them: values, and only whether each secret is set. */
  info(pluginId: string, fields: PluginSettingField[]): PluginSettingInfo[] {
    return fields.map((field) => {
      if (field.type === 'secret') {
        return { ...field, isSet: this.secrets.get(pluginId)?.has(field.id) === true };
      }
      const value = this.storedValue(pluginId, field);
      return value === undefined ? field : { ...field, value };
    });
  }

  /**
   * The settings as variables for the plugin's commands; secrets only with `withSecrets`, for
   * commands that run on this computer.
   */
  environment(
    pluginId: string,
    fields: PluginSettingField[],
    withSecrets: boolean
  ): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const field of fields) {
      if (field.type === 'secret' && !withSecrets) continue;
      const value = this.value(pluginId, field);
      if (value !== undefined) environment[settingVariable(field.id)] = String(value);
    }
    return environment;
  }

  /**
   * Sets some of a plugin's settings, or clears those given null or ''. Throws, changing nothing,
   * for a setting the plugin doesn't declare or a value of the wrong kind. Waits for the secrets
   * to load and for earlier saves, so it never writes over what they hold.
   */
  set(
    pluginId: string,
    fields: PluginSettingField[],
    changes: Record<string, unknown>
  ): Promise<void> {
    const loaded = this.loading ?? this.load();
    const run = this.saving.then(() => loaded).then(() => this.apply(pluginId, fields, changes));
    this.saving = run.catch(() => {});
    return run;
  }

  private async apply(
    pluginId: string,
    fields: PluginSettingField[],
    changes: Record<string, unknown>
  ): Promise<void> {
    const checked = Object.entries(changes).map(([id, raw]) => {
      const field = fields.find((each) => each.id === id);
      if (!field) throw new Error(`The plugin has no setting ${id}`);
      return { field, value: settingValue(field, raw) };
    });
    const entry = this.stored.plugins[pluginId] ?? {};
    const values = { ...entry.values };
    const secrets: Record<string, StoredSecret> = { ...entry.secrets };
    const decrypted = new Map(this.secrets.get(pluginId));
    for (const { field, value } of checked) {
      if (field.type !== 'secret') {
        if (value === undefined) delete values[field.id];
        else values[field.id] = value;
        continue;
      }
      if (value === undefined) {
        delete secrets[field.id];
        decrypted.delete(field.id);
        continue;
      }
      secrets[field.id] =
        this.storage === 'keychain'
          ? { keychain: await this.cipher.encrypt(String(value)) }
          : { file: String(value) };
      decrypted.set(field.id, String(value));
    }
    const next: StoredFile = {
      ...this.stored,
      plugins: {
        ...this.stored.plugins,
        [pluginId]: {
          ...(Object.keys(values).length > 0 && { values }),
          ...(Object.keys(secrets).length > 0 && { secrets }),
        },
      },
    };
    // Written first, so a failed write changes nothing.
    this.write(next);
    this.stored = next;
    this.secrets.set(pluginId, decrypted);
    this.changed(pluginId);
  }

  /** One listener that throws neither stops the others nor fails the save or load. */
  private changed(pluginId: string | undefined): void {
    for (const listener of this.listeners) {
      try {
        listener(pluginId);
      } catch (error) {
        logger.warn("A listener to plugins' settings failed", error);
      }
    }
  }

  /** The user's value, if it still fits the setting as the plugin declares it now. */
  private storedValue(pluginId: string, field: PluginSettingField): PluginSettingValue | undefined {
    const value = this.stored.plugins[pluginId]?.values?.[field.id];
    try {
      return settingValue(field, value);
    } catch {
      return undefined;
    }
  }

  private value(pluginId: string, field: PluginSettingField): PluginSettingValue | undefined {
    if (field.type === 'secret') return this.secrets.get(pluginId)?.get(field.id);
    return this.storedValue(pluginId, field) ?? field.default;
  }

  private read(): StoredFile {
    if (!existsSync(this.path)) return { plugins: {} };
    try {
      const parsed = storedFileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf-8')));
      if (parsed.success) return parsed.data;
      logger.warn(`Could not read ${this.path}`, parsed.error);
    } catch (error) {
      logger.warn(`Could not read ${this.path}`, error);
    }
    // The next save replaces it, so the user keeps a copy of what it held.
    try {
      copyFileSync(this.path, `${this.path}.unreadable`);
      logger.warn(`Plugins get their defaults; the file is copied to ${this.path}.unreadable`);
    } catch (error) {
      logger.warn(`Could not copy ${this.path} aside`, error);
    }
    return { plugins: {} };
  }

  private write(stored: StoredFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const content = { _version: FILE_VERSION, plugins: stored.plugins };
    // Only the user may read it, as it may hold secrets on a computer without a keychain.
    writeFileAtomicSync(this.path, `${JSON.stringify(content, null, 2)}\n`, FILE_MODE);
  }
}
