import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refusingExecFile } from '../../helpers/windows-refusal';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: vi.fn(),
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('../../../src/main/lib/wsl', () => ({
  isWslMode: vi.fn(() => false),
}));

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => '/mock/home/.komla',
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const _mockMkdirSync = vi.mocked(mkdirSync);
const originalPlatform = process.platform;

describe('CodexSettingsService', () => {
  function normalizeSlashes(value: string): string {
    return value.replace(/\\/g, '/');
  }

  /** Return the last write to hooks.json */
  function lastHooksWrite(): string | undefined {
    const calls = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('hooks.json')
    );
    return calls.length > 0 ? (calls[calls.length - 1][1] as string) : undefined;
  }

  /** Return the last write to config.toml */
  function lastSettingsWrite(): string | undefined {
    const calls = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('config.toml')
    );
    return calls.length > 0 ? (calls[calls.length - 1][1] as string) : undefined;
  }

  /** Mock file reads to return different content for hooks.json vs config.toml */
  function mockFiles(opts: { hooks?: string; settings?: string }): void {
    mockExistsSync.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith('hooks.json')) return opts.hooks !== undefined;
      if (p.endsWith('config.toml')) return opts.settings !== undefined;
      return false;
    });
    mockReadFileSync.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith('hooks.json')) return opts.hooks ?? '';
      if (p.endsWith('config.toml')) return opts.settings ?? '';
      return '';
    });
  }

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

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

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('preserves unrelated hooks sharing a matcher when explicitly updating', async () => {
    mockFiles({ hooks: JSON.stringify({ hooks: { Stop: [{ hooks: [
      { type: 'command', command: 'old # komla-notification-hook' },
      { type: 'command', command: 'my-own-hook' },
    ] }] } }) });
    const { codexSettingsService } = await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();
    expect(lastHooksWrite()).toContain('my-own-hook');
  });

  it('recognizes current hooks and detects missing events or feature flags without writing', async () => {
    const { codexSettingsService } = await import('../../../src/main/services/codex-settings.service');
    mockFiles({});
    codexSettingsService.enableNotificationHook();
    const hooks = lastHooksWrite()!;
    const settings = lastSettingsWrite()!;
    mockWriteFileSync.mockClear();
    mockFiles({ hooks, settings });
    expect(codexSettingsService.getNotificationUpdate()).toBeUndefined();
    mockFiles({ hooks, settings: '[features]\ncodex_hooks = true\n' });
    expect(codexSettingsService.getNotificationUpdate()).toBeDefined();
    const partial = JSON.parse(hooks);
    delete partial.hooks.Stop;
    mockFiles({ hooks: JSON.stringify(partial), settings });
    expect(codexSettingsService.getNotificationUpdate()).toBeDefined();
    mockFiles({ hooks: '{invalid', settings });
    expect(codexSettingsService.getNotificationUpdate()).toBeUndefined();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  // ── Status ──

  it('should report not configured when hooks.json does not exist', async () => {
    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');

    const status = codexSettingsService.getNotificationStatus();

    expect(status.isConfigured).toBe(false);
    expect(status.hasConflict).toBe(false);
    expect(status.canAutoConfigure).toBe(true);
  });

  it('should report a partial managed notification hook as Komla-managed but not configured', async () => {
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'some-cmd # komla-notification-hook' }] }],
        },
      }),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    const status = codexSettingsService.getNotificationStatus();

    expect(status.isConfigured).toBe(false);
    expect(status.isKomlaManaged).toBe(true);
  });

  // ── Malformed hooks.json ──

  it('should report conflict when hooks.json is malformed', async () => {
    mockFiles({ hooks: '{ not valid json !!!' });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    const status = codexSettingsService.getNotificationStatus();

    expect(status.isConfigured).toBe(false);
    expect(status.hasConflict).toBe(true);
    expect(status.canAutoConfigure).toBe(false);
    expect(status.conflictMessage).toContain('hooks.json');
  });

  it('should throw when enabling with malformed hooks.json', async () => {
    mockFiles({ hooks: '{ not valid json !!!', settings: '' });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');

    expect(() => codexSettingsService.enableNotificationHook()).toThrow();

    // Must not write hooks.json — would overwrite the user's file
    const hooksWrites = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('hooks.json')
    );
    expect(hooksWrites).toHaveLength(0);
  });

  it('should not throw or write hooks.json when disabling with malformed hooks.json', async () => {
    mockFiles({ hooks: '{ not valid json !!!' });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');

    // Should not throw — disable is a best-effort cleanup
    expect(() => codexSettingsService.disableNotificationHook()).not.toThrow();

    // Must not write hooks.json
    const hooksWrites = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('hooks.json')
    );
    expect(hooksWrites).toHaveLength(0);
  });

  // ── Enable ──

  it('should enable notifications by writing hooks to hooks.json', async () => {
    mockFiles({ settings: '' });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastHooksWrite();
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.PermissionRequest).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('komla-notification-hook');
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('--source codex');
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain('--event Stop');
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain('--event UserPromptSubmit');
    expect(parsed.hooks.PermissionRequest[0].hooks[0].command).toContain(
      '--event PermissionRequest'
    );
  });

  it('should add PowerShell-safe Windows commands when enabling notifications on Windows', async () => {
    setPlatform('win32');
    mockFiles({ settings: '' });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastHooksWrite();
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    const stopHook = parsed.hooks.Stop[0].hooks[0];

    expect(normalizeSlashes(stopHook.command)).toContain('/bin/komla.exe');
    expect(stopHook.commandWindows).toContain('powershell.exe -NoProfile');
    expect(stopHook.commandWindows).toContain("& '/mock/home/.komla/bin/komla.exe'");
    expect(stopHook.commandWindows).not.toContain('notify.js');
    expect(stopHook.commandWindows).toContain('--source codex');
    expect(stopHook.commandWindows).toContain('--event Stop');
    expect(stopHook.commandWindows).toContain('komla-notification-hook');
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].commandWindows).toContain(
      '--event UserPromptSubmit'
    );
    expect(parsed.hooks.PermissionRequest[0].hooks[0].commandWindows).toContain(
      '--event PermissionRequest'
    );
  });

  it('runs notify.js through PowerShell when Windows blocks the CLI', async () => {
    setPlatform('win32');
    mockFiles({ settings: '' });
    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    const { probeKomlaCli } = await import('../../../src/main/lib/komla-cli');
    vi.mocked(execFile).mockImplementationOnce(refusingExecFile());
    expect(probeKomlaCli('/missing/komla.exe')).toBe(true);

    codexSettingsService.enableNotificationHook();

    const stopHook = JSON.parse(lastHooksWrite()!).hooks.Stop[0].hooks[0];
    expect(stopHook.command).toBe(
      '"/mock/home/.komla/komla-node.cmd" "/mock/home/.komla/notify.js" --source codex --event Stop # komla-notification-hook'
    );
    expect(stopHook.commandWindows).toBe(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ${JSON.stringify(
        "& '/mock/home/.komla/komla-node.cmd' '/mock/home/.komla/notify.js' --source codex --event Stop # komla-notification-hook"
      )}`
    );
  });

  it('should enable the hooks feature flag in config.toml', async () => {
    mockFiles({ settings: 'model = "gpt-5"\n' });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('[features]');
    expect(written).toContain('hooks = true');
    expect(written).not.toContain('codex_hooks');
    expect(written).toContain('model = "gpt-5"');
  });

  it('should add feature flag under existing [features] section', async () => {
    mockFiles({
      settings: ['model = "gpt-5"', '', '[features]', 'other_flag = true'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('hooks = true');
    expect(written).not.toContain('codex_hooks');
    expect(written).toContain('other_flag = true');
    // Should not add a second [features] section
    expect(written!.match(/\[features\]/g)).toHaveLength(1);
  });

  it('should not duplicate feature flag if already present', async () => {
    mockFiles({
      settings: ['[features]', 'hooks = true'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    // Should still write hooks.json but not re-write config.toml for feature flag
    const settingsWrites = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('config.toml')
    );
    expect(settingsWrites).toHaveLength(0);
  });

  it('should migrate the deprecated codex_hooks feature flag', async () => {
    mockFiles({
      settings: ['[features]', 'codex_hooks = true'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('hooks = true');
    expect(written).not.toContain('codex_hooks');
  });

  it('should preserve the inline comment when migrating codex_hooks=true', async () => {
    mockFiles({
      settings: ['[features]', 'codex_hooks = true # user enabled it'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('hooks = true # user enabled it');
    expect(written).not.toContain('codex_hooks');
  });

  it('should preserve the inline comment when migrating codex_hooks=true with remaining hooks on disable', async () => {
    // disable path with non-Komla hooks remaining → ensureHooksFeatureFlag(forceEnable=false)
    // must migrate codex_hooks=true (with comment) to hooks=true (with comment).
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }],
        },
      }),
      settings: ['[features]', 'codex_hooks = true # user enabled it'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.disableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('hooks = true # user enabled it');
    expect(written).not.toContain('codex_hooks');
  });

  it('should update existing hooks feature flag with an inline comment', async () => {
    mockFiles({
      settings: ['[features]', 'hooks = false # user disabled it'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('hooks = true # user disabled it');
    expect(written!.match(/^\s*hooks\s*=/gm)).toHaveLength(1);
  });

  it('should update hooks after another feature without duplicating it', async () => {
    mockFiles({
      settings: ['[features]', 'other_flag = true', 'hooks = false'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('other_flag = true');
    expect(written).toContain('hooks = true');
    expect(written!.match(/^\s*hooks\s*=/gm)).toHaveLength(1);
    expect(written!.match(/\[features\]/g)).toHaveLength(1);
  });

  it('should use an empty [features] section at EOF instead of duplicating it', async () => {
    mockFiles({
      settings: '[features]',
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBe('[features]\nhooks = true\n');
    expect(written!.match(/\[features\]/g)).toHaveLength(1);
  });

  it('should keep the next table separate when empty [features] precedes it', async () => {
    mockFiles({
      settings: [
        '[features]',
        '',
        '[mcp_servers.komla]',
        'url = "http://localhost:52863/mcp"',
      ].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBe(
      [
        '[features]',
        'hooks = true',
        '',
        '[mcp_servers.komla]',
        'url = "http://localhost:52863/mcp"',
      ].join('\n') + '\n'
    );
    expect(written!.match(/\[features\]/g)).toHaveLength(1);
    expect(written!.match(/^\s*hooks\s*=/gm)).toHaveLength(1);
  });

  it('should keep an adjacent next table separate when empty [features] precedes it', async () => {
    mockFiles({
      settings: ['[features]', '[mcp_servers.komla]', 'url = "http://localhost:52863/mcp"'].join(
        '\n'
      ),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBe(
      [
        '[features]',
        'hooks = true',
        '',
        '[mcp_servers.komla]',
        'url = "http://localhost:52863/mcp"',
      ].join('\n') + '\n'
    );
    expect(written!.match(/\[features\]/g)).toHaveLength(1);
    expect(written!.match(/^\s*hooks\s*=/gm)).toHaveLength(1);
  });

  it('should insert feature flag before first table section', async () => {
    mockFiles({
      settings: ['[mcp_servers.komla]', 'url = "http://localhost:52863/mcp"'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    const featuresIndex = written!.indexOf('[features]');
    const mcpIndex = written!.indexOf('[mcp_servers.komla]');
    expect(featuresIndex).toBeGreaterThan(-1);
    expect(mcpIndex).toBeGreaterThan(-1);
    expect(featuresIndex).toBeLessThan(mcpIndex);
  });

  it('should replace existing managed hooks when re-enabling', async () => {
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'old-cmd # komla-notification-hook' }] }],
        },
      }),
      settings: ['[features]', 'hooks = true'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastHooksWrite();
    const parsed = JSON.parse(written!);
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).not.toContain('old-cmd');
    expect(normalizeSlashes(parsed.hooks.Stop[0].hooks[0].command)).toContain('/bin/komla');
    // Other notification events should also be added
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.PermissionRequest).toHaveLength(1);
  });

  it('should preserve other hooks in hooks.json when enabling', async () => {
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }],
        },
      }),
      settings: '',
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    const written = lastHooksWrite();
    const parsed = JSON.parse(written!);
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('user-hook');
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.PermissionRequest).toHaveLength(1);
  });

  // ── Disable ──

  it('should disable notifications by removing hooks from hooks.json', async () => {
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
          PermissionRequest: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
        },
      }),
      settings: ['[features]', 'hooks = true'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.disableNotificationHook();

    const written = lastHooksWrite();
    const parsed = JSON.parse(written!);
    expect(parsed.hooks).toBeUndefined();
  });

  it('should preserve other hooks and feature flag when disabling', async () => {
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }],
        },
      }),
      settings: ['model = "gpt-5"', '', '[features]', 'hooks = true'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.disableNotificationHook();

    const written = lastHooksWrite();
    const parsed = JSON.parse(written!);
    expect(parsed.hooks.Stop).toBeUndefined();
    expect(parsed.hooks.UserPromptSubmit).toBeUndefined();
    expect(parsed.hooks.PermissionRequest).toBeUndefined();
    expect(parsed.hooks.PreToolUse).toHaveLength(1);

    // Feature flag should NOT be removed — user's hooks still need it
    const settingsWrites = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('config.toml')
    );
    expect(settingsWrites).toHaveLength(0);
  });

  it('should not force hooks on when disabling with other hooks and hooks explicitly false', async () => {
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }],
        },
      }),
      settings: ['[features]', 'hooks = false # user disabled it'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.disableNotificationHook();

    const hooksWrite = lastHooksWrite();
    const parsed = JSON.parse(hooksWrite!);
    expect(parsed.hooks.Stop).toBeUndefined();
    expect(parsed.hooks.UserPromptSubmit).toBeUndefined();
    expect(parsed.hooks.PermissionRequest).toBeUndefined();
    expect(parsed.hooks.PreToolUse).toHaveLength(1);

    const settingsWrites = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('config.toml')
    );
    expect(settingsWrites).toHaveLength(0);
  });

  it('should migrate deprecated false hooks flag without enabling hooks when disabling', async () => {
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }],
        },
      }),
      settings: ['[features]', 'codex_hooks = false # user disabled it'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.disableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('hooks = false # user disabled it');
    expect(written).not.toContain('codex_hooks');
  });

  it('should remove feature flag when no hooks remain after disabling', async () => {
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
          PermissionRequest: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
        },
      }),
      settings: ['model = "gpt-5"', '', '[features]', 'hooks = true'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.disableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('model = "gpt-5"');
    expect(written).not.toContain('hooks = true');
    expect(written).not.toContain('codex_hooks');
  });

  it('should not write hooks.json if not configured when disabling', async () => {
    mockFiles({ settings: '' });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.disableNotificationHook();

    const hooksWrites = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('hooks.json')
    );
    expect(hooksWrites).toHaveLength(0);
  });

  it('should not synthesize hooks=true when disabling with other hooks and no [features] section', async () => {
    // User had a non-Komla hook + Komla hooks, but config.toml has no
    // [features] section. After Komla disable, the section should NOT be
    // created — Komla must not silently flip the user's flag from absent to
    // enabled.
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }],
        },
      }),
      settings: 'model = "gpt-5"\n',
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.disableNotificationHook();

    const settingsWrites = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('config.toml')
    );
    expect(settingsWrites).toHaveLength(0);
  });

  it('should not synthesize hooks=true when disabling with other hooks and [features] section without flag', async () => {
    // Same as above but [features] section exists with an unrelated flag.
    // Komla must not append `hooks = true`.
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }],
        },
      }),
      settings: ['[features]', 'other_flag = true'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.disableNotificationHook();

    const settingsWrites = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('config.toml')
    );
    expect(settingsWrites).toHaveLength(0);
  });

  it('should preserve codex_hooks=false by migrating to hooks=false when no hooks remain', async () => {
    // User had explicit `codex_hooks = false # disabled` opt-out. After
    // Komla removes its hooks, the flag should be migrated to `hooks = false`
    // rather than dropped — losing the user's intent would surprise them if
    // they later install their own hooks.
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
        },
      }),
      settings: ['[features]', 'codex_hooks = false # user disabled it'].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.disableNotificationHook();

    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('hooks = false # user disabled it');
    expect(written).not.toContain('codex_hooks');
  });

  it('should not offer an update when no integration exists', async () => {
    mockFiles({ settings: 'model = "gpt-5"\n' });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    expect(codexSettingsService.getNotificationUpdate()).toBeUndefined();

    const hooksWrites = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('hooks.json')
    );
    expect(hooksWrites).toHaveLength(0);
  });

  it('should refresh old hooks on explicit update', async () => {
    mockFiles({
      hooks: JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] }],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
          PermissionRequest: [
            { hooks: [{ type: 'command', command: 'cmd # komla-notification-hook' }] },
          ],
        },
      }),
      settings: 'model = "gpt-5"\n',
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    codexSettingsService.enableNotificationHook();

    // Explicit updates refresh old hook commands too.
    const hooksWrites = mockWriteFileSync.mock.calls.filter(([path]) =>
      String(path).endsWith('hooks.json')
    );
    expect(hooksWrites).toHaveLength(1);
  });

  // ── Command shape ──

  it('should generate notification config as JSON with all notification events', async () => {
    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');

    const configJson = codexSettingsService.getNotificationConfigJson();
    const parsed = JSON.parse(configJson);

    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.PermissionRequest).toHaveLength(1);
    const stopCmd = parsed.hooks.Stop[0].hooks[0].command;
    expect(stopCmd).toContain('--source codex');
    expect(stopCmd).toContain('--event Stop');
    expect(normalizeSlashes(stopCmd)).toContain('/bin/komla');
    // Should NOT contain --input argv (hooks use stdin)
    expect(stopCmd).not.toContain('--input');
  });

  it('should invoke the installed Komla CLI on Unix', async () => {
    setPlatform('linux');
    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');

    const configJson = codexSettingsService.getNotificationConfigJson();
    const parsed = JSON.parse(configJson);
    const stopCmd = parsed.hooks.Stop[0].hooks[0].command;
    expect(normalizeSlashes(stopCmd)).toContain('/bin/komla" notify');
    expect(stopCmd).not.toContain('notify.js');
  });

  // ── Force enable ──

  it('should succeed via enableNotificationHookForce', async () => {
    mockFiles({ settings: '' });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    const result = codexSettingsService.enableNotificationHookForce();

    expect(result.success).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(lastHooksWrite()).toBeDefined();
  });

  // ── MCP (unchanged) ──

  it('should build codex MCP CLI command and TOML config', async () => {
    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');

    expect(codexSettingsService.getMcpCliCommand(52863)).toBe(
      'codex mcp add komla --url http://localhost:52863/api/v1/mcp'
    );
    expect(codexSettingsService.getMcpRemoveCliCommand()).toBe('codex mcp remove komla');
    expect(codexSettingsService.getMcpConfigToml(52863)).toBe(
      '[mcp_servers.komla]\nurl = "http://localhost:52863/api/v1/mcp"'
    );
  });

  it('should report MCP configured when komla MCP section exists', async () => {
    mockFiles({
      settings: [
        'model = "gpt-5"',
        '',
        '[mcp_servers.komla]',
        'url = "http://localhost:52863/mcp"',
      ].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    expect(codexSettingsService.getMcpStatus().isConfigured).toBe(true);
  });

  it('should remove MCP server section via disableMcpServer', async () => {
    mockFiles({
      settings: [
        'model = "gpt-5"',
        '',
        '[mcp_servers.komla]',
        'url = "http://localhost:52863/mcp"',
        '',
        '[projects."/tmp/foo"]',
        'trust_level = "trusted"',
      ].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    const result = codexSettingsService.disableMcpServer();

    expect(result.success).toBe(true);
    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('model = "gpt-5"');
    expect(written).toContain('[projects."/tmp/foo"]');
    expect(written).not.toContain('[mcp_servers.komla]');
  });

  it('should add MCP server section via enableMcpServer', async () => {
    mockFiles({
      settings: ['model = "gpt-5"', '', '[projects."/tmp/foo"]', 'trust_level = "trusted"'].join(
        '\n'
      ),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    const result = codexSettingsService.enableMcpServer(52863);

    expect(result.success).toBe(true);
    const written = lastSettingsWrite();
    expect(written).toBeDefined();
    expect(written).toContain('[projects."/tmp/foo"]');
    expect(written).toContain('[mcp_servers.komla]');
    expect(written).toContain('url = "http://localhost:52863/api/v1/mcp"');
  });

  it('should succeed when MCP server section does not exist', async () => {
    mockFiles({ settings: 'model = "gpt-5"\n' });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    const result = codexSettingsService.disableMcpServer();

    expect(result.success).toBe(true);
  });

  it('should report MCP not configured when komla MCP section is missing', async () => {
    mockFiles({
      settings: [
        'model = "gpt-5"',
        '',
        '[mcp_servers.other]',
        'url = "http://localhost:52863/mcp"',
      ].join('\n'),
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');
    expect(codexSettingsService.getMcpStatus().isConfigured).toBe(false);
  });

  it('should not overwrite config.toml when it cannot be read', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');

    expect(codexSettingsService.enableMcpServer(52863).error).toContain('EACCES');
    expect(codexSettingsService.disableMcpServer().success).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('should not install hooks when config.toml cannot be read', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('config.toml')) throw new Error('EACCES: permission denied');
      return '{}';
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');

    expect(() => codexSettingsService.enableNotificationHook()).toThrow('EACCES');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('should not install hooks when config.toml is read-only', async () => {
    mockFiles({ hooks: '{}', settings: 'model = "gpt-5"\n' });
    mockWriteFileSync.mockImplementation((path) => {
      if (String(path).endsWith('config.toml')) throw new Error('EACCES: permission denied');
    });

    const { codexSettingsService } =
      await import('../../../src/main/services/codex-settings.service');

    try {
      expect(() => codexSettingsService.enableNotificationHook()).toThrow('EACCES');
      expect(
        mockWriteFileSync.mock.calls.some(([path]) => String(path).endsWith('hooks.json'))
      ).toBe(false);
    } finally {
      mockWriteFileSync.mockReset();
    }
  });
});
