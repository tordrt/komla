// MCP configuration status
export interface McpStatus {
  isConfigured: boolean;
  mcpServerUrl: string;
  cliCommand: string;
  configJson: string;
  codex?: {
    isConfigured: boolean;
    cliCommand: string;
    removeCliCommand: string;
    configToml: string;
    settingsPath: string;
  };
  antigravity?: {
    isConfigured: boolean;
    cliCommand: string;
    removeCliCommand: string;
    settingsPath: string;
  };
  opencode?: {
    isConfigured: boolean;
    cliCommand: string;
    configJson: string;
    settingsPath: string;
  };
  generic?: {
    cliCommand: string;
    configJson: string;
    notifyCommand: string;
    integrationPrompt: string;
  };
}

/** The Claude Code part of {@link McpStatus}. */
export type ClaudeMcpStatus = Pick<
  McpStatus,
  'isConfigured' | 'mcpServerUrl' | 'cliCommand' | 'configJson'
>;
