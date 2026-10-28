import { app, shell } from 'electron';

import { sshPortForwardService } from './ssh-port-forward.service';
import { workspaceService } from './workspace.service';

import type { WorkspaceVirtualDesktop } from '../../shared/types';

/** The app this computer opens vnc:// links with, such as Screen Sharing; '' when none. */
export function getVncAppName(): string {
  return app.getApplicationNameForProtocol('vnc://');
}

/**
 * Opens the VNC server on `vncPort` where the workspace runs in the app for vnc:// links, which
 * takes `vncPassword` from the link instead of asking for it. `runningVncPorts`, those of every
 * desktop running there, lets forwards to stopped desktops close.
 */
export async function openInVncApp(
  workspace: { backend?: { kind: 'local' } | { kind: 'ssh'; hostId: string } },
  vncPort: number,
  vncPassword?: string,
  runningVncPorts?: number[]
): Promise<void> {
  const port =
    workspace.backend?.kind === 'ssh'
      ? await sshPortForwardService.startVncForward(
          workspace.backend.hostId,
          vncPort,
          runningVncPorts
        )
      : vncPort;
  const password = vncPassword ? `:${encodeURIComponent(vncPassword)}@` : '';
  await shell.openExternal(`vnc://${password}127.0.0.1:${port}`);
}

/**
 * Forgets the workspace's virtual desktops on `vncPorts`, which a check that began at
 * `checkedAt` found stopped. A desktop shown since then may have taken one of those ports
 * after the check, so it stays.
 */
export function forgetVirtualDesktops(
  workspaceId: string,
  vncPorts: number[],
  checkedAt: number
): void {
  const desktops = workspaceService.get(workspaceId)?.virtualDesktops;
  const stopped = (desktop: WorkspaceVirtualDesktop): boolean =>
    vncPorts.includes(desktop.vncPort) && desktop.shownAt < checkedAt;
  if (!desktops?.some(stopped)) return;
  const kept = desktops.filter((desktop) => !stopped(desktop));
  workspaceService.broadcastWorkspaceUpdate(
    workspaceService.update(workspaceId, { virtualDesktops: kept.length > 0 ? kept : undefined })
  );
}

/**
 * Opens one of the workspace's saved desktops in the app for vnc:// links, with its saved
 * password. The desktops saved for that machine count as running, so forwards to others close.
 */
export async function openSavedDesktopInVncApp(
  workspaceId: string,
  vncPort: number
): Promise<void> {
  const workspace = workspaceService.get(workspaceId);
  const desktop = workspace?.virtualDesktops?.find((saved) => saved.vncPort === vncPort);
  if (!workspace || !desktop) throw new Error('That virtual desktop is no longer running.');
  const hostOf = (other: { backend?: { kind: string; hostId?: string } }): string | undefined =>
    other.backend?.kind === 'ssh' ? other.backend.hostId : undefined;
  const runningVncPorts = workspaceService
    .list()
    .filter((other) => hostOf(other) === hostOf(workspace))
    .flatMap((other) => (other.virtualDesktops ?? []).map((saved) => saved.vncPort));
  await openInVncApp(workspace, vncPort, desktop.vncPassword, runningVncPorts);
}
