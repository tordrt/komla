import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('../../mocks/electron')).mockElectron());

import { KomlaOperationError } from '../../../src/main/services/komla-operation/operation';
import {
  MAX_PANEL_POST_BYTES,
  PluginHostService,
  type HostedPlugin,
  type PluginHostDependencies,
  type PluginProcess,
} from '../../../src/main/services/plugin-host.service';
import { SidebarPanelStates } from '../../../src/main/services/sidebar-panel-states';

import type { FromPluginHost, ToPluginHost } from '../../../src/main/workers/plugin-host-protocol';
import type { KomlaEvent } from '../../../src/shared/types/komla-events';

class FakeProcess implements PluginProcess {
  sent: ToPluginHost[] = [];
  killed = false;
  private messageListener: (message: FromPluginHost) => void = () => {};
  private exitListener: (code: number) => void = () => {};
  private outputListener: (text: string) => void = () => {};
  postMessage(message: ToPluginHost) {
    this.sent.push(message);
  }
  onMessage(listener: (message: FromPluginHost) => void) {
    this.messageListener = listener;
  }
  onExit(listener: (code: number) => void) {
    this.exitListener = listener;
  }
  onOutput(listener: (text: string) => void) {
    this.outputListener = listener;
  }
  kill() {
    this.killed = true;
  }
  send(message: FromPluginHost) {
    this.messageListener(message);
  }
  exit(code: number) {
    this.exitListener(code);
  }
  print(text: string) {
    this.outputListener(text);
  }
  last<T extends ToPluginHost['type']>(type: T) {
    return this.sent.filter((message) => message.type === type).pop() as
      | Extract<ToPluginHost, { type: T }>
      | undefined;
  }
}

const prs: HostedPlugin = {
  source: { id: 'prs', name: 'Pull requests', dir: '/plugins/prs' },
  main: '/plugins/prs/main.ts',
  panels: ['list'],
  digest: 'a'.repeat(64),
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PluginHostService', () => {
  let processes: FakeProcess[];
  let states: SidebarPanelStates;
  let events: ((event: KomlaEvent) => void) | undefined;
  let timers: { callback: () => void; ms: number }[];
  let now: number;
  let dependencies: PluginHostDependencies;
  let service: PluginHostService;

  beforeEach(() => {
    processes = [];
    states = new SidebarPanelStates();
    events = undefined;
    timers = [];
    now = 1_000_000;
    dependencies = {
      fork: vi.fn(() => {
        const process = new FakeProcess();
        processes.push(process);
        return process;
      }),
      execute: vi.fn(async (request: unknown) => ({ ran: request })),
      exec: vi.fn(async () => 'printed\n'),
      states,
      panelScope: (_panel, workspaceId) => workspaceId ?? '',
      onEvent: (listener) => {
        events = listener;
        return () => {
          events = undefined;
        };
      },
      now: () => now,
      setTimeout: (callback, ms) => {
        const timer = { callback, ms };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        timers = timers.filter((each) => each !== timer);
      },
    };
    service = new PluginHostService(dependencies);
  });

  /** Starts the plugin and has its code activate. */
  function started(plugin = prs) {
    service.sync([plugin]);
    const process = processes.at(-1)!;
    process.send({ type: 'ready' });
    return process;
  }

  it("starts a plugin's code with what it is, and runs it once it's ready", () => {
    service.sync([prs]);
    expect(dependencies.fork).toHaveBeenCalledWith(prs);
    const [process] = processes;
    expect(process.sent[0]).toEqual({
      type: 'activate',
      main: '/plugins/prs/main.ts',
      plugin: { id: 'prs', name: 'Pull requests', dir: '/plugins/prs' },
    });
    expect(service.status().prs).toEqual({ state: 'starting', log: [] });
    process.send({ type: 'ready' });
    expect(service.status().prs.state).toBe('running');
  });

  it("answers its code's operations and commands, with Komla's error codes", async () => {
    const process = started();
    process.send({ type: 'call', id: 1, request: { type: 'tag.list' }, workspace: 'ws-1' });
    await flush();
    expect(dependencies.execute).toHaveBeenCalledWith({ type: 'tag.list' }, 'ws-1');
    expect(process.last('reply')).toEqual({
      type: 'reply',
      id: 1,
      ok: true,
      result: { ran: { type: 'tag.list' } },
    });

    vi.mocked(dependencies.execute).mockRejectedValueOnce(
      new KomlaOperationError('CAPABILITY_DISABLED', 'The user turned it off.', 403, {
        capability: 'agent.launch.tab',
      })
    );
    process.send({ type: 'call', id: 2, request: { type: 'agent.launch' } });
    await flush();
    expect(process.last('reply')).toEqual({
      type: 'reply',
      id: 2,
      ok: false,
      error: {
        code: 'CAPABILITY_DISABLED',
        message: 'The user turned it off.',
        details: { capability: 'agent.launch.tab' },
      },
    });

    process.send({
      type: 'exec',
      id: 3,
      command: 'gh pr list',
      workspace: 'ws-1',
      timeoutSeconds: 5,
    });
    await flush();
    expect(dependencies.exec).toHaveBeenCalledWith(prs, 'gh pr list', 'ws-1', 5000);
    expect(process.last('reply')).toEqual({ type: 'reply', id: 3, ok: true, result: 'printed\n' });

    vi.mocked(dependencies.exec).mockReturnValueOnce(undefined);
    process.send({ type: 'exec', id: 4, command: 'true', workspace: 'ssh-ws' });
    await flush();
    expect(process.last('reply')).toMatchObject({
      id: 4,
      ok: false,
      error: { code: 'WORKSPACE_UNAVAILABLE' },
    });
  });

  it("answers a request Komla can't read, rather than leave the code waiting", async () => {
    const process = started();
    vi.mocked(dependencies.execute).mockImplementationOnce(() => {
      throw new KomlaOperationError('INVALID_OPERATION', 'Komla has no such operation.', 400);
    });
    process.send({ type: 'call', id: 9, request: { type: 'nope' } });
    await flush();
    expect(process.last('reply')).toMatchObject({
      id: 9,
      ok: false,
      error: { code: 'INVALID_OPERATION' },
    });
  });

  it('tells code that starts after a page opened about the page', () => {
    service.sync([prs]);
    service.panelOpened('prs', 'list', 'ws-1');
    service.panelOpened('prs', 'list', 'ws-1');
    const [process] = processes;
    expect(process.last('panel-open')).toBeUndefined();
    process.send({ type: 'ready' });
    expect(process.sent.filter((message) => message.type === 'panel-open')).toEqual([
      { type: 'panel-open', panel: 'list', workspace: 'ws-1' },
    ]);

    // Started again, as after its files changed, it hears of the page again.
    service.sync([{ ...prs, digest: 'b'.repeat(64) }]);
    const next = processes.at(-1)!;
    next.send({ type: 'ready' });
    expect(next.last('panel-open')).toEqual({
      type: 'panel-open',
      panel: 'list',
      workspace: 'ws-1',
    });
  });

  it('tells code of a page opened before Komla started it, as at its own start', () => {
    service.panelOpened('prs', 'list', 'ws-1');
    service.panelOpened('gone', 'list', 'ws-1');
    service.sync([prs]);
    const [process] = processes;
    process.send({ type: 'ready' });
    expect(process.last('panel-open')).toEqual({
      type: 'panel-open',
      panel: 'list',
      workspace: 'ws-1',
    });
  });

  it("forgets opened pages past the latest ten, and trashed workspaces'", () => {
    started();
    for (let index = 0; index < 12; index++) service.panelOpened('prs', 'list', `ws-${index}`);
    events!({ type: 'workspace.trashed', workspaceId: 'ws-11' });

    service.sync([{ ...prs, digest: 'b'.repeat(64) }]);
    const next = processes.at(-1)!;
    next.send({ type: 'ready' });
    expect(
      next.sent.flatMap((message) => (message.type === 'panel-open' ? [message.workspace] : []))
    ).toEqual(['ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6', 'ws-7', 'ws-8', 'ws-9', 'ws-10']);
  });

  it('gives its own panels data and badges, and nothing to panels it lacks', () => {
    const process = started();
    process.send({ type: 'panel-post', panel: 'list', workspace: 'ws-1', data: { prs: [1] } });
    process.send({ type: 'panel-badge', panel: 'list', badge: { text: 3, tone: 'warning' } });
    expect(states.get('ws-1', 'prs.list')).toEqual({
      workspaceId: 'ws-1',
      id: 'prs.list',
      data: { data: { prs: [1] } },
      revision: 1,
    });
    // Without a workspace, for every workspace.
    expect(states.get('ws-2', 'prs.list')).toEqual({
      workspaceId: '',
      id: 'prs.list',
      badge: { text: '3', tone: 'warning' },
    });

    process.send({ type: 'panel-post', panel: 'other', data: 1 });
    process.send({ type: 'panel-badge', panel: 'list', badge: { html: '<b>' } });
    process.send({
      type: 'panel-post',
      panel: 'list',
      data: 'x'.repeat(MAX_PANEL_POST_BYTES + 1),
    });
    // Counted in UTF-8 bytes: each é is two.
    process.send({ type: 'panel-post', panel: 'list', data: 'é'.repeat(MAX_PANEL_POST_BYTES / 2) });
    expect(states.all()).toHaveLength(2);
    expect(service.status().prs.log).toEqual([
      'Komla: the plugin has no panel other.',
      "Komla: panel list's badge isn't text or a number.",
      `Komla: left out panel list's data, ${MAX_PANEL_POST_BYTES + 3} bytes of JSON, past ${MAX_PANEL_POST_BYTES}.`,
      `Komla: left out panel list's data, ${MAX_PANEL_POST_BYTES + 2} bytes of JSON, past ${MAX_PANEL_POST_BYTES}.`,
    ]);
  });

  it("carries a page's messages to its code and the code's answers back", async () => {
    const process = started();
    const answer = service.sendPanelMessage('prs', 'list', 'ws-1', { want: 'review' }, true);
    const sent = process.last('panel-message')!;
    expect(sent).toEqual({
      type: 'panel-message',
      id: sent.id,
      panel: 'list',
      workspace: 'ws-1',
      message: { want: 'review' },
      activated: true,
    });
    process.send({ type: 'reply', id: sent.id, ok: true, result: 'started' });
    await expect(answer).resolves.toEqual({ ok: true, result: 'started' });

    const late = service.sendPanelMessage('prs', 'list', 'ws-1', 'hi', false);
    timers.find((timer) => timer.ms === 30_000)!.callback();
    await expect(late).resolves.toMatchObject({ ok: false, error: { code: 'TIMED_OUT' } });

    await expect(
      service.sendPanelMessage('other', 'list', 'ws-1', 'hi', false)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'PLUGIN_NOT_RUNNING' },
    });
  });

  it('tells running code of events and opened panels', () => {
    const process = started();
    const event: KomlaEvent = { type: 'agent.done', workspaceId: 'ws-1', message: 'Done' };
    events!(event);
    service.panelOpened('prs', 'list', 'ws-1');
    expect(process.last('event')).toEqual({ type: 'event', event });
    expect(process.last('panel-open')).toEqual({
      type: 'panel-open',
      panel: 'list',
      workspace: 'ws-1',
    });

    service.sync([]);
    expect(events).toBeUndefined();
  });

  it('stops code whose plugin is off or changed, and forgets what it set', () => {
    const process = started();
    process.send({ type: 'panel-badge', panel: 'list', workspace: 'ws-1', badge: 2 });

    service.sync([{ ...prs, digest: 'b'.repeat(64) }]);
    expect(process.last('deactivate')).toEqual({ type: 'deactivate' });
    expect(states.all()).toEqual([]);
    expect(processes).toHaveLength(2);
    timers.find((timer) => timer.ms === 3000)!.callback();
    expect(process.killed).toBe(true);
    // A stopped process exiting starts nothing.
    process.exit(0);
    expect(processes).toHaveLength(2);

    service.sync([]);
    expect(service.status()).toEqual({});
  });

  it('starts code that stopped again, waiting longer each time, then leaves it off until it changes', () => {
    let process = started();
    process.print('booting\nhalf');
    process.print(' a line\n');
    for (const wait of [1000, 2000, 4000]) {
      process.exit(1);
      expect(service.status().prs).toMatchObject({ state: 'starting' });
      const timer = timers.find((each) => each.ms === wait)!;
      timers = timers.filter((each) => each !== timer);
      timer.callback();
      process = processes.at(-1)!;
      now += 1000;
    }
    process.exit(1);
    expect(processes).toHaveLength(4);
    expect(service.status().prs).toEqual({
      state: 'failed',
      error: expect.stringMatching(/stopped 4 times in a minute/),
      log: ['booting', 'half a line'],
    });

    service.sync([prs]);
    expect(processes).toHaveLength(4);
    service.sync([{ ...prs, digest: 'c'.repeat(64) }]);
    expect(processes).toHaveLength(5);
  });

  it('says so when code that stopped fails to start again, keeping its log', () => {
    const process = started();
    // Its last line, without a newline.
    process.print('crashed');
    process.send({ type: 'panel-post', panel: 'list', data: { prs: [1] } });
    const changed = vi.fn();
    service.onChange(changed);
    process.exit(1);
    changed.mockClear();
    vi.mocked(dependencies.fork).mockImplementationOnce(() => {
      throw new Error('spawn EAGAIN');
    });
    timers.at(-1)!.callback();
    expect(service.status().prs).toMatchObject({
      state: 'failed',
      error: "Komla couldn't start the plugin's code: spawn EAGAIN",
      log: ['crashed'],
    });
    expect(changed).toHaveBeenCalled();
    expect(states.all()).toEqual([]);
  });

  it('leaves off code whose activate failed, saying why', () => {
    service.sync([prs]);
    const [process] = processes;
    process.send({ type: 'activate-failed', message: 'main.ts exports no activate function' });
    expect(process.last('deactivate')).toBeDefined();
    expect(service.status().prs).toMatchObject({
      state: 'failed',
      error: 'Its activate failed: main.ts exports no activate function',
    });
    expect(service.hosts('prs')).toBe(false);
  });
});
