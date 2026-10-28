import { exec, execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { refusingExecFile } from '../../helpers/windows-refusal';

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
  },
}));

vi.mock('../../../src/main/lib/wsl', () => ({
  isWslMode: vi.fn(() => false),
}));

vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: vi.fn(() => ({})),
  },
}));

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomicSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockExec = vi.mocked(exec);

describe('ClaudeSettingsService', () => {
  it.each([
    { type: 'http', url: 'https://example.com/hook' },
    { type: 'prompt', prompt: 'Check whether the task is complete' },
    { type: 'agent', prompt: 'Verify the changes' },
  ])('preserves $type hooks while detecting and applying notification updates', async (userHook) => {
    const { claudeSettingsService } = await import('../../../src/main/services/claude-settings.service');
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: 'curl localhost:52863/notify' }] }],
        UserPromptSubmit: [{ hooks: [userHook] }],
        Stop: [{ hooks: [userHook, { type: 'command', command: 'curl localhost:52863/notify' }] }],
      },
    }));

    expect(claudeSettingsService.getNotificationUpdate()).toBeDefined();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    claudeSettingsService.enableNotificationHook();

    const written = mockWriteFileSync.mock.calls.at(-1)![1] as string;
    const settings = JSON.parse(written);
    expect(settings.hooks.UserPromptSubmit[0].hooks).toEqual([userHook]);
    expect(settings.hooks.Stop[0].hooks[0]).toEqual(userHook);
    mockReadFileSync.mockReturnValue(written);
    expect(claudeSettingsService.isNotificationHookEnabled()).toBe(true);
    expect(claudeSettingsService.getNotificationUpdate()).toBeUndefined();
  });

  it("tells whether any of Komla's notification hooks are installed", async () => {
    const { claudeSettingsService } =
      await import('../../../src/main/services/claude-settings.service');
    mockExistsSync.mockReturnValue(true);
    const userHook = { type: 'command', command: 'say done' };
    mockReadFileSync.mockReturnValue(JSON.stringify({ hooks: { Stop: [{ hooks: [userHook] }] } }));
    expect(claudeSettingsService.hasNotificationHooks()).toBe(false);

    claudeSettingsService.enableNotificationHook();
    const settings = JSON.parse(mockWriteFileSync.mock.calls.at(-1)![1] as string);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ hooks: { PreToolUse: settings.hooks.PreToolUse } })
    );
    expect(claudeSettingsService.hasNotificationHooks()).toBe(true);
  });

  it('detects old or partial Komla hooks without writing, and recognizes current hooks', async () => {
    const { claudeSettingsService } = await import('../../../src/main/services/claude-settings.service');
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ hooks: { Notification: [{ hooks: [
      { type: 'command', name: 'komla-notification-hook', command: 'curl localhost:52863/notify' },
      { type: 'command', command: 'unrelated-hook' },
    ] }] } }));
    expect(claudeSettingsService.getNotificationUpdate()).toBeDefined();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    claudeSettingsService.enableNotificationHook();
    const written = mockWriteFileSync.mock.calls.at(-1)![1] as string;
    expect(written).toContain('unrelated-hook');
    mockReadFileSync.mockReturnValue(written);
    mockWriteFileSync.mockClear();
    expect(claudeSettingsService.getNotificationUpdate()).toBeUndefined();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    const partial = JSON.parse(written);
    delete partial.hooks.Notification;
    mockReadFileSync.mockReturnValue(JSON.stringify(partial));
    expect(claudeSettingsService.getNotificationUpdate()).toBeDefined();
  });

  it('offers an update for an install without the PreToolUse hook', async () => {
    const { claudeSettingsService } = await import('../../../src/main/services/claude-settings.service');
    claudeSettingsService.enableNotificationHook();
    const installed = JSON.parse(mockWriteFileSync.mock.calls.at(-1)![1] as string);
    delete installed.hooks.PreToolUse;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(installed));

    expect(claudeSettingsService.getNotificationUpdate()).toBeDefined();
  });

  it('adds the turn-end hooks only for a Claude known to accept them', async () => {
    const { claudeSettingsService } = await import('../../../src/main/services/claude-settings.service');
    const written = () => JSON.parse(mockWriteFileSync.mock.calls.at(-1)![1] as string);
    for (const version of [undefined, '2.1.77']) {
      claudeSettingsService.enableNotificationHook(version);
      expect(Object.keys(written().hooks).sort()).toEqual(['Notification', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
      expect(JSON.parse(claudeSettingsService.getNotificationConfigJson(version)).hooks.StopFailure).toBeUndefined();
    }

    claudeSettingsService.enableNotificationHook('2.1.78');
    const installed = written();
    expect(installed.hooks.StopFailure[0].hooks[0].command).toContain('--event StopFailure');
    expect(installed.hooks.PostCompact[0].hooks[0].command).toContain('--event PostCompact');
    expect(installed.hooks.SessionEnd[0].hooks[0]).toMatchObject({ async: true });
    expect(JSON.parse(claudeSettingsService.getNotificationConfigJson('2.1.296')).hooks.SessionEnd).toHaveLength(1);
  });

  it('offers the turn-end hooks as an update once Claude accepts them, and removes them on disable', async () => {
    const { claudeSettingsService } = await import('../../../src/main/services/claude-settings.service');
    claudeSettingsService.enableNotificationHook(undefined);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(mockWriteFileSync.mock.calls.at(-1)![1] as string);
    expect(claudeSettingsService.getNotificationUpdate(undefined)).toBeUndefined();
    expect(claudeSettingsService.getNotificationUpdate('2.1.296')?.files[0].description).toContain('StopFailure, PostCompact, SessionEnd');

    claudeSettingsService.enableNotificationHook('2.1.296');
    mockReadFileSync.mockReturnValue(mockWriteFileSync.mock.calls.at(-1)![1] as string);
    expect(claudeSettingsService.getNotificationUpdate('2.1.296')).toBeUndefined();
    claudeSettingsService.disableNotificationHook();
    expect(JSON.parse(mockWriteFileSync.mock.calls.at(-1)![1] as string).hooks).toBeUndefined();
  });

  it('removes the turn-end hooks for a Claude known to be older, and keeps them when the version is unknown', async () => {
    const { claudeSettingsService } = await import('../../../src/main/services/claude-settings.service');
    const written = () => mockWriteFileSync.mock.calls.at(-1)![1] as string;
    claudeSettingsService.enableNotificationHook('2.1.296');
    const installed = JSON.parse(written());
    // Written by an older Komla whose CLI lived elsewhere.
    installed.hooks.SessionEnd[0].hooks[0].command = '"/old/komla" notify --source claude-code --event SessionEnd # komla-notification-hook';
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(installed));

    // Without a version, the hooks were written for a Claude that took them: kept, and kept current.
    expect(claudeSettingsService.getNotificationUpdate(undefined)).toBeDefined();
    claudeSettingsService.enableNotificationHook(undefined);
    const kept = JSON.parse(written());
    expect(Object.keys(kept.hooks)).toHaveLength(10);
    expect(kept.hooks.SessionEnd[0].hooks[0].command).not.toContain('/old/komla');
    mockReadFileSync.mockReturnValue(written());
    expect(claudeSettingsService.getNotificationUpdate(undefined)).toBeUndefined();

    // A downgraded Claude discards the whole file over these events, even with no hooks left in them.
    expect(claudeSettingsService.getNotificationUpdate('2.1.50')?.files[0].description).toContain('removing StopFailure, PostCompact, SessionEnd');
    claudeSettingsService.enableNotificationHook('2.1.50');
    expect(Object.keys(JSON.parse(written()).hooks).sort()).toEqual(['Notification', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  });

  it('reads the Claude version through the interactive login shell the terminals start, ignoring shell noise', async () => {
    mockExec.mockImplementation(((_cmd: string, _opts: unknown, callback: (error: Error | null, stdout: string) => void) => {
      callback(null, 'Welcome back!\n2.1.296 (Claude Code)\n');
      return {} as never;
    }) as typeof exec);
    const { claudeSettingsService } = await import('../../../src/main/services/claude-settings.service');

    await expect(claudeSettingsService.getClaudeVersion()).resolves.toBe('2.1.296');
    expect(mockExec.mock.calls[0][0]).toContain('claude --version');
    if (process.platform !== 'win32') expect(mockExec.mock.calls[0][0]).toContain(' -ilc ');
    // Settings ask on every open; the answer is reused for a while.
    await expect(claudeSettingsService.getClaudeVersion()).resolves.toBe('2.1.296');
    expect(mockExec).toHaveBeenCalledTimes(1);

    mockExec.mockImplementation(((_cmd: string, _opts: unknown, callback: (error: Error | null, stdout: string) => void) => {
      callback(new Error('command not found: claude'), '');
      return {} as never;
    }) as typeof exec);
    await expect(claudeSettingsService.getClaudeVersion({ fresh: true })).resolves.toBeUndefined();
  });

  it('does not offer updates for absent, unrelated or malformed settings', async () => {
    const { claudeSettingsService } = await import('../../../src/main/services/claude-settings.service');
    expect(claudeSettingsService.getNotificationUpdate()).toBeUndefined();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: 'command', command: 'my-hook' }] }] } }));
    expect(claudeSettingsService.getNotificationUpdate()).toBeUndefined();
    mockReadFileSync.mockReturnValue('{invalid');
    expect(claudeSettingsService.getNotificationUpdate()).toBeUndefined();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockExistsSync.mockReturnValue(false);
    // Like the real fs, reading a file the test reports as missing fails with ENOENT.
    mockReadFileSync.mockImplementation((path) => {
      if (mockExistsSync(path)) return '';
      throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: 'ENOENT' });
    });
  });

  it('routes hooks through notify.js, and offers that as an update, once Windows blocks the CLI', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const { claudeSettingsService } =
        await import('../../../src/main/services/claude-settings.service');
      const { probeKomlaCli } = await import('../../../src/main/lib/komla-cli');
      mockExistsSync.mockReturnValue(true);
      claudeSettingsService.enableNotificationHook();
      mockReadFileSync.mockReturnValue(mockWriteFileSync.mock.calls.at(-1)![1] as string);
      expect(claudeSettingsService.getNotificationUpdate()).toBeUndefined();

      vi.mocked(execFile).mockImplementationOnce(refusingExecFile());
      expect(probeKomlaCli('C:\\Users\\dev\\.komla\\bin\\komla.exe')).toBe(true);

      expect(claudeSettingsService.getHookCommand()).toBe(
        '"/mock/home/.komla/komla-node.cmd" "/mock/home/.komla/notify.js" --source claude-code --event Notification # komla-notification-hook'
      );
      expect(claudeSettingsService.getNotificationUpdate()?.files[0].description).toContain(
        'They run notify.js, because Windows blocks the Komla CLI on this computer.'
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('enables notification hook and creates settings directory when missing', async () => {
    const { claudeSettingsService } =
      await import('../../../src/main/services/claude-settings.service');

    claudeSettingsService.enableNotificationHook();

    expect(mockMkdirSync).toHaveBeenCalledWith(join('/mock/home/.claude'), { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledOnce();

    const [settingsPath, writtenSettings] = mockWriteFileSync.mock.calls[0] as [string, string];
    const parsed = JSON.parse(writtenSettings);

    expect(settingsPath).toBe(join('/mock/home/.claude/settings.json'));
    expect(parsed.hooks.Notification).toHaveLength(1);
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain('--event PreToolUse');
    expect(parsed.hooks.Notification[0].hooks[0].type).toBe('command');
    expect(parsed.hooks.Notification[0].hooks[0].async).toBe(true);
    expect(parsed.hooks.Notification[0].hooks[0].command).toContain('/bin/komla');
    expect(parsed.hooks.Notification[0].hooks[0].command).toContain(' notify ');
    expect(parsed.hooks.Notification[0].hooks[0].command).toContain('--source claude-code');
    expect(parsed.hooks.Notification[0].hooks[0].command).toContain('--event Notification');
    expect(parsed.hooks.Notification[0].hooks[0].command).toContain('komla-notification-hook');
    expect(parsed.hooks.Notification[0].hooks[0].command).not.toContain('notify.js');
    expect(parsed.hooks.Notification[0].matcher).toBe('');
    expect(parsed.hooks.Stop[0].hooks[0].type).toBe('command');
    expect(parsed.hooks.Stop[0].hooks[0].async).toBe(true);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('/bin/komla');
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('--event Stop');
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].type).toBe('command');
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].async).toBe(true);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain('/bin/komla');
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain('--event UserPromptSubmit');
  });

  it('updates existing managed notification hook instead of duplicating', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        hooks: {
          Notification: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'curl http://localhost:52863/notify # komla-notification-hook',
                },
              ],
            },
            {
              matcher: 'other',
              hooks: [{ type: 'command', command: 'echo untouched' }],
            },
          ],
        },
      })
    );

    const { claudeSettingsService } =
      await import('../../../src/main/services/claude-settings.service');

    claudeSettingsService.enableNotificationHook();

    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(parsed.hooks.Notification).toHaveLength(2);
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Notification[0].hooks[0].command).toContain('/bin/komla');
    expect(parsed.hooks.Notification[0].hooks[0].command).toContain('--source claude-code');
    expect(parsed.hooks.Notification[0].hooks[0].async).toBe(true);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('/bin/komla');
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('--event Stop');
    expect(parsed.hooks.Stop[0].hooks[0].async).toBe(true);
    expect(parsed.hooks.Notification[1].hooks[0].command).toBe('echo untouched');
  });

  it('disables notification hook and removes empty hooks object', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        hooks: {
          Notification: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'curl http://localhost:52863/notify # komla-notification-hook',
                },
              ],
            },
          ],
          Stop: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'curl http://localhost:52863/notify # komla-notification-hook',
                },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'curl http://localhost:52863/notify # komla-notification-hook',
                },
              ],
            },
          ],
        },
      })
    );

    const { claudeSettingsService } =
      await import('../../../src/main/services/claude-settings.service');

    claudeSettingsService.disableNotificationHook();

    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(parsed.hooks).toBeUndefined();
  });

  it('checks MCP configuration via ~/.claude.json first (fast path)', async () => {
    mockExistsSync.mockImplementation((path) => path === join('/mock/home/.claude.json'));
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          komla: {
            type: 'http',
            url: 'http://localhost:52863/api/v1/mcp',
          },
        },
      })
    );

    const { claudeSettingsService } =
      await import('../../../src/main/services/claude-settings.service');

    await expect(claudeSettingsService.isMcpServerConfigured()).resolves.toBe(true);
    // Should not call CLI when found in ~/.claude.json
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('falls back to CLI when ~/.claude.json has no MCP config', async () => {
    mockExec.mockImplementation(((
      _cmd: string,
      _opts: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => {
      callback(null, 'komla: http://localhost:52863/api/v1/mcp (HTTP)');
      return {} as never;
    }) as typeof exec);

    const { claudeSettingsService } =
      await import('../../../src/main/services/claude-settings.service');

    await expect(claudeSettingsService.isMcpServerConfigured()).resolves.toBe(true);
    expect(mockExec).toHaveBeenCalledOnce();
    expect(mockExec.mock.calls[0][0]).toContain('claude mcp list');
  });

  it.each(['{"projects": {},}', '[]', 'null'])(
    'never overwrites a ~/.claude.json or settings.json containing %s',
    async (contents) => {
      const { claudeSettingsService } =
        await import('../../../src/main/services/claude-settings.service');
      const claudeJsonPath = join('/mock/home', '.claude.json');
      const settingsPath = join('/mock/home', '.claude', 'settings.json');
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(contents);

      expect(claudeSettingsService.enableMcpServer(52863)).toMatchObject({
        success: false,
        error: expect.stringContaining(claudeJsonPath),
      });
      expect(claudeSettingsService.disableMcpServer().success).toBe(false);
      expect(() => claudeSettingsService.enableNotificationHook()).toThrow(settingsPath);
      expect(() => claudeSettingsService.disableNotificationHook()).toThrow(settingsPath);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(claudeSettingsService.isMcpServerInConfig()).toBe(false);
      expect(claudeSettingsService.isNotificationHookEnabled()).toBe(false);
    }
  );

  it('treats a blank ~/.claude.json as empty when adding the MCP server', async () => {
    const { claudeSettingsService } =
      await import('../../../src/main/services/claude-settings.service');
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('');

    expect(claudeSettingsService.enableMcpServer(52863)).toEqual({ success: true });

    const [path, written] = mockWriteFileSync.mock.calls[0] as [string, string];
    expect(path).toBe(join('/mock/home', '.claude.json'));
    expect(JSON.parse(written)).toEqual({
      mcpServers: { komla: { type: 'http', url: 'http://localhost:52863/api/v1/mcp' } },
    });
  });

  it('returns failure for MCP enable when write fails', async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });

    const { claudeSettingsService } =
      await import('../../../src/main/services/claude-settings.service');

    const result = claudeSettingsService.enableMcpServer(52863);

    expect(result.success).toBe(false);
    expect(result.error).toContain('disk full');
  });
});
