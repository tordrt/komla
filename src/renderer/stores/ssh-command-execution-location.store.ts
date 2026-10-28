import { create } from 'zustand';

import { resolveSshWorkspaceMode } from '@/types';

import { ACTION_SSH_EXECUTION_LOCATIONS } from '../../shared/types/action';

import { useConfigStore } from './config.store';
import { useProjectsStore } from './projects.store';
import { useSshHostsStore } from './ssh-hosts.store';

import type {
  ActionSshExecutionLocation,
  SshHost,
  SshWorkspaceMode,
  TerminalLaunchLocation,
  Workspace,
} from '@/types';

type ExecutionLocationResolution = TerminalLaunchLocation | null;

interface PendingResolution {
  workspaceId: string;
  projectId: string;
  projectName: string;
  hostName: string;
  resolve: (location: ExecutionLocationResolution) => void;
}

interface SshCommandExecutionLocationState {
  pending: PendingResolution | null;
  choice: SshWorkspaceMode;
  saving: boolean;
  error: string | null;
  requestExecutionLocation: (
    workspace: Workspace,
    actionLocation?: ActionSshExecutionLocation
  ) => Promise<ExecutionLocationResolution>;
  setChoice: (choice: SshWorkspaceMode) => void;
  confirm: () => Promise<void>;
  cancel: () => void;
}

export function supportsLocalCopy(host: SshHost): boolean {
  const localMirror = host.capabilities?.localMirror;
  return (
    localMirror?.platform === 'supported' &&
    localMirror.localRsync === 'available' &&
    localMirror.remoteRsync === 'available'
  );
}

function projectExecutionLocation(mode: SshWorkspaceMode): TerminalLaunchLocation {
  return mode === 'local-mirror-actions' ? 'local-mirror' : 'remote';
}

function findProject(projectId: string | null | undefined) {
  return projectId
    ? useProjectsStore.getState().projects.find((project) => project.id === projectId)
    : undefined;
}

async function findLatestProject(projectId: string) {
  try {
    const projects = await window.api.getProjects();
    return projects.find((project) => project.id === projectId) ?? findProject(projectId);
  } catch {
    return findProject(projectId);
  }
}

async function workspaceStillExists(workspaceId: string): Promise<boolean> {
  try {
    return (await window.api.getWorkspace(workspaceId)) !== undefined;
  } catch {
    // A transient lookup failure should not cancel an otherwise valid command.
    return true;
  }
}

export const useSshCommandExecutionLocationStore = create<SshCommandExecutionLocationState>(
  (set, get) => {
    let resolutionQueue = Promise.resolve();

    const finish = (pending: PendingResolution, location: ExecutionLocationResolution): void => {
      if (get().pending !== pending) return;
      set({ pending: null, saving: false, error: null });
      pending.resolve(location);
    };

    const resolveExecutionLocation = async (
      workspace: Workspace,
      actionLocation?: ActionSshExecutionLocation
    ): Promise<ExecutionLocationResolution> => {
      if (workspace.backend?.kind !== 'ssh') return 'workspace';

      let project = findProject(workspace.projectId);

      if (!(await workspaceStillExists(workspace.id))) {
        return null;
      }
      if (actionLocation === 'remote') return 'remote';

      if (
        !actionLocation &&
        !project &&
        workspace.projectId &&
        !useProjectsStore.getState().hasLoaded
      ) {
        await useProjectsStore.getState().loadProjects();
        project = findProject(workspace.projectId);
      }
      if (!actionLocation && project?.sshWorkspaceMode === 'remote' && workspace.projectId) {
        project = await findLatestProject(workspace.projectId);
        if (project?.sshWorkspaceMode === 'remote') {
          return 'remote';
        }
      }

      if (!useSshHostsStore.getState().hasLoaded) {
        await useSshHostsStore.getState().loadHosts();
      }
      const { hostId } = workspace.backend;
      const host = useSshHostsStore.getState().hosts.find((candidate) => candidate.id === hostId);
      if (!host) return 'remote';

      if (!supportsLocalCopy(host)) return 'remote';
      if (actionLocation === 'local-mirror') return 'local-mirror';

      // Read through persistence because another window may have saved the project choice while
      // host/project loading was pending but its renderer notification may not have arrived yet.
      project = workspace.projectId ? await findLatestProject(workspace.projectId) : undefined;
      if (project?.sshWorkspaceMode !== undefined) {
        return projectExecutionLocation(project.sshWorkspaceMode);
      }
      if (!project) {
        return projectExecutionLocation(
          resolveSshWorkspaceMode(
            useConfigStore.getState().config?.defaultSshWorkspaceMode,
            undefined
          )
        );
      }

      return new Promise<ExecutionLocationResolution>((resolve) => {
        set({
          pending: {
            workspaceId: workspace.id,
            projectId: project.id,
            projectName: project.name,
            hostName: host.name,
            resolve,
          },
          choice: 'remote',
          saving: false,
          error: null,
        });
      });
    };

    return {
      pending: null,
      choice: 'remote',
      saving: false,
      error: null,

      requestExecutionLocation: (workspace, actionLocation) => {
        if (workspace.backend?.kind !== 'ssh') {
          return Promise.resolve('workspace');
        }
        // An unknown location, such as one from a hand-edited actions.json, leaves it to the project.
        const location = ACTION_SSH_EXECUTION_LOCATIONS.find(
          (candidate) => candidate === actionLocation
        );
        // An Action's own location never asks, so it doesn't wait for another project's choice.
        if (location) {
          return resolveExecutionLocation(workspace, location);
        }
        ensureProjectChoiceSubscription();

        const resolution = resolutionQueue.then(() => resolveExecutionLocation(workspace));
        resolutionQueue = resolution.then(
          () => undefined,
          () => undefined
        );
        return resolution;
      },

      setChoice: (choice) => set({ choice }),

      confirm: async () => {
        const pending = get().pending;
        if (!pending) return;
        const choice = get().choice;
        set({ saving: true, error: null });

        try {
          if (!(await workspaceStillExists(pending.workspaceId))) {
            finish(pending, null);
            return;
          }
          const project = await window.api.setProjectSshWorkspaceModeIfUnset(
            pending.projectId,
            choice
          );
          useProjectsStore.setState((state) => ({
            projects: state.projects.map((candidate) =>
              candidate.id === project.id ? project : candidate
            ),
          }));
          finish(pending, projectExecutionLocation(project.sshWorkspaceMode ?? choice));
        } catch (updateError) {
          set({
            saving: false,
            error:
              (updateError as Error).message || 'Failed to save the Terminal Command location.',
          });
        }
      },

      cancel: () => {
        const pending = get().pending;
        if (pending && !get().saving) finish(pending, null);
      },
    };
  }
);

let projectChoiceSubscriptionStarted = false;

function ensureProjectChoiceSubscription(): void {
  if (projectChoiceSubscriptionStarted) return;
  projectChoiceSubscriptionStarted = true;
  useProjectsStore.subscribe((state) => {
    const locationState = useSshCommandExecutionLocationStore.getState();
    const pending = locationState.pending;
    if (!pending) return;

    const project = state.projects.find((candidate) => candidate.id === pending.projectId);
    if (project?.sshWorkspaceMode === undefined) return;

    useSshCommandExecutionLocationStore.setState({
      pending: null,
      saving: false,
      error: null,
    });
    pending.resolve(projectExecutionLocation(project.sshWorkspaceMode));
  });
}
