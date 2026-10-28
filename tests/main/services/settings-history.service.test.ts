import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => '/mock/home/.komla',
}));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  changedSettingKeys,
  SettingsHistoryService,
} from '../../../src/main/services/settings-history.service';

describe('changedSettingKeys', () => {
  it('names changed settings as dotted paths, ignoring _version', () => {
    expect(
      changedSettingKeys(
        JSON.stringify({ _version: 2, palette: 'nord', colors: { accent: 'a', bg: 'b' } }),
        JSON.stringify({ _version: 3, palette: 'dracula', colors: { accent: 'c', bg: 'b' } })
      )
    ).toEqual(['palette', 'colors.accent']);
  });

  it('names the items of id-keyed lists that were added, removed or changed', () => {
    expect(
      changedSettingKeys(
        JSON.stringify({
          actions: [
            { id: '1', title: 'Review' },
            { id: '2', title: 'Old' },
          ],
        }),
        JSON.stringify({
          actions: [
            { id: '1', title: 'Review' },
            { id: '3', title: 'Bug Scan' },
          ],
        })
      )
    ).toEqual(['actions[Old]', 'actions[Bug Scan]']);
  });

  it('names the list itself when only its order changed', () => {
    expect(
      changedSettingKeys(
        JSON.stringify({ actions: [{ id: '1' }, { id: '2' }] }),
        JSON.stringify({ actions: [{ id: '2' }, { id: '1' }] })
      )
    ).toEqual(['actions']);
  });

  it('returns nothing for content that is not JSON', () => {
    expect(changedSettingKeys('{', '{"a":1}')).toEqual([]);
  });
});

describe('SettingsHistoryService', () => {
  let root: string;
  let settingsDir: string;
  let statePath: string;
  let now: number;
  let onWatchedChange: (() => void) | null;
  let service: SettingsHistoryService;

  const write = (file: string, value: unknown) =>
    writeFileSync(join(settingsDir, file), JSON.stringify(value, null, 2));
  const read = (file: string) => JSON.parse(readFileSync(join(settingsDir, file), 'utf-8'));
  const create = () =>
    new SettingsHistoryService({
      settingsDir,
      statePath,
      now: () => now,
      watch: async (_dir, onChange) => {
        onWatchedChange = onChange;
        return async () => {
          onWatchedChange = null;
        };
      },
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'komla-settings-history-'));
    settingsDir = join(root, 'settings');
    statePath = join(root, 'settings-history.json');
    mkdirSync(settingsDir);
    now = 1_000_000;
    onWatchedChange = null;
    write('theme.json', { palette: 'default', colors: { accent: 'blue' } });
    service = create();
    await service.start();
  });

  afterEach(async () => {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('starts with an empty history and records a change the watcher reports', () => {
    expect(service.list()).toEqual([]);
    write('theme.json', { palette: 'nord', colors: { accent: 'blue' } });
    onWatchedChange?.();

    expect(service.list()).toEqual([
      expect.objectContaining({
        file: 'theme.json',
        changedKeys: ['palette'],
        laterChanges: 0,
      }),
    ]);
  });

  it('notifies listeners when it records a change', () => {
    const listener = vi.fn();
    service.onChange(listener);
    write('theme.json', { palette: 'nord', colors: { accent: 'blue' } });
    service.scan();
    service.scan();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores rewrites that leave the settings the same', () => {
    writeFileSync(
      join(settingsDir, 'theme.json'),
      JSON.stringify({ colors: { accent: 'blue' }, palette: 'default' })
    );
    service.scan();
    expect(service.list()).toEqual([]);
  });

  it('ignores what Komla records when an agent or Action is used', () => {
    const presets = (lastUsedAt: number, name = 'Claude') => ({
      presets: [{ id: 'claude', name }],
      activePresets: [{ presetId: 'claude', lastUsedAt, lastLaunchModeId: 'plan' }],
    });
    write('agent-presets.json', presets(1));
    service.scan();
    now += 10_000;
    write('agent-presets.json', presets(2));
    service.scan();
    expect(service.list()).toEqual([]);

    now += 10_000;
    write('agent-presets.json', presets(3, 'Claude Opus'));
    service.scan();
    expect(service.list()).toEqual([
      expect.objectContaining({
        file: 'agent-presets.json',
        changedKeys: ['presets[Claude Opus]'],
      }),
    ]);
  });

  it('makes one entry of changes to a file in quick succession', () => {
    write('theme.json', { palette: 'nord', colors: { accent: 'blue' } });
    service.scan();
    now += 1000;
    write('theme.json', { palette: 'nord', colors: { accent: 'red' } });
    service.scan();

    expect(service.list()).toHaveLength(1);
    expect(service.list()[0].changedKeys).toEqual(['palette', 'colors.accent']);

    now += 10_000;
    write('theme.json', { palette: 'dracula', colors: { accent: 'red' } });
    service.scan();
    expect(service.list()).toHaveLength(2);
  });

  it('drops a quick run of changes that ends where it began', () => {
    write('theme.json', { palette: 'nord', colors: { accent: 'blue' } });
    service.scan();
    write('theme.json', { palette: 'default', colors: { accent: 'blue' } });
    service.scan();
    expect(service.list()).toEqual([]);
  });

  it('reverts a change, records the revert, and can revert the revert', () => {
    write('theme.json', { palette: 'nord', colors: { accent: 'blue' } });
    service.scan();
    const [change] = service.list();

    const revert = service.revert(change.id);
    expect(read('theme.json').palette).toBe('default');
    expect(revert).toEqual(
      expect.objectContaining({ file: 'theme.json', revertOf: change.id, changedKeys: ['palette'] })
    );
    // The watcher reporting Komla's own write records nothing more.
    service.scan();
    expect(service.list()).toHaveLength(2);

    service.revert(revert.id);
    expect(read('theme.json').palette).toBe('nord');
  });

  it('counts the later changes a revert also undoes', () => {
    write('theme.json', { palette: 'nord', colors: { accent: 'blue' } });
    service.scan();
    now += 10_000;
    write('actions.json', { actions: [] });
    service.scan();
    now += 10_000;
    write('theme.json', { palette: 'dracula', colors: { accent: 'blue' } });
    service.scan();

    const first = service
      .list()
      .find((entry) => entry.changedKeys.length && entry.at === 1_000_000);
    expect(first?.laterChanges).toBe(1);
    service.revert(first!.id);
    expect(read('theme.json').palette).toBe('default');
  });

  it("doesn't record a file Komla creates, only later changes to it", () => {
    write('status-items.json', { items: [] });
    service.scan();
    expect(service.list()).toEqual([]);

    now += 10_000;
    write('status-items.json', { items: [{ id: 'ci', command: 'gh pr checks' }] });
    service.scan();
    expect(service.list()).toEqual([
      expect.objectContaining({ file: 'status-items.json', changedKeys: ['items[ci]'] }),
    ]);
    service.revert(service.list()[0].id);
    expect(read('status-items.json')).toEqual({ items: [] });
  });

  it('records changes made while Komla was closed', async () => {
    await service.dispose();
    write('theme.json', { palette: 'nord', colors: { accent: 'blue' } });

    service = create();
    await service.start();
    expect(service.list()).toEqual([
      expect.objectContaining({ file: 'theme.json', changedKeys: ['palette'] }),
    ]);
  });

  it('keeps the history across restarts', async () => {
    write('theme.json', { palette: 'nord', colors: { accent: 'blue' } });
    service.scan();
    await service.dispose();

    service = create();
    await service.start();
    expect(service.list()).toHaveLength(1);
    service.revert(service.list()[0].id);
    expect(read('theme.json').palette).toBe('default');
  });
});
