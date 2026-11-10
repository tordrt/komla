import { isDeepStrictEqual } from 'util';

import {
  encodeTerminalExecution,
  endsIfGoneFromHost,
  hostCheckStamp,
  needsHostCheck,
} from '../../../shared/lib/terminal-execution-state';
import {
  isMissingFromHost,
  workspaceProvisionFieldsAfter,
} from '../../../shared/lib/workspace-provision-state';
import { isSshWorkspace, type SshWorkspaceBackend } from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';
import {
  managedRemoteTerminalLifecycleService,
  type ManagedRemoteTerminalState,
} from '../managed-remote-terminal-lifecycle.service';
import { publishRemoteWorkspaceChange } from '../remote-workspace-events';
import { remoteWorkspaceObservationService } from '../remote-workspace-observation.service';
import { isSshHostDisconnected } from '../ssh-host-disconnection';
import { normalizePersistedTerminalLayout } from '../ssh-workspace-sync/terminal-layout';
import { sshWorkspaceService, type TerminalSessionRead } from '../ssh-workspace.service';

import { workspaceStore } from './store';

import type { Terminal, Workspace } from '../../../shared/types';
import type { SshWorkspaceSync } from '../ssh-workspace-sync/ssh-workspace-sync';
import type { HookMark, TerminalAttention } from '../terminal-attention/terminal-attention';

const logger = createLogger('WorkspaceService');

export interface SshSessionRecoveryDeps {
  attention: TerminalAttention;
  sshSync: SshWorkspaceSync;
}

/** Finds what Managed Remote Terminal Sessions still run on SSH hosts, and reconciles Terminals to them. */
export class SshSessionRecovery {
  constructor(private readonly deps: SshSessionRecoveryDeps) {}

  async recoverSshSessions(workspaceId: string): Promise<Workspace | undefined> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    // Opening a workspace picks up what other devices changed on its host.
    if (workspace && isSshWorkspace(workspace)) {
      void this.deps.sshSync.syncSoon(workspace.backend.hostId);
    }
    return this.recoverSshSessionsOnce(workspaceId);
  }

  /**
   * Notes which tabs not attached here have a tmux session on the host, such
   * as those another device runs, so the sidebar shows them running, their
   * changes are observed, and selecting the workspace or its pane reattaches
   * to them rather than starting their agents again. Limits don't count them.
   * A tab last seen running whose session is gone, e.g. one another device
   * stopped, is ended through the lifecycle: it shows stopped and selecting
   * the workspace starts its agents again.
   */
  async findSshSessionsOnHost(hostId: string): Promise<void> {
    const checked = (workspace: Workspace) =>
      workspaceStore.workspaces.get(workspace.id) === workspace &&
      workspace.status === 'active' &&
      !isMissingFromHost(workspace) &&
      !workspaceStore.isDeleting(workspace.id);
    const changed = new Set<Workspace>();
    let ended = false;
    const checks: Array<{
      workspace: Workspace & { backend: SshWorkspaceBackend };
      terminal: Terminal;
      stamp: string;
      hooks: HookMark;
      /** Finding no session means it ended. */
      endsIfGone: boolean;
      tracked: ManagedRemoteTerminalState | undefined;
    }> = [];
    for (const workspace of workspaceStore.workspaces.values()) {
      if (!isSshWorkspace(workspace) || workspace.backend.hostId !== hostId) continue;
      if (workspaceStore.isDeleting(workspace.id)) continue;
      if (!checked(workspace)) {
        // In the Trash or gone from the host: what an earlier check saw no longer holds.
        if (this.forgetSshSessionsOnHost(workspace)) changed.add(workspace);
        continue;
      }
      for (const terminal of workspace.terminals) {
        if (!needsHostCheck(workspace, terminal)) continue;
        checks.push({
          workspace,
          terminal,
          stamp: hostCheckStamp(terminal),
          hooks: this.deps.attention.hookMark(terminal.id),
          endsIfGone: endsIfGoneFromHost(workspace, terminal),
          tracked: managedRemoteTerminalLifecycleService.hostCheckBaseline(terminal.id),
        });
      }
    }
    const [first] = checks;
    const companion = first
      ? remoteWorkspaceObservationService.companionForWorkspace(first.workspace.backend)
      : undefined;
    const journals = new Set(
      checks
        .map(({ terminal }) => terminal.id)
        .filter((terminalId) => this.deps.attention.wantsJournal(terminalId))
    );
    let sessions = new Map<string, TerminalSessionRead>();
    try {
      if (first) {
        sessions = await sshWorkspaceService.readTerminalSessions(
          first.workspace.backend,
          checks.map(({ terminal }) => terminal.id),
          { background: true, hookInbox: companion?.hookInbox, journals }
        );
      }
    } catch (error) {
      // Nothing confirmed what copies kept on.
      this.deps.attention.hostChecked(hostId);
      throw error;
    }
    const reads: Promise<void>[] = [];
    for (const { workspace, terminal, ...seen } of checks) {
      // The workspace, or this device's own view of the session, changed while the host was checked.
      if (
        !checked(workspace) ||
        terminal.status !== 'stopped' ||
        hostCheckStamp(terminal) !== seen.stamp ||
        !workspace.terminals.includes(terminal)
      ) {
        continue;
      }
      const onHost = sessions.has(terminal.id);
      // A hook during the check is newer than the host it read: its session may have started, or
      // its program changed state, since.
      const hookSince = this.deps.attention.hookArrivedSince(terminal.id, seen.hooks);
      // Kept on by copies of hooks from a session that has since ended.
      if (!onHost && !hookSince) this.deps.attention.sessionGone(terminal.id);
      // Copies of the hooks that ran while this installation was away never come: its journal
      // keeps them. What the program last reported counts for an agent the journal holds no hooks
      // of, as one that reports without hooks or under a companion from before.
      const read = sessions.get(terminal.id);
      const readStatus = () => {
        if (!read) return;
        this.deps.attention.sessionStatusRead(terminal.id, read.status, {
          hookSince: this.deps.attention.hookArrivedSince(terminal.id, seen.hooks),
        });
      };
      if (read && journals.has(terminal.id)) {
        // The report is newer than the journal's turn it doesn't speak for.
        reads.push(
          this.deps.attention
            .journalRead(terminal.id, read.journal, {
              hookSince,
              installationKey: companion?.installationKey,
            })
            .then(readStatus)
            .catch((error) => logger.warn('Could not take in a Hook Journal', error))
        );
      } else {
        readStatus();
      }
      if (!onHost && seen.endsIfGone) {
        // Gone after it was seen running, e.g. stopped elsewhere: selecting it restarts the
        // agent, where reconnecting would open a shell in a new, empty session. If that can't
        // be settled now, it stays as it was for the next sync: "missing" would never end.
        if (
          !hookSince &&
          managedRemoteTerminalLifecycleService.sessionGoneFromHost(terminal.id, seen.tracked)
        ) {
          ended = true;
          changed.add(workspace);
        }
        continue;
      }
      Object.assign(terminal, encodeTerminalExecution({ kind: 'host-checked', onHost }));
      if (hostCheckStamp(terminal) !== seen.stamp) changed.add(workspace);
    }
    // Once what was read confirmed what it could.
    void Promise.all(reads).then(() => this.deps.attention.hostChecked(hostId));
    if (changed.size === 0) return;
    if (ended) workspaceStore.saveWorkspaces();
    // Each workspace's own update would make every window reload them all again.
    publishRemoteWorkspaceChange();
    workspaceStore.broadcastWorkspacesChanged();
    void remoteWorkspaceObservationService.reconcile();
  }

  /** Clears what host checks saw for a workspace's tabs; returns whether any had been checked. */
  private forgetSshSessionsOnHost(workspace: Workspace): boolean {
    let forgot = false;
    for (const terminal of workspace.terminals) {
      const stamp = hostCheckStamp(terminal);
      Object.assign(terminal, encodeTerminalExecution({ kind: 'host-checked', onHost: undefined }));
      if (hostCheckStamp(terminal) !== stamp) forgot = true;
    }
    return forgot;
  }

  private async recoverSshSessionsOnce(workspaceId: string): Promise<Workspace | undefined> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) return workspace;
    if (!sshWorkspaceService.hasHost(workspace.backend.hostId)) {
      const recovery = managedRemoteTerminalLifecycleService.recover(workspaceId).catch((error) => {
        logger.warn('Could not reconcile Managed Remote Terminal Sessions for a removed host', {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
      Object.assign(
        workspace,
        workspaceProvisionFieldsAfter(workspace, { kind: 'host-not-configured' })
      );
      workspaceStore.saveWorkspaces();
      workspaceStore.broadcastWorkspacesChanged();
      logger.warn('Skipping SSH session recovery for workspace with missing host', {
        workspaceId: workspace.id,
        hostId: workspace.backend.hostId,
      });
      await recovery;
      return workspace;
    }
    if (workspace.status !== 'active') return workspace;
    // What it last saw stays until the user connects again.
    if (isSshHostDisconnected(workspace.backend.hostId)) return workspace;

    const recovery = await managedRemoteTerminalLifecycleService
      .recover(workspaceId)
      .catch((error) => {
        logger.warn('Could not check Managed Remote Terminal Sessions after workspace selection', {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
    if (recovery.hostMissing) {
      Object.assign(
        workspace,
        workspaceProvisionFieldsAfter(workspace, { kind: 'host-not-configured' })
      );
      workspaceStore.saveWorkspaces();
      workspaceStore.broadcastWorkspacesChanged();
      logger.warn('Skipping SSH session recovery for workspace with missing host', {
        workspaceId: workspace.id,
        hostId: workspace.backend.hostId,
      });
      return workspace;
    }
    const inactiveTerminalIds = recovery.endedTerminalIds;
    if (inactiveTerminalIds.size > 0) {
      for (const terminalId of inactiveTerminalIds) this.deps.attention.sessionGone(terminalId);
      workspace.terminals = workspace.terminals.filter(
        (terminal) => !inactiveTerminalIds.has(terminal.id)
      );
      const remainingTerminalIds = new Set(workspace.terminals.map((terminal) => terminal.id));
      workspace.terminalLayout = normalizePersistedTerminalLayout(
        workspace.terminalLayout,
        remainingTerminalIds
      );
      if (!remainingTerminalIds.has(workspace.primaryTerminalId ?? '')) {
        workspace.primaryTerminalId = workspace.terminals[0]?.id;
      }
    }
    if (recovery.states.size > 0 || inactiveTerminalIds.size > 0) {
      workspaceStore.saveWorkspaces();
      workspaceStore.broadcastWorkspaceUpdate(workspace);
    }
    return workspace;
  }

  reconcilePersistedSshSessions(): void {
    for (const workspace of workspaceStore.workspaces.values()) {
      if (!isSshWorkspace(workspace) || workspace.status !== 'active') continue;
      if (sshWorkspaceService.hasHost(workspace.backend.hostId)) continue;
      void this.recoverSshSessions(workspace.id).catch((error) => {
        logger.warn('Could not reconcile removed SSH host during startup', error, {
          workspaceId: workspace.id,
          hostId: workspace.backend.hostId,
        });
      });
    }
    // Restore mailbox delivery for persisted remote sessions even when their workspace is
    // never selected. Terminal probing and attachment remain lazy.
    void remoteWorkspaceObservationService.reconcileAfterReconnect().catch((error) => {
      logger.warn('Could not restore SSH observation during startup', error);
    });
  }

  saveSshTerminalLayouts(layouts: Record<string, unknown>): void {
    let changed = false;
    for (const [workspaceId, layout] of Object.entries(layouts)) {
      const workspace = workspaceStore.workspaces.get(workspaceId);
      if (!workspace || !isSshWorkspace(workspace)) continue;
      const normalized = normalizePersistedTerminalLayout(
        layout as Workspace['terminalLayout'],
        new Set(workspace.terminals.map((terminal) => terminal.id))
      );
      if (!normalized) {
        if (workspace.terminalLayout) {
          workspace.terminalLayout = undefined;
          changed = true;
        }
        continue;
      }
      if (isDeepStrictEqual(workspace.terminalLayout, normalized)) continue;
      workspace.terminalLayout = normalized;
      changed = true;
    }
    if (changed) workspaceStore.saveWorkspaces();
  }
}
