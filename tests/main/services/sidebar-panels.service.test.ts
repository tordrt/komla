import { describe, expect, it, vi } from 'vitest';

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
vi.mock('../../../src/main/services/html-preview.service', () => ({
  htmlPreviewService: { createContentPreviewUrl: vi.fn() },
}));

import {
  parseSidebarPanelsFile,
  SidebarPanelsService,
  type SidebarPanelsDependencies,
} from '../../../src/main/services/sidebar-panels.service';
import { WorkspaceCommandError } from '../../../src/main/services/workspace-command';

import type { Workspace } from '../../../src/shared/types/workspace';

const workspace = { id: 'ws-1', projectId: 'p-1', workingDirectory: '/repo' } as Workspace;
const plugin = { id: 'ci', name: 'CI tools', dir: '/mock/.komla/plugins/ci' };

function createService(file: unknown, overrides: Partial<SidebarPanelsDependencies> = {}) {
  const service = new SidebarPanelsService({
    readFile: () => (typeof file === 'string' ? file : JSON.stringify(file)),
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    getProjectKeys: () => ['p-1', 'komla'],
    canRun: () => true,
    run: vi.fn(async () => '# Tests\n\nAll pass'),
    runLocal: vi.fn(async () => 'local'),
    readIcon: vi.fn(async (value: string) =>
      value === 'icons/missing.svg' ? undefined : `data:image/png;base64,${value}`
    ),
    servePage: vi.fn(async () => 'komla-preview://token/popover.html'),
    now: () => 42,
    ...overrides,
  });
  service.reload();
  return service;
}

describe('parseSidebarPanelsFile', () => {
  it('reads panels with a default interval', () => {
    expect(
      parseSidebarPanelsFile(
        JSON.stringify({ panels: [{ id: 'ci', title: 'CI', command: 'sh ci.sh' }] })
      )
    ).toEqual({ panels: [{ id: 'ci', title: 'CI', command: 'sh ci.sh', intervalSeconds: 60 }] });
  });

  it.each([
    ['{', /not valid JSON/],
    [JSON.stringify({ panels: [{ id: 'ci', command: 'x' }] }), /panels\.0\.title/],
    [
      JSON.stringify({ panels: [{ id: 'ci', title: 'A title far too long for a tab', command: 'x' }] }),
      /panels\.0\.title/,
    ],
    [JSON.stringify({ panels: [{ id: 'bad id', title: 'CI', command: 'x' }] }), /ids are/],
    [
      JSON.stringify({ panels: [{ id: 'ci', title: 'CI', command: 'x', intervalSeconds: 1 }] }),
      /intervalSeconds/,
    ],
    [
      JSON.stringify({
        panels: [
          { id: 'ci', title: 'CI', command: 'x' },
          { id: 'ci', title: 'CI 2', command: 'y' },
        ],
      }),
      /its own id/,
    ],
    [
      JSON.stringify({ panels: [{ id: 'ci', title: 'CI', command: 'x', popoverCommand: 'y' }] }),
      /popoverCommand/,
    ],
    [
      JSON.stringify({
        panels: [{ id: 'ci', title: 'CI', command: 'x', commands: { 'bad name': 'y' } }],
      }),
      /command names/,
    ],
  ])('names what is wrong with %s', (content, problem) => {
    const parsed = parseSidebarPanelsFile(content);
    expect(parsed.panels).toEqual([]);
    expect(parsed.problem).toMatch(problem);
  });
});

describe('SidebarPanelsService', () => {
  it("lists the panels for a workspace's project with their icons, and the file's problem", async () => {
    const service = createService({
      panels: [
        { id: 'ci', title: 'CI', command: 'x', icon: 'icons/ci.svg', iconColor: 'success' },
        { id: 'usage', title: 'Usage', command: 'y', runOn: 'local', intervalSeconds: 300 },
        { id: 'no-icon', title: 'Odd', command: 'z', icon: 'icons/missing.svg', iconColor: 'info' },
        { id: 'other', title: 'Other', command: 'z', projects: ['elsewhere'] },
      ],
    });
    await expect(service.list('ws-1')).resolves.toEqual({
      panels: [
        {
          id: 'ci',
          title: 'CI',
          intervalSeconds: 60,
          icon: 'data:image/png;base64,icons/ci.svg',
          iconColor: 'success',
        },
        { id: 'usage', title: 'Usage', intervalSeconds: 300, runOn: 'local' },
        { id: 'no-icon', title: 'Odd', intervalSeconds: 60 },
      ],
    });
    await expect(service.list('missing')).resolves.toEqual({ panels: [] });

    const broken = createService('{');
    expect((await broken.list('ws-1')).problem).toMatch(/sidebar-panels\.json/);
  });

  it('notifies listeners when the file is read again', () => {
    const service = createService({ panels: [] });
    const listener = vi.fn();
    service.onChange(listener);
    service.reload();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("runs a panel's command in the workspace and shows its Markdown and buttons", async () => {
    const run = vi.fn(async () =>
      JSON.stringify({
        markdown: '**2** failing',
        buttons: [
          { label: 'Rerun', run: 'rerun' },
          { label: 'Unknown', run: 'missing' },
          { label: 'Open', link: 'https://ci.example.com' },
        ],
      })
    );
    const service = createService(
      {
        panels: [
          { id: 'ci', title: 'CI', command: 'sh ci.sh', commands: { rerun: 'gh run rerun' } },
        ],
      },
      { run }
    );
    await expect(service.run('ws-1', 'ci')).resolves.toEqual({
      id: 'ci',
      workspaceId: 'ws-1',
      content: {
        markdown: '**2** failing',
        buttons: [
          { label: 'Rerun', run: 'rerun' },
          { label: 'Open', link: 'https://ci.example.com' },
        ],
      },
    });
    expect(run).toHaveBeenCalledWith(workspace, 'sh ci.sh', 30_000, undefined);
  });

  it('serves an HTML panel as a page with the theme, one page per window, workspace and panel', async () => {
    const servePage = vi.fn(async () => 'komla-preview://token/popover.html');
    const service = createService(
      { panels: [{ id: 'ci', title: 'CI', command: 'x', timeoutSeconds: 5 }] },
      { run: vi.fn(async () => JSON.stringify({ html: '<p>Hi</p>' })), servePage }
    );
    const theme = { scheme: 'light' as const, colors: { success: '0.7 0.17 150' } };
    await expect(service.run('ws-1', 'ci', theme, '7')).resolves.toEqual({
      id: 'ci',
      workspaceId: 'ws-1',
      content: { markdown: '', htmlUrl: 'komla-preview://token/popover.html', buttons: [] },
    });
    const [key, page] = servePage.mock.calls[0] as unknown as [string, string];
    expect(key).toBe('sidebar-panel:7:ws-1:ci');
    expect(page).toContain('--success: oklch(0.7 0.17 150);');
    expect(page).toContain('<p>Hi</p>');
  });

  it('runs a `runOn: local` panel on this computer, under one page key for every workspace', async () => {
    const runLocal = vi.fn(async () => JSON.stringify({ html: '<p>usage</p>' }));
    const servePage = vi.fn(async () => 'url');
    const service = createService(
      { panels: [{ id: 'usage', title: 'Usage', command: 'usage', runOn: 'local' }] },
      { runLocal, servePage, canRun: () => false }
    );
    await service.run('ws-1', 'usage', undefined, '1');
    expect(runLocal).toHaveBeenCalledWith('usage', 30_000, undefined);
    expect(servePage).toHaveBeenCalledWith('sidebar-panel:1::usage', expect.any(String));
  });

  it("says why a panel's command failed or couldn't run", async () => {
    const service = createService(
      { panels: [{ id: 'ci', title: 'CI', command: 'x', timeoutSeconds: 2 }] },
      {
        run: vi.fn(async () => {
          throw new WorkspaceCommandError('stopped', true);
        }),
      }
    );
    await expect(service.run('ws-1', 'ci')).resolves.toMatchObject({
      content: null,
      error: 'timed out after 2 seconds',
    });

    const offline = createService(
      { panels: [{ id: 'ci', title: 'CI', command: 'x' }] },
      { canRun: () => false }
    );
    await expect(offline.run('ws-1', 'ci')).resolves.toMatchObject({
      content: null,
      error: "This workspace can't run commands right now",
    });
  });

  it("doesn't run a panel the workspace doesn't show", async () => {
    const run = vi.fn(async () => 'x');
    const service = createService(
      { panels: [{ id: 'ci', title: 'CI', command: 'x', projects: ['elsewhere'] }] },
      { run }
    );
    await expect(service.run('ws-1', 'ci')).resolves.toEqual({
      id: 'ci',
      workspaceId: 'ws-1',
      content: null,
    });
    await expect(service.run('ws-1', 'missing')).resolves.toMatchObject({ content: null });
    expect(run).not.toHaveBeenCalled();
  });

  it("doesn't run the buttons of a panel the workspace doesn't show", async () => {
    const run = vi.fn(async () => '');
    const service = createService(
      {
        panels: [
          {
            id: 'ci',
            title: 'CI',
            command: 'x',
            projects: ['elsewhere'],
            commands: { deploy: 'make deploy' },
          },
        ],
      },
      { run }
    );
    await expect(service.runButton('ws-1', 'ci', 'deploy')).resolves.toEqual({
      error: 'sidebar-panels.json has no command deploy for ci',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a button's command by its name in the file, and only those", async () => {
    const run = vi.fn(async () => '');
    const service = createService(
      { panels: [{ id: 'ci', title: 'CI', command: 'x', commands: { rerun: 'gh run rerun' } }] },
      { run }
    );
    await expect(service.runButton('ws-1', 'ci', 'rerun')).resolves.toEqual({});
    expect(run).toHaveBeenCalledWith(workspace, 'gh run rerun', 60_000, undefined);
    await expect(service.runButton('ws-1', 'ci', 'toString')).resolves.toEqual({
      error: 'sidebar-panels.json has no command toString for ci',
    });
  });
});

describe('SidebarPanelsService with plugins', () => {
  const pluginPanel = {
    id: 'ci.checks',
    title: 'Checks',
    command: 'sh "$KOMLA_PLUGIN_DIR/checks.sh"',
    intervalSeconds: 60,
    icon: 'icons/checks.svg',
    commands: { rerun: 'sh "$KOMLA_PLUGIN_DIR/rerun.sh"' },
    plugin,
  };

  it("lists a plugin's panels after the file's, naming the plugin, and reads its icon from its folder", async () => {
    const readIcon = vi.fn(async () => 'data:image/svg+xml;base64,x');
    const service = createService(
      { panels: [{ id: 'mine', title: 'Mine', command: 'x' }] },
      { readIcon }
    );
    service.setPluginPanels([pluginPanel]);
    expect((await service.list('ws-1')).panels.map(({ id, plugin }) => [id, plugin])).toEqual([
      ['mine', undefined],
      ['ci.checks', 'CI tools'],
    ]);
    expect(readIcon).toHaveBeenCalledWith('icons/checks.svg', plugin.dir);
  });

  it("leaves out a plugin's panel when sidebar-panels.json has its id", async () => {
    const service = createService({ panels: [{ id: 'ci.checks', title: 'Mine', command: 'x' }] });
    service.setPluginPanels([pluginPanel]);
    expect((await service.list('ws-1')).panels.map((panel) => panel.title)).toEqual(['Mine']);
  });

  it("gives a plugin's commands its folder where they run on this computer", async () => {
    const run = vi.fn(async () => '');
    const service = createService({ panels: [] }, { run });
    service.setPluginPanels([pluginPanel]);
    await service.run('ws-1', 'ci.checks');
    await service.runButton('ws-1', 'ci.checks', 'rerun');
    expect(run).toHaveBeenNthCalledWith(1, workspace, pluginPanel.command, 30_000, {
      KOMLA_PLUGIN_DIR: plugin.dir,
    });
    expect(run).toHaveBeenNthCalledWith(2, workspace, pluginPanel.commands.rerun, 60_000, {
      KOMLA_PLUGIN_DIR: plugin.dir,
    });
    await expect(service.runButton('ws-1', 'ci.checks', 'missing')).resolves.toEqual({
      error: 'Plugin CI tools has no command missing for ci.checks',
    });
  });
});
