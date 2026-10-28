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
vi.mock('../../../src/main/services/html-preview.service', () => ({ htmlPreviewService: {} }));

import {
  parseStatusCommandOutput,
  parseStatusCommandsFile,
  parseStatusPopoverOutput,
  resolveStatusIcons,
  StatusCommandsService,
  type StatusCommandsDependencies,
} from '../../../src/main/services/status-commands.service';
import { WorkspaceCommandError } from '../../../src/main/services/workspace-command';

import type { Workspace } from '../../../src/shared/types/workspace';

const workspace = { id: 'ws-1', projectId: 'p-1', workingDirectory: '/repo' } as Workspace;

function createService(file: unknown, overrides: Partial<StatusCommandsDependencies> = {}) {
  const service = new StatusCommandsService({
    readFile: () => (typeof file === 'string' ? file : JSON.stringify(file)),
    getWorkspace: (id) => (id === workspace.id ? workspace : undefined),
    getProjectKeys: () => ['p-1', 'komla'],
    canRun: () => true,
    run: vi.fn(async () => 'ok'),
    runLocal: vi.fn(async () => 'local'),
    readIcon: vi.fn(async (value: string) =>
      value === 'bad' ? undefined : `data:image/png;base64,${value}`
    ),
    servePopoverPage: vi.fn(async () => 'komla-preview://token/popover.html'),
    now: () => 42,
    ...overrides,
  });
  service.reload();
  return service;
}

describe('parseStatusCommandsFile', () => {
  it('reads items with a default interval', () => {
    expect(
      parseStatusCommandsFile(JSON.stringify({ items: [{ id: 'ci', command: 'gh pr checks' }] }))
    ).toEqual({ items: [{ id: 'ci', command: 'gh pr checks', intervalSeconds: 60 }] });
  });

  it.each([
    ['{', /not valid JSON/],
    [JSON.stringify({ items: [{ id: 'bad id', command: 'x' }] }), /items\.0\.id: ids are/],
    [
      JSON.stringify({ items: [{ id: 'ci', command: 'x', intervalSeconds: 1 }] }),
      /intervalSeconds/,
    ],
    [
      JSON.stringify({
        items: [
          { id: 'ci', command: 'x' },
          { id: 'ci', command: 'y' },
        ],
      }),
      /its own id/,
    ],
    [JSON.stringify({ items: [{ id: 'ci', command: 'x', colour: 'red' }] }), /colour/],
    [
      JSON.stringify({ items: [{ id: 'ci', command: 'x', popoverCommand: 'y', action: 'Test' }] }),
      /not both/,
    ],
    [
      JSON.stringify({ items: [{ id: 'ci', command: 'x', commands: { rerun: 'gh run rerun' } }] }),
      /needs a popoverCommand/,
    ],
    [
      JSON.stringify({
        items: [{ id: 'ci', command: 'x', popoverCommand: 'y', commands: { 'bad name': 'z' } }],
      }),
      /command names/,
    ],
  ])('names the problem with %s', (content, problem) => {
    const parsed = parseStatusCommandsFile(content);
    expect(parsed.items).toEqual([]);
    expect(parsed.problem).toMatch(problem);
  });
});

describe('parseStatusCommandOutput', () => {
  it('shows the first line of text output, with the rest as its tooltip', () => {
    expect(parseStatusCommandOutput('3 open PRs\n#1 Fix\n#2 Add\n')).toEqual({
      text: '3 open PRs',
      tooltip: '#1 Fix\n#2 Add',
    });
  });

  it('keeps the colors text output printed, as theme colors', () => {
    expect(
      parseStatusCommandOutput(
        '\n\u001b[1;32m \uf00c CI\u001b[0m on \u001b[33mmain\u001b[0m \n#1\n'
      )
    ).toEqual({
      text: '\uf00c CI on main',
      segments: [
        { text: '\uf00c CI', color: 'success', bold: true },
        { text: ' on ' },
        { text: 'main', color: 'warning' },
      ],
      tooltip: '#1',
    });
  });

  it('cuts colored text where it cuts the text', () => {
    const content = parseStatusCommandOutput(
      `\u001b[31m${'x'.repeat(50)}\u001b[0m${'y'.repeat(20)}`
    );
    expect(content?.text).toHaveLength(60);
    expect(content?.segments?.map((segment) => segment.text.length)).toEqual([50, 10]);
    expect(content?.segments?.[1].text.endsWith('…')).toBe(true);
  });

  it('reads JSON output, dropping what it cannot show', () => {
    expect(
      parseStatusCommandOutput(
        JSON.stringify({ text: 'CI passing', tone: 'success', link: 'https://ci.example/1' })
      )
    ).toEqual({ text: 'CI passing', tone: 'success', link: 'https://ci.example/1' });
    expect(
      parseStatusCommandOutput(
        JSON.stringify({ text: 'CI', tone: 'green', color: 'red', link: 'file:///x' })
      )
    ).toEqual({ text: 'CI' });
    expect(parseStatusCommandOutput(JSON.stringify({ text: 'CI', color: '#e5c07b' }))).toEqual({
      text: 'CI',
      color: '#e5c07b',
    });
  });

  it("leaves out segments it can't show, and those past the most an item has", () => {
    expect(
      parseStatusCommandOutput(
        JSON.stringify({ text: 'CI', segments: [{ text: 4 }, { text: 'CI', color: 'success' }] })
      )
    ).toEqual({ text: 'CI', segments: [{ text: 'CI', color: 'success' }] });
    const parts = Array.from({ length: 31 }, (_, index) => ({
      text: String.fromCharCode(97 + (index % 26)),
      color: 'info',
    }));
    expect(parseStatusCommandOutput(JSON.stringify({ segments: parts }))?.segments).toHaveLength(
      30
    );
    expect(
      parseStatusCommandOutput(JSON.stringify({ text: 'CI', segments: [{ text: 4 }] }))
    ).toEqual({ text: 'CI' });
  });

  it('colors parts of JSON output by segments or by the terminal colors in its text', () => {
    expect(
      parseStatusCommandOutput(
        JSON.stringify({
          segments: [
            { text: '\uf00c', color: 'success' },
            { text: ' 2', color: 'red; x: y', bold: true },
            { text: ' CI ' },
          ],
          color: 'muted',
          link: 'https://ci.example/1',
        })
      )
    ).toEqual({
      text: '\uf00c 2 CI',
      segments: [{ text: '\uf00c', color: 'success' }, { text: ' 2', bold: true }, { text: ' CI' }],
      color: 'muted',
      link: 'https://ci.example/1',
    });
    expect(
      parseStatusCommandOutput(JSON.stringify({ text: '\u001b[31m\uf00d 1\u001b[0m failing' }))
    ).toEqual({
      text: '\uf00d 1 failing',
      segments: [{ text: '\uf00d 1', color: 'error' }, { text: ' failing' }],
    });
    // Without text or segments, it is no item's JSON.
    expect(parseStatusCommandOutput('{"count":2}')).toEqual({ text: '{"count":2}' });
  });

  it("puts icons where the output places them, its icon or else the item's before the text", () => {
    expect(
      parseStatusCommandOutput(
        JSON.stringify({ segments: [{ text: 'CI ' }, { icon: 'icons/a.svg', color: 'success' }] })
      )
    ).toEqual({
      text: 'CI',
      segments: [{ text: 'CI ' }, { icon: 'icons/a.svg', color: 'success' }],
    });
    expect(
      parseStatusCommandOutput('\u001b[32mCI\u001b[0m green\n', { icon: 'icons/logo.svg' })
    ).toEqual({
      text: 'CI green',
      segments: [
        { icon: 'icons/logo.svg' },
        { text: ' ' },
        { text: 'CI', color: 'success' },
        { text: ' green' },
      ],
    });
    expect(
      parseStatusCommandOutput(JSON.stringify({ text: 'CI', icon: '<svg/>', iconColor: 'info' }), {
        icon: 'icons/logo.svg',
      })
    ).toEqual({
      text: 'CI',
      segments: [{ icon: '<svg/>', color: 'info' }, { text: ' ' }, { text: 'CI' }],
    });
    // An item can show only an icon.
    expect(
      parseStatusCommandOutput(JSON.stringify({ segments: [{ icon: 'icons/a.svg' }] }))
    ).toEqual({ text: '', segments: [{ icon: 'icons/a.svg' }] });
  });

  it('shows nothing for empty output and shortens long text', () => {
    expect(parseStatusCommandOutput('  \n')).toBeNull();
    expect(parseStatusCommandOutput(JSON.stringify({ text: ' ' }))).toBeNull();
    expect(parseStatusCommandOutput('x'.repeat(80))?.text).toHaveLength(60);
  });
});

describe('parseStatusPopoverOutput', () => {
  it('shows text output as Markdown', () => {
    expect(parseStatusPopoverOutput('\u001b[1m## Checks\u001b[0m\n- e2e failed\n', [])).toEqual({
      markdown: '## Checks\n- e2e failed',
      buttons: [],
    });
    expect(parseStatusPopoverOutput(' \n', [])).toBeNull();
  });

  it('keeps buttons that open links, run Actions or run a command the item names', () => {
    const output = JSON.stringify({
      markdown: 'PR #812',
      buttons: [
        { label: 'Open PR', link: 'https://github.com/o/r/pull/812' },
        { label: 'Run tests', action: 'Tests' },
        { label: 'Rerun', run: 'rerun' },
        // Output can't bring commands of its own, or names the item doesn't have.
        { label: 'Sneaky', run: 'rm -rf ~' },
        { label: 'Other', command: 'rm -rf ~' },
        { label: 'Local', link: 'file:///etc/passwd' },
        'nonsense',
      ],
    });
    expect(parseStatusPopoverOutput(output, ['rerun'])).toEqual({
      markdown: 'PR #812',
      buttons: [
        { label: 'Open PR', link: 'https://github.com/o/r/pull/812' },
        { label: 'Run tests', action: 'Tests' },
        { label: 'Rerun', run: 'rerun' },
      ],
    });
  });
});

describe('StatusCommandsService', () => {
  it("lists the items for a workspace's project, with the file's problem", () => {
    const service = createService({
      items: [
        { id: 'everywhere', command: 'a', label: 'All' },
        { id: 'komla', command: 'b', intervalSeconds: 30, projects: ['komla'] },
        { id: 'other', command: 'c', projects: ['other-project'] },
      ],
    });
    expect(service.list('ws-1')).toEqual({
      items: [
        { id: 'everywhere', intervalSeconds: 60, label: 'All' },
        { id: 'komla', intervalSeconds: 30 },
      ],
      changedAt: 42,
    });
    expect(
      createService({
        items: [
          { id: 'pr', command: 'a', popoverCommand: 'b', commands: { rerun: 'c' } },
          { id: 'tests', command: 'a', action: 'Run tests' },
        ],
      }).list('ws-1').items
    ).toEqual([
      { id: 'pr', intervalSeconds: 60, popover: true },
      { id: 'tests', intervalSeconds: 60, action: 'Run tests' },
    ]);
    expect(service.list('missing')).toEqual({ items: [], changedAt: 42 });
    expect(createService('{').list('ws-1')).toEqual({
      items: [],
      problem: expect.stringMatching(/not valid JSON/),
      changedAt: 42,
    });
  });

  it('takes an icon from the icons folder, SVG markup or a data URL', () => {
    const problem = (icon: string) =>
      parseStatusCommandsFile(JSON.stringify({ items: [{ id: 'ci', command: 'x', icon }] }))
        .problem;
    expect(problem('icons/logo.svg')).toBeUndefined();
    expect(problem('<svg viewBox="0 0 1 1"/>')).toBeUndefined();
    expect(problem('data:image/png;base64,iVBORw0KGgo=')).toBeUndefined();
    expect(problem('../logo.svg')).toContain('icon:');
    expect(problem('icons/../../secret.svg')).toContain('icon:');
    expect(problem('data:text/html,<script>')).toContain('icon:');
  });

  it('reads the icons an item names, leaving out what is not one and past four', async () => {
    const readIcon = async (value: string) =>
      value === 'bad' ? undefined : `data:image/png;base64,${value}`;
    await expect(
      resolveStatusIcons(
        {
          text: 'CI',
          segments: [
            { icon: 'bad' },
            { icon: 'a', color: 'success' },
            { text: 'CI' },
            { icon: 'b' },
            { icon: 'c' },
            { icon: 'd' },
            { icon: 'e' },
          ],
        },
        readIcon
      )
    ).resolves.toEqual({
      text: 'CI',
      segments: [
        { icon: 'data:image/png;base64,a', color: 'success' },
        { text: 'CI' },
        { icon: 'data:image/png;base64,b' },
        { icon: 'data:image/png;base64,c' },
        { icon: 'data:image/png;base64,d' },
      ],
    });
    await expect(
      resolveStatusIcons({ text: '', segments: [{ icon: 'bad' }] }, readIcon)
    ).resolves.toBeNull();
  });

  it("shows the item's icon before its output", async () => {
    const service = createService(
      { items: [{ id: 'ci', command: 'gh pr checks', icon: 'icons/gh.svg', iconColor: 'muted' }] },
      { run: vi.fn(async () => 'All green\n') }
    );
    await expect(service.run('ws-1', 'ci')).resolves.toMatchObject({
      content: {
        text: 'All green',
        segments: [
          { icon: 'data:image/png;base64,icons/gh.svg', color: 'muted' },
          { text: ' ' },
          { text: 'All green' },
        ],
      },
    });
  });

  it('notifies listeners when the file is read again', () => {
    const service = createService({ items: [] });
    const listener = vi.fn();
    service.onChange(listener);
    service.reload();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('runs the command in the workspace and shows its output', async () => {
    const run = vi.fn(async () => 'All green\n');
    const service = createService({ items: [{ id: 'ci', command: 'gh pr checks' }] }, { run });

    await expect(service.run('ws-1', 'ci')).resolves.toEqual({
      id: 'ci',
      workspaceId: 'ws-1',
      content: { text: 'All green' },
      ranAt: 42,
    });
    expect(run).toHaveBeenCalledWith(workspace, 'gh pr checks', 15_000);
  });

  it("runs an item's popover command and keeps the buttons it names", async () => {
    const run = vi.fn(async () =>
      JSON.stringify({
        markdown: 'Checks',
        buttons: [
          { label: 'Rerun', run: 'rerun' },
          { label: 'Deploy', run: 'deploy' },
        ],
      })
    );
    const service = createService(
      {
        items: [
          {
            id: 'pr',
            command: 'a',
            popoverCommand: 'gh pr view',
            commands: { rerun: 'gh run rerun' },
          },
        ],
      },
      { run }
    );

    await expect(service.runPopover('ws-1', 'pr')).resolves.toEqual({
      id: 'pr',
      workspaceId: 'ws-1',
      content: { markdown: 'Checks', buttons: [{ label: 'Rerun', run: 'rerun' }] },
    });
    expect(run).toHaveBeenCalledWith(workspace, 'gh pr view', 15_000);
    await expect(service.runPopover('ws-1', 'missing')).resolves.toMatchObject({ content: null });
  });

  it('serves HTML popovers as a page with the theme, one page per workspace and item', async () => {
    const servePopoverPage = vi.fn(async () => 'komla-preview://token/popover.html');
    const service = createService(
      { items: [{ id: 'pr', command: 'a', popoverCommand: 'b' }] },
      {
        run: vi.fn(async () =>
          JSON.stringify({
            html: '<h1>Chart</h1>',
            buttons: [{ label: 'Open', link: 'https://x.dev' }],
          })
        ),
        servePopoverPage,
      }
    );

    await expect(
      service.runPopover('ws-1', 'pr', { scheme: 'light', colors: { success: '0.7 0.15 150' } })
    ).resolves.toEqual({
      id: 'pr',
      workspaceId: 'ws-1',
      content: {
        markdown: '',
        htmlUrl: 'komla-preview://token/popover.html',
        buttons: [{ label: 'Open', link: 'https://x.dev' }],
      },
    });
    const [key, page] = servePopoverPage.mock.calls[0] as unknown as [string, string];
    expect(key).toBe('status-popover::ws-1:pr');
    expect(page).toContain(':root { --success: oklch(0.7 0.15 150); }');
    expect(page).toContain('komlaPopoverHeight');
    expect(page.endsWith('<h1>Chart</h1>')).toBe(true);
  });

  it("runs a button's command by its name in the file, and only those", async () => {
    const run = vi.fn(async () => '');
    const service = createService(
      {
        items: [
          { id: 'pr', command: 'a', popoverCommand: 'b', commands: { rerun: 'gh run rerun' } },
        ],
      },
      { run }
    );

    await expect(service.runButton('ws-1', 'pr', 'rerun')).resolves.toEqual({});
    expect(run).toHaveBeenCalledWith(workspace, 'gh run rerun', 60_000);
    for (const name of ['deploy', 'toString', '__proto__']) {
      await expect(service.runButton('ws-1', 'pr', name)).resolves.toEqual({
        error: `status-items.json has no command ${name} for pr`,
      });
    }
    expect(run).toHaveBeenCalledOnce();

    run.mockRejectedValueOnce(new WorkspaceCommandError('timed out', true));
    await expect(service.runButton('ws-1', 'pr', 'rerun')).resolves.toEqual({
      error: 'timed out after 60 seconds',
    });
  });

  it("shares a run that's under way", async () => {
    let finish: (stdout: string) => void = () => {};
    const run = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const service = createService({ items: [{ id: 'ci', command: 'x' }] }, { run });

    const first = service.run('ws-1', 'ci');
    const second = service.run('ws-1', 'ci');
    finish('done');
    await expect(first).resolves.toEqual(await second);
    expect(run).toHaveBeenCalledOnce();
    const third = service.run('ws-1', 'ci');
    finish('again');
    await third;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs an item again after a button's command, past a run that began before it", async () => {
    const finishes: Array<(stdout: string) => void> = [];
    const run = vi.fn(
      (_workspace: Workspace, command: string) =>
        new Promise<string>((resolve) =>
          command === 'gh run rerun' ? resolve('') : finishes.push(resolve)
        )
    );
    const service = createService(
      {
        items: [
          { id: 'pr', command: 'checks', popoverCommand: 'b', commands: { rerun: 'gh run rerun' } },
        ],
      },
      { run }
    );

    const scheduled = service.run('ws-1', 'pr');
    await service.runButton('ws-1', 'pr', 'rerun');
    const refreshed = service.run('ws-1', 'pr');
    finishes[0]('pending');
    await expect(scheduled).resolves.toMatchObject({ content: { text: 'pending' } });
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    finishes[1]('rerunning');
    await expect(refreshed).resolves.toMatchObject({ content: { text: 'rerunning' } });
  });

  it('reports why a command failed', async () => {
    const failure = new WorkspaceCommandError('gh: Not logged in');
    const service = createService(
      { items: [{ id: 'ci', command: 'gh' }] },
      { run: vi.fn(async () => Promise.reject(failure)) }
    );

    await expect(service.run('ws-1', 'ci')).resolves.toMatchObject({
      content: null,
      error: 'gh: Not logged in',
    });
  });

  it('says a command timed out', async () => {
    const timeout = new WorkspaceCommandError('timed out', true);
    const service = createService(
      { items: [{ id: 'ci', command: 'sleep 99' }] },
      { run: vi.fn(async () => Promise.reject(timeout)) }
    );
    await expect(service.run('ws-1', 'ci')).resolves.toMatchObject({
      error: 'timed out after 15 seconds',
    });
  });

  it('runs a `runOn: local` item on this computer, once for every workspace', async () => {
    let finish: (stdout: string) => void = () => {};
    const run = vi.fn(async () => 'remote');
    const runLocal = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const servePopoverPage = vi.fn(async () => 'komla-preview://token/popover.html');
    const service = createService(
      {
        items: [
          {
            id: 'usage',
            command: 'usage',
            runOn: 'local',
            popoverCommand: 'details',
            commands: { reset: 'reset' },
          },
        ],
      },
      { run, runLocal, servePopoverPage, canRun: () => false }
    );

    expect(service.list('ws-1').items).toEqual([
      { id: 'usage', intervalSeconds: 60, runOn: 'local', popover: true },
    ]);
    // The SSH host being down doesn't stop it, and every workspace shares a run.
    const first = service.run('ws-1', 'usage');
    const second = service.run('ws-2', 'usage');
    finish('7d 12%');
    await expect(first).resolves.toMatchObject({ content: { text: '7d 12%' }, runOn: 'local' });
    await expect(second).resolves.toMatchObject({ content: { text: '7d 12%' } });
    expect(runLocal).toHaveBeenCalledOnce();
    expect(runLocal).toHaveBeenCalledWith('usage', 15_000);

    runLocal.mockImplementation(async () => '{"html": "<p>usage</p>"}');
    await service.runPopover('ws-1', 'usage');
    expect(servePopoverPage).toHaveBeenCalledWith('status-popover:::usage', expect.any(String));
    await expect(service.runButton('ws-1', 'usage', 'reset')).resolves.toEqual({});
    expect(runLocal).toHaveBeenLastCalledWith('reset', 60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('refreshes an item after a run under way, telling listeners what it shows', async () => {
    const finishes: Array<(stdout: string) => void> = [];
    const run = vi.fn(() => new Promise<string>((resolve) => finishes.push(resolve)));
    const service = createService({ items: [{ id: 'ci', command: 'gh' }] }, { run });
    const listener = vi.fn();
    service.onResult(listener);

    const scheduled = service.run('ws-1', 'ci');
    const refreshed = service.refresh('ws-1', 'ci');
    finishes[0]('old');
    await scheduled;
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    finishes[1]('new');
    await expect(refreshed).resolves.toMatchObject({
      workspaceId: 'ws-1',
      content: { text: 'new' },
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ content: { text: 'new' } }));

    await expect(service.refresh('ws-1', 'missing')).resolves.toBeUndefined();
    await expect(service.refresh('missing', 'ci')).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('shares a refresh that waits for a run under way with the refreshes after it', async () => {
    const finishes: Array<(stdout: string) => void> = [];
    const run = vi.fn(() => new Promise<string>((resolve) => finishes.push(resolve)));
    const service = createService({ items: [{ id: 'ci', command: 'gh' }] }, { run });
    const listener = vi.fn();
    service.onResult(listener);

    void service.run('ws-1', 'ci');
    const refreshes = [1, 2, 3].map(() => service.refresh('ws-1', 'ci'));
    finishes[0]('old');
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    finishes[1]('new');
    for (const refreshed of refreshes) {
      await expect(refreshed).resolves.toMatchObject({ content: { text: 'new' } });
    }
    expect(run).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledOnce();

    // Once that run started, a refresh waits for it and runs again after.
    const started = service.refresh('ws-1', 'ci');
    await vi.waitFor(() => expect(finishes).toHaveLength(3));
    const after = service.refresh('ws-1', 'ci');
    finishes[2]('third');
    await vi.waitFor(() => expect(finishes).toHaveLength(4));
    finishes[3]('fourth');
    await expect(started).resolves.toMatchObject({ content: { text: 'third' } });
    await expect(after).resolves.toMatchObject({ content: { text: 'fourth' } });
  });

  it("doesn't refresh an item in a workspace that can't run commands now", async () => {
    const run = vi.fn(async () => 'x');
    const service = createService(
      { items: [{ id: 'ci', command: 'gh' }] },
      { run, canRun: () => false }
    );
    const listener = vi.fn();
    service.onResult(listener);

    await expect(service.refresh('ws-1', 'ci')).resolves.toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("doesn't share a run under way once status-items.json changed, as its command may have", async () => {
    let file = JSON.stringify({ items: [{ id: 'ci', command: 'old' }] });
    let now = 42;
    const finishes: Array<(stdout: string) => void> = [];
    const run = vi.fn(
      (_workspace: Workspace, command: string) =>
        new Promise<string>((resolve) => finishes.push(() => resolve(command)))
    );
    const service = createService(undefined, { readFile: () => file, run, now: () => now });

    const before = service.run('ws-1', 'ci');
    file = JSON.stringify({ items: [{ id: 'ci', command: 'new' }] });
    now = 50;
    service.reload();
    expect(service.list('ws-1').changedAt).toBe(50);
    const after = service.run('ws-1', 'ci');
    expect(run).toHaveBeenCalledTimes(2);
    finishes.forEach((finish) => finish(''));
    await expect(before).resolves.toMatchObject({ content: { text: 'old' } });
    await expect(after).resolves.toMatchObject({ content: { text: 'new' } });
  });

  it("serves each window's HTML popover pages under a key of its own", async () => {
    const servePopoverPage = vi.fn(async () => 'komla-preview://token/popover.html');
    const service = createService(
      { items: [{ id: 'pr', command: 'a', popoverCommand: 'b' }] },
      { run: vi.fn(async () => '{"html": "<p>pr</p>"}'), servePopoverPage }
    );

    await service.runPopover('ws-1', 'pr', undefined, '1');
    await service.runPopover('ws-1', 'pr', undefined, '2');
    expect(servePopoverPage.mock.calls.map(([key]) => key)).toEqual([
      'status-popover:1:ws-1:pr',
      'status-popover:2:ws-1:pr',
    ]);
  });

  it("doesn't run commands for unknown items or a workspace that can't run them", async () => {
    const run = vi.fn(async () => 'x');
    const offline = createService(
      { items: [{ id: 'ci', command: 'x' }] },
      { run, canRun: () => false }
    );
    await expect(offline.run('ws-1', 'ci')).resolves.toMatchObject({ content: null });
    await expect(offline.run('ws-1', 'missing')).resolves.toMatchObject({ content: null });
    expect(run).not.toHaveBeenCalled();
  });
});
