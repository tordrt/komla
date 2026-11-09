import { posix as pathPosix } from 'path';

import { isSshWorkspace } from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';
import { executionLocations } from '../execution-location';
import { remoteCompanionService } from '../remote-companion.service';
import { remoteWorkspaceObservationService } from '../remote-workspace-observation.service';
import { sshWorkspaceService } from '../ssh-workspace.service';

import { workspaceStore } from './store';

import type { SshWorkspaceBackend, Workspace } from '../../../shared/types';

const logger = createLogger('WorkspaceService');

/** Saves SSH workspaces' Terminal Attention at once and records which hook deliveries it took in. */
export class SshAttentionPersistence {
  private pendingTerminalHookDeliveryIds = new Set<string>();

  hasAcceptedTerminalHook(terminalId: string, deliveryId: string): boolean {
    const deliveryKey = `${terminalId}\0${deliveryId}`;
    return (
      !this.pendingTerminalHookDeliveryIds.has(deliveryKey) &&
      workspaceStore.getTerminal(terminalId)?.lastAcceptedHookDeliveryId === deliveryId
    );
  }

  /** Records a copied hook's delivery; it only changes what's shown, so the save is batched. */
  recordCopiedHookDelivery(
    workspaceId: string,
    delivery?: { terminalId: string; deliveryId: string }
  ): void {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) return;
    const terminal = delivery
      ? workspace.terminals.find((candidate) => candidate.id === delivery.terminalId)
      : undefined;
    if (terminal && delivery) terminal.lastAcceptedHookDeliveryId = delivery.deliveryId;
    workspaceStore.saveWorkspaces();
  }

  async persistSshAttention(
    workspaceId: string,
    delivery?: { terminalId: string; deliveryId: string }
  ): Promise<void> {
    const workspace = workspaceStore.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) return;
    const terminal = delivery
      ? workspace.terminals.find((candidate) => candidate.id === delivery.terminalId)
      : undefined;
    const previousDeliveryId = terminal?.lastAcceptedHookDeliveryId;
    const deliveryKey = delivery ? `${delivery.terminalId}\0${delivery.deliveryId}` : undefined;
    if (terminal && delivery && deliveryKey) {
      this.pendingTerminalHookDeliveryIds.add(deliveryKey);
      terminal.lastAcceptedHookDeliveryId = delivery.deliveryId;
    }
    try {
      await workspaceStore.saveWorkspacesImmediateChecked();
    } catch (error) {
      if (terminal) terminal.lastAcceptedHookDeliveryId = previousDeliveryId;
      throw error;
    } finally {
      if (deliveryKey) this.pendingTerminalHookDeliveryIds.delete(deliveryKey);
    }
  }
}

/** Tells the other devices showing an SSH tab that its agent was interrupted here. */
export function relayInterrupt(workspace: Workspace, terminalId: string, sources: string[]): void {
  void relayThroughCompanion(workspace, terminalId, 'an interrupt', (backend, companion) =>
    sshWorkspaceService.relayInterrupt(backend, companion, terminalId, sources)
  );
}

/**
 * Tells the other installations showing an SSH tab that the user saw its agent's done here.
 * Resolves whether it did.
 */
export function relaySeen(
  workspace: Workspace,
  terminalId: string,
  source: string,
  deliveryId: string
): Promise<boolean> {
  return relayThroughCompanion(workspace, terminalId, 'a seen done', (backend, companion) =>
    sshWorkspaceService.relaySeen(backend, companion, terminalId, source, deliveryId)
  );
}

/**
 * Has this installation's companion on the tab's host pass something on to the other
 * installations' mailboxes and Hook Journal, for a tab backed by a Managed Remote Terminal
 * Session. Resolves whether it did; a failure is logged.
 */
async function relayThroughCompanion(
  workspace: Workspace,
  terminalId: string,
  what: string,
  relay: (
    backend: SshWorkspaceBackend,
    companion: { executable: string; hookInbox: string }
  ) => Promise<void>
): Promise<boolean> {
  try {
    const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
    if (
      !isSshWorkspace(workspace) ||
      !terminal ||
      !executionLocations.managesSession(workspace, terminal.executionLocation)
    ) {
      return false;
    }
    const { backend } = workspace;
    const host = sshWorkspaceService.getHost(backend.hostId);
    // The inbox this device's terminals use, at <base>/helpers/companion/<key>/inbox.
    const { hookInbox } = remoteWorkspaceObservationService.companionForWorkspace(backend);
    const remoteBasePath = pathPosix.join(hookInbox, '..', '..', '..', '..');
    // Only through a companion already installed: a relay mustn't upload one.
    const executable = await remoteCompanionService.installedPath(host, remoteBasePath);
    if (!executable) {
      logger.info(`Not relaying ${what}: no companion installed on its host yet`, {
        hostId: backend.hostId,
      });
      return false;
    }
    await relay(backend, { executable, hookInbox });
    return true;
  } catch (error) {
    logger.warn(`Could not tell other installations about ${what}:`, error);
    return false;
  }
}
