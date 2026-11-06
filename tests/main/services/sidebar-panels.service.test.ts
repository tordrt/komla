import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
  findPanelPage,
  parseSidebarPanelsFile,
  SidebarPanelsService,
  type SidebarPanelsDependencies,
} from '../../../src/main/services/sidebar-panels.service';
import { WorkspaceCommandError } from '../../../src/main/services/workspace-command';

import type { Workspace } from '../../../src/shared/types/workspace';

const workspace = { id: 'ws-1', projectId: 'p-1', workingDirectory: '/repo' } as Workspace;
/** What commands run for that workspace get about it. */
const workspaceEnv = { KOMLA_WORKSPACE_ID: 'ws-1', KOMLA_PROJECT: 'komla' };
const plugin = { id: 'ci', name: 'CI tools', dir: '/mock/.komla/plugins/ci' };

function createService(file: unknown, overrides: Partial<SidebarPanelsDependencies> = {}) {
  const service = new SidebarPanelsService({
    readFile: () => (typeof file === 'string' ? file : JSON.stringify(file)),
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    getProjectKeys: () => ['p-1', 'komla'],
    getBranch: (candidate) => candidate.branchName,
    getRepositoryUrl: async () => undefined,
    canRun: () => true,
    run: vi.fn(async () => '# Tests\n\nAll pass'),
    runLocal: vi.fn(async () => 'local'),
    servePage: vi.fn(async () => 'komla-preview://token/popover.html'),
    findPage: vi.fn(async (page: string, pluginDir?: string) =>
      page === 'panels/missing'
        ? undefined
        : { root: `${pluginDir ?? '/mock/.komla/settings'}/${page}`, entry: 'index.html' }
    ),
    servePanelPage: vi.fn(async () => 'komla-preview://token/index.html'),
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
      JSON.stringify({
        panels: [{ id: 'ci', title: 'A title far too long for a tab', command: 'x' }],
      }),
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
    [JSON.stringify({ panels: [{ id: 'ci', title: 'CI' }] }), /a command, a page or both/],
    [
      JSON.stringify({ panels: [{ id: 'ci', title: 'CI', page: 'panels/../hooks.json' }] }),
      /page: a file or folder in the panels folder/,
    ],
    [
      JSON.stringify({ panels: [{ id: 'ci', title: 'CI', page: 'board/index.html' }] }),
      /page: a file or folder in the panels folder/,
    ],
    [
      JSON.stringify({ panels: [{ id: 'ci', title: 'CI', page: 'panels/.git' }] }),
      /page: a file or folder in the panels folder/,
    ],
    [
      JSON.stringify({
        panels: [{ id: 'ci', title: 'CI', page: 'panels/ci', capabilities: ['shell.run'] }],
      }),
      /capabilities/,
    ],
  ])('names what is wrong with %s', (content, problem) => {
    const parsed = parseSidebarPanelsFile(content);
    expect(parsed.panels).toEqual([]);
    expect(parsed.problem).toMatch(problem);
  });
});

describe('SidebarPanelsService', () => {
  it("lists the panels for a workspace's project, and the file's problem", async () => {
    const service = createService({
      panels: [
        { id: 'ci', title: 'CI', command: 'x' },
        { id: 'usage', title: 'Usage', command: 'y', runOn: 'local', intervalSeconds: 300 },
        { id: 'other', title: 'Other', command: 'z', projects: ['elsewhere'] },
      ],
    });
    await expect(service.list('ws-1')).resolves.toEqual({
      panels: [
        { id: 'ci', title: 'CI', intervalSeconds: 60 },
        { id: 'usage', title: 'Usage', intervalSeconds: 300, runOn: 'local' },
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

  it('shows plain output as a terminal would, with its colors', async () => {
    const run = vi.fn(async () => '\n\u001b[32m✓\u001b[0m unit\n\u001b[1;31m✗ e2e\u001b[0m\n\n');
    const service = createService(
      { panels: [{ id: 'ci', title: 'CI', command: 'sh ci.sh' }] },
      { run }
    );

    expect((await service.run('ws-1', 'ci')).content).toEqual({
      markdown: '',
      terminal: [
        [{ text: '✓', color: 'success' }, { text: ' unit' }],
        [{ text: '✗ e2e', color: 'error', bold: true }],
      ],
      buttons: [],
    });
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
    expect(run).toHaveBeenCalledWith(workspace, 'sh ci.sh', 30_000, workspaceEnv);
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
      error: "This workspace doesn't show ci",
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
    expect(run).toHaveBeenCalledWith(workspace, 'gh run rerun', 60_000, workspaceEnv);
    await expect(service.runButton('ws-1', 'ci', 'toString')).resolves.toEqual({
      error: 'sidebar-panels.json has no command toString for ci',
    });
  });
});

describe('SidebarPanelsService with pages of their own', () => {
  const board = {
    id: 'board',
    title: 'Board',
    page: 'panels/board',
    command: 'gh pr list --json title',
    capabilities: ['workspace.tag'],
  };

  it('reads a page, with or without a command, and the capabilities its page uses', () => {
    expect(
      parseSidebarPanelsFile(
        JSON.stringify({
          panels: [board, { id: 'notes', title: 'Notes', page: 'panels/notes.html' }],
        })
      )
    ).toEqual({
      panels: [
        { ...board, intervalSeconds: 60 },
        { id: 'notes', title: 'Notes', page: 'panels/notes.html', intervalSeconds: 60 },
      ],
    });
  });

  it('lists which panels have a page, and a command for it', async () => {
    const service = createService({
      panels: [board, { id: 'notes', title: 'Notes', page: 'panels/notes.html' }],
    });
    const { panels } = await service.list('ws-1');
    expect(panels).toEqual([
      expect.objectContaining({ id: 'board', page: true, command: true }),
      expect.not.objectContaining({ command: true }),
    ]);
    expect(panels[1]).toMatchObject({ id: 'notes', page: true });
  });

  it("serves a panel's page in the window's theme, one per window, workspace and panel", async () => {
    const servePanelPage = vi.fn(async () => 'komla-preview://token/index.html');
    const service = createService({ panels: [board] }, { servePanelPage });
    const theme = { scheme: 'dark' as const, colors: { success: '0.7 0.1 150' } };

    expect(await service.pageUrl('ws-1', 'board', theme, '7')).toEqual({
      url: 'komla-preview://token/index.html',
    });
    expect(servePanelPage).toHaveBeenCalledWith(
      'sidebar-panel-page:7:ws-1:board',
      { root: '/mock/.komla/settings/panels/board', entry: 'index.html' },
      theme
    );
    // A panel without a page has none to serve.
    expect(await service.pageUrl('ws-1', 'other')).toEqual({});
  });

  it("says when a panel's page isn't there", async () => {
    const service = createService({
      panels: [{ ...board, page: 'panels/missing' }],
    });
    expect(await service.pageUrl('ws-1', 'board')).toEqual({
      error: "panels/missing isn't in the settings folder",
    });
  });

  it('gives the page what its command prints: its JSON, or its text without colors', async () => {
    const run = vi.fn(async () => '[{"title":"Add search"}]');
    const service = createService({ panels: [board] }, { run });
    expect(await service.runData('ws-1', 'board')).toEqual({ data: [{ title: 'Add search' }] });
    expect(run).toHaveBeenCalledWith(workspace, board.command, 30_000, workspaceEnv);

    run.mockResolvedValueOnce('\u001b[32mAll pass\u001b[0m\n');
    expect(await service.runData('ws-1', 'board')).toEqual({ data: 'All pass' });

    run.mockRejectedValueOnce(new WorkspaceCommandError('slow', true));
    expect(await service.runData('ws-1', 'board')).toEqual({
      error: 'timed out after 30 seconds',
    });
  });

  it("finds a plugin's page in its folder", async () => {
    const servePanelPage = vi.fn(async () => 'komla-preview://token/index.html');
    const service = createService({ panels: [] }, { servePanelPage });
    service.setPluginPanels([{ ...board, id: 'ci.board', intervalSeconds: 60, plugin } as never]);

    expect(await service.pageUrl('ws-1', 'ci.board')).toEqual({
      url: 'komla-preview://token/index.html',
    });
    expect(servePanelPage).toHaveBeenCalledWith(
      expect.any(String),
      { root: `${plugin.dir}/panels/board`, entry: 'index.html' },
      undefined
    );
  });
});

describe('findPanelPage', () => {
  it("finds a folder's index.html, or an HTML file in its folder", async () => {
    const root = mkdtempSync(join(tmpdir(), 'komla-panel-page-'));
    try {
      mkdirSync(join(root, 'app'));
      writeFileSync(join(root, 'app', 'index.html'), '<p>app</p>');
      mkdirSync(join(root, 'empty'));
      writeFileSync(join(root, 'notes.html'), '<p>notes</p>');
      writeFileSync(join(root, 'data.json'), '{}');

      expect(await findPanelPage(join(root, 'app'))).toEqual({
        root: join(root, 'app'),
        entry: 'index.html',
      });
      expect(await findPanelPage(join(root, 'notes.html'))).toEqual({
        root,
        entry: 'notes.html',
      });
      expect(await findPanelPage(join(root, 'empty'))).toBeUndefined();
      expect(await findPanelPage(join(root, 'data.json'))).toBeUndefined();
      expect(await findPanelPage(join(root, 'missing'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('SidebarPanelsService with plugins', () => {
  const pluginPanel = {
    id: 'ci.checks',
    title: 'Checks',
    command: 'sh "$KOMLA_PLUGIN_DIR/checks.sh"',
    intervalSeconds: 60,
    commands: { rerun: 'sh "$KOMLA_PLUGIN_DIR/rerun.sh"' },
    plugin,
  };

  it("lists a plugin's panels after the file's, naming the plugin", async () => {
    const service = createService({ panels: [{ id: 'mine', title: 'Mine', command: 'x' }] });
    service.setPluginPanels([pluginPanel]);
    expect(
      (await service.list('ws-1')).panels.map(({ id, plugin, pluginId }) => [id, plugin, pluginId])
    ).toEqual([
      ['mine', undefined, undefined],
      ['ci.checks', 'CI tools', 'ci'],
    ]);
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
      ...workspaceEnv,
      KOMLA_PLUGIN_DIR: plugin.dir,
    });
    expect(run).toHaveBeenNthCalledWith(2, workspace, pluginPanel.commands.rerun, 60_000, {
      ...workspaceEnv,
      KOMLA_PLUGIN_DIR: plugin.dir,
    });
    await expect(service.runButton('ws-1', 'ci.checks', 'missing')).resolves.toEqual({
      error: 'Plugin CI tools has no command missing for ci.checks',
    });
  });
});
