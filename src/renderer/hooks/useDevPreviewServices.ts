import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from 'react';

import {
  getCandidatePorts,
  mergeDetectedServices,
  type PreviewUrlCandidate,
} from '@/lib/dev-preview-candidates';
import { scanWorkspaceTerminalsForLocalhostUrlCandidates } from '@/lib/scan-terminal-urls';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { DevPreviewServiceDetection } from '../../shared/types';

/** How long a visible server list waits after an answer before checking again. */
export const LIVE_REFRESH_MS = 3_000;
/**
 * The wait for a server list's first QUICK_REFRESHES checks after it opens, so a server
 * started just before, which takes a few seconds to listen, shows soon.
 */
export const QUICK_REFRESH_MS = 1_000;
export const QUICK_REFRESHES = 10;

/** The wait before a server list's next check, after `checks` since it opened. */
export function liveRefreshDelay(checks: number): number {
  return checks < QUICK_REFRESHES ? QUICK_REFRESH_MS : LIVE_REFRESH_MS;
}

interface DetectionResult {
  key: string;
  token: string;
  /** Null when detection failed, so callers fall back to the terminal scan alone. */
  detection: DevPreviewServiceDetection | null;
}

/**
 * Asks main which ports the workspace's terminals listen on and which of
 * `ports` answer, on this machine (`local`) or the SSH host (`remote`), and
 * which of `own`, on the workspace's machine, this user's processes listen on.
 * `ready` turns true once an answer for this workspace and port list arrives
 * while enabled; `detection` is null when it failed. A new `refreshKey` asks
 * again, keeping the previous answer while `pending`.
 */
export function useDevPreviewServices(
  workspaceId: string,
  ports: { local: number[]; remote: number[]; own?: number[] },
  enabled: boolean,
  refreshKey: number | string = 0
): { detection: DevPreviewServiceDetection | null; ready: boolean; pending: boolean } {
  const portsKey = `${ports.local.join(',')};${ports.remote.join(',')};${(ports.own ?? []).join(',')}`;
  const key = `${workspaceId}|${portsKey}`;
  const token = `${key}|${refreshKey}`;
  const [result, setResult] = useState<DetectionResult | null>(null);
  // Servers may have started or stopped while disabled, so the next enable starts fresh.
  if (!enabled && result !== null) setResult(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const settle = (detection: DevPreviewServiceDetection | null): void => {
      if (!cancelled) setResult({ key, token, detection });
    };
    const [localPorts, remotePorts, ownPorts] = portsKey
      .split(';')
      .map((list) => (list ? list.split(',').map(Number) : []));
    void window.api
      .detectDevPreviewServices(workspaceId, localPorts, remotePorts, ownPorts)
      .then(settle, () => settle(null));
    return () => {
      cancelled = true;
    };
  }, [enabled, key, portsKey, token, workspaceId]);

  const ready = enabled && result?.key === key;
  return {
    detection: ready ? result.detection : null,
    ready,
    pending: enabled && result?.token !== token,
  };
}

/**
 * Bumps `setTick` `delayMs` after each answer while `waiting`, that is
 * while a list is shown and no check is pending; the bump must end the wait,
 * as a new `refreshKey` above does. A hidden window, such as a minimized one,
 * bumps only once it shows again.
 */
export function useLiveRefresh(
  waiting: boolean,
  setTick: Dispatch<SetStateAction<number>>,
  delayMs = LIVE_REFRESH_MS
): void {
  useEffect(() => {
    if (!waiting) return;
    let due = false;
    const refresh = (): void => {
      if (!due || document.visibilityState === 'hidden') return;
      due = false;
      setTick((tick) => tick + 1);
    };
    const timer = setTimeout(() => {
      due = true;
      refresh();
    }, delayMs);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [delayMs, setTick, waiting]);
}

const NO_PORTS: number[] = [];

/** Which of the ports asked about for a workspace this user's processes listened on. */
export interface OwnPortsAnswer {
  workspaceId: string;
  checkedPorts: ReadonlySet<number>;
  openPorts: ReadonlySet<number>;
  /** When main began reading the ports, as Date.now() there. */
  checkedAt: number;
}

/**
 * The localhost URLs the workspace's terminals printed and the servers found running,
 * for a list on screen while `open`. The terminals are scanned on each check, so a
 * port that changed since the list last opened shows up. `ownPorts` are other ports
 * on the machine the workspace runs on to check alongside: `own` holds those this
 * user's processes listen on, which ports and workspace were checked and when main
 * checked, and is null while that's unknown.
 */
export function usePreviewUrlCandidates(
  workspaceId: string,
  isSshWorkspace: boolean,
  open: boolean,
  ownPorts: number[] = NO_PORTS
): {
  candidates: PreviewUrlCandidate[];
  ready: boolean;
  own: OwnPortsAnswer | null;
} {
  const [refreshTick, setRefreshTick] = useState(0);
  const scannedCandidates = useMemo(() => {
    void refreshTick;
    if (!open) return [];
    // Read on each check rather than followed, as background runs' output changes often.
    const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
    return scanWorkspaceTerminalsForLocalhostUrlCandidates(workspaceId, workspace);
  }, [open, refreshTick, workspaceId]);
  const detectionPorts = useMemo(
    () => ({ ...getCandidatePorts(scannedCandidates, isSshWorkspace), own: ownPorts }),
    [isSshWorkspace, ownPorts, scannedCandidates]
  );
  const { detection, ready, pending } = useDevPreviewServices(
    workspaceId,
    detectionPorts,
    open,
    refreshTick
  );
  // While the list is open, look again a few seconds after each answer, every second at
  // first, so servers that start or stop show up without reopening it.
  useLiveRefresh(open && !pending, setRefreshTick, liveRefreshDelay(refreshTick));
  const candidates = useMemo(
    () => mergeDetectedServices(scannedCandidates, detection, isSshWorkspace),
    [detection, isSshWorkspace, scannedCandidates]
  );
  // An answer is for the workspace and ports asked about.
  const own = useMemo(
    () =>
      detection?.ownOpenPorts && detection.checkedAt !== undefined
        ? {
            workspaceId,
            checkedPorts: new Set(ownPorts),
            openPorts: new Set(detection.ownOpenPorts),
            checkedAt: detection.checkedAt,
          }
        : null,
    [detection, ownPorts, workspaceId]
  );
  return { candidates, ready, own };
}
