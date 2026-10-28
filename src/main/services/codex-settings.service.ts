import { homedir } from 'os';
import { join } from 'path';

import { CODEX_NOTIFICATION_HOOK_EVENTS } from '../lib/codex-hook-events';
import { setCodexMcpServer } from '../lib/codex-mcp-config';
import {
  describeNotifyRunner,
  getKomlaCliPath,
  getNotifyHelper,
  isKomlaCliBlocked,
} from '../lib/komla-cli';
import { createLogger } from '../lib/logger';
import { powerShellSingleQuote } from '../lib/powershell-native-arguments';
import {
  readUserConfigFile,
  readUserJsonObjectFile,
  writeUserConfigFile,
} from '../lib/user-config-file';

import type { NotificationIntegrationUpdate } from '../../shared/types/notification-integration';

const logger = createLogger('CodexSettingsService');

interface CodexHook {
  type: 'command';
  command: string;
  commandWindows?: string;
  timeout?: number;
  statusMessage?: string;
}

interface CodexHookMatcher {
  matcher?: string;
  hooks: CodexHook[];
}

interface CodexHooksConfig {
  hooks?: {
    [eventName: string]: CodexHookMatcher[];
  };
}

export interface CodexNotificationStatus {
  isConfigured: boolean;
  hasConflict: boolean;
  canAutoConfigure: boolean;
  conflictMessage: string | null;
  isKomlaManaged: boolean;
}

export interface CodexMcpStatus {
  isConfigured: boolean;
}

class CodexSettingsService {
  private notificationEvents: readonly string[] = CODEX_NOTIFICATION_HOOK_EVENTS;

  // config.toml — used for MCP servers and feature flags
  private settingsPath = join(homedir(), '.codex', 'config.toml');

  // hooks.json — used for notification hooks (new hooks system)
  private hooksPath = join(homedir(), '.codex', 'hooks.json');

  private hookMarker = 'komla-notification-hook';
  private mcpServerName = 'komla';

  getSettingsPath(): string {
    return this.settingsPath;
  }

  getHooksPath(): string {
    return this.hooksPath;
  }

  // ── config.toml read/write ──

  private readSettings(): string {
    try {
      return readUserConfigFile(this.settingsPath);
    } catch (error) {
      logger.error('Failed to read Codex settings:', error);
    }
    return '';
  }

  private writeSettings(contents: string): void {
    try {
      writeUserConfigFile(this.settingsPath, contents);
    } catch (error) {
      logger.error('Failed to write Codex settings:', error);
      throw error;
    }
  }

  // ── hooks.json read/write ──

  /**
   * Read and parse hooks.json.
   * Returns {} when the file is missing or blank.
   * Throws when the file exists but cannot be read or parsed — callers that
   * mutate state must not proceed with a fallback {} because that would
   * silently overwrite the user's (malformed but present) hooks file.
   */
  private readHooks(): CodexHooksConfig {
    return readUserJsonObjectFile<CodexHooksConfig>(this.hooksPath);
  }

  private writeHooks(config: CodexHooksConfig): void {
    try {
      writeUserConfigFile(this.hooksPath, JSON.stringify(config, null, 2));
    } catch (error) {
      logger.error('Failed to write Codex hooks:', error);
      throw error;
    }
  }

  // ── Hook command generation ──

  private buildHookCommand(eventName: string): string {
    if (isKomlaCliBlocked()) {
      const { nodeCommand, script } = getNotifyHelper();
      return `${JSON.stringify(nodeCommand.replace(/\\/g, '/'))} ${JSON.stringify(script.replace(/\\/g, '/'))} --source codex --event ${eventName} # ${this.hookMarker}`;
    }
    const cli = getKomlaCliPath().replace(/\\/g, '/');
    return `${JSON.stringify(cli)} notify --source codex --event ${eventName} # ${this.hookMarker}`;
  }

  private buildWindowsHookCommand(eventName: string): string {
    let invocation: string;
    if (isKomlaCliBlocked()) {
      const { nodeCommand, script } = getNotifyHelper();
      invocation = `${powerShellSingleQuote(nodeCommand.replace(/\\/g, '/'))} ${powerShellSingleQuote(script.replace(/\\/g, '/'))}`;
    } else {
      invocation = `${powerShellSingleQuote(getKomlaCliPath().replace(/\\/g, '/'))} notify`;
    }
    const command = `& ${invocation} --source codex --event ${eventName} # ${this.hookMarker}`;
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ${JSON.stringify(command)}`;
  }

  private isOurHook(command: string): boolean {
    return command.includes(this.hookMarker);
  }

  // ── Hook management in hooks.json ──

  private upsertHook(config: CodexHooksConfig, eventName: string): void {
    if (!config.hooks) {
      config.hooks = {};
    }
    if (!config.hooks[eventName]) {
      config.hooks[eventName] = [];
    }

    const matchers = config.hooks[eventName];
    const existingIndex = matchers.findIndex((matcher) =>
      matcher.hooks.some((hook) => this.isOurHook(hook.command))
    );

    const hookMatcher: CodexHookMatcher = {
      hooks: [
        {
          type: 'command',
          command: this.buildHookCommand(eventName),
          ...(process.platform === 'win32'
            ? { commandWindows: this.buildWindowsHookCommand(eventName) }
            : {}),
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

  private removeHook(config: CodexHooksConfig, eventName: string): void {
    const matchers = config.hooks?.[eventName];
    if (!matchers) return;

    config.hooks![eventName] = matchers.filter(
      (matcher) => !matcher.hooks.some((hook) => this.isOurHook(hook.command))
    );

    if (config.hooks![eventName].length === 0) {
      delete config.hooks![eventName];
    }

    if (config.hooks && Object.keys(config.hooks).length === 0) {
      delete config.hooks;
    }
  }

  // ── Feature flag management in config.toml ──

  private updateFeaturesSection(
    settings: string,
    updateBody: (body: string) => string | null
  ): string | undefined {
    const lines = settings.split('\n');
    const tableHeaderRegex = /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/;
    const featureStart = lines.findIndex((line) => /^\s*\[\s*features\s*\]\s*(#.*)?$/.test(line));
    if (featureStart === -1) return undefined;

    let featureEnd = lines.length;
    for (let index = featureStart + 1; index < lines.length; index++) {
      if (tableHeaderRegex.test(lines[index])) {
        featureEnd = index;
        break;
      }
    }

    const nextBody = updateBody(lines.slice(featureStart + 1, featureEnd).join('\n'));
    if (nextBody === null) {
      return settings;
    }

    const nextLines =
      nextBody.length > 0 ? [lines[featureStart].trimEnd(), ...nextBody.split('\n')] : [];
    lines.splice(featureStart, featureEnd - featureStart, ...nextLines);
    return lines.join('\n');
  }

  private ensureHooksFeatureFlag({ forceEnable = true }: { forceEnable?: boolean } = {}): void {
    let settings = readUserConfigFile(this.settingsPath);

    const updated = this.updateFeaturesSection(settings, (body) => {
      const deprecatedHooksMatch = /^\s*codex_hooks\s*=\s*(true|false)(\s*(#.*)?)?\n?/m.exec(body);
      let nextBody = body.replace(/^\s*codex_hooks\s*=\s*(true|false)(\s*(#.*)?)?\n?/m, '');
      if (/^\s*hooks\s*=\s*true(\s*(#.*)?)?$/m.test(nextBody)) {
        return nextBody === body ? null : nextBody;
      }
      if (/^\s*hooks\s*=\s*false(\s*(#.*)?)?$/m.test(nextBody) && !forceEnable) {
        return nextBody === body ? null : nextBody;
      }
      if (deprecatedHooksMatch?.[1] === 'false' && !forceEnable) {
        const trimmedBody = nextBody.trimEnd();
        const comment = deprecatedHooksMatch[2] ?? '';
        nextBody =
          trimmedBody.length > 0
            ? `${trimmedBody}\nhooks = false${comment}\n`
            : `hooks = false${comment}\n`;
        return nextBody;
      }
      // Non-force callers must not synthesize a flag from absence — only
      // migrate or preserve what the user already has.
      if (!forceEnable && !deprecatedHooksMatch) {
        return nextBody === body ? null : nextBody;
      }
      if (/^\s*hooks\s*=\s*(true|false)(\s*(#.*)?)?$/m.test(nextBody)) {
        nextBody = nextBody.replace(
          /^(\s*)hooks\s*=\s*(true|false)(\s*(#.*)?)?$/m,
          '$1hooks = true$3'
        );
      } else {
        const trimmedBody = nextBody.trimEnd();
        // Preserve any inline comment from a migrated codex_hooks = true line.
        const comment = deprecatedHooksMatch?.[2] ?? '';
        nextBody =
          trimmedBody.length > 0
            ? `${trimmedBody}\nhooks = true${comment}\n`
            : `hooks = true${comment}\n`;
      }
      return nextBody;
    });

    if (updated !== undefined) {
      if (updated === settings) return;
      settings = updated;
    } else {
      if (!forceEnable) return;
      // Add [features] section before first table section, or at end
      const lines = settings.split('\n');
      const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));

      if (firstTableIndex === -1) {
        const trimmed = settings.trimEnd();
        settings =
          trimmed.length > 0
            ? `${trimmed}\n\n[features]\nhooks = true\n`
            : `[features]\nhooks = true\n`;
      } else {
        const before = lines.slice(0, firstTableIndex).join('\n').trimEnd();
        const after = lines.slice(firstTableIndex).join('\n');
        settings =
          before.length > 0
            ? `${before}\n\n[features]\nhooks = true\n\n${after}`
            : `[features]\nhooks = true\n\n${after}`;
      }
    }

    settings = settings.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    this.writeSettings(settings);
  }

  private removeHooksFeatureFlag(): void {
    let settings = readUserConfigFile(this.settingsPath);
    if (!settings) return;

    const updated = this.updateFeaturesSection(settings, (body) => {
      // Preserve an explicit `codex_hooks = false` by migrating it to
      // `hooks = false` — losing a user opt-out would surprise the user
      // if they later add their own hooks.
      const deprecatedHooksMatch = /^\s*codex_hooks\s*=\s*(true|false)(\s*(#.*)?)?\n?/m.exec(body);
      let nextBody = body
        .replace(/^\s*hooks\s*=\s*true(\s*(#.*)?)?\n?/m, '')
        .replace(/^\s*codex_hooks\s*=\s*(true|false)(\s*(#.*)?)?\n?/m, '');
      if (deprecatedHooksMatch?.[1] === 'false') {
        const trimmedBody = nextBody.trimEnd();
        const comment = deprecatedHooksMatch[2] ?? '';
        nextBody =
          trimmedBody.length > 0
            ? `${trimmedBody}\nhooks = false${comment}\n`
            : `hooks = false${comment}\n`;
      }
      return nextBody.trim().length > 0 ? nextBody : '';
    });
    if (updated === undefined || updated === settings) return;
    settings = updated;

    settings = settings.replace(/\n{3,}/g, '\n\n').trim();
    this.writeSettings(settings.length > 0 ? `${settings}\n` : '');
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  getNotificationUpdate(): NotificationIntegrationUpdate | undefined {
    const settings = this.readSettings();
    let hooks: CodexHooksConfig;
    try {
      hooks = this.readHooks();
    } catch {
      return undefined; // The existing conflict UI handles malformed hooks.json.
    }
    if (!this.hasAnyManagedNotificationHook(hooks)) return undefined;
    const current = this.notificationEvents.every((event) =>
      hooks.hooks?.[event]?.some((matcher) =>
        matcher.hooks.some(
          (hook) =>
            hook.command === this.buildHookCommand(event) &&
            (process.platform !== 'win32' ||
              hook.commandWindows === this.buildWindowsHookCommand(event))
        )
      )
    );
    let featureEnabled = false;
    this.updateFeaturesSection(settings, (body) => {
      featureEnabled =
        /^\s*hooks\s*=\s*true(\s*(#.*)?)?$/m.test(body) && !/^\s*codex_hooks\s*=/m.test(body);
      return null;
    });
    if (current && featureEnabled) return undefined;
    return {
      files: [
        {
          path: this.hooksPath,
          description: `Update Komla hooks for ${this.notificationEvents.join(', ')}. They run ${describeNotifyRunner()}. Other hooks are preserved.`,
        },
        {
          path: this.settingsPath,
          description:
            'Enable features.hooks and replace the deprecated codex_hooks flag if present. Other settings are preserved.',
        },
      ],
    };
  }

  // ── Public notification API ──

  getNotifyCommand(): string {
    return this.buildHookCommand('Stop');
  }

  getNotificationConfigJson(): string {
    const config: CodexHooksConfig = {};
    for (const event of this.notificationEvents) this.upsertHook(config, event);
    return JSON.stringify(config, null, 2);
  }

  getNotificationStatus(): CodexNotificationStatus {
    let hooksConfig: CodexHooksConfig;
    try {
      hooksConfig = this.readHooks();
    } catch {
      // hooks.json exists but is malformed — report as a conflict so the UI
      // can tell the user to fix it rather than silently overwriting.
      return {
        isConfigured: false,
        hasConflict: true,
        canAutoConfigure: false,
        isKomlaManaged: false,
        conflictMessage:
          'Your ~/.codex/hooks.json file could not be parsed. Please fix or remove it before enabling notifications.',
      };
    }
    const isConfigured = this.isHookConfigured(hooksConfig);
    const isKomlaManaged = this.hasAnyManagedNotificationHook(hooksConfig);

    return {
      isConfigured,
      hasConflict: false,
      canAutoConfigure: true,
      isKomlaManaged,
      conflictMessage: null,
    };
  }

  private isHookConfigured(config: CodexHooksConfig): boolean {
    return CODEX_NOTIFICATION_HOOK_EVENTS.every((eventName) =>
      this.hasManagedHook(config, eventName)
    );
  }

  private hasManagedHook(config: CodexHooksConfig, eventName: string): boolean {
    return (
      config.hooks?.[eventName]?.some((matcher) =>
        matcher.hooks.some((hook) => this.isOurHook(hook.command))
      ) ?? false
    );
  }

  private hasAnyManagedNotificationHook(config: CodexHooksConfig): boolean {
    return this.notificationEvents.some((eventName) => this.hasManagedHook(config, eventName));
  }

  private hasAnyHooks(config: CodexHooksConfig): boolean {
    return config.hooks !== undefined && Object.keys(config.hooks).length > 0;
  }

  enableNotificationHook(): void {
    const config = this.readHooks();
    for (const eventName of this.notificationEvents) {
      this.upsertHook(config, eventName);
    }

    // Enable the feature flag in config.toml before writing hooks.json: if a
    // later write fails, an enabled flag without Komla hooks is harmless, while
    // hooks without the flag would silently never run.
    this.ensureHooksFeatureFlag();
    this.writeHooks(config);
  }

  enableNotificationHookForce(): { success: boolean; backupPath?: string; error?: string } {
    try {
      this.enableNotificationHook();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to force enable notifications: ${message}`);
      return { success: false, error: message };
    }
  }

  disableNotificationHook(): void {
    // Always attempt to remove our hooks from both events.
    // Don't gate on isHookConfigured() — a partial state (only one hook present)
    // would otherwise be impossible to clean up through the UI.
    let config: CodexHooksConfig | null = null;
    try {
      config = this.readHooks();
    } catch (error) {
      // hooks.json is malformed — don't overwrite it.
      logger.warn('Cannot modify hooks.json (parse error), skipping hook removal:', error);
    }

    if (config) this.removeManagedHooks(config);
  }

  private removeManagedHooks(config: CodexHooksConfig): void {
    let changed = false;
    for (const eventName of this.notificationEvents) {
      const before = config.hooks?.[eventName]?.length ?? 0;
      this.removeHook(config, eventName);
      const after = config.hooks?.[eventName]?.length ?? 0;
      if (before !== after) changed = true;
    }
    if (changed) {
      this.writeHooks(config);
    }

    // Only remove the feature flag if no hooks remain (user's or ours).
    // hooks is a global switch — removing it would break the user's own hooks.
    if (!this.hasAnyHooks(config)) {
      this.removeHooksFeatureFlag();
    } else {
      this.ensureHooksFeatureFlag({ forceEnable: false });
    }
  }

  // ── MCP methods (unchanged — still config.toml) ──

  getMcpServerUrl(port: number): string {
    return `http://localhost:${port}/api/v1/mcp`;
  }

  getMcpConfigToml(port: number): string {
    const url = this.getMcpServerUrl(port);
    return [`[mcp_servers.${this.mcpServerName}]`, `url = "${url}"`].join('\n');
  }

  getMcpCliCommand(port: number): string {
    return `codex mcp add ${this.mcpServerName} --url ${this.getMcpServerUrl(port)}`;
  }

  getMcpRemoveCliCommand(): string {
    return `codex mcp remove ${this.mcpServerName}`;
  }

  enableMcpServer(port: number): { success: boolean; error?: string } {
    try {
      const next = setCodexMcpServer(
        readUserConfigFile(this.settingsPath),
        this.getMcpServerUrl(port)
      );
      this.writeSettings(next);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  disableMcpServer(): { success: boolean; error?: string } {
    try {
      const settings = readUserConfigFile(this.settingsPath);
      const updated = setCodexMcpServer(settings, null);
      if (updated !== settings) {
        this.writeSettings(updated);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  getMcpStatus(): CodexMcpStatus {
    const settings = this.readSettings();
    const sectionRegex = new RegExp(
      `^\\s*\\[mcp_servers\\.${this.escapeRegex(this.mcpServerName)}\\]\\s*$`,
      'm'
    );
    return {
      isConfigured: sectionRegex.test(settings),
    };
  }
}

export const codexSettingsService = new CodexSettingsService();
