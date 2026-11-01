import { isRunningOnSshHost, takesFreeSshSlot } from '../../../shared/lib/terminal-execution-state';
import { executionLocations } from '../execution-location';
import { FREE_WORKSPACE_LIMIT, licenseService } from '../license.service';
import { telemetryService } from '../telemetry.service';

import { workspaceStore } from './store';

import type { TerminalExecutionLocation, Workspace } from '../../../shared/types';

/** The free plan's limit on SSH workspaces, counting those being created or started. */
export class FreeSshSlots {
  // SSH workspaces being created or started; only they count toward the free plan's limit.
  private pendingRemoteCreates = 0;
  private pendingRemoteStarts = 0;

  /**
   * Throws, and reports the hit, when the free plan has no SSH workspace slot
   * left for a launch that finds `checkedCount` slots taken.
   */
  private assertFreeSshSlot(
    source: 'create_workspace' | 'start_workspace',
    runningCount: number,
    checkedCount = runningCount
  ): void {
    const check = licenseService.canStartWorkspace(checkedCount);
    if (check.allowed) return;
    telemetryService.sendMonetizationEvent('free_limit_hit', {
      source,
      limit: FREE_WORKSPACE_LIMIT,
      runningCount,
    });
    throw new Error(check.reason);
  }

  /**
   * Reserve a pending-start slot when a terminal starting at `executionLocation`
   * puts this SSH workspace on its host, enforcing the free-tier limit. Throws if
   * the limit is hit. Returns whether it reserved; the caller then calls
   * releaseStartSlot.
   */
  reserveWorkspaceStartSlot(
    workspace: Workspace,
    executionLocation: TerminalExecutionLocation | undefined
  ): boolean {
    if (
      !executionLocations.managesSession(workspace, executionLocation) ||
      isRunningOnSshHost(workspace)
    ) {
      return false;
    }
    this.assertFreeSshSlot(
      'start_workspace',
      workspaceStore.getRunningRemoteWorkspaceCount() + this.pendingRemoteStarts
    );
    this.pendingRemoteStarts++;
    return true;
  }

  reserveWorkspaceCreateSlots(workspaceCount: number): void {
    const runningCount =
      workspaceStore.countWorkspaces(takesFreeSshSlot) + this.pendingRemoteCreates;
    this.assertFreeSshSlot('create_workspace', runningCount, runningCount + workspaceCount - 1);
    this.pendingRemoteCreates += workspaceCount;
  }

  releaseCreateSlot(): void {
    this.pendingRemoteCreates--;
  }

  releaseStartSlot(): void {
    this.pendingRemoteStarts = Math.max(0, this.pendingRemoteStarts - 1);
  }

  /**
   * Restarting starts a workspace's terminals on its SSH host. Doesn't double-count it: restarting
   * one already there doesn't add a running workspace.
   */
  assertRestartSlot(workspace: Workspace): void {
    this.assertFreeSshSlot(
      'start_workspace',
      workspaceStore.getRunningRemoteWorkspaceCount() +
        this.pendingRemoteStarts -
        (isRunningOnSshHost(workspace) ? 1 : 0)
    );
  }
}
