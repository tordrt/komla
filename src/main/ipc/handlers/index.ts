import { registerAgentSettingsHandlers } from './agent-settings.handlers';
import { registerAgentsMenuBarHandlers } from './agents-menu-bar.handlers';
import { registerAppHandlers } from './app.handlers';
import { registerAskpassHandlers } from './askpass.handlers';
import { registerAutomationHandlers } from './automation.handlers';
import { registerConfigHandlers } from './config.handlers';
import { registerCustomizationHandlers } from './customization.handlers';
import { registerDevPreviewHandlers } from './dev-preview.handlers';
import { registerGitHandlers } from './git.handlers';
import { registerHooksHandlers } from './hooks.handlers';
import { registerNotesHandlers } from './notes.handlers';
import { registerPluginsHandlers } from './plugins.handlers';
import { registerProjectHandlers } from './project.handlers';
import { registerPromptDraftHandlers } from './prompt-draft.handlers';
import { registerRemoteControlHandlers } from './remote-control.handlers';
import { registerSettingsHandlers } from './settings.handlers';
import { registerShellHandlers } from './shell.handlers';
import { registerSidebarPanelsHandlers } from './sidebar-panels.handlers';
import { registerSoundsHandlers } from './sounds.handlers';
import { registerStatusItemsHandlers } from './status-items.handlers';
import { registerTelemetryHandlers } from './telemetry.handlers';
import { registerTerminalHandlers } from './terminal.handlers';
import { registerToastOverlayHandlers } from './toast-overlay.handlers';
import { registerVoiceHandlers } from './voice.handlers';
import { registerWindowHandlers } from './window.handlers';
import { registerWorkspaceHandlers } from './workspace.handlers';

export function registerIpcHandlers(): void {
  registerWorkspaceHandlers();
  registerTerminalHandlers();
  registerGitHandlers();
  registerConfigHandlers();
  registerProjectHandlers();
  registerShellHandlers();
  registerTelemetryHandlers();
  registerAgentSettingsHandlers();
  registerCustomizationHandlers();
  registerDevPreviewHandlers();
  registerToastOverlayHandlers();
  registerAgentsMenuBarHandlers();
  registerPromptDraftHandlers();
  registerAppHandlers();
  registerWindowHandlers();
  registerAskpassHandlers();
  registerVoiceHandlers();
  registerSoundsHandlers();
  registerNotesHandlers();
  registerRemoteControlHandlers();
  registerSettingsHandlers();
  registerAutomationHandlers();
  registerStatusItemsHandlers();
  registerSidebarPanelsHandlers();
  registerHooksHandlers();
  registerPluginsHandlers();
}

// Re-export individual handler registration functions for testing or selective use
export {
  registerWorkspaceHandlers,
  registerTerminalHandlers,
  registerGitHandlers,
  registerConfigHandlers,
  registerProjectHandlers,
  registerShellHandlers,
  registerTelemetryHandlers,
  registerAgentSettingsHandlers,
  registerCustomizationHandlers,
  registerDevPreviewHandlers,
  registerToastOverlayHandlers,
  registerAgentsMenuBarHandlers,
  registerAppHandlers,
  registerWindowHandlers,
  registerAskpassHandlers,
  registerAutomationHandlers,
  registerVoiceHandlers,
  registerSoundsHandlers,
  registerNotesHandlers,
  registerRemoteControlHandlers,
  registerSettingsHandlers,
  registerStatusItemsHandlers,
  registerSidebarPanelsHandlers,
  registerHooksHandlers,
  registerPluginsHandlers,
};
