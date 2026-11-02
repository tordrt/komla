import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';

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

type DetectionPorts = { local: number[]; remote: number[]; own?: number[] };

// Sorted, as main checks a port list in any order the same.
function detectionKey(workspaceId: string, ports: DetectionPorts): string {
  const list = (each: number[] = []) => [...each].sort((a, b) => a - b).join(',');
  return `${workspaceId}|${list(ports.local)};${list(ports.remote)};${list(ports.own)}`;
}

/** Asks main; null when detection failed. */
function detect(
  workspaceId: string,
  ports: DetectionPorts
): Promise<DevPreviewServiceDetection | null> {
  return window.api
    .detectDevPreviewServices(workspaceId, ports.local, ports.remote, ports.own ?? [])
    .catch(() => null);
}

/** A check started before a list opened, such as while the pointer rests on its button. */
interface AheadCheck {
  request: Promise<DevPreviewServiceDetection | null>;
  /** Its answer, once it came, and when. */
  answered?: { detection: DevPreviewServiceDetection; at: number };
}

// Checks started ahead, by workspace and ports, each for the next list to open. An answer
// stands only as long as an open list would wait to look again.
const aheadChecks = new Map<string, AheadCheck>();

function isFresh(check: AheadCheck): boolean {
  return !check.answered || Date.now() - check.answered.at < LIVE_REFRESH_MS;
}

function freshAheadCheck(key: string): AheadCheck | undefined {
  const check = aheadChecks.get(key);
  return check && isFresh(check) ? check : undefined;
}

/** Forgets the checks started ahead, for tests. */
export function resetAheadChecks(): void {
  aheadChecks.clear();
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
 * again, keeping the previous answer while `pending`. Given `takesAheadCheck`,
 * the first answer for a workspace and port list is that of a fresh check
 * `checkPreviewUrlCandidatesAhead` started for them, if any.
 */
export function useDevPreviewServices(
  workspaceId: string,
  ports: DetectionPorts,
  enabled: boolean,
  refreshKey: number | string = 0,
  takesAheadCheck = false
): { detection: DevPreviewServiceDetection | null; ready: boolean; pending: boolean } {
  const key = detectionKey(workspaceId, ports);
  const portsKey = key.slice(workspaceId.length + 1);
  const token = `${key}|${refreshKey}`;
  const [result, setResult] = useState<DetectionResult | null>(null);
  // The key last answered for while enabled, whose next asks are refreshes.
  const answeredKey = useRef<string | null>(null);
  // Servers may have started or stopped while disabled, so the next enable starts fresh.
  if (!enabled && result !== null) setResult(null);

  useEffect(() => {
    if (!enabled) {
      answeredKey.current = null;
      return;
    }
    let cancelled = false;
    const ahead = takesAheadCheck && answeredKey.current !== key ? freshAheadCheck(key) : undefined;
    const [local, remote, own] = portsKey
      .split(';')
      .map((list) => (list ? list.split(',').map(Number) : []));
    void (ahead?.request ?? detect(workspaceId, { local, remote, own })).then((detection) => {
      // Taken once, even by a list closed since, so a list that reopens asks again.
      if (ahead && aheadChecks.get(key) === ahead) aheadChecks.delete(key);
      if (cancelled) return;
      answeredKey.current = key;
      setResult({ key, token, detection });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, portsKey, takesAheadCheck, token, workspaceId]);

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

// Read on each check rather than followed, as background runs' output changes often.
function scanCandidates(workspaceId: string) {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  return scanWorkspaceTerminalsForLocalhostUrlCandidates(workspaceId, workspace);
}

/**
 * Starts the check `usePreviewUrlCandidates` makes on opening with these arguments, for
 * a list about to open, such as while the pointer rests on its button: the list opens
 * with its answer while that's on its way or a few seconds old. A check still fresh
 * answers instead of a new one. Resolves to the candidates found, or null when the
 * check failed.
 */
export function checkPreviewUrlCandidatesAhead(
  workspaceId: string,
  isSshWorkspace: boolean,
  ownPorts: number[] = NO_PORTS
): Promise<PreviewUrlCandidate[] | null> {
  const scanned = scanCandidates(workspaceId);
  const ports = { ...getCandidatePorts(scanned, isSshWorkspace), own: ownPorts };
  const key = detectionKey(workspaceId, ports);
  let check = freshAheadCheck(key);
  if (!check) {
    for (const [staleKey, stale] of aheadChecks) {
      if (!isFresh(stale)) aheadChecks.delete(staleKey);
    }
    const started: AheadCheck = { request: detect(workspaceId, ports) };
    aheadChecks.set(key, started);
    void started.request.then((detection) => {
      if (aheadChecks.get(key) !== started) return;
      // A failed check leaves the list to ask again.
      if (detection) started.answered = { detection, at: Date.now() };
      else aheadChecks.delete(key);
    });
    check = started;
  }
  return check.request.then((detection) =>
    detection ? mergeDetectedServices(scanned, detection, isSshWorkspace) : null
  );
}

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
 * checked, and is null while that's unknown. The list opens with the answer of a
 * fresh check `checkPreviewUrlCandidatesAhead` started for it, if any.
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
    return open ? scanCandidates(workspaceId) : [];
  }, [open, refreshTick, workspaceId]);
  const detectionPorts = useMemo(
    () => ({ ...getCandidatePorts(scannedCandidates, isSshWorkspace), own: ownPorts }),
    [isSshWorkspace, ownPorts, scannedCandidates]
  );
  const { detection, ready, pending } = useDevPreviewServices(
    workspaceId,
    detectionPorts,
    open,
    refreshTick,
    true
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
