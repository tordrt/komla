import type { AgentIntegrationFilter } from './AgentIntegrations';

/** An agent's notifications on this computer. */
export interface AgentNotificationStatus {
  isConfigured: boolean;
  /** The file that turning them on changes. */
  path: string;
  /** False when turning them on would fail until the user resolves a conflict, as with a Codex
   * notify config Komla can't merge into. The integration panel offers that fix. */
  canEnable: boolean;
}

interface AgentNotificationSetup {
  status: () => Promise<AgentNotificationStatus>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

const AGENT_NOTIFICATIONS: Record<AgentIntegrationFilter, AgentNotificationSetup> = {
  claude: {
    status: async () => {
      const info = await window.api.getNotificationHookDetails();
      return { isConfigured: info.isConfigured, path: info.settingsPath, canEnable: true };
    },
    enable: () => window.api.enableNotifications(),
    disable: () => window.api.disableNotifications(),
  },
  codex: {
    status: async () => {
      const info = await window.api.getCodexNotificationHookDetails();
      return {
        isConfigured: info.isConfigured,
        path: info.settingsPath,
        canEnable: !info.hasConflict || info.canAutoConfigure,
      };
    },
    enable: () => window.api.enableCodexNotifications(),
    disable: () => window.api.disableCodexNotifications(),
  },
  antigravity: {
    status: async () => {
      const info = await window.api.getAntigravityNotificationHookDetails();
      return { isConfigured: info.isConfigured, path: info.settingsPath, canEnable: true };
    },
    enable: () => window.api.enableAntigravityNotifications(),
    disable: () => window.api.disableAntigravityNotifications(),
  },
  opencode: {
    status: async () => {
      const info = await window.api.getOpenCodeNotificationHookDetails();
      return { isConfigured: info.isConfigured, path: info.pluginPath, canEnable: true };
    },
    enable: () => window.api.enableOpenCodeNotifications(),
    disable: () => window.api.disableOpenCodeNotifications(),
  },
};

export function agentNotificationStatus(
  agent: AgentIntegrationFilter
): Promise<AgentNotificationStatus> {
  return AGENT_NOTIFICATIONS[agent].status();
}

// Electron wraps main-process errors as "Error invoking remote method '<channel>': Error: <message>".
function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

/** Turns an agent's notifications on or off; returns what failed, or an empty string. */
export async function setAgentNotifications(
  agent: AgentIntegrationFilter,
  on: boolean
): Promise<string> {
  const setup = AGENT_NOTIFICATIONS[agent];
  try {
    await (on ? setup.enable() : setup.disable());
    return '';
  } catch (err) {
    return `Couldn’t turn ${on ? 'on' : 'off'} hooks: ${ipcErrorMessage(err)}`;
  }
}
