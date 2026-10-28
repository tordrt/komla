import { execFile } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refusingExecFile } from '../../helpers/windows-refusal';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const paths = vi.hoisted(() => ({ komlaBase: '/mock/home/.komla' }));

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => paths.komlaBase,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/home'),
  },
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const originalPlatform = process.platform;
const hooksPath = join('/mock/home', '.gemini', 'config', 'hooks.json');
const mcpPath = join('/mock/home', '.gemini', 'config', 'mcp_config.json');
const settingsPath = join('/mock/home', '.gemini', 'antigravity-cli', 'settings.json');

let files: Map<string, string>;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function writtenJson(path: string): Record<string, any> {
  const call = mockWriteFileSync.mock.calls.findLast(([target]) => target === path);
  expect(call).toBeDefined();
  return JSON.parse(call![1] as string);
}

async function loadService() {
  const { antigravitySettingsService } =
    await import('../../../src/main/services/antigravity-settings.service');
  return antigravitySettingsService;
}

describe('AntigravitySettingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    paths.komlaBase = '/mock/home/.komla';
    files = new Map();
    // Like the real fs, a missing file fails with ENOENT and writes are readable afterwards.
    mockReadFileSync.mockImplementation((path) => {
      const content = files.get(String(path));
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: 'ENOENT' });
      }
      return content;
    });
    mockWriteFileSync.mockImplementation((path, content) => {
      files.set(String(path), String(content));
    });
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('writes a komla hook set for model calls, tool results and stops', async () => {
    const service = await loadService();

    service.enableNotificationHook();

    const { komla } = writtenJson(hooksPath);
    expect(Object.keys(komla)).toEqual(['PreInvocation', 'PostToolUse', 'Stop']);
    expect(komla.PreInvocation).toEqual([
      { type: 'command', command: expect.stringContaining('--event PreInvocation') },
    ]);
    expect(komla.PostToolUse).toEqual([
      {
        matcher: '*',
        hooks: [{ type: 'command', command: expect.stringContaining('--event PostToolUse') }],
      },
    ]);
    expect(komla.Stop[0].command).toMatch(
      /\/bin\/komla" notify --source antigravity --event Stop$/
    );
    expect(JSON.parse(service.getNotificationConfigJson())).toEqual({ komla });
    expect(service.isNotificationHookEnabled()).toBe(true);
    expect(service.getNotificationUpdate()).toBeUndefined();
  });

  it('keeps other hook sets when enabling and disabling', async () => {
    const lint = { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: './lint.sh' }] }] };
    files.set(hooksPath, JSON.stringify({ lint }));
    const service = await loadService();

    service.enableNotificationHook();
    expect(writtenJson(hooksPath).lint).toEqual(lint);

    service.disableNotificationHook();
    expect(writtenJson(hooksPath)).toEqual({ lint });
    expect(service.isNotificationHookEnabled()).toBe(false);
  });

  it("turns on Antigravity's terminal alerts and keeps its other settings", async () => {
    files.set(settingsPath, JSON.stringify({ trustedWorkspaces: ['/work'] }));
    const service = await loadService();

    service.enableNotificationHook();

    expect(writtenJson(settingsPath)).toEqual({
      trustedWorkspaces: ['/work'],
      notifications: true,
    });
  });

  it('leaves the terminal alerts on when disabling', async () => {
    const service = await loadService();
    service.enableNotificationHook();
    mockWriteFileSync.mockClear();

    service.disableNotificationHook();

    expect(mockWriteFileSync.mock.calls.map(([path]) => path)).toEqual([hooksPath]);
    expect(JSON.parse(files.get(settingsPath)!)).toEqual({ notifications: true });
  });

  it('offers an update that turns the terminal alerts back on', async () => {
    const service = await loadService();
    service.enableNotificationHook();
    files.set(settingsPath, JSON.stringify({ notifications: false }));

    expect(service.getNotificationUpdate()?.files.map(({ path }) => path)).toEqual([settingsPath]);
  });

  it('never overwrites unparseable Antigravity settings', async () => {
    files.set(settingsPath, '{"notifications": false,}');
    const service = await loadService();

    expect(() => service.enableNotificationHook()).toThrow(settingsPath);
    expect(mockWriteFileSync.mock.calls.map(([path]) => path)).not.toContain(settingsPath);
  });

  it('does not write when disabling without a komla hook set', async () => {
    files.set(hooksPath, JSON.stringify({ lint: {} }));
    const service = await loadService();

    service.disableNotificationHook();

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('reports a hook set turned off in Antigravity as not configured', async () => {
    const service = await loadService();
    service.enableNotificationHook();
    const config = writtenJson(hooksPath);
    files.set(hooksPath, JSON.stringify({ komla: { ...config.komla, enabled: false } }));

    expect(service.isNotificationHookEnabled()).toBe(false);
  });

  it('reads an empty komla hook set as not configured', async () => {
    files.set(hooksPath, JSON.stringify({ komla: {} }));
    const service = await loadService();

    expect(service.isNotificationHookEnabled()).toBe(false);
  });

  it('offers an update for an outdated komla hook set without writing', async () => {
    files.set(
      hooksPath,
      JSON.stringify({ komla: { Stop: [{ type: 'command', command: 'old-komla notify' }] } })
    );
    const service = await loadService();

    expect(service.getNotificationUpdate()?.files[0].path).toBe(hooksPath);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('does not offer updates for absent, unrelated or malformed hook files', async () => {
    const service = await loadService();
    expect(service.getNotificationUpdate()).toBeUndefined();

    files.set(hooksPath, JSON.stringify({ lint: { Stop: [{ command: './check.sh' }] } }));
    expect(service.getNotificationUpdate()).toBeUndefined();

    files.set(hooksPath, '{invalid');
    expect(service.getNotificationUpdate()).toBeUndefined();
    expect(service.isNotificationHookEnabled()).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('runs the CLI directly on Windows when cmd needs no quoting for its path', async () => {
    setPlatform('win32');
    paths.komlaBase = 'C:\\Users\\dev\\.komla';
    const service = await loadService();

    expect(service.getHookCommand()).toBe(
      `${join('C:\\Users\\dev\\.komla', 'bin', 'komla.exe')} notify --source antigravity --event Stop`
    );
  });

  it('runs hooks through an encoded PowerShell command when the Windows path needs quoting', async () => {
    setPlatform('win32');
    paths.komlaBase = 'C:\\Users\\Jane Doe\\.komla';
    const service = await loadService();

    const command = service.getHookCommand();

    const match = command.match(
      /^powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/
    );
    expect(match).not.toBeNull();
    expect(Buffer.from(match![1], 'base64').toString('utf16le')).toBe(
      "& 'C:/Users/Jane Doe/.komla/bin/komla.exe' notify --source antigravity --event Stop"
    );
  });

  it('runs notify.js once Windows blocks the CLI, and offers that as an update', async () => {
    setPlatform('win32');
    paths.komlaBase = 'C:\\Users\\dev\\.komla';
    const service = await loadService();
    const { probeKomlaCli } = await import('../../../src/main/lib/komla-cli');
    files.set(hooksPath, service.getNotificationConfigJson());
    files.set(settingsPath, JSON.stringify({ notifications: true }));
    expect(service.getNotificationUpdate()).toBeUndefined();

    vi.mocked(execFile).mockImplementationOnce(refusingExecFile());
    expect(probeKomlaCli('/missing/komla.exe')).toBe(true);

    expect(service.getHookCommand()).toBe(
      `${join('C:\\Users\\dev\\.komla', 'komla-node.cmd')} ${join('C:\\Users\\dev\\.komla', 'notify.js')} --source antigravity --event Stop`
    );
    expect(service.getNotificationUpdate()?.files[0].description).toContain(
      'They run notify.js, because Windows blocks the Komla CLI on this computer.'
    );
  });

  it('quotes notify.js in an encoded PowerShell command when the Windows path needs it', async () => {
    setPlatform('win32');
    paths.komlaBase = 'C:\\Users\\Jane Doe\\.komla';
    const service = await loadService();
    const { probeKomlaCli } = await import('../../../src/main/lib/komla-cli');
    vi.mocked(execFile).mockImplementationOnce(refusingExecFile());
    probeKomlaCli('/missing/komla.exe');

    const encoded = service.getHookCommand().split(' ').at(-1)!;
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(
      "& 'C:/Users/Jane Doe/.komla/komla-node.cmd' 'C:/Users/Jane Doe/.komla/notify.js' --source antigravity --event Stop"
    );
  });

  it('builds agy MCP add and remove commands', async () => {
    const service = await loadService();

    expect(service.getMcpCliCommand(52863)).toBe(
      'agy mcp add komla http://localhost:52863/api/v1/mcp'
    );
    expect(service.getMcpRemoveCliCommand()).toBe('agy mcp remove komla');
  });

  it('adds and removes the komla MCP server and keeps other servers', async () => {
    const other = { serverUrl: 'https://example.com/mcp' };
    files.set(mcpPath, JSON.stringify({ mcpServers: { other } }));
    const service = await loadService();

    expect(service.enableMcpServer(52863)).toEqual({ success: true });
    expect(writtenJson(mcpPath).mcpServers).toEqual({
      other,
      komla: { serverUrl: 'http://localhost:52863/api/v1/mcp' },
    });
    expect(service.getMcpStatus().isConfigured).toBe(true);

    expect(service.disableMcpServer()).toEqual({ success: true });
    expect(writtenJson(mcpPath)).toEqual({ mcpServers: { other } });
    expect(service.getMcpStatus().isConfigured).toBe(false);
  });

  it('drops an empty mcpServers object after removing komla', async () => {
    files.set(mcpPath, JSON.stringify({ mcpServers: { komla: { serverUrl: 'x' } } }));
    const service = await loadService();

    service.disableMcpServer();

    expect(writtenJson(mcpPath)).toEqual({});
  });

  it('reports an MCP server disabled in Antigravity as not configured', async () => {
    files.set(
      mcpPath,
      JSON.stringify({ mcpServers: { komla: { serverUrl: 'x', disabled: true } } })
    );
    const service = await loadService();

    expect(service.getMcpStatus().isConfigured).toBe(false);
  });

  it('never overwrites unparseable config files', async () => {
    files.set(hooksPath, '{"lint": {},}');
    files.set(mcpPath, '{"mcpServers": {},}');
    const service = await loadService();

    expect(() => service.enableNotificationHook()).toThrow(hooksPath);
    expect(() => service.disableNotificationHook()).toThrow(hooksPath);
    expect(service.enableMcpServer(52863).error).toContain(mcpPath);
    expect(service.disableMcpServer().success).toBe(false);
    expect(service.getMcpStatus().isConfigured).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});
