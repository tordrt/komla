import { existsSync, readFileSync } from 'fs';
import { join, posix as pathPosix } from 'path';

import { BrowserWindow } from 'electron';

import { turnedOffQueuedCommands } from '../../shared/constants/agent-capabilities';
import { IPC } from '../../shared/constants/ipc-channels';
import { branchSuffixToName } from '../../shared/lib/random-names';
import { normalizeRecentLinks } from '../../shared/lib/recent-links';
import { normalizeSavedLayout } from '../../shared/lib/saved-layout';
import {
  isResumable,
  runningTerminalCount,
  sessionEndedHere,
} from '../../shared/lib/terminal-execution-state';
import { normalizeVirtualDesktops } from '../../shared/lib/virtual-desktops';
import { withoutWorkspaceMarker } from '../../shared/lib/workspace-markers';
import {
  normalizeWorkspaceTags,
  pullRequestTagUpdate,
  workspaceTagAppearance,
  type PullRequestTagState,
} from '../../shared/lib/workspace-tags';
import {
  attentionWakesSnooze,
  isSshWorkspace,
  isWorkspaceSnoozed,
} from '../../shared/types/workspace';
import { writeFileAtomic } from '../lib/atomic-write';
import { publishAttentionHookEvent, publishHookEvent } from '../lib/hook-events';
import { publishWorkingTreeEvents } from '../lib/komla-events';
import { createLogger } from '../lib/logger';
import { sshConnectionFailure } from '../lib/ssh-connection-failure';
import {
  onTerminalOscNotification,
  onTerminalProgramStatus,
  onTerminalTitle,
} from '../lib/terminal-notification-events';

import { actionService } from './action.service';
import { agentPresetService } from './agent-preset.service';
import { backgroundProcessService } from './background-process.service';
import { configService } from './config.service';
import { executionLocations } from './execution-location';
import { gitService } from './git.service';
import { localCopyService } from './local-copy.service';
import {
  configureManagedRemoteTerminalLifecycle,
  managedRemoteTerminalLifecycleService,
} from './managed-remote-terminal-lifecycle.service';
import { ensureKomlaBasePath, getKomlaBasePath } from './paths';
import { projectService } from './project.service';
import { ptyService } from './pty.service';
import { remoteCompanionService, resolveRemoteCompanionRuntime } from './remote-companion.service';
import { remoteControlHostAccessService } from './remote-control-host-access.service';
import { configureHostLaunch } from './remote-control-host-launch';
import {
  configureRemoteWorkspaceObservation,
  remoteWorkspaceObservationService,
} from './remote-workspace-observation.service';
import { sshHostService } from './ssh-host.service';
import { sshPortForwardService } from './ssh-port-forward.service';
import { configureSshWorkspaceProvisioning } from './ssh-workspace-provisioning.service';
import { sshWorkspaceSyncHost } from './ssh-workspace-sync/host';
import { SshWorkspaceSync } from './ssh-workspace-sync/ssh-workspace-sync';
import { sshCompanionInstallationId, sshWorkspaceService } from './ssh-workspace.service';
import { telemetryService } from './telemetry.service';
import { FolderTrustWatch } from './terminal-attention/folder-trust-watch';
import { TerminalAttention, type AgentHook } from './terminal-attention/terminal-attention';
import { electronAttentionWindows } from './terminal-attention/windows';
import { resolveAgentCommand, resolvePreset } from './workspace/agent-launch';
import { relayInterrupt, SshAttentionPersistence } from './workspace/attention-persistence';
import {
  checkWorkspacesForCleanup,
  getBranchCleanupScope,
  listHostBranches,
} from './workspace/branch-cleanup';
import { WorkspaceCreation } from './workspace/creation';
import { WorkspaceLifecycle } from './workspace/lifecycle';
import {
  initializeLocalCopy,
  prepareLocalCopy,
  requestSshLocalCopySync,
  retryLocalCopySync,
} from './workspace/local-copy';
import { WorkspaceNaming } from './workspace/naming';
import { hydrateWorkspace } from './workspace/persisted-workspace';
import {
  managedWorktree,
  moveFoldersIntoProjects,
  propagateProjectBaseBranch,
  registerBaseBranches,
} from './workspace/projects';
import { WorkspaceProvisioning } from './workspace/provisioning';
import { SshWorkspaceAdoption } from './workspace/ssh-adoption';
import { SshSessionRecovery } from './workspace/ssh-sessions';
import { notifyListeners, workspaceStore } from './workspace/store';
import { WorkspaceTerminals } from './workspace/terminals';
import {
  AUTO_BRANCH_MAX_ATTEMPTS,
  createAutoBranchCandidate,
  createBranchConflictError,
  deriveBranchSuffixForName,
} from './workspace/worktree-branches';
import { sshWorkspaceGit } from './workspace-git/ssh-git';
import { backgroundActionNotification } from './workspace-setup/action-run-notification';
import { writeWorkspaceSecretFile } from './workspace-setup/secret-file-writing';
import { configureWorkspaceSetup, workspaceSetupService } from './workspace-setup.service';
import { wakeWorkspace, WorkspaceSnoozeAlarm } from './workspace-snooze';
import { configureWorkspaceStatus, workspaceStatusService } from './workspace-status.service';
import { worktreeWatcherService } from './worktree-watcher.service';

import type { BackgroundActionLaunch } from './workspace-setup/automation';
import type {
  CreateWorkspaceParams,
  Terminal,
  TerminalStatus,
  Workspace,
  WorkspaceAttention,
  WorkspaceAttentionEvent,
} from '../../shared/types';
import type { SshWorkspaceLaunch } from '../../shared/types/ssh-workspace-manifest';

// Re-export types for consumers that import from this module
export type { TerminalStatus, Terminal, Workspace, CreateWorkspaceParams };

const logger = createLogger('WorkspaceService');

/** The SSH workspace copies last seen on their hosts, which merges after a restart start from. */
function sshWorkspaceSyncPath(): string {
  return join(getKomlaBasePath(), 'ssh-workspace-sync.json');
}

/** Whether this installation shares an SSH host's workspaces with other installations; on by default. */
function syncsSshWorkspaces(hostId: string): boolean {
  return !configService.get().workspaceSyncDisabledHostIds?.includes(hostId);
}

/** The workspace's agent commands, for the host's CLI to start new workspaces while Komla is disconnected. */
function sshWorkspaceLaunch(workspace: Workspace): SshWorkspaceLaunch | undefined {
  const preset = agentPresetService.getPresetForWorkspace?.(workspace.presetId);
  const template =
    preset && agentPresetService.resolvePosixPromptTemplate?.(preset, workspace.launchModeId);
  if (!template) return undefined;
  const continueCommand = agentPresetService.resolvePosixContinueCommand?.(
    preset,
    workspace.launchModeId
  );
  return { agentName: preset.name, ...template, ...(continueCommand ? { continueCommand } : {}) };
}

worktreeWatcherService.onObservation = (snapshot) =>
  workspaceStatusService.change({ kind: 'snapshot-observed', snapshot });

// Agent hooks arrive with every tool call; a minute is precise enough for Recent and "x ago".
const AGENT_TURN_ACTIVITY_INTERVAL_MS = 60 * 1000;

/** A local workspace outside the Trash that has finished being created, which a launch can restart. */
function isRestorable(workspace: Workspace): boolean {
  return workspace.status === 'active' && !workspace.provisioning && !isSshWorkspace(workspace);
}

/**
 * What the rest of the app asks of workspaces. It wires the modules in ./workspace to each other
 * and to the services around them, in the order startup needs, and keeps what spans them.
 */
class WorkspaceService {
  readonly sshSync: SshWorkspaceSync;
  readonly attention: TerminalAttention;
  private readonly folderTrust: FolderTrustWatch;
  private readonly naming: WorkspaceNaming;
  private readonly terminals: WorkspaceTerminals;
  private readonly creation: WorkspaceCreation;
  private readonly lifecycle: WorkspaceLifecycle;
  private readonly sessions: SshSessionRecovery;
  private readonly adoption: SshWorkspaceAdoption;
  private readonly sshAttention: SshAttentionPersistence;
  // The workspaces each window shows a browser or note pane of, by window id.
  private paneSurfaceWorkspaceIdsByWindow = new Map<string, ReadonlySet<string>>();
  private readonly snoozeAlarm = new WorkspaceSnoozeAlarm({
    workspaces: () => workspaceStore.workspaces.values(),
    woke: (workspaces) => {
      workspaceStore.saveWorkspaces();
      for (const workspace of workspaces) workspaceStore.broadcastWorkspaceUpdate(workspace);
      this.attention.workspaceStatusChanged();
    },
  });
  private attentionListeners = new Set<(event: WorkspaceAttentionEvent) => void>();
  private promptSubmitListeners = new Set<(terminalId: string) => void>();

  constructor() {
    const komlaPath = ensureKomlaBasePath();
    this.sshSync = new SshWorkspaceSync({
      host: sshWorkspaceSyncHost,
      store: {
        workspaces: () => workspaceStore.workspaces.values(),
        get: (workspaceId) => workspaceStore.workspaces.get(workspaceId),
        isDeleting: (workspaceId) => workspaceStore.isDeleting(workspaceId),
        projectLookup: async () => {
          const projectsByRemote = await this.adoption.projectsByGitRemote();
          return (repository) =>
            this.adoption.sshRepositoryProject(repository, projectsByRemote)?.id ?? null;
        },
        add: (hostId, manifest, placement) =>
          this.adoption.addAdoptedSshWorkspace(hostId, manifest, placement),
        deleteHere: (workspaceId) =>
          this.lifecycle.delete(workspaceId, true, false, { skipBackendCleanup: true }),
        hostSynced: (hostId) => {
          this.adoption.notifySshHostSynced(hostId);
          return this.sessions.findSshSessionsOnHost(hostId).catch((error) => {
            logger.warn('Could not check which SSH workspace sessions run on their host', {
              hostId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
        applyMerged: (workspaceId, merged) =>
          this.adoption.applyMergedSshWorkspace(workspaceId, merged),
        changeStatus: (workspaceId, status) =>
          this.adoption.applySshWorkspaceStatusFromOtherDevice(workspaceId, status),
        removeTerminal: (workspaceId, terminalId) =>
          this.terminals.removeTerminal(workspaceId, terminalId),
        save: () => workspaceStore.saveWorkspaces(),
        changed: (workspaceId) => {
          const workspace = workspaceStore.workspaces.get(workspaceId);
          if (workspace) workspaceStore.broadcastWorkspaceUpdate(workspace);
        },
        layoutChanged: (workspaceId, { addedTerminalIds, arranged }) => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed()) continue;
            window.webContents.send(IPC.WORKSPACE_LAYOUT_CHANGED_ON_OTHER_DEVICE, {
              workspaceId,
              terminalIds: addedTerminalIds,
              arranged,
            });
          }
        },
        markMissing: (workspaceId) => this.adoption.markSshWorkspaceRemoved(workspaceId),
        markFound: (workspaceId) => this.adoption.markSshWorkspaceFound(workspaceId),
        removeDeletedElsewhere: (workspaceId) =>
          this.adoption.removeSshWorkspaceDeletedElsewhere(workspaceId),
      },
      now: () => Date.now(),
      deviceId: () => configService.getWorkspaceSyncDeviceId(),
      syncsWith: (hostId) => syncsSshWorkspaces(hostId),
      launch: sshWorkspaceLaunch,
      tag: (workspace) =>
        workspace.tag
          ? workspaceTagAppearance(
              normalizeWorkspaceTags(configService.get().workspaceTags),
              workspace.tag
            )
          : undefined,
      inUse: () => BrowserWindow.getFocusedWindow() !== null,
      pushes: (hostId) => remoteWorkspaceObservationService.companionForHost(hostId) !== undefined,
      hostCopies: {
        read: () => {
          const path = sshWorkspaceSyncPath();
          return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
        },
        write: (content) => writeFileAtomic(sshWorkspaceSyncPath(), content),
      },
    });
    this.attention = new TerminalAttention({
      store: {
        workspaces: () => workspaceStore.workspaces.values(),
        get: (workspaceId) => workspaceStore.workspaces.get(workspaceId),
        broadcast: (workspace) => workspaceStore.broadcastWorkspaceUpdate(workspace),
        save: () => workspaceStore.saveWorkspaces(),
        saveNow: (workspaceId) => this.sshAttention.persistSshAttention(workspaceId),
      },
      windows: {
        ...electronAttentionWindows,
        attentionRaised: (raised) => {
          this.wakeSnoozedForAttention(raised.workspaceId, raised.attention);
          // Decided here, after the wake: the windows have the workspace's new snooze already.
          const workspace = workspaceStore.workspaces.get(raised.workspaceId);
          const event = { ...raised, snoozed: !!workspace && isWorkspaceSnoozed(workspace) };
          electronAttentionWindows.attentionRaised(event);
          publishAttentionHookEvent(event);
          notifyListeners(this.attentionListeners, event);
        },
      },
      relay: {
        interrupted: (workspace, terminalId, sources) =>
          relayInterrupt(workspace, terminalId, sources),
      },
      promptSubmitted: (workspaceId, prompt, terminalId) => {
        this.naming.recordPromptSubmit(workspaceId, prompt, terminalId);
        if (terminalId) notifyListeners(this.promptSubmitListeners, terminalId);
        publishHookEvent({
          event: 'agent.prompt',
          workspaceId,
          ...(terminalId && { terminalId }),
          message: prompt,
        });
      },
      agentReplied: (workspaceId, reply, terminalId) =>
        this.naming.recordAgentReply(workspaceId, reply, terminalId),
      turnActivity: (workspaceId) => this.recordAgentTurnActivity(workspaceId),
      milestone: (name, properties) => telemetryService.sendIntegrationMilestone(name, properties),
      agentReported: (workspace, source, terminalId) =>
        this.folderTrust.agentReported(workspace.projectId, source, terminalId),
    });
    this.folderTrust = new FolderTrustWatch({
      projectOf: (terminalId) =>
        workspaceStore.findWorkspaceByTerminalId(terminalId)?.projectId ?? undefined,
      isDone: (projectId, agent) => projectService.isFolderTrustWatchDone(projectId, agent),
      markDone: (projectId, agent) => projectService.markFolderTrustWatchDone(projectId, agent),
      readScreen: async (terminalId) => (await ptyService.readText(terminalId, 0))?.text,
      asked: (terminalId, agent) => this.attention.folderTrustAsked(terminalId, agent),
      answered: (terminalId, agent) => this.attention.folderTrustAnswered(terminalId, agent),
    });
    ptyService.onReset((terminalId) => this.folderTrust.started(terminalId));
    ptyService.onData((terminalId, data) => this.folderTrust.output(terminalId, data));
    ptyService.onExit((terminalId) => this.folderTrust.ended(terminalId));
    workspaceStore.attach({
      workspacesPath: join(komlaPath, 'workspaces.json'),
      terminalStatus: (terminalId) => ptyService.getStatus(terminalId),
      saving: (workspaces) => this.sshSync.saved(workspaces),
      persistedSources: (workspaceId, terminalId) =>
        this.attention.persistedSources(workspaceId, terminalId),
    });
    const { attention, sshSync } = this;
    const naming = new WorkspaceNaming();
    const terminals = new WorkspaceTerminals({ attention });
    const provisioning = new WorkspaceProvisioning({ attention, naming, terminals });
    const lifecycle = new WorkspaceLifecycle({
      attention,
      sshSync,
      naming,
      terminals,
      provisioning,
    });
    this.naming = naming;
    this.terminals = terminals;
    this.lifecycle = lifecycle;
    this.creation = new WorkspaceCreation({ attention, naming, terminals, provisioning });
    this.sessions = new SshSessionRecovery({ attention, sshSync });
    this.adoption = new SshWorkspaceAdoption({ attention, lifecycle, naming });
    this.sshAttention = new SshAttentionPersistence();
    onTerminalTitle((terminalId, title) => {
      if (title === null) this.attention.attachmentEnded(terminalId);
      else this.attention.titleChanged(terminalId, title);
    });
    onTerminalProgramStatus((terminalId, status) =>
      this.attention.programStatusChanged(terminalId, status)
    );
    onTerminalOscNotification((alert) => this.attention.alertRaised(alert));
    configureSshWorkspaceProvisioning({
      listWorkspaces: () => Array.from(workspaceStore.workspaces.values()),
      saveWorkspaces: () => workspaceStore.saveWorkspaces(),
      persistWorkspaces: () => workspaceStore.saveWorkspacesImmediateChecked(),
      broadcastWorkspaceUpdate: (workspace) => workspaceStore.broadcastWorkspaceUpdate(workspace),
      maxAttempts: AUTO_BRANCH_MAX_ATTEMPTS,
      nextBranchName: (base, prefix, attempt, exact) =>
        createAutoBranchCandidate(base, prefix, attempt, exact),
      workspaceName: (branch, prefix) =>
        branchSuffixToName(deriveBranchSuffixForName(branch, prefix)),
      branchConflictError: (branch, workspace) => createBranchConflictError(branch, workspace),
      installCompanion: (backend) =>
        remoteCompanionService.ensureInstalled(
          sshWorkspaceService.getHost(backend.hostId),
          pathPosix.dirname(pathPosix.dirname(backend.remoteProjectRoot))
        ),
      ssh: sshWorkspaceService,
    });
    gitService.setManagedWorktreeLookup((path) => managedWorktree(path));
    this.loadWorkspaces();
    this.snoozeAlarm.check({ startup: true });
    configureWorkspaceSetup({
      getWorkspace: (workspaceId) => workspaceStore.workspaces.get(workspaceId),
      broadcastWorkspaceUpdate: (workspace) => workspaceStore.broadcastWorkspaceUpdate(workspace),
      addTerminal: (...args) => this.terminals.addTerminal(...args),
      resolvePreset: (presetId, workspace) => resolvePreset(presetId, workspace),
      resolveAgentCommand: (preset, prompt, launchModeId, reasoningLevelId, modelId) =>
        resolveAgentCommand(
          preset,
          prompt,
          launchModeId,
          undefined,
          reasoningLevelId,
          undefined,
          modelId
        ),
      locations: executionLocations,
      prepareLocalCopy: (workspaceId) => prepareLocalCopy(workspaceId),
      projects: projectService,
      actions: actionService,
      presets: agentPresetService,
      hosts: sshHostService,
      ssh: sshWorkspaceService,
      background: backgroundProcessService,
      writeSecretFile: (workspace, step, destination) =>
        writeWorkspaceSecretFile(workspace, step, destination),
      notifyActionRunFinished: (workspace, run) =>
        this.notifyWorkspace(workspace, backgroundActionNotification(run)),
    });
    configureWorkspaceStatus({
      getWorkspace: (workspaceId) => workspaceStore.workspaces.get(workspaceId),
      listWorkspaces: () => Array.from(workspaceStore.workspaces.values()),
      saveWorkspaces: () => workspaceStore.saveWorkspaces(),
      broadcastWorkspaceUpdate: (workspace) => workspaceStore.broadcastWorkspaceUpdate(workspace),
      publishWorkingTreeChange: (
        workspaceId,
        changeTypes,
        activityAt,
        remoteChange,
        filesChanged
      ) => {
        // A status refresh confirms the files again; working-tree.changed is for when they change.
        publishWorkingTreeEvents(
          workspaceId,
          filesChanged ? changeTypes : changeTypes.filter((type) => type !== 'file')
        );
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            // SSH workspaces push no file or git status here; the observation carries it.
            window.webContents.send(
              IPC.GIT_STATUS_WORKTREE_CHANGED,
              workspaceId,
              changeTypes,
              activityAt,
              undefined,
              undefined,
              remoteChange
            );
          }
        }
      },
      requestLocalCopySync: (workspaceId) => requestSshLocalCopySync(workspaceId),
      isLocalCopyCurrent: (workspaceId) => localCopyService.isCurrent(workspaceId),
      getSshSnapshot: (backend, targetBranch) => sshWorkspaceGit.getSnapshot(backend, targetBranch),
      restartLocalWatcher: (workspaceId, workingDirectory) =>
        worktreeWatcherService.restartWatching(workspaceId, workingDirectory),
      now: () => Date.now(),
    });
    void workspaceStatusService.change({ kind: 'restore' });
    configureRemoteWorkspaceObservation({
      listWorkspaces: () => Array.from(workspaceStore.workspaces.values()),
      ensureKomlaDataTunnel: (hostId, localPort, onConnected) =>
        sshPortForwardService.ensureKomlaDataTunnel(hostId, localPort, onConnected),
      stopKomlaDataTunnelsExcept: (activeHostIds) =>
        sshPortForwardService.stopKomlaDataTunnelsExcept(activeHostIds),
      getHost: (hostId) => sshWorkspaceService.getHost(hostId),
      ensureRemoteNotificationScript: (backend) =>
        sshWorkspaceService.ensureRemoteNotificationScript(backend),
      ensureRemoteCompanion: (host, options) =>
        remoteCompanionService.ensureRunning(host, {
          ...options,
          turnedOffCommands: turnedOffQueuedCommands(configService.get()),
        }),
      invalidateRemoteCompanion: (hostId) => remoteCompanionService.invalidateHost(hostId),
      companionInstallationId: (hostId) => sshCompanionInstallationId(hostId),
      workspaceSyncDeviceId: () => configService.getWorkspaceSyncDeviceId(),
      resolveCompanionRuntime: (remoteBasePath, installationId) =>
        resolveRemoteCompanionRuntime(remoteBasePath, installationId),
      markRemoteDisconnected: (workspaceIds) =>
        workspaceStatusService.change({ kind: 'remote-source-unreachable', workspaceIds }),
      refreshWorkspaceStatus: (workspaceId, reason) =>
        workspaceStatusService.change({ kind: 'refresh-requested', workspaceId, reason }),
      isWorkspaceDeleting: (workspaceId) => workspaceStore.deletingWorkspaceIds.has(workspaceId),
      hostConnected: (hostId) => {
        this.attention.hostConnected(hostId);
        void this.sshSync.syncSoon(hostId, { now: true });
        remoteControlHostAccessService.hostConnected(hostId);
      },
    });
    configureHostLaunch({
      projectIdsOnHost: (hostId) =>
        new Set(
          Array.from(workspaceStore.workspaces.values()).flatMap((workspace) =>
            workspace.backend?.kind === 'ssh' &&
            workspace.backend.hostId === hostId &&
            workspace.projectId
              ? [workspace.projectId]
              : []
          )
        ),
    });
    configureManagedRemoteTerminalLifecycle({
      findTerminal: (terminalId) => {
        const workspace = workspaceStore.findWorkspaceByTerminalId(terminalId);
        const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
        if (
          !workspace ||
          !terminal ||
          !isSshWorkspace(workspace) ||
          !executionLocations.managesSession(workspace, terminal.executionLocation)
        ) {
          return undefined;
        }
        return {
          workspaceId: workspace.id,
          backend: workspace.backend,
          terminal,
          companion: remoteWorkspaceObservationService.companionForWorkspace(workspace.backend),
        };
      },
      findWorkspace: (workspaceId) => {
        const workspace = workspaceStore.workspaces.get(workspaceId);
        if (!workspace || !isSshWorkspace(workspace)) return undefined;
        return {
          workspaceId,
          backend: workspace.backend,
          terminals: workspace.terminals.filter((terminal) =>
            executionLocations.managesSession(workspace, terminal.executionLocation)
          ),
        };
      },
      changed: (workspaceId) => {
        const workspace = workspaceStore.workspaces.get(workspaceId);
        if (!workspace) return;
        workspaceStore.saveWorkspaces();
        try {
          workspaceStore.broadcastWorkspaceUpdate(workspace);
        } catch (error) {
          logger.warn('Failed to publish Managed Remote Terminal lifecycle state', {
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      prepareObservationBestEffort: async (workspaceId) => {
        const workspace = workspaceStore.workspaces.get(workspaceId);
        if (!workspace || !isSshWorkspace(workspace)) return;
        await remoteWorkspaceObservationService.reconcile();
      },
      prepareObservationInBackground: (workspaceId) => {
        const workspace = workspaceStore.workspaces.get(workspaceId);
        if (!workspace || !isSshWorkspace(workspace)) return;
        void remoteWorkspaceObservationService.reconcileAfterReconnect().catch((error) => {
          logger.debug('Could not prepare SSH observation after reconnecting', {
            workspaceId: workspace.id,
            error,
          });
        });
      },
      reconcileObservation: () => {
        void remoteWorkspaceObservationService.reconcile();
      },
    });
    // Watchers are now started lazily when git status is requested

    // Keep workspace snapshots in sync with the live PTY state. Renderers also
    // receive these events directly, but a later workspace recovery must not
    // overwrite that newer status with stale main-process metadata.
    ptyService.onStatus((terminalId, status) => {
      this.terminals.updateTerminalStatus(terminalId, status);
    });

    ptyService.onSshTerminalPoolAssignment((terminalId, assignment) => {
      sshWorkspaceService.recordTerminalPoolAssignment(terminalId, assignment);
    });

    localCopyService.onSyncStatus((status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC.WORKSPACE_LOCAL_COPY_SYNC_STATUS, status);
        }
      }
    });

    // Remove stale workspaces whose directories no longer exist (e.g. crash mid-delete).
    // Snapshot IDs now so we only check workspaces that were loaded from disk,
    // not ones created after startup.
    const loadedIds = Array.from(workspaceStore.workspaces.keys());
    setImmediate(() => this.lifecycle.cleanupStaleWorkspaces(loadedIds));

    // Clear only the aborted terminal's spinner when user sends an abort
    // signal (Ctrl-C, Ctrl-D, Esc). Other agent tabs in the workspace may
    // still be processing. Its late activity is held back, longer when the
    // agent's title confirmed the interrupt: an Esc may just have closed a menu.
    ptyService.onAbort((terminalId, confirmed) => this.attention.aborted(terminalId, confirmed));
    ptyService.onAnswerKey((terminalId) => this.attention.answerKeyPressed(terminalId));

    ptyService.onManagedRemoteTerminalSessionReplaced((terminalId) => {
      const workspace = workspaceStore.findWorkspaceByTerminalId(terminalId);
      const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
      if (
        !workspace ||
        !terminal ||
        !executionLocations.managesSession(workspace, terminal.executionLocation)
      ) {
        return;
      }
      this.attention.replaced(terminalId);
      terminal.dynamicTitle = undefined;
    });

    // Clear only the exited terminal's spinner.
    ptyService.onExit((terminalId, exit) => {
      sshWorkspaceService.releaseTerminalPoolAssignment(terminalId);
      const workspace = workspaceStore.findWorkspaceByTerminalId(terminalId);
      if (workspace) {
        const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
        if (terminal && executionLocations.managesSession(workspace, terminal.executionLocation)) {
          // Set before the lifecycle publishes the exit, so the pane says why along with it.
          terminal.connectionError = exit && sshConnectionFailure(exit.exitCode, exit.output);
          if (isResumable(workspace, terminal)) {
            void managedRemoteTerminalLifecycleService.attachmentExited(terminalId).then(() => {
              if (sessionEndedHere(workspace, terminal)) this.attention.ended(terminalId);
            });
          } else {
            this.attention.ended(terminalId);
            void managedRemoteTerminalLifecycleService.attachmentExited(terminalId);
          }
        } else {
          this.attention.ended(terminalId);
        }
      }
    });
  }

  /**
   * Ensure a file watcher is running for a workspace.
   * Called lazily when git status is requested for the workspace.
   * This improves startup time by not starting all watchers upfront.
   */
  ensureWatcherStarted(workspaceId: string): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (
      !workspace ||
      workspace.status !== 'active' ||
      workspace.lastStoppedAt ||
      isSshWorkspace(workspace)
    ) {
      return;
    }

    // Only start if not already watching
    if (!worktreeWatcherService.isWatching(workspaceId)) {
      worktreeWatcherService.startWatching(workspaceId, workspace.workingDirectory).catch((err) => {
        logger.error(`Failed to start watcher for workspace ${workspaceId}:`, err);
      });
    }
  }

  private loadWorkspaces(): void {
    try {
      const workspacesList = workspaceStore.readPersistedWorkspaces();
      if (workspacesList === null) return;

      for (const rawPersisted of workspacesList) {
        const { workspace, agentSources, agentStartedAt, runningAtQuit } =
          hydrateWorkspace(rawPersisted);
        workspaceStore.workspaces.set(workspace.id, workspace);
        if (runningAtQuit) workspaceStore.runningAtQuitIds.add(workspace.id);
        this.attention.restored(workspace, agentSources, agentStartedAt);
      }
      // Give workspaces that share a position their own; dragging between them does nothing.
      const ordered = [...workspaceStore.workspaces.values()].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0)
      );
      ordered.forEach((workspace, index) => (workspace.order = index));
      if (moveFoldersIntoProjects()) workspaceStore.saveWorkspaces();
      this.sshSync.restored(workspaceStore.workspaces.values());

      registerBaseBranches();
    } catch (error) {
      logger.error('Failed to load workspaces:', error);
    }
  }

  // Always snapshot last-known SSH session activity before the app quits,
  // even when no other workspace metadata is waiting to be persisted.
  async dispose(): Promise<void> {
    this.sshSync.dispose();
    this.folderTrust.dispose();
    for (const workspace of workspaceStore.workspaces.values()) {
      this.terminals.cancelDeferredWorkspaceLaunches(workspace);
      if (isSshWorkspace(workspace)) {
        managedRemoteTerminalLifecycleService.cancelPendingLaunches({
          workspaceId: workspace.id,
        });
      }
    }
    await workspaceSetupService.dispose();
    await workspaceStore.saveWorkspacesImmediate();
  }

  /** Tags the workspace for where its pull request stands, as `pullRequestTagUpdate` decides. */
  applyPullRequestTag(workspaceId: string, state: PullRequestTagState | undefined): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    const update =
      workspace &&
      pullRequestTagUpdate(
        workspace,
        state,
        normalizeWorkspaceTags(configService.get().workspaceTags)
      );
    if (!workspace || !update) return;
    Object.assign(workspace, update);
    workspaceStore.saveWorkspaces();
    workspaceStore.broadcastWorkspaceUpdate(workspace);
  }

  /**
   * An agent waiting on the user, or failing, ends its workspace's snooze early, as any
   * notification does for a snooze until notified.
   */
  private wakeSnoozedForAttention(workspaceId: string, attention: WorkspaceAttention): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) return;
    if (!attentionWakesSnooze(workspace, attention)) return;
    wakeWorkspace(workspace, attention.updatedAt);
    workspaceStore.saveWorkspaces();
    workspaceStore.broadcastWorkspaceUpdate(workspace);
    this.snoozeAlarm.check();
    this.attention.workspaceStatusChanged();
  }

  /** Calls `listener` with the Terminal each prompt is submitted in, until unsubscribed. */
  onPromptSubmitted(listener: (terminalId: string) => void): () => void {
    this.promptSubmitListeners.add(listener);
    return () => this.promptSubmitListeners.delete(listener);
  }

  /** Calls `listener` with each attention a Terminal or workspace raises, until unsubscribed. */
  onAttentionRaised(listener: (event: WorkspaceAttentionEvent) => void): () => void {
    this.attentionListeners.add(listener);
    return () => this.attentionListeners.delete(listener);
  }

  /**
   * Takes the marker under this key off, from main's own copy of the markers, so one a script put
   * on while the user's click was on its way stays.
   */
  removeMarker(workspaceId: string, key: string): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace?.markers?.some((marker) => marker.key === key)) return;
    const updated = this.update(workspaceId, {
      markers: withoutWorkspaceMarker(workspace.markers, key),
    });
    workspaceStore.broadcastWorkspaceUpdate(updated);
  }

  update(workspaceId: string, updates: Partial<Omit<Workspace, 'id' | 'terminals'>>): Workspace {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const normalizedUpdates = { ...updates };
    // Matches the IPC schema, for internal callers that skip it.
    if ('savedLayout' in normalizedUpdates) {
      normalizedUpdates.savedLayout = normalizeSavedLayout(normalizedUpdates.savedLayout);
    }
    // Setup's panes open once: the window that laid them out says so, and keeps them from there.
    if ('setupPanes' in normalizedUpdates) normalizedUpdates.setupPanes = undefined;
    if ('recentLinks' in normalizedUpdates) {
      normalizedUpdates.recentLinks = normalizeRecentLinks(normalizedUpdates.recentLinks);
    }
    if ('virtualDesktops' in normalizedUpdates) {
      normalizedUpdates.virtualDesktops = normalizeVirtualDesktops(
        normalizedUpdates.virtualDesktops
      );
    }
    // A script's word on a tag is about that tag, so another tag, or none, drops it.
    if ('tag' in normalizedUpdates && !('tagTooltip' in normalizedUpdates)) {
      if (normalizedUpdates.tag !== workspace.tag) normalizedUpdates.tagTooltip = undefined;
    }
    if ('customName' in normalizedUpdates) {
      if (normalizedUpdates.customName) {
        normalizedUpdates.customNameSource = 'manual';
        normalizedUpdates.customNameGeneratedAt = undefined;
        normalizedUpdates.promptSubmitsSinceCustomNameGeneration = undefined;
      } else {
        this.naming.abortAutoNaming(workspaceId);
        normalizedUpdates.customNameSource = undefined;
        normalizedUpdates.customNameGeneratedAt = undefined;
        normalizedUpdates.promptSubmitsSinceCustomNameGeneration = undefined;
        // Reset prompt context so future titles use only prompts submitted from this point on.
        normalizedUpdates.promptSubmits = undefined;
        normalizedUpdates.autoNaming = false;
      }
    }

    const previousSshTargetBranch = isSshWorkspace(workspace)
      ? workspace.baseBranch ||
        workspace.backend.baseBranch ||
        projectService.get(workspace.projectId)?.baseBranch ||
        'main'
      : undefined;

    const wasTrashed = workspace.status === 'trashed';
    Object.assign(workspace, normalizedUpdates);
    // The Trash counts its days from the move; restoring takes a workspace out of it.
    if (workspace.status !== 'trashed') workspace.trashedAt = undefined;
    else if (!wasTrashed) {
      workspace.trashedAt = Date.now();
      publishHookEvent({ event: 'workspace.trashed', workspaceId });
    }
    const snoozeChanged = 'snoozedUntil' in updates || 'wakesOnNotification' in updates;
    if (snoozeChanged) this.snoozeAlarm.check();
    if ('status' in updates || snoozeChanged) this.attention.workspaceStatusChanged();

    if ('branchName' in updates && isSshWorkspace(workspace)) {
      workspace.backend.branchName = workspace.branchName;
    }

    // Keep the backend target branch synchronized with the mutable workspace override.
    if ('baseBranch' in updates && isSshWorkspace(workspace)) {
      workspace.backend.baseBranch =
        workspace.baseBranch ||
        projectService.get(workspace.projectId)?.baseBranch ||
        workspace.backend.defaultBranch;
    } else if ('baseBranch' in updates) {
      // If workspace override was cleared, fall back to the project's baseBranch
      const effectiveBranch =
        workspace.baseBranch || projectService.get(workspace.projectId)?.baseBranch;
      gitService.registerTargetBranch(workspace.workingDirectory, effectiveBranch);
    }

    workspaceStore.saveWorkspaces();
    if (
      previousSshTargetBranch !== undefined &&
      isSshWorkspace(workspace) &&
      previousSshTargetBranch !==
        (workspace.baseBranch ||
          workspace.backend.baseBranch ||
          projectService.get(workspace.projectId)?.baseBranch ||
          'main')
    ) {
      void remoteWorkspaceObservationService.reconcile();
    }
    if ('customName' in updates && !normalizedUpdates.customName) {
      workspaceStore.broadcastWorkspaceUpdate(workspace);
    }
    return workspace;
  }

  dismissSetupActivity(workspaceId: string, activityId: string): Workspace {
    return workspaceSetupService.dismiss(workspaceId, activityId);
  }

  retrySetupStep(workspaceId: string, stepId: string): Workspace {
    return workspaceSetupService.retry(workspaceId, stepId);
  }

  runBackgroundAction(
    workspaceId: string,
    actionId: string,
    launch?: BackgroundActionLaunch
  ): Workspace {
    return workspaceSetupService.runAction(workspaceId, actionId, launch);
  }

  stopBackgroundActionRun(workspaceId: string, activityId: string): Promise<void> {
    return workspaceSetupService.stopRun(workspaceId, activityId);
  }

  reorderWorkspace(workspaceId: string, newOrder: number): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const oldOrder = workspace.order ?? 0;

    // Get all workspaces sorted by order
    const sortedWorkspaces = Array.from(workspaceStore.workspaces.values()).sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0)
    );

    // Update orders for affected workspaces
    for (const w of sortedWorkspaces) {
      if (w.id === workspaceId) continue;

      const currentOrder = w.order ?? 0;

      if (oldOrder < newOrder) {
        // Moving down: shift workspaces between old and new position up
        if (currentOrder > oldOrder && currentOrder <= newOrder) {
          w.order = currentOrder - 1;
        }
      } else if (oldOrder > newOrder) {
        // Moving up: shift workspaces between new and old position down
        if (currentOrder >= newOrder && currentOrder < oldOrder) {
          w.order = currentOrder + 1;
        }
      }
    }

    workspace.order = newOrder;
    workspaceStore.saveWorkspaces();
  }

  // Move workspace to a different window
  moveWorkspaceToWindow(workspaceId: string, windowId: string | null): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    workspace.windowId = windowId;
    workspaceStore.saveWorkspaces();
  }

  // Assign all unassigned workspaces to the main window on startup
  assignUnassignedToMainWindow(mainWindowId: string): void {
    let changed = false;
    for (const workspace of workspaceStore.workspaces.values()) {
      if (workspace.windowId === null) {
        workspace.windowId = mainWindowId;
        changed = true;
      }
    }
    if (changed) {
      workspaceStore.saveWorkspaces();
    }
  }

  /**
   * Records the workspaces a window shows a browser or note pane of. Such a pane keeps its
   * workspace running without a terminal, through `showsPaneSurfaces`.
   */
  setPaneSurfaceWorkspaces(windowId: string, workspaceIds: readonly string[]): void {
    this.paneSurfaceWorkspaceIdsByWindow.set(windowId, new Set(workspaceIds));
    this.updateShowsPaneSurfaces();
  }

  /** A closed window shows no pane; the window that takes its workspaces reports its own. */
  clearWindowPaneSurfaces(windowId: string): void {
    if (this.paneSurfaceWorkspaceIdsByWindow.delete(windowId)) this.updateShowsPaneSurfaces();
  }

  private updateShowsPaneSurfaces(): void {
    const shown = new Set<string>();
    for (const ids of this.paneSurfaceWorkspaceIdsByWindow.values()) {
      for (const id of ids) shown.add(id);
    }
    for (const workspace of workspaceStore.workspaces.values()) {
      const showsPaneSurfaces = shown.has(workspace.id) || undefined;
      if (workspace.showsPaneSurfaces === showsPaneSurfaces) continue;
      workspace.showsPaneSurfaces = showsPaneSurfaces;
      workspaceStore.broadcastWorkspaceUpdate(workspace);
    }
  }

  // Reassign all workspaces from a closing window to a target window
  // Returns IDs of affected workspaces so callers can broadcast changes
  reassignWindowWorkspaces(windowId: string, targetWindowId: string | null): string[] {
    const affected: string[] = [];
    for (const workspace of workspaceStore.workspaces.values()) {
      if (workspace.windowId === windowId) {
        workspace.windowId = targetWindowId;
        affected.push(workspace.id);
      }
    }
    if (affected.length > 0) {
      workspaceStore.saveWorkspaces();
    }
    return affected;
  }

  /** Update lastActivityAt timestamp for a workspace (e.g. from file watcher activity) */
  touchLastActivity(workspaceId: string, activityAt = Date.now()): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace) return;
    workspace.lastActivityAt = activityAt;
    workspaceStore.saveWorkspaces();
  }

  /** An agent's turn ran in the workspace, so it counts as in use, at most once a minute. */
  recordAgentTurnActivity(workspaceId: string): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    // Files aren't watched in a workspace in the Trash either.
    if (workspace?.status !== 'active') return;
    const now = Date.now();
    const sinceLastActivity = now - workspace.lastActivityAt;
    // A time ahead of this clock, such as one synced from another device, is replaced.
    if (sinceLastActivity >= 0 && sinceLastActivity < AGENT_TURN_ACTIVITY_INTERVAL_MS) return;
    this.touchLastActivity(workspaceId, now);
    workspaceStore.broadcastWorkspaceUpdate(workspace);
  }

  /** Notifies a workspace of something no Terminal of its own reported, such as its CI ending. */
  notifyWorkspace(workspace: Workspace, hook: AgentHook): void {
    // Saved at once on SSH workspaces and published to remote viewers, as a hook over HTTP is.
    this.attention
      .hook({ workspace, hasInvalidTerminalId: false }, hook)
      .then(() => this.persistSshAttention(workspace.id))
      .catch((error) => logger.error('Failed to notify a workspace:', error));
  }

  prepareLocalCopy(...args: Parameters<typeof prepareLocalCopy>) {
    return prepareLocalCopy(...args);
  }

  initializeLocalCopy(...args: Parameters<typeof initializeLocalCopy>) {
    return initializeLocalCopy(...args);
  }

  retryLocalCopySync(...args: Parameters<typeof retryLocalCopySync>) {
    return retryLocalCopySync(...args);
  }

  saveWorkspacesImmediate(...args: Parameters<typeof workspaceStore.saveWorkspacesImmediate>) {
    return workspaceStore.saveWorkspacesImmediate(...args);
  }

  saveWorkspacesImmediateChecked(
    ...args: Parameters<typeof workspaceStore.saveWorkspacesImmediateChecked>
  ) {
    return workspaceStore.saveWorkspacesImmediateChecked(...args);
  }

  withPersistenceTransaction<T>(
    transaction: (save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    return workspaceStore.withPersistenceTransaction(transaction);
  }

  recoverSshSessions(...args: Parameters<SshSessionRecovery['recoverSshSessions']>) {
    return this.sessions.recoverSshSessions(...args);
  }

  markSshWorkspaceRemoved(...args: Parameters<SshWorkspaceAdoption['markSshWorkspaceRemoved']>) {
    return this.adoption.markSshWorkspaceRemoved(...args);
  }

  markSshWorkspaceFound(...args: Parameters<SshWorkspaceAdoption['markSshWorkspaceFound']>) {
    return this.adoption.markSshWorkspaceFound(...args);
  }

  removeSshWorkspaceDeletedElsewhere(
    ...args: Parameters<SshWorkspaceAdoption['removeSshWorkspaceDeletedElsewhere']>
  ) {
    return this.adoption.removeSshWorkspaceDeletedElsewhere(...args);
  }

  assignSshWorkspaceProjects(
    ...args: Parameters<SshWorkspaceAdoption['assignSshWorkspaceProjects']>
  ) {
    return this.adoption.assignSshWorkspaceProjects(...args);
  }

  linkSshWorkspaceToProject(
    ...args: Parameters<SshWorkspaceAdoption['linkSshWorkspaceToProject']>
  ) {
    return this.adoption.linkSshWorkspaceToProject(...args);
  }

  onSshHostSynced(...args: Parameters<SshWorkspaceAdoption['onSshHostSynced']>) {
    return this.adoption.onSshHostSynced(...args);
  }

  gitRemoteProjectLookup(...args: Parameters<SshWorkspaceAdoption['gitRemoteProjectLookup']>) {
    return this.adoption.gitRemoteProjectLookup(...args);
  }

  sshRepositoryProjectLookup(
    ...args: Parameters<SshWorkspaceAdoption['sshRepositoryProjectLookup']>
  ) {
    return this.adoption.sshRepositoryProjectLookup(...args);
  }

  reconcilePersistedSshSessions(
    ...args: Parameters<SshSessionRecovery['reconcilePersistedSshSessions']>
  ) {
    return this.sessions.reconcilePersistedSshSessions(...args);
  }

  saveSshTerminalLayouts(...args: Parameters<SshSessionRecovery['saveSshTerminalLayouts']>) {
    return this.sessions.saveSshTerminalLayouts(...args);
  }

  getRunningWorkspaceCount(...args: Parameters<typeof workspaceStore.getRunningWorkspaceCount>) {
    return workspaceStore.getRunningWorkspaceCount(...args);
  }

  create(...args: Parameters<WorkspaceCreation['create']>) {
    return this.creation.create(...args);
  }

  createBatch(...args: Parameters<WorkspaceCreation['createBatch']>) {
    return this.creation.createBatch(...args);
  }

  recordPromptSubmit(...args: Parameters<WorkspaceNaming['recordPromptSubmit']>) {
    return this.naming.recordPromptSubmit(...args);
  }

  recordAgentReply(...args: Parameters<WorkspaceNaming['recordAgentReply']>) {
    return this.naming.recordAgentReply(...args);
  }

  onWorkspaceUpdated(...args: Parameters<typeof workspaceStore.onWorkspaceUpdated>) {
    return workspaceStore.onWorkspaceUpdated(...args);
  }

  broadcastWorkspaceUpdate(...args: Parameters<typeof workspaceStore.broadcastWorkspaceUpdate>) {
    return workspaceStore.broadcastWorkspaceUpdate(...args);
  }

  regenerateWorkspaceName(...args: Parameters<WorkspaceNaming['regenerateWorkspaceName']>) {
    return this.naming.regenerateWorkspaceName(...args);
  }

  generateBranchName(...args: Parameters<WorkspaceNaming['generateBranchName']>) {
    return this.naming.generateBranchName(...args);
  }

  cancelBranchNaming(...args: Parameters<WorkspaceNaming['cancelBranchNaming']>) {
    return this.naming.cancelBranchNaming(...args);
  }

  addTerminal(...args: Parameters<WorkspaceTerminals['addTerminal']>) {
    return this.terminals.addTerminal(...args);
  }

  addTerminalWithPreparation(
    ...args: Parameters<WorkspaceTerminals['addTerminalWithPreparation']>
  ) {
    return this.terminals.addTerminalWithPreparation(...args);
  }

  addAgentTab(...args: Parameters<WorkspaceTerminals['addAgentTab']>) {
    return this.terminals.addAgentTab(...args);
  }

  removeTerminal(...args: Parameters<WorkspaceTerminals['removeTerminal']>) {
    return this.terminals.removeTerminal(...args);
  }

  findWorkspaceByTerminalId(...args: Parameters<typeof workspaceStore.findWorkspaceByTerminalId>) {
    return workspaceStore.findWorkspaceByTerminalId(...args);
  }

  getTerminal(...args: Parameters<typeof workspaceStore.getTerminal>) {
    return workspaceStore.getTerminal(...args);
  }

  stop(...args: Parameters<WorkspaceLifecycle['stop']>) {
    return this.lifecycle.stop(...args);
  }

  /**
   * At quit, before anything stops, marks the local workspaces with running terminals so the next
   * launch can offer to restart them. Those this launch offered and the user left unanswered keep
   * their marks. The final save at quit records them.
   */
  rememberRunningAtQuit(): void {
    const marks = workspaceStore.runningAtQuitIds;
    for (const id of marks) {
      const workspace = workspaceStore.workspaces.get(id);
      if (!workspace || !isRestorable(workspace)) marks.delete(id);
    }
    for (const workspace of workspaceStore.workspaces.values()) {
      if (isRestorable(workspace) && runningTerminalCount(workspace) > 0) marks.add(workspace.id);
    }
  }

  /**
   * The local workspaces that were running when Komla last quit and are stopped now, in their
   * saved order. Starting a terminal in one, or `forgetRunningAtLastQuit`, takes it off the list.
   */
  listRunningAtLastQuit(): string[] {
    return [...workspaceStore.runningAtQuitIds]
      .map((id) => workspaceStore.workspaces.get(id))
      .filter(
        (workspace): workspace is Workspace =>
          workspace !== undefined &&
          isRestorable(workspace) &&
          runningTerminalCount(workspace) === 0
      )
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((workspace) => workspace.id);
  }

  /** The user declined restarting these, or they left the offer another way. */
  forgetRunningAtLastQuit(workspaceIds: readonly string[]): void {
    let changed = false;
    for (const id of workspaceIds) changed = workspaceStore.runningAtQuitIds.delete(id) || changed;
    if (changed) workspaceStore.saveWorkspaces();
  }

  stopTerminal(...args: Parameters<WorkspaceTerminals['stopTerminal']>) {
    return this.terminals.stopTerminal(...args);
  }

  restartTerminal(...args: Parameters<WorkspaceTerminals['restartTerminal']>) {
    return this.terminals.restartTerminal(...args);
  }

  reconnectSshTerminal(...args: Parameters<WorkspaceTerminals['reconnectSshTerminal']>) {
    return this.terminals.reconnectSshTerminal(...args);
  }

  findInSshTerminal(...args: Parameters<WorkspaceTerminals['findInSshTerminal']>) {
    return this.terminals.findInSshTerminal(...args);
  }

  delete(...args: Parameters<WorkspaceLifecycle['delete']>) {
    return this.lifecycle.delete(...args);
  }

  deleteAll(...args: Parameters<WorkspaceLifecycle['deleteAll']>) {
    return this.lifecycle.deleteAll(...args);
  }

  deleteSshHost(...args: Parameters<WorkspaceLifecycle['deleteSshHost']>) {
    return this.lifecycle.deleteSshHost(...args);
  }

  getBranchCleanupScope(...args: Parameters<typeof getBranchCleanupScope>) {
    return getBranchCleanupScope(...args);
  }

  checkWorkspacesForCleanup(...args: Parameters<typeof checkWorkspacesForCleanup>) {
    return checkWorkspacesForCleanup(...args);
  }

  listHostBranches(...args: Parameters<typeof listHostBranches>) {
    return listHostBranches(...args);
  }

  getWorkspacesByProjectId(...args: Parameters<typeof workspaceStore.getWorkspacesByProjectId>) {
    return workspaceStore.getWorkspacesByProjectId(...args);
  }

  list(...args: Parameters<typeof workspaceStore.list>) {
    return workspaceStore.list(...args);
  }

  assertSshHostConnectionUpdateAllowed(
    ...args: Parameters<WorkspaceLifecycle['assertSshHostConnectionUpdateAllowed']>
  ) {
    return this.lifecycle.assertSshHostConnectionUpdateAllowed(...args);
  }

  get(...args: Parameters<typeof workspaceStore.get>) {
    return workspaceStore.get(...args);
  }

  isDeleting(...args: Parameters<typeof workspaceStore.isDeleting>) {
    return workspaceStore.isDeleting(...args);
  }

  propagateProjectBaseBranch(...args: Parameters<typeof propagateProjectBaseBranch>) {
    return propagateProjectBaseBranch(...args);
  }

  updateTerminal(...args: Parameters<WorkspaceTerminals['updateTerminal']>) {
    return this.terminals.updateTerminal(...args);
  }

  restart(...args: Parameters<WorkspaceLifecycle['restart']>) {
    return this.lifecycle.restart(...args);
  }

  restartWithCleanup(...args: Parameters<WorkspaceLifecycle['restartWithCleanup']>) {
    return this.lifecycle.restartWithCleanup(...args);
  }

  updateTerminalStatus(...args: Parameters<WorkspaceTerminals['updateTerminalStatus']>) {
    return this.terminals.updateTerminalStatus(...args);
  }

  hasAcceptedTerminalHook(...args: Parameters<SshAttentionPersistence['hasAcceptedTerminalHook']>) {
    return this.sshAttention.hasAcceptedTerminalHook(...args);
  }

  recordCopiedHookDelivery(
    ...args: Parameters<SshAttentionPersistence['recordCopiedHookDelivery']>
  ) {
    return this.sshAttention.recordCopiedHookDelivery(...args);
  }

  persistSshAttention(...args: Parameters<SshAttentionPersistence['persistSshAttention']>) {
    return this.sshAttention.persistSshAttention(...args);
  }

  getDiagnostics(...args: Parameters<typeof workspaceStore.getDiagnostics>) {
    return workspaceStore.getDiagnostics(...args);
  }
}

export const workspaceService = new WorkspaceService();
