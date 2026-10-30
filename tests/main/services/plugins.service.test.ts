import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/services/paths', () => ({ getKomlaBasePath: () => '/mock/.komla' }));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({}) },
}));
vi.mock('../../../src/main/services/project.service', () => ({ projectService: {} }));
vi.mock('../../../src/main/services/ssh-host.service', () => ({ sshHostService: {} }));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({ sshWorkspaceService: {} }));
vi.mock('../../../src/main/services/workspace.service', () => ({ workspaceService: {} }));
vi.mock('../../../src/main/services/file-watcher', () => ({ FileWatcher: class {} }));
vi.mock('../../../src/main/services/html-preview.service', () => ({ htmlPreviewService: {} }));

import { digestFolder, PluginsService } from '../../../src/main/services/plugins.service';

const prManifest = {
  id: 'github-prs',
  name: 'GitHub PRs',
  version: '1.0.0',
  contributes: {
    statusItems: [
      { id: 'pr', label: 'PR', command: 'node "$KOMLA_PLUGIN_DIR/pr.js"', popoverCommand: 'gh pr view' },
    ],
    hooks: [{ id: 'ping', event: 'agent.done', command: 'echo done' }],
  },
};

describe('PluginsService', () => {
  let root: string;
  let pluginsPath: string;
  let settingsPath: string;
  let service: PluginsService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'komla-plugins-'));
    pluginsPath = join(root, 'plugins');
    settingsPath = join(root, 'settings');
    mkdirSync(pluginsPath);
    service = new PluginsService(pluginsPath, settingsPath);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writePlugin = (folder: string, manifest: unknown, files: Record<string, string> = {}) => {
    const dir = join(pluginsPath, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'komla-plugin.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
    );
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  };

  /** Turns a plugin on as Komla last read it, as the user does seeing it in Settings. */
  const turnOn = (id: string) => {
    const plugin = service.list().find((other) => other.id === id && other.state !== 'invalid');
    service.setEnabled({ [id]: plugin?.digest ?? 'none' });
  };

  it('lists a plugin as off until it is turned on, and runs nothing of it', async () => {
    writePlugin('prs', prManifest);
    await service.scan();

    expect(service.list()).toEqual([
      {
        id: 'github-prs',
        name: 'GitHub PRs',
        version: '1.0.0',
        folder: 'prs',
        state: 'off',
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        contributions: [
          {
            kind: 'status-item',
            id: 'github-prs.pr',
            title: 'PR',
            command: 'node "$KOMLA_PLUGIN_DIR/pr.js"',
            when: 'Every 60 seconds',
            moreCommands: [{ label: 'Popover command, run on click', command: 'gh pr view' }],
          },
          {
            kind: 'hook',
            id: 'github-prs.ping',
            title: 'ping',
            command: 'echo done',
            when: 'An agent finishes',
          },
        ],
      },
    ]);
    expect(service.statusItems()).toEqual([]);
    expect(service.hooks()).toEqual([]);
  });

  it('runs a plugin once turned on, with its ids after its own and its folder', async () => {
    const dir = writePlugin('prs', prManifest);
    await service.scan();
    const listener = vi.fn();
    service.onChange(listener);

    turnOn('github-prs');

    expect(listener).toHaveBeenCalled();
    expect(service.list()[0].state).toBe('on');
    const source = { id: 'github-prs', name: 'GitHub PRs', dir };
    expect(service.statusItems()).toEqual([
      expect.objectContaining({ id: 'github-prs.pr', intervalSeconds: 60, plugin: source }),
    ]);
    expect(service.hooks()).toEqual([
      expect.objectContaining({ id: 'github-prs.ping', timeoutSeconds: 60, plugin: source }),
    ]);
    const saved = JSON.parse(readFileSync(join(settingsPath, 'plugins.json'), 'utf-8'));
    expect(saved).toEqual({
      _version: 1,
      enabled: [{ id: 'github-prs', digest: (await digestFolder(dir)).digest }],
    });
  });

  it('stops a plugin whose files changed until it is turned on again', async () => {
    writePlugin('prs', prManifest, { 'pr.js': 'console.log("PR")' });
    await service.scan();
    turnOn('github-prs');

    writePlugin('prs', prManifest, { 'pr.js': 'console.log("something else")' });
    await service.scan();

    expect(service.list()[0].state).toBe('changed');
    expect(service.statusItems()).toEqual([]);
    expect(service.hooks()).toEqual([]);

    turnOn('github-prs');
    expect(service.list()[0].state).toBe('on');
  });

  it("doesn't count changes to the plugin's .git folder", async () => {
    writePlugin('prs', prManifest, { '.git/HEAD': 'ref: refs/heads/main' });
    await service.scan();
    turnOn('github-prs');

    writePlugin('prs', prManifest, { '.git/HEAD': 'ref: refs/heads/other' });
    await service.scan();

    expect(service.list()[0].state).toBe('on');
  });

  it('turns a plugin off', async () => {
    writePlugin('prs', prManifest);
    await service.scan();
    turnOn('github-prs');

    service.setEnabled({ 'github-prs': false });

    expect(service.list()[0].state).toBe('off');
    expect(service.statusItems()).toEqual([]);
  });

  it.each([
    ['not JSON', '{', /komla-plugin.json is not valid JSON/],
    ['a bad id', { ...prManifest, id: 'GitHub PRs' }, /id: ids are up to 24/],
    ['nothing to add', { ...prManifest, contributes: {} }, /contributes: adds nothing/],
    [
      'a bad item',
      { ...prManifest, contributes: { statusItems: [{ id: 'pr' }] } },
      /contributes.statusItems.0.command/,
    ],
    [
      'an id twice',
      {
        ...prManifest,
        contributes: {
          hooks: [
            { id: 'a', event: 'agent.done', command: 'x' },
            { id: 'a', event: 'agent.error', command: 'y' },
          ],
        },
      },
      /a is already in the list/,
    ],
    [
      'ids that are too long together',
      {
        ...prManifest,
        id: 'a-rather-long-plugin-id',
        contributes: { hooks: [{ id: 'and-a-long-hook-id-too', event: 'agent.done', command: 'x' }] },
      },
      /longer than 40 characters/,
    ],
  ])("can't turn on a plugin with %s", async (_, manifest, problem) => {
    writePlugin('broken', manifest);
    await service.scan();

    const [plugin] = service.list();
    expect(plugin.state).toBe('invalid');
    expect(plugin.problem).toMatch(problem);
    expect(() => service.setEnabled({ [plugin.id]: 'f'.repeat(64) })).toThrow(problem);
  });

  it("lists a folder without a manifest as one it can't read", async () => {
    mkdirSync(join(pluginsPath, 'notes'));
    await service.scan();

    expect(service.list()).toEqual([
      expect.objectContaining({ id: 'notes', state: 'invalid', problem: 'has no komla-plugin.json' }),
    ]);
  });

  it("doesn't turn on files that changed since the user saw them", async () => {
    writePlugin('prs', prManifest, { 'pr.js': 'one' });
    await service.scan();
    const [{ digest }] = service.list();
    writePlugin('prs', prManifest, { 'pr.js': 'two' });
    await service.scan();

    expect(() => service.setEnabled({ 'github-prs': digest! })).toThrow(
      "Plugin github-prs's files changed. Look at its commands again, then turn it on."
    );
    expect(service.list()[0].state).toBe('off');
  });

  it('tells its listeners only when something changed, as they run everything again', async () => {
    writePlugin('prs', prManifest);
    await service.scan();
    turnOn('github-prs');
    const listener = vi.fn();
    service.onChange(listener);

    await service.scan();
    service.reloadSettings();
    expect(listener).not.toHaveBeenCalled();

    writePlugin('prs', prManifest, { 'pr.js': 'new' });
    await service.scan();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['outside its folder', 'outside.sh', 'has a link, run.sh, to outside its folder'],
    ["to a file that isn't there", 'nothing.sh', "has a link, run.sh, to a file that isn't there"],
  ])("can't turn on a plugin with a link %s, as Komla can't see it change", async (...args) => {
    const [, to, problem] = args;
    writeFileSync(join(root, 'outside.sh'), 'echo one');
    const dir = writePlugin('prs', prManifest);
    symlinkSync(join(root, to), join(dir, 'run.sh'));
    await service.scan();

    expect(service.list()[0]).toMatchObject({ state: 'invalid', problem });
  });

  it("can't turn on a plugin with a link into its .git, which Komla doesn't follow", async () => {
    const dir = writePlugin('prs', prManifest, { '.git/hooks/run': 'echo one' });
    symlinkSync(join(dir, '.git', 'hooks', 'run'), join(dir, 'run.sh'));
    await service.scan();

    expect(service.list()[0]).toMatchObject({
      state: 'invalid',
      problem: 'has a link, run.sh, to outside its folder',
    });
  });

  it('reads a manifest that links to a file in its folder', async () => {
    const dir = writePlugin('prs', 'not read', {
      'manifests/real.json': JSON.stringify(prManifest),
    });
    rmSync(join(dir, 'komla-plugin.json'));
    symlinkSync(join(dir, 'manifests', 'real.json'), join(dir, 'komla-plugin.json'));
    await service.scan();

    turnOn('github-prs');

    expect(service.list()[0].state).toBe('on');
  });

  it('hashes the manifest it reads, so what runs is what the digest covers', async () => {
    const dir = writePlugin('prs', prManifest);

    const { kept } = await digestFolder(dir, 'komla-plugin.json');

    expect(kept?.toString('utf-8')).toBe(JSON.stringify(prManifest));
  });

  it('reads a plugin whose folder links to itself without walking it forever', async () => {
    const dir = writePlugin('prs', prManifest);
    symlinkSync(dir, join(dir, 'loop'));
    await service.scan();

    expect(service.list()[0].state).toBe('off');
  });

  it('lists a plugin linked into the plugins folder with why it does not run', async () => {
    const elsewhere = join(root, 'my-plugin');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'komla-plugin.json'), JSON.stringify(prManifest));
    symlinkSync(elsewhere, join(pluginsPath, 'prs'));
    await service.scan();

    expect(service.list()).toEqual([
      expect.objectContaining({
        folder: 'prs',
        state: 'invalid',
        problem: 'is a link. Copy or clone the plugin into the plugins folder',
      }),
    ]);
  });

  it("turns on a plugin when a folder Komla can't read has its id", async () => {
    mkdirSync(join(pluginsPath, 'github-prs'));
    writePlugin('z-prs', prManifest);
    await service.scan();

    turnOn('github-prs');

    expect(service.list().map(({ folder, state }) => ({ folder, state }))).toEqual([
      { folder: 'github-prs', state: 'invalid' },
      { folder: 'z-prs', state: 'on' },
    ]);
  });

  it('runs only the first of two plugins with one id', async () => {
    writePlugin('a-prs', prManifest);
    writePlugin('b-prs', prManifest);
    await service.scan();
    turnOn('github-prs');

    expect(service.list().map(({ folder, state, problem }) => ({ folder, state, problem }))).toEqual(
      [
        { folder: 'a-prs', state: 'on', problem: undefined },
        { folder: 'b-prs', state: 'invalid', problem: 'has the id github-prs, as the plugin in a-prs does' },
      ]
    );
    expect(service.statusItems()).toHaveLength(1);
  });

  it('runs no plugin while plugins.json is unreadable', async () => {
    writePlugin('prs', prManifest);
    await service.scan();
    turnOn('github-prs');

    writeFileSync(join(settingsPath, 'plugins.json'), '{ broken');
    service.reloadSettings();

    expect(service.list()[0].state).toBe('off');
    expect(service.statusItems()).toEqual([]);
  });

  it('changes its revision when a plugin changes', async () => {
    writePlugin('prs', prManifest, { 'pr.js': 'one' });
    await service.scan();
    const before = service.revision();

    writePlugin('prs', prManifest, { 'pr.js': 'two' });
    await service.scan();

    expect(service.revision()).not.toBe(before);
  });
});
