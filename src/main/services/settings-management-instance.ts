import { join } from 'path';

import { nativeTheme } from 'electron';

import { actionService } from './action.service';
import { agentPresetService } from './agent-preset.service';
import {
  automationAgentProblem,
  automationHostProblem,
  automationService,
} from './automation.service';
import { configService } from './config.service';
import { customizationService } from './customization.service';
import { getKomlaBasePath } from './paths';
import { pluginsService } from './plugins.service';
import { projectService } from './project.service';
import { settingsApprovalService } from './settings-approval.service';
import { createSettingsFiles } from './settings-files';
import { SettingsManagementService } from './settings-management.service';
import { shortcutsService } from './shortcuts.service';
import { sshHostService } from './ssh-host.service';
import { workspaceCwdResolutionService } from './workspace-cwd-resolution.service';
import { workspaceService } from './workspace.service';

let settingsService: SettingsManagementService | null = null;

/** The service over Komla's own settings, created when first asked for. */
export function getSettingsManagementService(): SettingsManagementService {
  if (settingsService) return settingsService;
  settingsService = new SettingsManagementService({
    actions: actionService,
    projects: projectService,
    workspaces: workspaceService,
    resolveProjectByCwd: (cwd, sshHostId) => {
      const result = workspaceCwdResolutionService.findProjectByCwd(cwd, {
        workspaces: workspaceService
          .list()
          .filter(
            (workspace) =>
              !sshHostId ||
              (workspace.backend?.kind === 'ssh' && workspace.backend.hostId === sshHostId)
          ),
        getProject: (id) => projectService.get(id),
        komlaBasePath: getKomlaBasePath(),
      });
      return {
        project: result.project,
        workspace: result.sourceWorkspace,
        error: result.error,
      };
    },
    presets: agentPresetService,
    appearance: {
      get: () => customizationService.getTheme(),
      systemIsDark: () => nativeTheme.shouldUseDarkColors,
      set: (settings) => customizationService.setAppearance(settings),
    },
    environmentConfiguration: () => {
      const config = configService.get();
      return {
        lastWorkspaceEnvironment: config.lastWorkspaceEnvironment,
        defaultSshWorkspaceMode: config.defaultSshWorkspaceMode,
        sshHosts: sshHostService
          .list()
          .filter((host) => !host.setupPending)
          .map(({ id }) => ({ id })),
      };
    },
    files: createSettingsFiles({
      settingsPath: join(getKomlaBasePath(), 'settings'),
      shortcuts: {
        get: () => shortcutsService.getConfig().shortcuts,
        update: (shortcuts) => shortcutsService.updateConfig({ shortcuts }),
      },
      terminal: {
        get: () => customizationService.getTerminal(),
        update: (updates) => customizationService.updateTerminal(updates),
      },
      presets: agentPresetService,
      plugins: pluginsService,
    }),
    automations: {
      list: () => automationService.list(),
      listCurrent: (options) => automationService.listCurrent(options),
      hostProblem: (project) => automationHostProblem(project),
      agentProblem: (target, presetId, launchModeId) =>
        automationAgentProblem(target, presetId, launchModeId),
      save: (params) => automationService.save(params),
      setEnabled: (target, id, enabled) => automationService.setEnabled(target, id, enabled),
      delete: (target, id) => automationService.delete(target, id),
      hostName: (hostId) => sshHostService.get(hostId)?.name,
      timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
    approve: (request, signal) => settingsApprovalService.approve(request, signal),
    feedback: (message, workspace) => settingsApprovalService.sendFeedback(message, workspace),
  });
  return settingsService;
}
