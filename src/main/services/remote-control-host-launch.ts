// What a phone may start on an SSH host while it talks to the host directly (ADR 0005): the
// projects whose workspaces would go there and each agent's POSIX launch commands. The desktop
// writes it to the host as `launch.json` next to the phone trust file. Only projects with a workspace
// on that host go there, and the host offers only those whose repository it already has.

import { projectColorHex } from '../../shared/lib/project-color';
import { resolveBranchPrefix } from '../../shared/lib/project-git-defaults';
import { projectRepoPath } from '../../shared/lib/project-repo-path';
import { normalizeSshTargetBranch } from '../../shared/lib/ssh-target-branch';
import { createLogger } from '../lib/logger';

import { agentPresetService } from './agent-preset.service';
import { configService } from './config.service';
import { gitService } from './git.service';
import { projectService } from './project.service';
import { sshWorkspaceService } from './ssh-workspace.service';

import type { AgentPreset, ActivePresetEntry } from '../../shared/types/agent-preset';
import type { Project } from '../../shared/types/project';
import type { RemoteAgentPresetSummary, RemoteProjectSummary } from '@komla/remote-protocol';

const logger = createLogger('RemoteControlHostLaunch');

export function remoteProjectSummary(project: Project): RemoteProjectSummary {
  const color = projectColorHex(project.color, project.name);
  return {
    id: project.id,
    name: project.name,
    repositoryPath: project.repositoryPath,
    ...(color ? { color } : {}),
  };
}

export function remotePresetSummary(
  preset: AgentPreset,
  entry: Pick<ActivePresetEntry, 'lastLaunchModeId'>,
  launchModes = preset.launchModes
): RemoteAgentPresetSummary {
  return {
    id: preset.id,
    name: preset.name,
    launchModes: launchModes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.color ? { color: mode.color } : {}),
    })),
    ...(entry.lastLaunchModeId !== undefined ? { lastLaunchModeId: entry.lastLaunchModeId } : {}),
  };
}

interface HostLaunchProject {
  summary: RemoteProjectSummary;
  remoteRepoPath: string;
  remoteProjectRoot: string;
  gitUrl: string;
  projectName: string;
  baseBranch?: string;
  branchPrefix?: string;
}

interface HostLaunchPreset {
  summary: RemoteAgentPresetSummary;
  launches: Array<{
    launchModeId?: string;
    promptCommand: string;
    openCommand: string;
    continueCommand?: string;
  }>;
}

/** Which projects have a workspace on an SSH host; the workspace service fills it in. */
const workspaces: { projectIdsOnHost: (hostId: string) => ReadonlySet<string> } = {
  projectIdsOnHost: () => new Set(),
};

export function configureHostLaunch(adapter: typeof workspaces): void {
  Object.assign(workspaces, adapter);
}

export interface HostLaunchFile {
  version: 1;
  hostId: string;
  defaultLaunchModeId?: string;
  projects: HostLaunchProject[];
  presets: HostLaunchPreset[];
}

async function hostProject(
  hostId: string,
  basePath: string,
  project: Project
): Promise<HostLaunchProject | null> {
  if (project.kind === 'directory') return null;
  const gitUrl = await gitService.getRemoteUrl(projectRepoPath(project)).catch(() => null);
  if (!gitUrl) return null;
  const baseBranch = normalizeSshTargetBranch(project.baseBranch);
  const branchPrefix = resolveBranchPrefix(project, configService.get().gitDefaults);
  const { backend } = sshWorkspaceService.createWorkspacePlan({
    hostId,
    gitUrl,
    projectId: project.id,
    projectName: project.name,
    branchName: 'phone',
    baseBranch,
    resolvedBasePath: basePath,
  });
  return {
    summary: { ...remoteProjectSummary(project), repositoryPath: backend.remoteProjectRoot },
    remoteRepoPath: backend.remoteRepoPath,
    remoteProjectRoot: backend.remoteProjectRoot,
    gitUrl: backend.gitUrl,
    projectName: project.name,
    ...(baseBranch ? { baseBranch } : {}),
    ...(branchPrefix ? { branchPrefix } : {}),
  };
}

function hostPreset(entry: ActivePresetEntry): HostLaunchPreset | null {
  const preset = agentPresetService.get(entry.presetId);
  if (!preset) return null;
  const launches = [undefined, ...preset.launchModes.map((mode) => mode.id)].flatMap(
    (launchModeId) => {
      const template = agentPresetService.resolvePosixPromptTemplate(preset, launchModeId);
      if (!template) return [];
      const continueCommand = agentPresetService.resolvePosixContinueCommand(preset, launchModeId);
      return [
        {
          ...(launchModeId ? { launchModeId } : {}),
          ...template,
          ...(continueCommand ? { continueCommand } : {}),
        },
      ];
    }
  );
  if (!launches.length) return null;
  // A mode the host can't start stays off the phone rather than starting another one.
  const launchModes = preset.launchModes.filter((mode) =>
    launches.some((launch) => launch.launchModeId === mode.id)
  );
  return { summary: remotePresetSummary(preset, entry, launchModes), launches };
}

/** One malformed project or agent leaves the file without it rather than failing the sync. */
async function skipFailed<T>(kind: string, id: string, build: () => Promise<T | null>) {
  try {
    return await build();
  } catch (error) {
    logger.warn(`could not add ${kind} to SSH host launch options`, {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** `launch.json` for the host whose Komla data directory is `basePath`. */
export async function buildHostLaunchFile(hostId: string, basePath: string): Promise<string> {
  const onHost = workspaces.projectIdsOnHost(hostId);
  const projects = await Promise.all(
    projectService
      .list()
      .filter((project) => onHost.has(project.id))
      .map((project) =>
        skipFailed('project', project.id, () => hostProject(hostId, basePath, project))
      )
  );
  const presets = await Promise.all(
    agentPresetService
      .getActivePresets()
      .map((entry) => skipFailed('agent', entry.presetId, async () => hostPreset(entry)))
  );
  const defaultLaunchModeId = configService.get().defaultLaunchModeId;
  const file: HostLaunchFile = {
    version: 1,
    hostId,
    ...(defaultLaunchModeId ? { defaultLaunchModeId } : {}),
    projects: projects.filter((project): project is HostLaunchProject => project !== null),
    presets: presets.filter((preset): preset is HostLaunchPreset => preset !== null),
  };
  return JSON.stringify(file);
}
