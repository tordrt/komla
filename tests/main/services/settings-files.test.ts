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

import { PluginsService } from '../../../src/main/services/plugins.service';
import { createSettingsFiles } from '../../../src/main/services/settings-files';

import type { TerminalConfig } from '../../../src/shared/types';
import type { AgentPreset } from '../../../src/shared/types/agent-preset';

describe('settings files', () => {
  let settingsPath: string;
  let shortcuts: Record<string, string>;
  let terminal: TerminalConfig;
  let presets: AgentPreset[];
  const update = { shortcuts: vi.fn(), terminal: vi.fn(), preset: vi.fn() };
  let files: ReturnType<typeof createSettingsFiles>;
  let plugins: PluginsService;

  beforeEach(() => {
    settingsPath = mkdtempSync(join(tmpdir(), 'komla-settings-files-'));
    shortcuts = { 'workspace.new': 'Cmd+N', 'pane.splitRight': 'Cmd+D' };
    terminal = {
      font: { family: 'JetBrains Mono', size: 13, lineHeight: 1.2 },
      cursor: { style: 'block', blink: true },
      scrollback: 10_000,
    } as TerminalConfig;
    presets = [
      {
        id: 'goose-id',
        name: 'Goose',
        openCommand: 'goose session {{launchMode}}',
        continueCommand: 'goose session --resume {{launchMode}}',
        promptCommand: 'goose run {{launchMode}} -t {{prompt}}',
        launchModes: [],
        isBuiltin: false,
      },
    ];
    update.shortcuts.mockReset();
    update.terminal.mockReset();
    update.preset.mockReset();
    plugins = new PluginsService(join(settingsPath, 'plugins'), settingsPath);
    files = createSettingsFiles({
      settingsPath,
      shortcuts: { get: () => shortcuts, update: update.shortcuts },
      terminal: { get: () => terminal, update: update.terminal },
      presets: { list: () => presets, update: update.preset },
      plugins,
    });
  });

  afterEach(() => {
    rmSync(settingsPath, { recursive: true, force: true });
  });

  const writeFile = (name: string, value: unknown) =>
    writeFileSync(join(settingsPath, name), JSON.stringify(value));

  describe('plugins', () => {
    const writePlugin = (manifest: unknown, folder = 'prs') => {
      const dir = join(settingsPath, 'plugins', folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'komla-plugin.json'), JSON.stringify(manifest));
    };
    const manifest = {
      id: 'github-prs',
      name: 'GitHub PRs',
      contributes: {
        statusItems: [
          {
            id: 'pr',
            command: 'gh pr view',
            popoverCommand: 'gh pr view --json body',
            commands: { open: 'gh pr view --web' },
          },
        ],
        hooks: [{ id: 'ping', event: 'interval', intervalSeconds: 600, runOn: 'local', command: 'x' }],
      },
    };

    it('lists each plugin with whether it runs, in a form apply takes back', async () => {
      writePlugin(manifest);
      await plugins.scan();

      const read = files.plugins.read();
      expect(read).toMatchObject({
        plugins: [{ id: 'github-prs', enabled: false, state: 'off', name: 'GitHub PRs' }],
      });
      expect(files.plugins.prepare(read)).toEqual({ next: { enable: {}, manifests: [] }, changes: [] });
    });

    it('turns a plugin on, listing every command it runs', async () => {
      writePlugin(manifest);
      await plugins.scan();

      const prepared = files.plugins.prepare({ plugins: [{ id: 'github-prs', enabled: true }] });

      expect(prepared).toEqual({
        next: { enable: { 'github-prs': plugins.list()[0].digest }, manifests: [] },
        changes: [
          {
            operation: 'add',
            kind: 'status-item',
            title: 'GitHub PRs: pr',
            contentLabel: 'Command',
            content: 'gh pr view',
            moreContent: [
              { label: 'Popover command, run on click', content: 'gh pr view --json body' },
              { label: 'Button command open', content: 'gh pr view --web' },
            ],
            details: [
              { label: 'When', value: 'Every 60 seconds' },
              { label: 'Id', value: 'github-prs.pr' },
            ],
          },
          {
            operation: 'add',
            kind: 'hook',
            title: 'GitHub PRs: ping',
            contentLabel: 'Command',
            content: 'x',
            details: [
              { label: 'When', value: 'Every 600 seconds, once' },
              { label: 'Runs on', value: 'This computer, in your home folder' },
              { label: 'Id', value: 'github-prs.ping' },
            ],
          },
        ],
        warning: expect.stringContaining('A plugin stops when its files change'),
      });
      if ('problems' in prepared) throw new Error('unexpected problems');
      await files.plugins.write(prepared.next);
      expect(files.plugins.read()).toMatchObject({
        plugins: [{ id: 'github-prs', enabled: true, state: 'on' }],
      });
    });

    it("doesn't run files that changed after the approval listed them", async () => {
      writePlugin(manifest);
      await plugins.scan();
      const prepared = files.plugins.prepare({ plugins: [{ id: 'github-prs', enabled: true }] });
      if ('problems' in prepared) throw new Error('unexpected problems');

      writePlugin({ ...manifest, name: 'Something else' });
      await plugins.scan();

      await expect(async () => files.plugins.write(prepared.next)).rejects.toThrow(/github-prs's files changed/);
      expect(plugins.list()[0].state).toBe('off');
    });

    it('turns a plugin off', async () => {
      writePlugin(manifest);
      await plugins.scan();
      plugins.setEnabled({ 'github-prs': plugins.list()[0].digest! });

      const prepared = files.plugins.prepare({ plugins: [{ id: 'github-prs', enabled: false }] });

      expect(prepared).toMatchObject({
        next: { enable: { 'github-prs': false }, manifests: [] },
        changes: [{ operation: 'delete' }, { operation: 'delete' }],
      });
      expect(prepared).not.toHaveProperty('warning');
    });

    it('turns off a plugin whose files changed, so it forgets them', async () => {
      writePlugin(manifest);
      await plugins.scan();
      plugins.setEnabled({ 'github-prs': plugins.list()[0].digest! });
      writePlugin({ ...manifest, version: '2' });
      await plugins.scan();

      const prepared = files.plugins.prepare({ plugins: [{ id: 'github-prs', enabled: false }] });

      expect(prepared).toMatchObject({
        next: { enable: { 'github-prs': false }, manifests: [] },
        changes: [{ operation: 'delete' }, { operation: 'delete' }],
      });
    });

    it("lists the plugins Komla can't read apart, so each id is listed once", async () => {
      writePlugin(manifest, 'prs');
      mkdirSync(join(settingsPath, 'plugins', 'github-prs'));
      writePlugin(manifest, 'z-prs');
      await plugins.scan();

      const read = files.plugins.read();
      expect(read).toEqual({
        plugins: [expect.objectContaining({ id: 'github-prs', folder: 'prs' })],
        invalid: [
          {
            id: 'github-prs',
            name: 'github-prs',
            folder: 'github-prs',
            problem: 'has no komla-plugin.json',
          },
          {
            id: 'github-prs',
            name: 'GitHub PRs',
            folder: 'z-prs',
            problem: 'has the id github-prs, as the plugin in prs does',
          },
        ],
      });
      expect(files.plugins.prepare(read)).toEqual({ next: { enable: {}, manifests: [] }, changes: [] });
      const prepared = files.plugins.prepare({ plugins: [{ id: 'github-prs', enabled: true }] });
      if ('problems' in prepared) throw new Error(prepared.problems.join('\n'));
      await files.plugins.write(prepared.next);
      expect(plugins.list().map((plugin) => plugin.state)).toEqual(['invalid', 'on', 'invalid']);
    });

    it.each([
      [{ plugins: [{ id: 'nope', enabled: true }] }, /There is no plugin nope/],
      [
        {
          plugins: [
            { id: 'github-prs', enabled: true },
            { id: 'github-prs', enabled: false },
          ],
        },
        /github-prs is in the list more than once/,
      ],
      [
        {
          plugins: [
            { id: 'github-prs', enabled: false },
            { id: 'github-prs', enabled: true },
          ],
        },
        /github-prs is in the list more than once/,
      ],
      [{ plugins: [{ id: 'github-prs' }] }, /enabled/],
      [{ plugins: [], extra: true }, /extra/],
    ])('refuses %j', async (desired, problem) => {
      writePlugin(manifest);
      await plugins.scan();

      const prepared = files.plugins.prepare(desired);

      expect(prepared).toHaveProperty('problems');
      expect((prepared as { problems: string[] }).problems.join('\n')).toMatch(problem);
    });

    it("refuses to turn on a plugin Komla can't read", async () => {
      writePlugin({ ...manifest, contributes: {} });
      await plugins.scan();

      expect(files.plugins.prepare({ plugins: [{ id: 'prs', enabled: true }] })).toEqual({
        problems: ["Plugin prs can't be turned on: komla-plugin.json contributes: adds nothing"],
      });
    });

    describe('with a manifest, as from an SSH host', () => {
      const apply = async (desired: Record<string, unknown>) => {
        const prepared = files.plugins.prepare(desired);
        if ('problems' in prepared) throw new Error(prepared.problems.join('\n'));
        await files.plugins.write(prepared.next);
        return prepared;
      };

      it('makes a plugin and turns it on, listing every command it runs', async () => {
        await plugins.scan();

        const prepared = await apply({ plugins: [{ id: 'github-prs', enabled: true, manifest }] });

        expect(prepared.changes.map(({ operation, kind, title }) => [operation, kind, title])).toEqual([
          ['add', 'plugin', 'GitHub PRs'],
          ['add', 'status-item', 'GitHub PRs: pr'],
          ['add', 'hook', 'GitHub PRs: ping'],
        ]);
        expect(prepared.changes[0].details).toEqual([
          { label: 'Folder', value: 'plugins/github-prs' },
          { label: 'Adds', value: '1 status bar item, 1 hook' },
        ]);
        expect(prepared).toHaveProperty('warning');
        expect(
          JSON.parse(
            readFileSync(join(settingsPath, 'plugins', 'github-prs', 'komla-plugin.json'), 'utf-8')
          )
        ).toEqual(manifest);
        expect(plugins.list()).toEqual([
          expect.objectContaining({ id: 'github-prs', folder: 'github-prs', state: 'on' }),
        ]);
        const read = files.plugins.read();
        expect(read).toMatchObject({ plugins: [{ manifest: { id: 'github-prs' } }] });
        expect(files.plugins.prepare(read)).toEqual({
          next: { enable: {}, manifests: [] },
          changes: [],
        });
      });

      it('changes a running plugin, listing only what changes in what runs', async () => {
        writePlugin(manifest);
        await plugins.scan();
        plugins.setEnabled({ 'github-prs': plugins.list()[0].digest! });

        const prepared = await apply({
          plugins: [
            {
              id: 'github-prs',
              enabled: true,
              manifest: {
                ...manifest,
                contributes: {
                  statusItems: [{ ...manifest.contributes.statusItems[0], command: 'gh pr checks' }],
                },
              },
            },
          ],
        });

        expect(prepared.changes.map(({ operation, kind, title }) => [operation, kind, title])).toEqual([
          ['edit', 'plugin', 'GitHub PRs'],
          ['edit', 'status-item', 'GitHub PRs: pr'],
          ['delete', 'hook', 'GitHub PRs: ping'],
        ]);
        expect(plugins.list()).toEqual([
          expect.objectContaining({ folder: 'prs', state: 'on', contributions: [expect.anything()] }),
        ]);
      });

      it('makes a plugin that stays off until turned on', async () => {
        await plugins.scan();

        const prepared = await apply({ plugins: [{ id: 'github-prs', enabled: false, manifest }] });

        expect(prepared.changes).toEqual([
          expect.objectContaining({
            operation: 'add',
            kind: 'plugin',
            details: expect.arrayContaining([{ label: 'Runs', value: 'Only once turned on' }]),
          }),
        ]);
        expect(prepared).not.toHaveProperty('warning');
        expect(plugins.list()[0].state).toBe('off');
      });

      it("fixes a plugin Komla couldn't read", async () => {
        writePlugin({ ...manifest, contributes: {} });
        await plugins.scan();

        await apply({ plugins: [{ id: 'prs', enabled: true, manifest: { ...manifest, id: 'prs' } }] });

        expect(plugins.list()).toEqual([expect.objectContaining({ id: 'prs', state: 'on' })]);
      });

      it.each([
        [{ ...manifest, id: 'other' }, 'github-prs', "github-prs: its manifest's id is other"],
        [
          { ...manifest, id: 'prs' },
          'prs',
          'prs: the plugins folder has a folder prs already, for github-prs',
        ],
        [
          { ...manifest, id: 'p' },
          'p',
          'p: the plugins folder has a folder P already, for github-prs',
        ],
      ])('refuses a manifest that %#', async (written, id, problem) => {
        writePlugin(manifest);
        writePlugin(manifest, 'P');
        await plugins.scan();

        expect(files.plugins.prepare({ plugins: [{ id, enabled: true, manifest: written }] })).toEqual(
          { problems: [problem] }
        );
      });

      it("doesn't turn on a script that changed while the approval was open", async () => {
        writePlugin(manifest);
        writeFileSync(join(settingsPath, 'plugins', 'prs', 'run.sh'), 'echo one');
        await plugins.scan();
        const prepared = files.plugins.prepare({
          plugins: [{ id: 'github-prs', enabled: true, manifest: { ...manifest, version: '2' } }],
        });
        if ('problems' in prepared) throw new Error(prepared.problems.join('\n'));

        writeFileSync(join(settingsPath, 'plugins', 'prs', 'run.sh'), 'echo two');

        await expect(async () => files.plugins.write(prepared.next)).rejects.toThrow(
          "Plugin github-prs's files changed since the approval listed them. Apply it again."
        );
        expect(
          JSON.parse(readFileSync(join(settingsPath, 'plugins', 'prs', 'komla-plugin.json'), 'utf-8'))
        ).toEqual(manifest);
        expect(plugins.list()[0].state).toBe('off');
      });

      it("doesn't make a plugin in a folder that appeared while the approval was open", async () => {
        await plugins.scan();
        const prepared = files.plugins.prepare({
          plugins: [{ id: 'github-prs', enabled: true, manifest }],
        });
        if ('problems' in prepared) throw new Error(prepared.problems.join('\n'));

        writePlugin({ ...manifest, name: 'Theirs' }, 'github-prs');

        await expect(async () => files.plugins.write(prepared.next)).rejects.toThrow(
          /changed since the approval listed them/
        );
        await plugins.scan();
        expect(plugins.list()[0]).toMatchObject({ name: 'Theirs', state: 'off' });
      });

      it('lists the manifest as its file has it, without the defaults Komla fills in', async () => {
        writePlugin(manifest);
        await plugins.scan();

        expect(files.plugins.read()).toMatchObject({ plugins: [{ manifest }] });
      });

      it("refuses to write into a folder Komla can't run whatever it says", async () => {
        const elsewhere = join(settingsPath, 'elsewhere');
        mkdirSync(elsewhere);
        mkdirSync(join(settingsPath, 'plugins'), { recursive: true });
        symlinkSync(elsewhere, join(settingsPath, 'plugins', 'github-prs'));
        await plugins.scan();

        expect(
          files.plugins.prepare({ plugins: [{ id: 'github-prs', enabled: true, manifest }] })
        ).toEqual({
          problems: [
            'Plugin github-prs is a link. Copy or clone the plugin into the plugins folder',
          ],
        });
      });

      it('refuses new plugins past as many as Komla reads, counting the ones applied', async () => {
        for (let index = 0; index < 99; index++) {
          writePlugin({ ...manifest, id: `p${index}` }, `p${String(index).padStart(3, '0')}`);
        }
        await plugins.scan();

        expect(
          files.plugins.prepare({
            plugins: [
              { id: 'a', enabled: true, manifest: { ...manifest, id: 'a' } },
              { id: 'b', enabled: true, manifest: { ...manifest, id: 'b' } },
            ],
          })
        ).toEqual({
          problems: [
            'b: Komla reads only 100 plugins, and this would be one more',
          ],
        });
      });

      it('writes a manifest into a folder that has only its scripts so far', async () => {
        const dir = join(settingsPath, 'plugins', 'github-prs');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'run.sh'), 'echo one');
        await plugins.scan();

        const prepared = await apply({ plugins: [{ id: 'github-prs', enabled: true, manifest }] });

        expect(prepared.changes[0]).toMatchObject({ operation: 'add', kind: 'plugin' });
        expect(plugins.list()).toEqual([
          expect.objectContaining({ id: 'github-prs', folder: 'github-prs', state: 'on' }),
        ]);
      });

      it("refuses a new plugin whose name is a file's in the plugins folder", async () => {
        mkdirSync(join(settingsPath, 'plugins'), { recursive: true });
        writeFileSync(join(settingsPath, 'plugins', 'GitHub-PRs'), 'notes');
        await plugins.scan();

        expect(
          files.plugins.prepare({ plugins: [{ id: 'github-prs', enabled: true, manifest }] })
        ).toEqual({
          problems: [
            "github-prs: the plugins folder has GitHub-PRs already, which isn't a plugin's folder",
          ],
        });
      });

      it('lists a status item and a hook with one id as changes of their own', async () => {
        const both = {
          ...manifest,
          contributes: {
            statusItems: [{ id: 'x', command: 'echo item' }],
            hooks: [{ id: 'x', event: 'agent.done', command: 'echo hook' }],
          },
        };
        writePlugin(both);
        await plugins.scan();
        plugins.setEnabled({ 'github-prs': plugins.list()[0].digest! });

        const prepared = files.plugins.prepare({
          plugins: [
            {
              id: 'github-prs',
              enabled: true,
              manifest: {
                ...both,
                contributes: {
                  ...both.contributes,
                  hooks: [{ ...both.contributes.hooks[0], command: 'echo new' }],
                },
              },
            },
          ],
        });

        expect(
          'changes' in prepared && prepared.changes.map(({ operation, kind }) => [operation, kind])
        ).toEqual([
          ['edit', 'plugin'],
          ['edit', 'hook'],
        ]);
      });

      it('refuses a manifest Komla could not read', async () => {
        await plugins.scan();

        const prepared = files.plugins.prepare({
          plugins: [{ id: 'github-prs', enabled: true, manifest: { ...manifest, contributes: {} } }],
        });

        expect(prepared).toEqual({ problems: ['plugins.0.manifest.contributes: adds nothing'] });
      });
    });
  });

  describe('hooks and status bar items', () => {
    it("takes the guides' examples as they are", () => {
      const examples = (guide: string) =>
        [
          ...readFileSync(join('resources', 'skills', guide), 'utf-8').matchAll(
            /```json\r?\n([\s\S]*?)```/g
          ),
        ].map(([, json]) => JSON.parse(json) as Record<string, unknown>);
      const [hooks] = examples('komla-customize-instructions.md');
      const [items] = examples('komla-status-items-instructions.md');

      expect(files.hooks.prepare(hooks)).not.toHaveProperty('problems');
      expect(files['status-items'].prepare(items)).not.toHaveProperty('problems');
    });

    it('reads an empty file when there is none yet', () => {
      expect(files.hooks.read()).toEqual({ _version: 1, hooks: [] });
      expect(files['status-items'].read()).toEqual({ _version: 1, items: [] });
    });

    it('reads what the file says, without the defaults Komla fills in', () => {
      writeFile('status-items.json', { items: [{ id: 'pr', command: 'gh pr view' }] });

      expect(files['status-items'].read()).toEqual({
        items: [{ id: 'pr', command: 'gh pr view' }],
      });
    });

    it('says what is wrong with a file Komla cannot read, with its content to fix', () => {
      writeFileSync(join(settingsPath, 'hooks.json'), '{"hooks": [');

      expect(files.hooks.read()).toEqual({
        problem: expect.stringMatching(/^hooks\.json is not valid JSON/),
        content: '{"hooks": [',
      });
    });

    it('lists each hook added, changed or removed with its command', () => {
      writeFile('hooks.json', {
        hooks: [
          { id: 'lint', event: 'agent.done', command: 'npm run lint' },
          { id: 'say', event: 'agent.needs-input', command: 'say hi' },
          { id: 'old', event: 'workspace.created', command: 'echo old' },
        ],
      });

      const prepared = files.hooks.prepare({
        hooks: [
          // Writing out the default timeout changes nothing.
          { id: 'lint', event: 'agent.done', command: 'npm run lint', timeoutSeconds: 60 },
          { id: 'say', event: 'agent.needs-input', command: 'say "needs you"', projects: ['web'] },
          { id: 'test', event: 'agent.done', command: 'npm test', timeoutSeconds: 300 },
        ],
      });

      expect(prepared).toMatchObject({
        changes: [
          {
            operation: 'edit',
            kind: 'hook',
            title: 'say',
            contentLabel: 'Command',
            content: 'say "needs you"',
            details: [
              { label: 'When', value: 'An agent needs input' },
              { label: 'Timeout', value: '60 seconds' },
              { label: 'Projects', value: 'web' },
            ],
          },
          {
            operation: 'add',
            title: 'test',
            content: 'npm test',
            details: [
              { label: 'When', value: 'An agent finishes' },
              { label: 'Timeout', value: '300 seconds' },
              { label: 'Projects', value: 'All projects' },
            ],
          },
          { operation: 'delete', title: 'old', content: 'echo old' },
        ],
        warning: expect.stringContaining('without asking again'),
      });
    });

    it('says when and where interval hooks run', () => {
      writeFile('hooks.json', { hooks: [] });

      const prepared = files.hooks.prepare({
        hooks: [
          { id: 'ci', event: 'interval', intervalSeconds: 120, command: 'check-ci' },
          { id: 'sync', event: 'interval', intervalSeconds: 60, runOn: 'local', command: 'sync' },
        ],
      });

      expect(prepared).toMatchObject({
        changes: [
          {
            title: 'ci',
            details: [
              { label: 'When', value: 'Every 120 seconds, in each workspace' },
              { label: 'Timeout', value: '60 seconds' },
              { label: 'Projects', value: 'All projects' },
            ],
          },
          {
            title: 'sync',
            details: [
              { label: 'When', value: 'Every 60 seconds, once' },
              { label: 'Runs on', value: 'This computer, in your home folder' },
              { label: 'Timeout', value: '60 seconds' },
            ],
          },
        ],
      });
    });

    it('does not warn about commands when the change only removes them', () => {
      writeFile('hooks.json', { hooks: [{ id: 'lint', event: 'agent.done', command: 'true' }] });

      const prepared = files.hooks.prepare({ hooks: [] });

      expect(prepared).toEqual({
        next: { _version: 1, hooks: [] },
        changes: [expect.objectContaining({ operation: 'delete' })],
      });
    });

    it('describes status bar items by label, interval and projects', () => {
      const prepared = files['status-items'].prepare({
        items: [{ id: 'pr', command: 'gh pr view', label: 'Pull request', intervalSeconds: 120 }],
      });

      expect(prepared).toMatchObject({
        changes: [
          {
            operation: 'add',
            kind: 'status-item',
            title: 'Pull request',
            content: 'gh pr view',
            details: [
              { label: 'Runs', value: 'Every 120 seconds' },
              { label: 'Projects', value: 'All projects' },
            ],
          },
        ],
      });
    });

    it('says when a status bar item runs on this computer', () => {
      const prepared = files['status-items'].prepare({
        items: [{ id: 'usage', command: 'usage', runOn: 'local' }],
      });

      expect(prepared).toMatchObject({
        changes: [
          {
            details: [
              { label: 'Runs', value: 'Every 60 seconds' },
              { label: 'Runs on', value: 'This computer, in your home folder' },
              { label: 'Projects', value: 'All projects' },
            ],
          },
        ],
      });
    });

    it('lists every command an item can run, its popover and buttons too', () => {
      const prepared = files['status-items'].prepare({
        items: [
          {
            id: 'pr',
            command: 'gh pr view',
            popoverCommand: 'scripts/pr-details.sh',
            commands: { rerun: 'gh run rerun --failed' },
          },
          { id: 'tests', command: 'cat .tests', action: 'Run tests' },
        ],
      });

      expect(prepared).toMatchObject({
        changes: [
          {
            title: 'pr',
            content: 'gh pr view',
            moreContent: [
              { label: 'Popover command, run on click', content: 'scripts/pr-details.sh' },
              { label: 'Button command rerun', content: 'gh run rerun --failed' },
            ],
          },
          {
            title: 'tests',
            details: expect.arrayContaining([
              { label: 'On click, runs the quick command', value: 'Run tests' },
            ]),
          },
        ],
      });
    });

    it('names each problem with where it is', () => {
      const prepared = files.hooks.prepare({
        hooks: [{ id: 'lint', event: 'agent.finished', command: 'npm run lint' }],
      });

      expect(prepared).toEqual({ problems: [expect.stringMatching(/^hooks\.0\.event: /)] });
    });

    it('rejects fields the file does not have, such as a problem read back with it', () => {
      expect(files.hooks.prepare({ hooks: [], problem: 'old' })).toEqual({
        problems: [expect.stringContaining('problem')],
      });
    });

    it('writes the file as Komla reads it, and a new revision with it', () => {
      const before = files.hooks.revision();
      const next = { _version: 1, hooks: [{ id: 'lint', event: 'agent.done', command: 'true' }] };

      files.hooks.write(next);

      expect(JSON.parse(readFileSync(join(settingsPath, 'hooks.json'), 'utf8'))).toEqual(next);
      expect(files.hooks.read()).toEqual(next);
      expect(files.hooks.revision()).not.toBe(before);
    });
  });

  describe('keyboard shortcuts', () => {
    it('reads every shortcut action with its keys', () => {
      expect(files.shortcuts.read()).toEqual({ shortcuts });
    });

    it('changes only the shortcuts given, listing the keys they had', () => {
      const prepared = files.shortcuts.prepare({
        shortcuts: { 'workspace.new': 'Cmd+Shift+N', 'pane.splitRight': 'Cmd+D' },
      });

      expect(prepared).toEqual({
        next: { 'workspace.new': 'Cmd+Shift+N' },
        changes: [
          {
            operation: 'change',
            kind: 'shortcut',
            title: 'workspace.new',
            details: [
              { label: 'Keys', value: 'Cmd+Shift+N' },
              { label: 'From', value: 'Cmd+N' },
            ],
          },
        ],
      });
      files.shortcuts.write({ 'workspace.new': 'Cmd+Shift+N' });
      expect(update.shortcuts).toHaveBeenCalledWith({ 'workspace.new': 'Cmd+Shift+N' });
    });

    it('unbinds an action given no keys', () => {
      const prepared = files.shortcuts.prepare({ shortcuts: { 'pane.splitRight': '' } });

      expect(prepared).toMatchObject({
        next: { 'pane.splitRight': '' },
        changes: [
          {
            title: 'pane.splitRight',
            details: [
              { label: 'Keys', value: 'Not set' },
              { label: 'From', value: 'Cmd+D' },
            ],
          },
        ],
      });
    });

    it('rejects an action Komla does not have', () => {
      expect(files.shortcuts.prepare({ shortcuts: { 'workspace.nwe': 'Cmd+N' } })).toEqual({
        problems: ['shortcuts.workspace.nwe: Komla has no shortcut action named workspace.nwe'],
      });
    });
  });

  describe('terminal settings', () => {
    it('lists each value that changes by its path', () => {
      const prepared = files.terminal.prepare({
        font: { size: 14, family: 'JetBrains Mono' },
        cursor: { blink: false },
      });

      expect(prepared).toEqual({
        next: { font: { size: 14, family: 'JetBrains Mono' }, cursor: { blink: false } },
        changes: [
          {
            operation: 'change',
            kind: 'terminal-setting',
            title: 'font.size',
            details: [
              { label: 'Value', value: '14' },
              { label: 'From', value: '13' },
            ],
          },
          {
            operation: 'change',
            kind: 'terminal-setting',
            title: 'cursor.blink',
            details: [
              { label: 'Value', value: 'false' },
              { label: 'From', value: 'true' },
            ],
          },
        ],
      });
    });

    it('rejects settings the terminal does not have', () => {
      expect(files.terminal.prepare({ fontSize: 14 })).toEqual({
        problems: [expect.stringContaining('fontSize')],
      });
    });
  });

  describe('agent presets', () => {
    const warning = expect.stringContaining('another agent');

    it('reads each preset with the program it runs and its level names, never its commands', () => {
      presets.push({
        ...presets[0],
        id: 'aider-id',
        name: 'Aider',
        openCommand: 'OPENAI_API_KEY="sk 1" aider {{launchMode}}',
        launchModes: [{ id: 'yolo', name: 'YOLO', arguments: '--yes-always' }],
        reasoningLevels: [
          { id: 'l1', name: 'Sonnet ', arguments: '--model sonnet --api-key sk-2' },
        ],
        levelPicker: { title: 'Model', icon: 'cpu' },
      });

      expect(files.agents.read()).toEqual({
        presets: [
          {
            id: 'goose-id',
            name: 'Goose',
            program: 'goose',
            levelPicker: { title: 'Effort', icon: 'gauge', hidden: false },
          },
          {
            id: 'aider-id',
            name: 'Aider',
            program: 'aider',
            levelPicker: {
              title: 'Model',
              icon: 'cpu',
              hidden: false,
              levels: [{ name: 'Sonnet' }],
            },
          },
        ],
      });
    });

    it('adds the arguments after the program in each command, listing what each was', () => {
      const prepared = files.agents.prepare({
        presets: [{ id: 'goose-id', addArguments: '--trust "$PWD"' }],
      });

      expect(prepared).toEqual({
        next: [
          {
            id: 'goose-id',
            updates: {
              openCommand: 'goose --trust "$PWD" session {{launchMode}}',
              continueCommand: 'goose --trust "$PWD" session --resume {{launchMode}}',
              promptCommand: 'goose --trust "$PWD" run {{launchMode}} -t {{prompt}}',
            },
          },
        ],
        changes: [
          {
            operation: 'edit',
            kind: 'agent-preset',
            title: 'Goose',
            moreContent: [
              {
                label: 'Open command',
                content: 'goose --trust "$PWD" session {{launchMode}}',
                previous: 'goose session {{launchMode}}',
              },
              {
                label: 'Continue command',
                content: 'goose --trust "$PWD" session --resume {{launchMode}}',
                previous: 'goose session --resume {{launchMode}}',
              },
              {
                label: 'Prompt command',
                content: 'goose --trust "$PWD" run {{launchMode}} -t {{prompt}}',
                previous: 'goose run {{launchMode}} -t {{prompt}}',
              },
            ],
            details: [],
          },
        ],
        warning,
      });
      files.agents.write((prepared as { next: unknown }).next);
      expect(update.preset).toHaveBeenCalledWith('goose-id', {
        openCommand: 'goose --trust "$PWD" session {{launchMode}}',
        continueCommand: 'goose --trust "$PWD" session --resume {{launchMode}}',
        promptCommand: 'goose --trust "$PWD" run {{launchMode}} -t {{prompt}}',
      });
    });

    it('adds them after variables the command sets, and skips the rest', () => {
      presets[0] = {
        ...presets[0],
        openCommand: 'GOOSE_MODE="a b" goose session',
        continueCommand: '',
        promptCommand: 'other-cli {{prompt}}',
        launchModes: [{ id: 'new', name: 'New', arguments: '--new' }],
      };

      expect(
        files.agents.prepare({ presets: [{ id: 'goose-id', addArguments: '--trust' }] })
      ).toMatchObject({
        next: [
          {
            id: 'goose-id',
            updates: { openCommand: 'GOOSE_MODE="a b" goose --trust session' },
          },
        ],
        changes: [
          {
            moreContent: [
              {
                label: 'Open command',
                content: 'GOOSE_MODE="a b" goose --trust session',
                previous: 'GOOSE_MODE="a b" goose session',
              },
            ],
          },
        ],
      });
    });

    it('changes nothing when every command already has the arguments', () => {
      presets[0] = { ...presets[0], openCommand: 'goose --trust session' };
      presets[0].continueCommand = 'goose --trust session --resume';
      presets[0].promptCommand = 'goose --trust run {{prompt}}';

      expect(
        files.agents.prepare({ presets: [{ id: 'goose-id', addArguments: ' --trust ' }] })
      ).toEqual({ next: [], changes: [] });
    });

    it('rejects a preset Komla does not have, or one given twice', () => {
      expect(
        files.agents.prepare({
          presets: [
            { id: 'aider-id', addArguments: '--yes' },
            { id: 'goose-id', addArguments: '--a' },
            { id: 'goose-id', addArguments: '--b' },
          ],
        })
      ).toEqual({
        problems: [
          'presets.0.id: Komla has no agent preset aider-id',
          'presets.2.id: goose-id is already in the list',
        ],
      });
    });

    it('rejects anything but arguments', () => {
      for (const addArguments of [
        '--a; rm -rf ~',
        '--a && curl x',
        '--a | sh',
        '--a > out',
        '--a `id`',
        '--a $(id)',
        '--a\n--b',
        '--dir {{cwd}}',
      ]) {
        expect(
          files.agents.prepare({ presets: [{ id: 'goose-id', addArguments }] }),
          addArguments
        ).toEqual({ problems: [expect.stringMatching(/^presets\.0\.addArguments: /)] });
      }
    });

    it('rejects fields it cannot change, such as a command', () => {
      expect(
        files.agents.prepare({ presets: [{ id: 'goose-id', openCommand: 'goose --yolo' }] })
      ).toEqual({ problems: [expect.stringContaining('openCommand')] });
    });

    it('takes back what it reads, changing nothing', () => {
      expect(files.agents.prepare(files.agents.read())).toEqual({ next: [], changes: [] });
    });

    describe('level picker', () => {
      beforeEach(() => {
        presets[0].reasoningLevels = [
          { id: 'low-id', name: 'Low', arguments: '--effort low' },
          { id: 'high-id', name: 'High', arguments: '--effort high' },
        ];
      });

      it('changes its title and icon without a warning, since they run nothing', () => {
        const prepared = files.agents.prepare({
          presets: [{ id: 'goose-id', levelPicker: { title: ' Thinking ', icon: 'brain' } }],
        });

        expect(prepared).toEqual({
          next: [
            { id: 'goose-id', updates: { levelPicker: { title: 'Thinking', icon: 'brain' } } },
          ],
          changes: [
            {
              operation: 'edit',
              kind: 'agent-preset',
              title: 'Goose',
              moreContent: [],
              details: [
                { label: 'Picker title', value: 'Thinking', previous: 'Effort' },
                { label: 'Picker icon', value: 'brain', previous: 'gauge' },
              ],
            },
          ],
        });
      });

      it('hides the picker without a warning', () => {
        expect(
          files.agents.prepare({ presets: [{ id: 'goose-id', levelPicker: { hidden: true } }] })
        ).toEqual({
          next: [{ id: 'goose-id', updates: { levelPicker: { hidden: true } } }],
          changes: [
            {
              operation: 'edit',
              kind: 'agent-preset',
              title: 'Goose',
              moreContent: [],
              details: [{ label: 'Picker', value: 'Hidden', previous: 'Shown' }],
            },
          ],
        });
      });

      it('keeps a hidden picker hidden when hidden is left out', () => {
        presets[0].levelPicker = { hidden: true };

        expect(
          files.agents.prepare({ presets: [{ id: 'goose-id', levelPicker: { title: 'Model' } }] })
        ).toMatchObject({
          next: [{ id: 'goose-id', updates: { levelPicker: { title: 'Model', hidden: true } } }],
          changes: [{ details: [{ label: 'Picker title', value: 'Model', previous: 'Effort' }] }],
        });
      });

      it('stores nothing for the defaults', () => {
        presets[0].levelPicker = { title: 'Model', icon: 'cpu', hidden: true };

        expect(
          files.agents.prepare({
            presets: [{ id: 'goose-id', levelPicker: { hidden: false } }],
          })
        ).toMatchObject({ next: [{ id: 'goose-id', updates: { levelPicker: {} } }] });
      });

      it('replaces its levels, keeping the id and arguments of each level named alone, with a warning', () => {
        const prepared = files.agents.prepare({
          presets: [
            {
              id: 'goose-id',
              levelPicker: {
                levels: [
                  { name: 'High' },
                  { name: 'Low', arguments: '--effort minimal' },
                  { name: 'Fast', arguments: '--model fast' },
                ],
              },
            },
          ],
        });

        expect(prepared).toEqual({
          next: [
            {
              id: 'goose-id',
              updates: {
                reasoningLevels: [
                  { id: 'high-id', name: 'High', arguments: '--effort high' },
                  { id: 'low-id', name: 'Low', arguments: '--effort minimal' },
                  { id: expect.any(String), name: 'Fast', arguments: '--model fast' },
                ],
              },
            },
          ],
          changes: [
            expect.objectContaining({
              moreContent: [
                {
                  label: 'Levels',
                  content: 'High: --effort high\nLow: --effort minimal\nFast: --model fast',
                  previous: 'Low: --effort low\nHigh: --effort high',
                },
              ],
              details: [],
            }),
          ],
          warning,
        });
        const [{ updates }] = (prepared as { next: { updates: Partial<AgentPreset> }[] }).next;
        expect(updates.reasoningLevels?.[2].id).not.toMatch(/^(low|high)-id$/);
      });

      it('needs the arguments of a new level', () => {
        expect(
          files.agents.prepare({
            presets: [{ id: 'goose-id', levelPicker: { levels: [{ name: 'Max' }] } }],
          })
        ).toEqual({
          problems: [
            'presets.0.levelPicker.levels.0.arguments: Max is a new level, so it needs arguments',
          ],
        });
      });

      it('saves an empty list for a preset without levels, so its template does not add them later', () => {
        delete presets[0].reasoningLevels;

        expect(
          files.agents.prepare({ presets: [{ id: 'goose-id', levelPicker: { levels: [] } }] })
        ).toMatchObject({
          next: [{ id: 'goose-id', updates: { reasoningLevels: [] } }],
          changes: [{ moreContent: [{ label: 'Levels', content: 'None', previous: 'Not set' }] }],
        });
      });

      it('rejects a level that is not only arguments, an unknown icon, or a name given twice', () => {
        expect(
          files.agents.prepare({
            presets: [
              {
                id: 'goose-id',
                levelPicker: {
                  icon: 'skull',
                  levels: [{ name: 'Max', arguments: '--a; rm -rf ~' }],
                },
              },
            ],
          })
        ).toEqual({
          problems: [
            expect.stringMatching(/^presets\.0\.levelPicker\.icon: /),
            expect.stringMatching(/^presets\.0\.levelPicker\.levels\.0\.arguments: /),
          ],
        });
        expect(
          files.agents.prepare({
            presets: [
              {
                id: 'goose-id',
                levelPicker: { levels: [{ name: 'Low' }, { name: 'Low', arguments: '--b' }] },
              },
            ],
          })
        ).toEqual({
          problems: ['presets.0.levelPicker.levels.1.name: Low is already in the list'],
        });
      });

      it('takes back what it reads, changing nothing, even arguments it would refuse', () => {
        presets[0].levelPicker = { title: 'Model', icon: 'cpu' };
        presets[0].reasoningLevels = [
          { id: 'a', name: ' Piped ', arguments: '--effort high | tee log ' },
          { id: 'b', name: 'Empty', arguments: '' },
        ];
        presets.push({ ...presets[0], id: 'unset-id', name: 'Unset', reasoningLevels: undefined });

        expect(files.agents.prepare(files.agents.read())).toEqual({ next: [], changes: [] });
      });
    });

    it('rejects a preset with no command to add them to', () => {
      presets[0] = { ...presets[0], openCommand: '  ' };
      // A hand-edited file can leave a command out.
      delete (presets[0] as Partial<AgentPreset>).promptCommand;

      expect(
        files.agents.prepare({ presets: [{ id: 'goose-id', addArguments: '--trust' }] })
      ).toEqual({ problems: ['presets.0.id: Goose has no open command to add arguments to'] });
    });
  });
});
