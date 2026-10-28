import { randomUUID } from 'crypto';
import { join } from 'path';

import { IPC } from '../../shared/constants/ipc-channels';
import { canStartWithPrompt } from '../../shared/lib/agent-preset-prompt';
import { resolveBranchPrefix } from '../../shared/lib/project-git-defaults';
import { shellQuotePosix } from '../../shared/lib/shell-quote';
import { normalizeSshTargetBranch } from '../../shared/lib/ssh-target-branch';
import { isSshWorkspace } from '../../shared/types/workspace';

import { agentPresetService } from './agent-preset.service';
import { AutomationService, type SshAutomation } from './automation/automation-service';
import { createAutomationHostClient } from './automation/host-client';
import { LocalAutomationStore } from './automation/local-store';
import { configService } from './config.service';
import { gitService } from './git.service';
import { getKomlaBasePath } from './paths';
import { projectService } from './project.service';
import { remoteCompanionService } from './remote-companion.service';
import { sshHostService } from './ssh-host.service';
import { sshWorkspaceService } from './ssh-workspace.service';
import { windowService } from './window.service';
import { workspaceService } from './workspace.service';

import type { Automation, AutomationTarget, HostAutomation } from '../../shared/types/automation';
import type { Project } from '../../shared/types/project';

export { AutomationService } from './automation/automation-service';

/** `nightly-deps-20261015-0900`: the automation's name and when the run is for, in its time zone. */
export function automationBranchName(name: string, instant: number, timeZone: string): string {
  const slug =
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .slice(0, 5)
      .join('-')
      .slice(0, 40)
      .replace(/-+$/, '') || 'automation';
  const { year, month, day, hour, minute } = zonedParts(instant, timeZone);
  return `${slug}-${year}${month}${day}-${hour}${minute}`;
}

/** `2026-10-15 09:00 Europe/Oslo`. */
export function automationRunTime(instant: number, timeZone: string): string {
  const { year, month, day, hour, minute } = zonedParts(instant, timeZone);
  return `${year}-${month}-${day} ${hour}:${minute} ${timeZone}`;
}

function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function projectRepoPath(project: {
  managed: boolean;
  managedRepoPath?: string;
  repositoryPath: string;
}) {
  return project.managed && project.managedRepoPath
    ? project.managedRepoPath
    : project.repositoryPath;
}

async function launchLocal(
  automation: Automation,
  request: { trigger: 'schedule' | 'manual'; scheduledFor?: number; startedAt: number }
): Promise<{ workspaceId: string; branch?: string }> {
  const project = automation.projectId ? projectService.get(automation.projectId) : undefined;
  if (!project) throw new Error('Its project is no longer in Komla.');
  const instant = request.scheduledFor ?? request.startedAt;
  const { timeZone } = automation.schedule;
  const isFolder = project.kind === 'directory';
  const created = await workspaceService.create({
    mode: isFolder ? 'directory' : 'worktree',
    projectId: project.id,
    ...(isFolder
      ? {}
      : {
          branchName: automationBranchName(automation.name, instant, timeZone),
          autoResolveBranchConflicts: true,
          // A branch of its own starts from origin's copy too, so each run sees what was pushed.
          ...(automation.startBranch
            ? { baseBranch: automation.startBranch, startFromOrigin: true }
            : {}),
        }),
    customName: automation.name,
    customDescription: `${request.trigger === 'schedule' ? 'Scheduled' : 'Manual'} run · ${automationRunTime(instant, timeZone)}`,
    initialPrompt: automation.prompt,
    ...(automation.presetId ? { presetId: automation.presetId } : {}),
    ...(automation.launchModeId ? { launchModeId: automation.launchModeId } : {}),
    windowId: windowService.getMainWindowId() ?? undefined,
    environment: { kind: 'local' },
    skipRecordUsage: true,
  });
  windowService.broadcastWhenReady(IPC.WORKSPACE_CREATED, created);
  return {
    workspaceId: created.id,
    ...(created.branchName ? { branch: created.branchName } : {}),
  };
}

/** Why the project's automations couldn't run on an SSH host, checked before saving one there. */
export async function automationHostProblem(project: Project): Promise<string | undefined> {
  if (project.kind === 'directory') return "Folder projects can't run on an SSH host.";
  const gitUrl = await gitService.getRemoteUrl(projectRepoPath(project)).catch(() => null);
  return gitUrl ? undefined : `Add a Git remote to ${project.name} to run it on an SSH host.`;
}

/** Why an automation's agent couldn't start with its prompt where it runs, checked before saving. */
export function automationAgentProblem(
  target: AutomationTarget,
  presetId?: string,
  launchModeId?: string
): string | undefined {
  const preset = agentPresetService.getPresetForWorkspace(presetId);
  if (!preset) return 'Choose an agent.';
  if (target.kind === 'ssh') {
    return agentPresetService.resolvePosixPromptTemplate(preset, launchModeId)
      ? undefined
      : `${preset.name} can't start with a prompt on an SSH host.`;
  }
  return canStartWithPrompt(preset) ? undefined : `${preset.name} can't start with a prompt.`;
}

async function compileForHost(automation: SshAutomation): Promise<HostAutomation> {
  const project = automation.projectId ? projectService.get(automation.projectId) : undefined;
  if (!project) throw new Error('Choose a project.');
  if (project.kind === 'directory') {
    throw new Error("Folder projects can't run on an SSH host.");
  }
  const { hostId } = automation.target;
  const gitUrl = await gitService.getRemoteUrl(projectRepoPath(project)).catch(() => null);
  if (!gitUrl) {
    throw new Error(`Add a Git remote to ${project.name} to run it on an SSH host.`);
  }
  const preset = agentPresetService.getPresetForWorkspace(automation.presetId);
  if (!preset) throw new Error('Choose an agent.');
  const template = agentPresetService.resolvePosixPromptTemplate(preset, automation.launchModeId);
  if (!template) {
    throw new Error(`${preset.name} can't start with a prompt on an SSH host.`);
  }
  const baseBranch = normalizeSshTargetBranch(project.baseBranch);
  const startBranch = normalizeSshTargetBranch(automation.startBranch);
  if (startBranch) {
    const branches = await gitService.listBranches(projectRepoPath(project), true);
    if (!branches.some((branch) => branch.remoteRef === `origin/${startBranch}`)) {
      throw new Error(`Push ${startBranch} first: the host starts runs from origin’s copy of it.`);
    }
  }
  const branchPrefix = resolveBranchPrefix(project, configService.get().gitDefaults);
  const { backend } = sshWorkspaceService.createWorkspacePlan({
    hostId,
    gitUrl,
    projectId: project.id,
    projectName: project.name,
    branchName: 'automation',
    baseBranch,
    resolvedBasePath: await sshWorkspaceService.resolveWorkspaceBasePath(hostId),
  });
  return {
    schema: 1,
    id: automation.id,
    name: automation.name,
    prompt: automation.prompt,
    enabled: automation.enabled,
    schedule: automation.schedule,
    missedRunGraceMinutes: automation.missedRunGraceMinutes,
    project: {
      remoteRepoPath: backend.remoteRepoPath,
      remoteProjectRoot: backend.remoteProjectRoot,
      gitUrl: backend.gitUrl,
      projectName: project.name,
      ...(baseBranch ? { baseBranch } : {}),
      ...(branchPrefix ? { branchPrefix } : {}),
    },
    ...(startBranch ? { startBranch } : {}),
    launch: { agentName: preset.name, ...template },
    desktop: {
      projectId: project.id,
      presetId: preset.id,
      ...(automation.launchModeId ? { launchModeId: automation.launchModeId } : {}),
    },
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    writtenBy: configService.getWorkspaceSyncDeviceId(),
  };
}

/** Saves SSH automations again when the Git settings they have compiled in change here. */
export function retargetAutomationsOnGitSettingsChange(): void {
  projectService.onGitSettingsChange((projectId) => {
    void automationService.retargetProject(projectId);
  });
  configService.onBranchPrefixChange(() => {
    for (const project of projectService.list()) {
      if (!project.defaultBranchPrefix) void automationService.retargetProject(project.id);
    }
  });
}

export const automationService = new AutomationService({
  now: () => Date.now(),
  newId: () => randomUUID(),
  local: new LocalAutomationStore(join(getKomlaBasePath(), 'automations.json')),
  hosts: createAutomationHostClient({
    async run(hostId, args, { input, timeoutMs }) {
      const host = sshWorkspaceService.getHost(hostId);
      const basePath = await sshWorkspaceService.resolveWorkspaceBasePath(hostId);
      const executable = await remoteCompanionService.ensureInstalled(host, basePath);
      const command = [executable, ...args].map(shellQuotePosix).join(' ');
      return input === undefined
        ? sshWorkspaceService.run(host, command, {
            purpose: { kind: 'background' },
            timeout: timeoutMs,
          })
        : sshWorkspaceService.runWithInput(host, command, input, { timeout: timeoutMs });
    },
  }),
  hostIds: () =>
    sshHostService
      .list()
      .filter((host) => !host.setupPending)
      .map((host) => host.id),
  hostIdsInUse: () => [
    ...new Set(
      workspaceService
        .list()
        .flatMap((workspace) => (isSshWorkspace(workspace) ? [workspace.backend.hostId] : []))
    ),
  ],
  launchLocal,
  compileForHost,
  async resolveHostAutomations(hostId, automations) {
    const projectOf = await workspaceService.sshRepositoryProjectLookup();
    return automations.map((automation) => {
      const savedProjectId = automation.desktop?.projectId;
      const projectId =
        savedProjectId && projectService.get(savedProjectId)
          ? savedProjectId
          : projectOf({
              hostId,
              remoteRepoPath: automation.project.remoteRepoPath,
              gitUrl: automation.project.gitUrl,
            });
      const savedPresetId = automation.desktop?.presetId;
      const presetId =
        savedPresetId && agentPresetService.get(savedPresetId) ? savedPresetId : undefined;
      return {
        ...(projectId ? { projectId } : {}),
        ...(presetId ? { presetId } : {}),
        ...(presetId && automation.desktop?.launchModeId
          ? { launchModeId: automation.desktop.launchModeId }
          : {}),
      };
    });
  },
  projectGitSettings(projectId) {
    const project = projectService.get(projectId);
    if (!project) return {};
    const baseBranch = normalizeSshTargetBranch(project.baseBranch);
    const branchPrefix = resolveBranchPrefix(project, configService.get().gitDefaults);
    return { ...(baseBranch ? { baseBranch } : {}), ...(branchPrefix ? { branchPrefix } : {}) };
  },
  changed: () => windowService.broadcastWhenReady(IPC.AUTOMATIONS_CHANGED),
});
