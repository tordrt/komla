import { exec } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

import {
  ALL_CLAUDE_HOOK_EVENTS,
  ClaudeVersionCache,
  claudeHookPlan,
  claudeHooksOutdated,
  claudeHooksToWrite,
  parseClaudeVersion,
  type ClaudeHookEvent,
} from '../lib/claude-hook-events';
import {
  describeNotifyRunner,
  getKomlaCliPath,
  getNotifyHelper,
  isKomlaCliBlocked,
} from '../lib/komla-cli';
import { readUserJsonObjectFile, writeUserConfigFile } from '../lib/user-config-file';
import { isWslMode } from '../lib/wsl';

import { configService } from './config.service';

import type { ClaudeMcpStatus } from '../../shared/types/mcp-status';
import type { NotificationIntegrationUpdate } from '../../shared/types/notification-integration';

interface ClaudeHook {
  type: 'command' | 'http' | 'prompt' | 'agent';
  command?: string;
  async?: boolean;
}

interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeHook[];
}

interface ClaudeSettings {
  hooks?: {
    Notification?: ClaudeHookMatcher[];
    Stop?: ClaudeHookMatcher[];
    [key: string]: ClaudeHookMatcher[] | undefined;
  };
  [key: string]: unknown;
}

interface ClaudeJson {
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

class ClaudeSettingsService {
  private settingsPath = join(homedir(), '.claude', 'settings.json');
  private claudeJsonPath = join(homedir(), '.claude.json');
  private hookMarker = 'komla-notification-hook';
  private mcpServerName = 'komla';
  private claudeVersions = new ClaudeVersionCache();

  private readSettings(): ClaudeSettings {
    try {
      return readUserJsonObjectFile<ClaudeSettings>(this.settingsPath);
    } catch (error) {
      console.error('Failed to read Claude settings:', error);
    }
    return {};
  }

  private writeSettings(settings: ClaudeSettings): void {
    try {
      writeUserConfigFile(this.settingsPath, JSON.stringify(settings, null, 2));
    } catch (error) {
      console.error('Failed to write Claude settings:', error);
      throw error;
    }
  }

  private buildHookCommand(eventName: ClaudeHookEvent): string {
    if (isKomlaCliBlocked()) {
      const { nodeCommand, script } = getNotifyHelper();
      return `${JSON.stringify(nodeCommand.replace(/\\/g, '/'))} ${JSON.stringify(script.replace(/\\/g, '/'))} --source claude-code --event ${eventName} # ${this.hookMarker}`;
    }
    const cli = getKomlaCliPath().replace(/\\/g, '/');
    return `${JSON.stringify(cli)} notify --source claude-code --event ${eventName} # ${this.hookMarker}`;
  }

  /**
   * Get the hook command for display in the UI
   */
  getHookCommand(): string {
    return this.buildHookCommand('Notification');
  }

  /**
   * Get the path to the Claude settings file
   */
  getSettingsPath(): string {
    return this.settingsPath;
  }

  private isOurHook(command: unknown): boolean {
    return (
      typeof command === 'string' &&
      (command.includes(this.hookMarker) || /localhost:\d+\/(api\/v1\/)?notify/.test(command))
    );
  }

  private managedCommands(settings: ClaudeSettings, eventName: ClaudeHookEvent): string[] {
    return (settings.hooks?.[eventName] ?? [])
      .flatMap((matcher) => matcher.hooks)
      .map((hook) => hook.command)
      .filter((command): command is string => this.isOurHook(command));
  }

  private removeManagedHooks(settings: ClaudeSettings, events: readonly ClaudeHookEvent[]): void {
    if (!settings.hooks) return;
    for (const eventName of events) {
      const hooks = settings.hooks[eventName];
      if (!hooks) continue;
      settings.hooks[eventName] = hooks.filter(
        (matcher) => !matcher.hooks.some((hook) => this.isOurHook(hook.command))
      );
      // An old Claude rejects the whole file over an event it doesn't know, even an empty one.
      if (settings.hooks[eventName]?.length === 0) {
        delete settings.hooks[eventName];
      }
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  private upsertManagedHook(settings: ClaudeSettings, eventName: ClaudeHookEvent): void {
    if (!settings.hooks) {
      settings.hooks = {};
    }
    if (!settings.hooks[eventName]) {
      settings.hooks[eventName] = [];
    }

    const matchers = settings.hooks[eventName];
    if (!matchers) return;

    const existingIndex = matchers.findIndex((matcher) =>
      matcher.hooks.some((hook) => this.isOurHook(hook.command))
    );

    const hookMatcher: ClaudeHookMatcher = {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: this.buildHookCommand(eventName),
          async: true,
        },
      ],
    };

    if (existingIndex >= 0) {
      const existing = matchers[existingIndex];
      existing.hooks = existing.hooks.map((hook) =>
        this.isOurHook(hook.command) ? hookMatcher.hooks[0] : hook
      );
    } else {
      matchers.push(hookMatcher);
    }
  }

  /**
   * The installed Claude's version, which decides the events Komla may write; see
   * claude-hook-events. `fresh` skips the cached answer.
   */
  getClaudeVersion({ fresh = false }: { fresh?: boolean } = {}): Promise<string | undefined> {
    return this.claudeVersions.get('local', () => this.probeClaudeVersion(), fresh);
  }

  private async probeClaudeVersion(): Promise<string | undefined> {
    // The interactive login shell the terminals start, so .zshrc and .bashrc set up PATH too.
    const command =
      process.platform === 'win32'
        ? this.loginShellCommand('claude --version')
        : `${process.env.SHELL || '/bin/bash'} -ilc 'claude --version' </dev/null`;
    try {
      const output = await new Promise<string>((resolve, reject) => {
        exec(command, { timeout: 10000 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      return parseClaudeVersion(output);
    } catch {
      return undefined;
    }
  }

  enableNotificationHook(claudeVersion?: string): void {
    const settings = readUserJsonObjectFile<ClaudeSettings>(this.settingsPath);
    const plan = claudeHookPlan(claudeVersion);
    for (const event of claudeHooksToWrite(plan, (event) =>
      this.managedCommands(settings, event)
    )) {
      this.upsertManagedHook(settings, event);
    }
    this.removeManagedHooks(settings, plan.remove);

    this.writeSettings(settings);
  }

  disableNotificationHook(): void {
    const settings = readUserJsonObjectFile<ClaudeSettings>(this.settingsPath);

    if (!settings.hooks) {
      return;
    }

    this.removeManagedHooks(settings, ALL_CLAUDE_HOOK_EVENTS);

    this.writeSettings(settings);
  }

  getNotificationUpdate(claudeVersion?: string): NotificationIntegrationUpdate | undefined {
    const settings = this.readSettings();
    const managed = (event: ClaudeHookEvent) => this.managedCommands(settings, event);
    if (ALL_CLAUDE_HOOK_EVENTS.every((event) => managed(event).length === 0)) return undefined;
    const plan = claudeHookPlan(claudeVersion);
    if (!claudeHooksOutdated(plan, managed, (event) => this.buildHookCommand(event))) {
      return undefined;
    }
    const removed = plan.remove.filter((event) => managed(event).length > 0);
    return {
      files: [
        {
          path: this.settingsPath,
          description: `Update Komla notification hooks to include ${claudeHooksToWrite(plan, managed).join(', ')} events${removed.length > 0 ? `, removing ${removed.join(', ')}, which this Claude Code version doesn't support` : ''}. They run ${describeNotifyRunner()}. Other hooks and settings are preserved.`,
        },
      ],
    };
  }

  /** Whether any of Komla's notification hooks are installed, so an update may be due. */
  hasNotificationHooks(): boolean {
    const settings = this.readSettings();
    return ALL_CLAUDE_HOOK_EVENTS.some((event) => this.managedCommands(settings, event).length > 0);
  }

  isNotificationHookEnabled(): boolean {
    const settings = this.readSettings();

    return ['Notification', 'Stop'].some(
      (eventName) =>
        settings.hooks?.[eventName]?.some((matcher) =>
          matcher.hooks.some((hook) => this.isOurHook(hook.command))
        ) ?? false
    );
  }

  // MCP Server Configuration Methods

  /**
   * Get the URL for the streamable HTTP MCP endpoint
   */
  getMcpServerUrl(port: number): string {
    return `http://localhost:${port}/api/v1/mcp`;
  }

  private readClaudeJson(): ClaudeJson {
    try {
      return readUserJsonObjectFile<ClaudeJson>(this.claudeJsonPath);
    } catch (error) {
      console.error('Failed to read ~/.claude.json:', error);
    }
    return {};
  }

  private writeClaudeJson(config: ClaudeJson): void {
    try {
      writeUserConfigFile(this.claudeJsonPath, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Failed to write ~/.claude.json:', error);
      throw error;
    }
  }

  isMcpServerInConfig(): boolean {
    const claudeJson = this.readClaudeJson();
    return claudeJson.mcpServers?.[this.mcpServerName] !== undefined;
  }

  async isMcpServerConfigured(): Promise<boolean> {
    // Fast path: check ~/.claude.json first (instant file read)
    const claudeJson = this.readClaudeJson();
    if (claudeJson.mcpServers?.[this.mcpServerName] !== undefined) {
      return true;
    }

    // Slow path: fall back to `claude mcp list` to check other scopes (project, local)
    try {
      const cmd = this.loginShellCommand('claude mcp list');
      const output = await new Promise<string>((resolve, reject) => {
        exec(cmd, { timeout: 10000 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      // Output contains lines like "komla: http://localhost:52863/mcp (HTTP) - ..."
      return output
        .split('\n')
        .some((line) => line.trimStart().startsWith(`${this.mcpServerName}:`));
    } catch {
      return false;
    }
  }

  enableMcpServer(port: number): { success: boolean; error?: string } {
    try {
      const config = readUserJsonObjectFile<ClaudeJson>(this.claudeJsonPath);

      if (!config.mcpServers) {
        config.mcpServers = {};
      }

      config.mcpServers[this.mcpServerName] = {
        type: 'http',
        url: this.getMcpServerUrl(port),
      };

      this.writeClaudeJson(config);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  disableMcpServer(): { success: boolean; error?: string } {
    try {
      const config = readUserJsonObjectFile<ClaudeJson>(this.claudeJsonPath);

      if (config.mcpServers?.[this.mcpServerName]) {
        delete config.mcpServers[this.mcpServerName];

        // Clean up empty mcpServers object
        if (Object.keys(config.mcpServers).length === 0) {
          delete config.mcpServers;
        }

        this.writeClaudeJson(config);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  getMcpConfigJson(port: number): string {
    const url = this.getMcpServerUrl(port);
    return JSON.stringify(
      {
        mcpServers: {
          [this.mcpServerName]: {
            type: 'http',
            url,
          },
        },
      },
      null,
      2
    );
  }

  /**
   * Wraps a command in a login shell on Unix so the user's full PATH is available.
   * Without this, exec() uses /bin/sh which doesn't source profile files,
   * so tools installed via npm/nvm/etc. aren't found.
   */
  loginShellCommand(cmd: string): string {
    if (process.platform === 'win32') {
      if (isWslMode()) {
        // Wrap the command in wsl.exe so it runs inside the Linux environment
        // with a login shell for full PATH access.
        const distro = configService.get().wslDistro;
        const distroArgs = distro ? `-d ${distro} ` : '';
        return `wsl.exe ${distroArgs}-- bash -lc ${JSON.stringify(cmd)}`;
      }
      return cmd;
    }
    const shell = process.env.SHELL || '/bin/bash';
    return `${shell} -lc ${JSON.stringify(cmd)}`;
  }

  getMcpCliCommand(port: number): string {
    const url = this.getMcpServerUrl(port);
    return `claude mcp add --scope user --transport http ${this.mcpServerName} ${url}`;
  }

  getMcpRemoveCliCommand(): string {
    return `claude mcp remove ${this.mcpServerName}`;
  }

  getNotificationConfigJson(claudeVersion?: string): string {
    const settings: ClaudeSettings = {};
    for (const event of claudeHookPlan(claudeVersion).install) {
      this.upsertManagedHook(settings, event);
    }
    return JSON.stringify(settings, null, 2);
  }

  async getMcpStatus(port: number): Promise<ClaudeMcpStatus> {
    return {
      isConfigured: await this.isMcpServerConfigured(),
      mcpServerUrl: this.getMcpServerUrl(port),
      cliCommand: this.getMcpCliCommand(port),
      configJson: this.getMcpConfigJson(port),
    };
  }
}

export const claudeSettingsService = new ClaudeSettingsService();
