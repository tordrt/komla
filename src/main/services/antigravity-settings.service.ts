import { homedir } from 'os';
import { join } from 'path';

import {
  ANTIGRAVITY_ALERTS_SETTING,
  ANTIGRAVITY_CONFIG_DIR,
  ANTIGRAVITY_HOOK_SET,
  ANTIGRAVITY_HOOKS_FILE,
  ANTIGRAVITY_MCP_FILE,
  ANTIGRAVITY_SETTINGS_DIR,
  ANTIGRAVITY_SETTINGS_FILE,
  antigravityUpdateFiles,
  areAntigravityAlertsOn,
  buildAntigravityHookSet,
  isAntigravityHookSetEnabled,
  isAntigravityMcpServerEnabled,
  type AntigravityHookEvent,
} from '../lib/antigravity-hooks';
import {
  describeNotifyRunner,
  getKomlaCliPath,
  getNotifyHelper,
  isKomlaCliBlocked,
} from '../lib/komla-cli';
import { powerShellSingleQuote } from '../lib/powershell-native-arguments';
import { readUserJsonObjectFile, writeUserConfigFile } from '../lib/user-config-file';

import type { NotificationIntegrationUpdate } from '../../shared/types/notification-integration';

interface AntigravityMcpServerConfig {
  serverUrl?: string;
  command?: string;
  args?: string[];
  disabled?: boolean;
  [key: string]: unknown;
}

interface AntigravityMcpConfig {
  mcpServers?: Record<string, AntigravityMcpServerConfig>;
  [key: string]: unknown;
}

export interface AntigravityMcpStatus {
  isConfigured: boolean;
}

class AntigravitySettingsService {
  private hooksPath = join(homedir(), ...ANTIGRAVITY_CONFIG_DIR, ANTIGRAVITY_HOOKS_FILE);
  private mcpConfigPath = join(homedir(), ...ANTIGRAVITY_CONFIG_DIR, ANTIGRAVITY_MCP_FILE);
  private cliSettingsPath = join(homedir(), ...ANTIGRAVITY_SETTINGS_DIR, ANTIGRAVITY_SETTINGS_FILE);
  private mcpServerName = 'komla';

  private readJson<T extends object>(path: string): T {
    try {
      return readUserJsonObjectFile<T>(path);
    } catch (error) {
      console.error('Failed to read Antigravity config:', error);
    }
    return {} as T;
  }

  private writeJson(path: string, value: object): void {
    try {
      writeUserConfigFile(path, JSON.stringify(value, null, 2));
    } catch (error) {
      console.error('Failed to write Antigravity config:', error);
      throw error;
    }
  }

  private buildHookCommand(event: AntigravityHookEvent): string {
    const cli = getKomlaCliPath().replace(/\\/g, '/');
    if (process.platform === 'win32') {
      // Antigravity runs hooks through `cmd /c`, which mangles nested quotes.
      // Hooks run on every model call, so skip PowerShell's startup when the
      // paths need no quoting; otherwise an encoded script needs none.
      const blocked = isKomlaCliBlocked();
      const helper = getNotifyHelper();
      const paths = blocked ? [helper.nodeCommand, helper.script] : [getKomlaCliPath()];
      const args = `${blocked ? '' : 'notify '}--source antigravity --event ${event}`;
      if (paths.every((path) => /^[\w.:\\/-]+$/.test(path))) {
        return `${paths.join(' ')} ${args}`;
      }
      const quoted = paths.map((path) => powerShellSingleQuote(path.replace(/\\/g, '/')));
      const script = `& ${quoted.join(' ')} ${args}`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
    }
    return `${JSON.stringify(cli)} notify --source antigravity --event ${event}`;
  }

  private buildHookSet(): Record<AntigravityHookEvent, unknown[]> {
    return buildAntigravityHookSet((event) => this.buildHookCommand(event));
  }

  private installedHookSet(): unknown {
    return this.readJson<Record<string, unknown>>(this.hooksPath)[ANTIGRAVITY_HOOK_SET];
  }

  /**
   * Get the hook command for display in the UI
   */
  getHookCommand(): string {
    return this.buildHookCommand('Stop');
  }

  /**
   * Get the path to the Antigravity hooks file
   */
  getSettingsPath(): string {
    return this.hooksPath;
  }

  getMcpSettingsPath(): string {
    return this.mcpConfigPath;
  }

  enableNotificationHook(): void {
    const config = readUserJsonObjectFile<Record<string, unknown>>(this.hooksPath);
    config[ANTIGRAVITY_HOOK_SET] = this.buildHookSet();
    this.writeJson(this.hooksPath, config);

    const settings = readUserJsonObjectFile<Record<string, unknown>>(this.cliSettingsPath);
    if (areAntigravityAlertsOn(settings)) return;
    settings[ANTIGRAVITY_ALERTS_SETTING] = true;
    this.writeJson(this.cliSettingsPath, settings);
  }

  disableNotificationHook(): void {
    const config = readUserJsonObjectFile<Record<string, unknown>>(this.hooksPath);
    if (!(ANTIGRAVITY_HOOK_SET in config)) return;
    delete config[ANTIGRAVITY_HOOK_SET];
    this.writeJson(this.hooksPath, config);
  }

  getNotificationUpdate(): NotificationIntegrationUpdate | undefined {
    const files = antigravityUpdateFiles(
      {
        path: this.hooksPath,
        installed: this.installedHookSet(),
        expected: this.buildHookSet(),
        runner: describeNotifyRunner(),
      },
      { path: this.cliSettingsPath, installed: this.readJson(this.cliSettingsPath) }
    );
    return files && { files };
  }

  isNotificationHookEnabled(): boolean {
    return isAntigravityHookSetEnabled(this.installedHookSet());
  }

  getNotificationConfigJson(): string {
    return JSON.stringify({ [ANTIGRAVITY_HOOK_SET]: this.buildHookSet() }, null, 2);
  }

  getMcpServerUrl(port: number): string {
    return `http://localhost:${port}/api/v1/mcp`;
  }

  getMcpCliCommand(port: number): string {
    // agy detects the http transport from the URL and writes ~/.gemini/config/mcp_config.json.
    return `agy mcp add ${this.mcpServerName} ${this.getMcpServerUrl(port)}`;
  }

  getMcpRemoveCliCommand(): string {
    return `agy mcp remove ${this.mcpServerName}`;
  }

  enableMcpServer(port: number): { success: boolean; error?: string } {
    try {
      const config = readUserJsonObjectFile<AntigravityMcpConfig>(this.mcpConfigPath);
      config.mcpServers = {
        ...config.mcpServers,
        [this.mcpServerName]: { serverUrl: this.getMcpServerUrl(port) },
      };
      this.writeJson(this.mcpConfigPath, config);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  disableMcpServer(): { success: boolean; error?: string } {
    try {
      const config = readUserJsonObjectFile<AntigravityMcpConfig>(this.mcpConfigPath);
      if (config.mcpServers?.[this.mcpServerName]) {
        delete config.mcpServers[this.mcpServerName];
        if (Object.keys(config.mcpServers).length === 0) {
          delete config.mcpServers;
        }
        this.writeJson(this.mcpConfigPath, config);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  getMcpStatus(): AntigravityMcpStatus {
    const server = this.readJson<AntigravityMcpConfig>(this.mcpConfigPath).mcpServers?.[
      this.mcpServerName
    ];
    return { isConfigured: isAntigravityMcpServerEnabled(server) };
  }
}

export const antigravitySettingsService = new AntigravitySettingsService();
