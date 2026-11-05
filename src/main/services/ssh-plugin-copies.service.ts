import { createLogger } from '../lib/logger';

import { providePluginHostFolders } from './plugin-environment';
import { pluginsService } from './plugins.service';
import { sshPluginCopyHost } from './ssh-plugin-copies/host';
import { SshPluginCopies } from './ssh-plugin-copies/ssh-plugin-copies';
import { sshWorkspaceService } from './ssh-workspace.service';
import { workspaceService } from './workspace.service';

const logger = createLogger('SshPluginCopies');

export const sshPluginCopies = new SshPluginCopies({
  ...sshPluginCopyHost,
  plugins: () => pluginsService.pluginsForSshHosts(),
  files: (pluginId, digest) => pluginsService.pluginFiles(pluginId, digest),
  now: () => Date.now(),
});

/**
 * Gives plugins' commands on SSH hosts their copies there, and keeps each host's copies to the
 * plugins that run as SSH Workspace Sync reads it.
 */
export function startSshPluginCopies(): void {
  providePluginHostFolders(async (hostId, pluginId, wait) =>
    wait ? sshPluginCopies.folder(hostId, pluginId) : sshPluginCopies.knownFolder(hostId, pluginId)
  );
  sshWorkspaceService.onForgetHost((hostId) => sshPluginCopies.forgetHost(hostId));
  workspaceService.onSshHostSynced((hostId) => {
    void sshPluginCopies.syncHost(hostId).catch((error) => {
      logger.warn(`Could not sync plugins to SSH host ${hostId}`, error);
    });
  });
}
