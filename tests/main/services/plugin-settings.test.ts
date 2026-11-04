import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  pluginSettingFieldSchema,
  PluginSettingsStore,
  settingValue,
  type SecretCipher,
} from '../../../src/main/services/plugin-settings';

import type { PluginSettingField } from '../../../src/shared/types/plugins';

const FIELDS: PluginSettingField[] = [
  { id: 'repo', title: 'Repository', type: 'text' },
  { id: 'limit', title: 'Limit', type: 'number', default: 30 },
  { id: 'drafts', title: 'Show drafts', type: 'boolean', default: true },
  { id: 'sort', title: 'Sort', type: 'choice', options: ['updated', 'created'] },
  { id: 'token', title: 'Token', type: 'secret' },
];

/** Reversible, so a test can tell the file holds ciphertext, not the secret. */
function fakeCipher(available = true): SecretCipher {
  return {
    available: async () => available,
    encrypt: async (text) => ciphertext(text),
    // `enc1:` is an older key's, which Electron asks to encrypt again.
    decrypt: async (base64) => {
      const text = Buffer.from(base64, 'base64').toString();
      const match = /^enc([12]):/.exec(text);
      if (!match) throw new Error('not ours');
      return { text: text.slice(5), reEncrypt: match[1] === '1' };
    },
  };
}

function ciphertext(text: string, key = 2): string {
  return Buffer.from(`enc${key}:${text}`).toString('base64');
}

/** A cipher whose decrypting waits until `answer()`, as for the keychain's prompt. */
function promptingCipher() {
  let answer = () => {};
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const cipher = fakeCipher();
  return {
    answer,
    cipher: {
      ...cipher,
      decrypt: async (base64: string) => {
        await answered;
        return cipher.decrypt(base64);
      },
    },
  };
}

describe('PluginSettingsStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plugin-settings-'));
    path = join(dir, 'settings', 'plugin-settings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function store(cipher = fakeCipher()) {
    const loaded = new PluginSettingsStore(path, cipher);
    await loaded.load();
    return loaded;
  }

  it('gives defaults until the user sets a value', async () => {
    const settings = await store();
    expect(settings.values('prs', FIELDS)).toEqual({ limit: 30, drafts: true });

    await settings.set('prs', FIELDS, { repo: 'cli/cli', limit: 10, drafts: false });

    expect(settings.values('prs', FIELDS)).toEqual({ repo: 'cli/cli', limit: 10, drafts: false });
    // Another plugin's are its own.
    expect(settings.values('other', FIELDS)).toEqual({ limit: 30, drafts: true });
  });

  it('keeps secrets encrypted on disk, readable only by the user, and decrypts them again', async () => {
    const settings = await store();
    await settings.set('prs', FIELDS, { token: 'ghp_123' });

    const file = readFileSync(path, 'utf-8');
    expect(file).not.toContain('ghp_123');
    expect(JSON.parse(file).plugins.prs.secrets.token).toHaveProperty('keychain');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    const again = await store();
    expect(again.values('prs', FIELDS).token).toBe('ghp_123');
  });

  it('tells Settings only whether a secret is set, never the secret', async () => {
    const settings = await store();
    await settings.set('prs', FIELDS, { token: 'ghp_123', repo: 'cli/cli' });

    const info = settings.info('prs', FIELDS);
    expect(info.find((field) => field.id === 'token')).toEqual({ ...FIELDS[4], isSet: true });
    expect(info.find((field) => field.id === 'repo')).toEqual({ ...FIELDS[0], value: 'cli/cli' });
    expect(JSON.stringify(info)).not.toContain('ghp_123');
  });

  it('gives commands their settings as variables, and secrets only when asked', async () => {
    const settings = await store();
    await settings.set('prs', FIELDS, { repo: 'cli/cli', token: 'ghp_123', sort: 'created' });

    expect(settings.environment('prs', FIELDS, false)).toEqual({
      KOMLA_SETTING_REPO: 'cli/cli',
      KOMLA_SETTING_LIMIT: '30',
      KOMLA_SETTING_DRAFTS: 'true',
      KOMLA_SETTING_SORT: 'created',
    });
    expect(settings.environment('prs', FIELDS, true).KOMLA_SETTING_TOKEN).toBe('ghp_123');
  });

  it('clears settings given null or nothing, back to their defaults', async () => {
    const settings = await store();
    await settings.set('prs', FIELDS, { limit: 10, token: 'ghp_123' });

    await settings.set('prs', FIELDS, { limit: null, token: '' });

    expect(settings.values('prs', FIELDS)).toEqual({ limit: 30, drafts: true });
    expect(settings.info('prs', FIELDS).find((field) => field.id === 'token')?.isSet).toBe(false);
  });

  it('refuses a setting the plugin lacks or a value of the wrong kind, changing nothing', async () => {
    const settings = await store();
    const listener = vi.fn();
    settings.onChange(listener);

    await expect(settings.set('prs', FIELDS, { repo: 'a', nope: 1 })).rejects.toThrow(
      'The plugin has no setting nope'
    );
    await expect(settings.set('prs', FIELDS, { repo: 'a', sort: 'oldest' })).rejects.toThrow(
      'Sort must be one of updated, created'
    );
    await expect(settings.set('prs', FIELDS, { limit: '10' })).rejects.toThrow(
      'Limit must be a number'
    );
    // Only null or '' clears a setting, not a value left undefined by mistake.
    await expect(settings.set('prs', FIELDS, { repo: undefined })).rejects.toThrow(
      'Repository takes a value, or null to clear it'
    );

    expect(settings.values('prs', FIELDS).repo).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it('forgets every setting of a plugin, secrets too, as when it is deleted', async () => {
    const settings = await store();
    await settings.set('prs', FIELDS, { repo: 'cli/cli', token: 'ghp_123' });
    await settings.set('other', FIELDS, { repo: 'kept' });
    const listener = vi.fn();
    settings.onChange(listener);

    await settings.forget('prs');

    expect(settings.values('prs', FIELDS)).toEqual({ limit: 30, drafts: true });
    expect(settings.values('other', FIELDS).repo).toBe('kept');
    expect(JSON.parse(readFileSync(path, 'utf-8')).plugins).not.toHaveProperty('prs');
    expect(listener).toHaveBeenCalledWith('prs');
  });

  it('tells listeners which plugin changed', async () => {
    const settings = await store();
    const listener = vi.fn();
    settings.onChange(listener);

    await settings.set('prs', FIELDS, { repo: 'cli/cli' });

    expect(listener).toHaveBeenCalledWith('prs');
  });

  it('gives the default for a value that no longer fits, as after the plugin changed', async () => {
    const settings = await store();
    await settings.set('prs', FIELDS, { sort: 'created' });

    const changed = FIELDS.map((field) =>
      field.id === 'sort' ? { ...field, options: ['updated'], default: 'updated' } : field
    );

    expect(settings.values('prs', changed).sort).toBe('updated');
  });

  it('keeps secrets in the file alone on a computer without a keychain, and says so', async () => {
    const settings = await store(fakeCipher(false));
    expect(settings.secretStorage()).toBe('file');

    await settings.set('prs', FIELDS, { token: 'ghp_123' });

    expect(JSON.parse(readFileSync(path, 'utf-8')).plugins.prs.secrets.token).toEqual({
      file: 'ghp_123',
    });
    expect((await store(fakeCipher(false))).values('prs', FIELDS).token).toBe('ghp_123');
  });

  it("reads a secret it can't decrypt as not set, and the rest as they are", async () => {
    const settings = await store();
    await settings.set('prs', FIELDS, { token: 'ghp_123', repo: 'cli/cli' });
    const file = JSON.parse(readFileSync(path, 'utf-8'));
    file.plugins.prs.secrets.token = { keychain: Buffer.from('garbage').toString('base64') };
    writeFileSync(path, JSON.stringify(file));

    const again = await store();

    expect(again.values('prs', FIELDS)).toEqual({ repo: 'cli/cli', limit: 30, drafts: true });
  });

  it('starts from defaults when the file is unreadable, keeping a copy of it', async () => {
    const settings = await store();
    await settings.set('prs', FIELDS, { repo: 'cli/cli' });
    writeFileSync(path, '{ not json');

    const again = await store();
    expect(again.values('prs', FIELDS)).toEqual({ limit: 30, drafts: true });
    await again.set('other', FIELDS, { repo: 'a/b' });
    expect(readFileSync(`${path}.unreadable`, 'utf-8')).toBe('{ not json');
  });

  it('gives values at once, and secrets, telling listeners, once the keychain answers', async () => {
    await (await store()).set('prs', FIELDS, { repo: 'cli/cli', token: 'ghp_123' });
    const { answer, cipher } = promptingCipher();
    const settings = new PluginSettingsStore(path, cipher);
    const listener = vi.fn();
    settings.onChange(listener);

    const loaded = settings.load();
    expect(settings.values('prs', FIELDS)).toMatchObject({ repo: 'cli/cli' });
    expect(settings.values('prs', FIELDS).token).toBeUndefined();
    expect(settings.secretStorage()).toBeUndefined();

    answer();
    await loaded;
    expect(settings.values('prs', FIELDS).token).toBe('ghp_123');
    expect(settings.secretStorage()).toBe('keychain');
    // Once, for every plugin.
    expect(listener.mock.calls).toEqual([[undefined]]);
    // Read once, however many ask.
    await settings.load();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('saves and loads even when a listener throws', async () => {
    const settings = new PluginSettingsStore(path, fakeCipher());
    const after = vi.fn();
    settings.onChange(() => {
      throw new Error('a bad status item');
    });
    settings.onChange(after);

    await settings.load();
    await settings.set('prs', FIELDS, { repo: 'cli/cli' });

    expect(after).toHaveBeenCalledWith('prs');
    expect((await store()).values('prs', FIELDS).repo).toBe('cli/cli');
  });

  it("saves only once the secrets are read, never dropping other plugins' settings", async () => {
    await (await store()).set('prs', FIELDS, { repo: 'cli/cli', token: 'ghp_123' });
    const { answer, cipher } = promptingCipher();
    const settings = new PluginSettingsStore(path, cipher);
    void settings.load();

    // From Settings during the keychain's prompt.
    const saved = settings.set('other', FIELDS, { token: 'ghp_other' });
    answer();
    await saved;

    const again = await store();
    expect(again.values('prs', FIELDS)).toMatchObject({ repo: 'cli/cli', token: 'ghp_123' });
    expect(again.values('other', FIELDS).token).toBe('ghp_other');
  });

  it('keeps both of two saves made at once', async () => {
    const settings = await store();

    await Promise.all([
      settings.set('prs', FIELDS, { token: 'ghp_123' }),
      settings.set('prs', FIELDS, { repo: 'cli/cli' }),
    ]);

    expect((await store()).values('prs', FIELDS)).toMatchObject({
      repo: 'cli/cli',
      token: 'ghp_123',
    });
  });

  it('encrypts secrets again once the keychain can, or after its key changed', async () => {
    mkdirSync(join(dir, 'settings'));
    writeFileSync(
      path,
      JSON.stringify({
        plugins: {
          prs: { secrets: { token: { file: 'ghp_plain' } } },
          other: { secrets: { token: { keychain: ciphertext('ghp_old', 1) } } },
        },
      })
    );

    const settings = await store();

    const file = readFileSync(path, 'utf-8');
    expect(file).not.toContain('ghp_plain');
    expect(JSON.parse(file).plugins).toEqual({
      prs: { secrets: { token: { keychain: ciphertext('ghp_plain') } } },
      other: { secrets: { token: { keychain: ciphertext('ghp_old') } } },
    });
    expect(settings.values('prs', FIELDS).token).toBe('ghp_plain');
    expect(settings.values('other', FIELDS).token).toBe('ghp_old');
  });

  it("doesn't encrypt again without a keychain that protects it", async () => {
    mkdirSync(join(dir, 'settings'));
    const old = { keychain: ciphertext('ghp_old', 1) };
    writeFileSync(path, JSON.stringify({ plugins: { prs: { secrets: { token: old } } } }));

    const settings = await store(fakeCipher(false));

    expect(settings.values('prs', FIELDS).token).toBe('ghp_old');
    expect(JSON.parse(readFileSync(path, 'utf-8')).plugins.prs.secrets.token).toEqual(old);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'changes nothing when the file cannot be written',
    async () => {
      const settings = await store();
      await settings.set('prs', FIELDS, { repo: 'cli/cli', token: 'ghp_123' });
      chmodSync(join(dir, 'settings'), 0o500);
      try {
        await expect(
          settings.set('prs', FIELDS, { repo: 'cli/go-gh', token: 'ghp_456' })
        ).rejects.toThrow();
      } finally {
        chmodSync(join(dir, 'settings'), 0o700);
      }

      expect(settings.values('prs', FIELDS)).toMatchObject({ repo: 'cli/cli', token: 'ghp_123' });
    }
  );
});

describe('pluginSettingFieldSchema', () => {
  const issues = (field: unknown) =>
    pluginSettingFieldSchema.safeParse(field).error?.issues.map((issue) => issue.message) ?? [];

  it('takes each kind of setting', () => {
    for (const field of FIELDS) expect(issues(field)).toEqual([]);
  });

  it('refuses choices without options, options elsewhere, and defaults of the wrong kind', () => {
    expect(issues({ id: 'sort', title: 'Sort', type: 'choice' })).toEqual([
      'a choice needs options',
    ]);
    expect(issues({ id: 'repo', title: 'Repo', type: 'text', options: ['a'] })).toEqual([
      'only a choice has options',
    ]);
    expect(issues({ id: 'token', title: 'Token', type: 'secret', default: 'x' })).toEqual([
      'a secret has no default',
    ]);
    expect(issues({ id: 'limit', title: 'Limit', type: 'number', default: 'ten' })).toEqual([
      'the default: Limit must be a number',
    ]);
    expect(issues({ id: 'API', title: 'API', type: 'text' })).toEqual([
      'setting ids are up to 32 lowercase letters, digits and underscores',
    ]);
  });
});

describe('settingValue', () => {
  it('reads empty text as clearing the setting', () => {
    expect(settingValue(FIELDS[0], '')).toBeUndefined();
    expect(settingValue(FIELDS[0], null)).toBeUndefined();
  });
});
