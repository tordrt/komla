import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { runInNewContext } from 'node:vm';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { refusingExecFile } from '../../helpers/windows-refusal';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: vi.fn(),
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => (name === 'home' ? '/mock/home' : `/mock/${name}`)) },
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

interface KomlaRun {
  args: string[];
  input: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Notification {
  eventName: string;
  payload: Record<string, unknown>;
}

interface GeneratedPlugin {
  id: string;
  server: () => Promise<{
    event: (context: { event: unknown }) => Promise<void>;
    'tool.execute.before': (input: unknown, output: unknown) => Promise<void>;
  }>;
  setup: (context: unknown) => Promise<() => void>;
}

/** Evaluates the generated module with the Komla CLI replaced by a recorder. */
function evaluateGeneratedPlugin(pluginContent: string) {
  const spawnStart = pluginContent.indexOf('async function runKomla(args, input, env) {');
  const spawnEnd = pluginContent.indexOf('\n}\n', spawnStart);
  if (spawnStart === -1 || spawnEnd === -1) {
    throw new Error('Could not find runKomla in generated plugin');
  }
  const script = (
    pluginContent.slice(0, spawnStart) +
    `async function runKomla(args, input, env) {
  globalThis.runs.push({ args, input, env });
  const { cwd, source, ...payload } = input;
  globalThis.notifications.push({ eventName: args[args.indexOf("--event") + 1], payload });
}` +
    pluginContent.slice(spawnEnd + 2)
  ).replace('export default', 'globalThis.plugin =');
  const context = {
    globalThis: {
      runs: [] as KomlaRun[],
      notifications: [] as Notification[],
      plugin: undefined as unknown as GeneratedPlugin,
    },
    process: { cwd: () => '/terminal/cwd' },
    AbortController,
  };
  runInNewContext(script, context);
  return context.globalThis;
}

async function loadGeneratedPlugin(pluginContent: string): Promise<{
  event: (context: { event: unknown }) => Promise<void>;
  toolExecuteBefore: (input: unknown, output: unknown) => Promise<void>;
  notifications: Notification[];
  runs: KomlaRun[];
}> {
  const generated = evaluateGeneratedPlugin(pluginContent);
  const hooks = await generated.plugin.server();
  return {
    event: hooks.event,
    toolExecuteBefore: hooks['tool.execute.before'],
    notifications: generated.notifications,
    runs: generated.runs,
  };
}

interface SessionInfo {
  parentID?: string;
  location?: { directory: string };
}

/**
 * A stand-in for OpenCode 2's plugin context. Every folder the service loads runs its own
 * setup(), and each subscription sees every event.
 */
function fakeOpenCode2(sessions: Record<string, SessionInfo> = {}) {
  const subscribers: Array<(event: unknown) => void> = [];
  const hooks = new Map<string, (event: unknown) => unknown>();
  return {
    hooks,
    context(directory: string) {
      return {
        location: { directory },
        session: {
          get: async ({ sessionID }: { sessionID: string }) => {
            if (!sessions[sessionID]) throw new Error(`Session not found: ${sessionID}`);
            return sessions[sessionID];
          },
          hook: async (name: string, callback: (event: unknown) => unknown) => {
            hooks.set(`session.${name}`, callback);
            return { dispose: async () => {} };
          },
        },
        tool: {
          hook: async (name: string, callback: (event: unknown) => unknown) => {
            hooks.set(`tool.${name}`, callback);
            return { dispose: async () => {} };
          },
        },
        event: {
          subscribe: ({ signal }: { signal: AbortSignal }) => {
            const queue: unknown[] = [];
            let wake: (() => void) | undefined;
            subscribers.push((event) => {
              queue.push(event);
              wake?.();
            });
            return {
              async *[Symbol.asyncIterator]() {
                while (!signal.aborted) {
                  if (queue.length > 0) yield queue.shift();
                  else await new Promise<void>((resolve) => (wake = resolve));
                }
              },
            };
          },
        },
      };
    },
    emit(event: unknown) {
      for (const subscriber of subscribers) subscriber(event);
    },
    prompt(sessionID: string, text: string) {
      hooks.get('session.prompt')?.({ sessionID, messageID: 'msg', prompt: { text } });
    },
    tool(sessionID: string, tool: string) {
      hooks.get('tool.execute.before')?.({ sessionID, tool, id: 'call', input: {} });
    },
  };
}

/** Lets the plugin's pending lookups and reports run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadOpenCode2Plugin(
  sessions: Record<string, SessionInfo> = {},
  folders = ['/service']
) {
  const { opencodeSettingsService } =
    await import('../../../src/main/services/opencode-settings.service');
  const generated = evaluateGeneratedPlugin(opencodeSettingsService.getPluginContent());
  const opencode = fakeOpenCode2(sessions);
  for (const folder of folders) await generated.plugin.setup(opencode.context(folder));
  return { opencode, runs: generated.runs, notifications: generated.notifications };
}

describe('OpenCodeSettingsService', () => {
  it('offers an update only for a differing installed plugin, without writing', async () => {
    const { opencodeSettingsService } = await import('../../../src/main/services/opencode-settings.service');
    mockExistsSync.mockReturnValue(false);
    expect(opencodeSettingsService.getNotificationUpdate()).toBeUndefined();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('// old or customized Komla plugin');
    expect(opencodeSettingsService.getNotificationUpdate()?.files[0].description).toContain('manual edits');
    mockReadFileSync.mockReturnValue(opencodeSettingsService.getPluginContent());
    expect(opencodeSettingsService.getNotificationUpdate()).toBeUndefined();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockExistsSync.mockReturnValue(false);
  });

  it('writes a normalized notification plugin', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');

    opencodeSettingsService.enableNotificationPlugin();

    expect(mockMkdirSync).toHaveBeenCalledWith('/mock/home/.config/opencode/plugins', {
      recursive: true,
    });
    expect(mockWriteFileSync).toHaveBeenCalledOnce();

    const [pluginPath, pluginContent] = mockWriteFileSync.mock.calls[0] as [string, string];
    expect(pluginPath).toBe('/mock/home/.config/opencode/plugins/komla-notify.js');
    expect(pluginContent).toContain('/bin/komla');
    expect(pluginContent).toContain('"notify"');
    expect(pluginContent).not.toContain('/notify.js');
    expect(pluginContent).toContain('proc.stdin?.end(JSON.stringify');
    expect(pluginContent).toContain('--source');
    expect(pluginContent).toContain('opencode');
    expect(pluginContent).toContain('--event');
    expect(pluginContent).toContain('Stop');
    expect(pluginContent).toContain('UserPromptSubmit');
    expect(pluginContent).toContain('PermissionRequest');
    expect(pluginContent).toContain('source: "opencode"');
    expect(pluginContent).toContain('session.idle');
    expect(pluginContent).toContain('session.status');
    expect(pluginContent).toContain('permission.asked');
    expect(pluginContent).toContain('permission.updated');
    expect(pluginContent).toContain('tool.execute.before');
    expect(pluginContent).toContain('input.tool !== "question"');
    expect(pluginContent).toContain('session.next.prompted');
    expect(pluginContent).toContain('message.updated');
    expect(pluginContent).toContain('message.part.updated');
    expect(pluginContent).toContain('pendingUserMessages');
    expect(pluginContent).toContain('textParts');
    expect(pluginContent).toContain('seenPrompts.has("key:" + key)');
    expect(pluginContent).toContain('typeof props.permission === "object"');
    expect(pluginContent).not.toContain('curl');
    expect(pluginContent).not.toContain('Notification');
  });

  it('runs notify.js with Komla itself once Windows blocks the CLI, and offers that as an update', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const { probeKomlaCli } = await import('../../../src/main/lib/komla-cli');
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(opencodeSettingsService.getPluginContent());
    expect(opencodeSettingsService.getNotificationUpdate()).toBeUndefined();

    vi.mocked(execFile).mockImplementationOnce(refusingExecFile());
    expect(probeKomlaCli('/missing/komla')).toBe(true);

    const pluginContent = opencodeSettingsService.getPluginContent();
    expect(pluginContent).toContain('readFileSync("/mock/home/.komla/node-path", "utf8")');
    expect(pluginContent).toContain('["/mock/home/.komla/notify.js", ...args.slice(1)]');
    expect(pluginContent).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(opencodeSettingsService.getNotificationUpdate()?.files[0].description).toContain(
      'It runs notify.js, because Windows blocks the Komla CLI on this computer.'
    );
  });

  it('deduplicates matching prompt events across OpenCode event shapes', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());

    await plugin.event({
      event: {
        type: 'session.next.prompted',
        properties: { sessionID: 'session-1', prompt: { text: 'build the thing' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { sessionID: 'session-1', info: { id: 'message-1', role: 'user' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: { messageID: 'message-1', type: 'text', text: 'build the thing' },
        },
      },
    });

    expect(plugin.notifications).toEqual([
      {
        eventName: 'UserPromptSubmit',
        payload: { sessionID: 'session-1', prompt: 'build the thing' },
      },
    ]);
  });

  it('keeps OpenCode permission request details from v2 object-shaped events', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());

    await plugin.event({
      event: {
        type: 'permission.asked',
        properties: {
          sessionID: 'session-1',
          id: 'request-1',
          permission: 'bash',
          patterns: ['npm test', 'git status'],
          metadata: { tool_name: 'Bash' },
        },
      },
    });

    expect(plugin.notifications).toEqual([
      {
        eventName: 'PermissionRequest',
        payload: {
          sessionID: 'session-1',
          permissionID: 'request-1',
          tool_name: 'Bash',
          tool_input: {
            description: undefined,
            command: 'npm test, git status',
          },
        },
      },
    ]);
  });

  it.each([
    { sessionID: 'session-1', requestID: 'request-1', reply: 'once' },
    { sessionID: 'session-1', permissionID: 'request-1', response: 'once' },
  ])('reports the reply to a permission request as tool activity naming it', async (properties) => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());

    await plugin.event({ event: { type: 'permission.replied', properties } });

    expect(plugin.notifications).toEqual([
      {
        eventName: 'PreToolUse',
        payload: { sessionID: 'session-1', permissionID: 'request-1' },
      },
    ]);
  });

  it.each([
    { sessionID: 'session-1', requestID: 'request-1', reply: 'reject' },
    { sessionID: 'session-1', permissionID: 'request-1', response: 'reject' },
  ])('reports no tool activity for a rejected permission request', async (properties) => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());

    await plugin.event({ event: { type: 'permission.replied', properties } });

    expect(plugin.notifications).toEqual([]);
  });

  it('reports tool activity while keeping questions as permission requests', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());

    await plugin.toolExecuteBefore(
      { tool: 'bash', sessionID: 'session-1', callID: 'call-1' },
      { args: { command: 'npm test' } }
    );
    expect(plugin.notifications).toEqual([{
      eventName: 'PreToolUse',
      payload: { sessionID: 'session-1', tool_name: 'bash' },
    }]);
    plugin.notifications.length = 0;

    await plugin.toolExecuteBefore(
      { tool: 'question', sessionID: 'session-1', callID: 'call-2' },
      {
        args: {
          questions: [
            { question: 'Which database should we use?', header: 'Database', options: [] },
          ],
        },
      }
    );

    expect(plugin.notifications).toEqual([
      {
        eventName: 'PermissionRequest',
        payload: {
          sessionID: 'session-1',
          tool_name: 'question',
          tool_input: { description: 'Which database should we use?' },
        },
      },
    ]);
  });

  it('reports a recorded subagent run as one root turn', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());
    // Real events from OpenCode 1.18.20 running a task-tool subagent, reduced to the
    // fields the plugin reads.
    const actualFs = await vi.importActual<typeof import('fs')>('fs');
    const trace = actualFs
      .readFileSync(`${__dirname}/../../fixtures/opencode/task-subagent-1.18.20.jsonl`, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; input?: unknown });
    for (const event of trace) {
      if (event.type === 'tool.execute.before') await plugin.toolExecuteBefore(event.input, {});
      else await plugin.event({ event });
    }

    // The subagent's prompt and idle stay out; its tools keep the root turn working.
    const root = 'ses_ee97aec64ffe4H68ZW3V5Dl59f';
    expect(
      plugin.notifications.map(({ eventName, payload }) => [eventName, payload.sessionID])
    ).toEqual([
      ['UserPromptSubmit', root],
      ['PreToolUse', root],
      ['PreToolUse', root],
      ['PreToolUse', root],
      ['Stop', root],
    ]);
  });

  it('reports recorded turns that were aborted or failed', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());
    // Real events from OpenCode 1.18.35 against a scripted model server, reduced to the fields
    // the plugin reads. Each scenario runs in its own session.
    const actualFs = await vi.importActual<typeof import('fs')>('fs');
    const trace = actualFs
      .readFileSync(`${__dirname}/../../fixtures/opencode/turn-endings-1.18.35.jsonl`, 'utf-8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            scenario: string;
            type: string;
            input?: unknown;
            properties?: { sessionID?: string };
          }
      );
    const scenarios = new Map<unknown, string>();
    for (const event of trace) {
      scenarios.set(event.properties?.sessionID, event.scenario);
      if (event.type === 'tool.execute.before') await plugin.toolExecuteBefore(event.input, {});
      else await plugin.event({ event });
    }

    const reported: Record<string, string[]> = {};
    for (const { eventName, payload } of plugin.notifications) {
      (reported[scenarios.get(payload.sessionID)!] ??= []).push(eventName);
    }
    expect(reported).toEqual({
      '1-normal': ['UserPromptSubmit', 'Stop'],
      '2-abort-stream': ['UserPromptSubmit', 'Interrupt'],
      '3-abort-tool': ['UserPromptSubmit', 'PreToolUse', 'Interrupt'],
      '4-error-401': ['UserPromptSubmit', 'StopFailure'],
      '4-error-500': ['UserPromptSubmit', 'StopFailure'],
      // An abort while waiting to retry reports no error.
      '4c-abort-during-retry': ['UserPromptSubmit', 'Interrupt'],
      '4d-retry-then-success': ['UserPromptSubmit', 'Stop'],
      // OpenCode compacts the conversation and carries on, with a message of its own.
      '8-overflow': ['UserPromptSubmit', 'Stop'],
      // The subagent's failure is reported to the root turn, which carries on.
      '10b-subagent-401': ['UserPromptSubmit', 'PreToolUse', 'Stop'],
      '14-content-filter': ['UserPromptSubmit', 'StopFailure'],
    });
    expect(
      plugin.notifications.find(
        ({ eventName, payload }) =>
          eventName === 'StopFailure' && scenarios.get(payload.sessionID) === '4-error-401'
      )?.payload.error
    ).toBe('mock invalid api key');
  });

  it('shortens the error of a failed turn to fit on the command line', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());
    const page = '<html>' + 'x'.repeat(200_000);
    await plugin.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 's1', error: { name: 'APIError', data: { message: page } } },
      },
    });
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });

    expect(plugin.notifications).toEqual([
      { eventName: 'StopFailure', payload: { sessionID: 's1', error: page.slice(0, 2000) } },
    ]);
  });

  it('keeps only recent message text in a long session', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());
    const text = (messageID: string) =>
      plugin.event({
        event: {
          type: 'message.part.updated',
          properties: { part: { type: 'text', messageID, sessionID: 's', text: messageID } },
        },
      });
    const userMessage = (id: string) =>
      plugin.event({
        event: { type: 'message.updated', properties: { info: { id, role: 'user', sessionID: 's' } } },
      });
    for (let index = 0; index < 300; index++) await text(`msg-${index}`);
    await userMessage('msg-0');
    await userMessage('msg-299');
    expect(plugin.notifications.map(({ payload }) => payload.prompt)).toEqual(['msg-299']);
  });

  it('allows a fresh completion after tool activity cancels a recent stop', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());
    const event = { type: 'session.idle', properties: { sessionID: 'session-1' } };
    await plugin.event({ event });
    await plugin.toolExecuteBefore({ tool: 'read', sessionID: 'session-1' }, {});
    await plugin.event({ event });
    expect(plugin.notifications.map((entry) => entry.eventName)).toEqual([
      'Stop', 'PreToolUse', 'Stop',
    ]);
  });

  it('ignores malformed tool callbacks', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());
    for (const input of [undefined, {}, { tool: 42 }, { tool: '' }]) {
      await plugin.toolExecuteBefore(input, {});
    }
    expect(plugin.notifications).toEqual([]);
  });

  it('reports OpenCode 1 events from the terminal it runs in', async () => {
    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    const plugin = await loadGeneratedPlugin(opencodeSettingsService.getPluginContent());

    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });

    expect(plugin.runs).toEqual([
      {
        args: ['notify', '--source', 'opencode', '--event', 'Stop', '--cwd', '/terminal/cwd'],
        input: {
          cwd: '/terminal/cwd',
          source: 'opencode',
          sessionID: 's1',
          message: 'OpenCode finished',
        },
        env: undefined,
      },
    ]);
  });

  it('reports an OpenCode 2 session from its own folder, not the terminal that started the service', async () => {
    const { opencode, runs } = await loadOpenCode2Plugin({
      s1: { location: { directory: '/work/app' } },
    });

    opencode.prompt('s1', 'build the thing');
    opencode.emit({ id: 'evt_1', type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    await settle();

    const blank = { KOMLA_TERMINAL_ID: '', KOMLA_WORKSPACE_ID: '', TMUX: '' };
    expect(runs).toEqual([
      {
        args: [
          'notify',
          '--source',
          'opencode',
          '--event',
          'UserPromptSubmit',
          '--cwd',
          '/work/app',
        ],
        input: { cwd: '/work/app', source: 'opencode', sessionID: 's1', prompt: 'build the thing' },
        env: blank,
      },
      {
        args: ['notify', '--source', 'opencode', '--event', 'Stop', '--cwd', '/work/app'],
        input: {
          cwd: '/work/app',
          source: 'opencode',
          sessionID: 's1',
          message: 'OpenCode finished',
        },
        env: blank,
      },
    ]);
  });

  it('reports an OpenCode 2 event once although every loaded folder sees it', async () => {
    const { opencode, notifications } = await loadOpenCode2Plugin(
      { s1: { location: { directory: '/work/app' } } },
      ['/service', '/work/app', '/work/other']
    );

    opencode.emit({ id: 'evt_1', type: 'session.execution.succeeded', data: { sessionID: 's1' } });
    await settle();

    expect(notifications.map(({ eventName }) => eventName)).toEqual(['Stop']);
  });

  it('reports recorded OpenCode 2 turns', async () => {
    // Real plugin input from OpenCode 2.1.2 against a scripted model server, reduced to the
    // fields the plugin reads. Each scenario runs in its own session; the subagent's prompt
    // reaches the plugin before its session does.
    const actualFs = await vi.importActual<typeof import('fs')>('fs');
    const trace = actualFs
      .readFileSync(`${__dirname}/../../fixtures/opencode/turns-2.1.2.jsonl`, 'utf-8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            scenario: string;
            kind: 'event' | 'prompt' | 'tool';
            id?: string;
            type?: string;
            data?: { sessionID?: string; parentID?: string; location?: { directory: string } };
            sessionID?: string;
            prompt?: { text: string };
            tool?: string;
          }
      );
    const sessions: Record<string, SessionInfo> = {};
    const scenarios = new Map<unknown, string>();
    for (const entry of trace) {
      if (entry.type !== 'session.created' || !entry.data?.sessionID) continue;
      sessions[entry.data.sessionID] = entry.data;
      if (!entry.data.parentID) scenarios.set(entry.data.sessionID, entry.scenario);
    }
    const { opencode, runs } = await loadOpenCode2Plugin(sessions);
    for (const entry of trace) {
      if (entry.kind === 'prompt') opencode.prompt(entry.sessionID!, entry.prompt!.text);
      else if (entry.kind === 'tool') opencode.tool(entry.sessionID!, entry.tool!);
      else opencode.emit({ id: entry.id, type: entry.type, data: entry.data });
      await settle();
    }

    const reported: Record<string, string[]> = {};
    for (const { args, input } of runs) {
      const scenario = scenarios.get(input.sessionID)!;
      // Every report names the root session and comes from its folder.
      expect([args[args.indexOf('--cwd') + 1], input.cwd]).toEqual([
        sessions[input.sessionID as string].location!.directory,
        sessions[input.sessionID as string].location!.directory,
      ]);
      const event = args[args.indexOf('--event') + 1];
      (reported[scenario] ??= []).push(input.permissionID ? `${event}:answer` : event);
    }
    expect(reported).toEqual({
      normal: ['UserPromptSubmit', 'Stop'],
      'abort-stream': ['UserPromptSubmit', 'Interrupt'],
      fail: ['UserPromptSubmit', 'StopFailure'],
      permission: [
        'UserPromptSubmit',
        'PreToolUse',
        'PermissionRequest:answer',
        'PreToolUse:answer',
        'Stop',
      ],
      question: ['UserPromptSubmit', 'PermissionRequest:answer', 'PreToolUse:answer', 'Stop'],
      // The subagent's prompt and turn end stay out; its tools keep the root turn working.
      subagent: [
        'UserPromptSubmit',
        'PreToolUse',
        'PreToolUse',
        'PermissionRequest:answer',
        'PreToolUse:answer',
        'Stop',
      ],
      'abort-at-permission': [
        'UserPromptSubmit',
        'PreToolUse',
        'PermissionRequest:answer',
        'Interrupt',
      ],
      // The subagent's failure is reported to the root turn, which carries on.
      'subagent-fail': ['UserPromptSubmit', 'PreToolUse', 'Stop'],
    });
    expect(runs.find(({ args }) => args.includes('StopFailure'))?.args.slice(-2)).toEqual([
      '--message',
      'mock invalid api key',
    ]);
    expect(runs.find(({ input }) => input.tool_name === 'question')?.input.tool_input).toEqual({
      description: 'Which database should we use?',
    });
  });

  it('ends an OpenCode 2 turn quietly unless a newer run took it over', async () => {
    const { opencode, notifications } = await loadOpenCode2Plugin();

    opencode.emit({
      id: 'evt_1',
      type: 'session.execution.interrupted',
      data: { sessionID: 's1', reason: 'superseded' },
    });
    opencode.emit({
      id: 'evt_2',
      type: 'session.execution.interrupted',
      data: { sessionID: 's1', reason: 'shutdown' },
    });
    await settle();

    expect(notifications).toEqual([{ eventName: 'Interrupt', payload: { sessionID: 's1' } }]);
  });

  it.each([
    [
      { type: 'provider.http', message: '<html>' + 'x'.repeat(200_000) },
      '<html>' + 'x'.repeat(1994),
    ],
    [{ type: 'provider.auth', message: ' ' }, 'provider.auth'],
  ])(
    'shortens the error of a failed OpenCode 2 turn to fit on the command line',
    async (error, reported) => {
      const { opencode, runs } = await loadOpenCode2Plugin();

      opencode.emit({
        id: 'evt_1',
        type: 'session.execution.failed',
        data: { sessionID: 's1', error },
      });
      await settle();

      expect(runs.map(({ args, input }) => [args.slice(-2), input.error])).toEqual([
        [['--message', reported], reported],
      ]);
    }
  );

  it('removes the plugin when disabling notifications', async () => {
    mockExistsSync.mockImplementation(
      (path) => path === '/mock/home/.config/opencode/plugins/komla-notify.js'
    );

    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');
    opencodeSettingsService.disableNotificationPlugin();

    expect(mockUnlinkSync).toHaveBeenCalledWith(
      '/mock/home/.config/opencode/plugins/komla-notify.js'
    );
  });

  it('reports MCP configured when komla remote entry exists', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcp: {
          komla: {
            type: 'remote',
            url: 'http://localhost:52863/api/v1/mcp',
          },
        },
      })
    );

    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');

    expect(opencodeSettingsService.getMcpStatus().isConfigured).toBe(true);
  });

  it('reads config with single-line comments', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`{
      // Komla MCP server
      "mcp": {
        "komla": {
          "type": "remote",
          "url": "http://localhost:52863/api/v1/mcp"
        }
      }
    }`);

    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');

    expect(opencodeSettingsService.getMcpStatus().isConfigured).toBe(true);
  });

  it('reads config with block comments and commented-out entries', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`{
      "$schema": "https://opencode.ai/config.json",
      "mcp": {
        /* "old-server": {
          "type": "remote",
          "url": "http://localhost:9999/mcp"
        }, */
        "komla": {
          "type": "remote",
          "url": "http://localhost:52863/api/v1/mcp" // production port
        }
      }
    }`);

    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');

    expect(opencodeSettingsService.getMcpStatus().isConfigured).toBe(true);
  });

  it('returns not configured when config has comments but no komla mcp', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`{
      // my custom setting
      "mcp": {}
    }`);

    const { opencodeSettingsService } =
      await import('../../../src/main/services/opencode-settings.service');

    expect(opencodeSettingsService.getMcpStatus().isConfigured).toBe(false);
  });
});
