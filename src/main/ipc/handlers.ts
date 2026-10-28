// Re-export from the new modular structure
export {
  registerIpcHandlers,
  registerWorkspaceHandlers,
  registerTerminalHandlers,
  registerGitHandlers,
  registerLicenseHandlers,
  registerConfigHandlers,
  registerProjectHandlers,
  registerShellHandlers,
  registerAgentSettingsHandlers,
  registerCustomizationHandlers,
  registerAppHandlers,
  registerWindowHandlers,
  registerAskpassHandlers,
  registerSettingsHandlers,
} from './handlers/index';
