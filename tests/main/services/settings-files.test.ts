import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
    files = createSettingsFiles({
      settingsPath,
      shortcuts: { get: () => shortcuts, update: update.shortcuts },
      terminal: { get: () => terminal, update: update.terminal },
      presets: { list: () => presets, update: update.preset },
    });
  });

  afterEach(() => {
    rmSync(settingsPath, { recursive: true, force: true });
  });

  const writeFile = (name: string, value: unknown) =>
    writeFileSync(join(settingsPath, name), JSON.stringify(value));

  describe('hooks and status bar items', () => {
    it("takes the guides' examples as they are", () => {
      const examples = (guide: string) =>
        [
          ...readFileSync(join('resources', 'skills', guide), 'utf-8').matchAll(
            /```json\n([\s\S]*?)```/g
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
              { label: 'Open command', content: 'goose --trust "$PWD" session {{launchMode}}' },
              { label: 'Open command, from', content: 'goose session {{launchMode}}' },
              {
                label: 'Continue command',
                content: 'goose --trust "$PWD" session --resume {{launchMode}}',
              },
              {
                label: 'Continue command, from',
                content: 'goose session --resume {{launchMode}}',
              },
              {
                label: 'Prompt command',
                content: 'goose --trust "$PWD" run {{launchMode}} -t {{prompt}}',
              },
              { label: 'Prompt command, from', content: 'goose run {{launchMode}} -t {{prompt}}' },
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
              { label: 'Open command', content: 'GOOSE_MODE="a b" goose --trust session' },
              { label: 'Open command, from', content: 'GOOSE_MODE="a b" goose session' },
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
                { label: 'Picker title', value: 'Thinking, from Effort' },
                { label: 'Picker icon', value: 'brain, from gauge' },
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
              details: [{ label: 'Picker', value: 'hidden, from shown' }],
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
          changes: [{ details: [{ label: 'Picker title', value: 'Model, from Effort' }] }],
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
                },
                { label: 'Levels, from', content: 'Low: --effort low\nHigh: --effort high' },
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
          changes: [{ moreContent: [{ label: 'Levels', content: 'None' }, expect.anything()] }],
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
