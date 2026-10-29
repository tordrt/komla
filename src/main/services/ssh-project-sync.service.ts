import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { isSshWorkspace } from '../../shared/types/workspace';
import { writeFileAtomic } from '../lib/atomic-write';

import { actionService } from './action.service';
import { agentPresetService } from './agent-preset.service';
import { configService } from './config.service';
import { getKomlaBasePath } from './paths';
import { projectService } from './project.service';
import { sshProjectSyncHost } from './ssh-project-sync/host';
import { SshProjectSync } from './ssh-project-sync/ssh-project-sync';
import { workspaceService } from './workspace.service';

import type { Project } from '../../shared/types';

function agreementsPath(): string {
  return join(getKomlaBasePath(), 'ssh-project-sync.json');
}

export const sshProjectSync = new SshProjectSync({
  host: sshProjectSyncHost,
  projects: {
    get: (id) => projectService.get(id),
    onHost: (hostId) => {
      const found = new Map<string, { project: Project; gitUrl: string }>();
      for (const workspace of workspaceService.list()) {
        if (!isSshWorkspace(workspace) || workspace.backend.hostId !== hostId) continue;
        const project = projectService.get(workspace.projectId);
        if (!project || project.kind === 'directory' || found.has(project.id)) continue;
        found.set(project.id, { project, gitUrl: workspace.backend.gitUrl });
      }
      return [...found.values()];
    },
    lookup: () => workspaceService.gitRemoteProjectLookup(),
    createFromRemote: async ({ name, ...params }) => {
      // A project here with that name but another repository gets the repository's own name.
      const taken = projectService
        .list()
        .some((project) => project.name.trim().toLowerCase() === name?.trim().toLowerCase());
      const project = await projectService.createFromRemote(taken ? params : { ...params, name });
      // The host's workspaces of this repository join it.
      await workspaceService.assignSshWorkspaceProjects();
      return project;
    },
    update: (id, updates) => projectService.update(id, updates),
  },
  actions: {
    list: () => actionService.list(),
    replaceAll: (actions) => {
      actionService.replaceAll(actionService.getStorageRevision(), actions);
    },
  },
  presets: () => agentPresetService.list(),
  now: () => Date.now(),
  deviceId: () => configService.getWorkspaceSyncDeviceId(),
  agreements: {
    read: () => {
      const path = agreementsPath();
      return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
    },
    write: (content) => writeFileAtomic(agreementsPath(), content),
  },
});

/** Publishes project settings each time SSH Workspace Sync reads a host. */
export function startSshProjectSync(): void {
  workspaceService.onSshHostSynced((hostId) => {
    void sshProjectSync.syncHost(hostId);
  });
}
