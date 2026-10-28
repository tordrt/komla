import { ArrowClockwise, Plug, WarningCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useBrowserTabsSource } from '@/hooks/useBrowserTabsSource';
import {
  liveRefreshDelay,
  useDevPreviewServices,
  useLiveRefresh,
} from '@/hooks/useDevPreviewServices';
import { useForwardSshPreviewUrl } from '@/hooks/useForwardSshPreviewUrl';
import { isSshForwardedBrowserTab, updatePaneBrowserTabs } from '@/lib/browser-tabs';
import {
  decidePreviewCandidate,
  getCandidatePorts,
  isNonHttpListener,
  mergeDetectedServices,
  type PreviewUrlCandidate,
} from '@/lib/dev-preview-candidates';
import { useEditorSurfaceBackground } from '@/lib/palette-runtime';
import { rememberTerminalLinks, recordOpenedRecentLink } from '@/lib/recent-links';
import {
  parseLoopbackForwardIntent,
  scanWorkspaceTerminalsForLocalhostUrlCandidates,
  type LoopbackForwardIntent,
} from '@/lib/scan-terminal-urls';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useDevServerPreviewStore } from '@/stores/dev-server-preview.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { useWorktreeEventsStore } from '@/stores/worktree-events.store';
import { isLocalTerminalExecutionLocation } from '@/types';

import {
  addBrowserTab,
  getActiveBrowserTab,
  getBrowserTabs,
  isLocalPageUrl,
  isSameBrowserUrl,
  setActiveBrowserTabUrl,
} from '../../../shared/lib/browser-tabs';
import { isLoopbackUrl } from '../../../shared/lib/loopback-url';

import { BrowserLinksList, type BrowserLinkPick } from './BrowserLinksList';
import { InlineDevServerPreviewHeader } from './InlineDevServerPreviewHeader';
import { NativeDevPreviewHost } from './NativeDevPreviewHost';

// Per-attempt probe timeout — short so retries during dev-server startup
// stay responsive.
const PROBE_TIMEOUT_MS = 1500;
// How long to keep retrying a not-yet-reachable URL. Agents commonly open the
// preview while the dev server is still booting, so the panel polls until the
// server answers (or the user gives up and hits "Try again").
const RETRY_WINDOW_MS = 25_000;
// Backoff between retry attempts; the last value repeats once the window is
// long enough to exhaust the list.
const RETRY_DELAYS_MS = [500, 1000, 2000, 2000, 4000];
const AUTO_RELOAD_DEBOUNCE_MS = 250;
const NO_SERVERS: { candidates: PreviewUrlCandidate[]; ready: boolean } = {
  candidates: [],
  ready: true,
};

interface InlineDevServerPreviewPanelProps {
  workspaceId: string;
  /** The browser pane's surface id. */
  browserId: string;
  isActive?: boolean;
  isSplitResizeActive?: boolean;
  /** Something covers the page, such as the file panel over a browser pane, so it hides. */
  isCovered?: boolean;
}

function appendForwardPath(localUrl: string, pathSuffix?: string): string {
  if (!pathSuffix) return localUrl;
  try {
    const local = new URL(localUrl);
    const forwarded = new URL(pathSuffix.startsWith('//') ? `.${pathSuffix}` : pathSuffix, local);
    return forwarded.origin === local.origin ? forwarded.toString() : local.toString();
  } catch {
    return localUrl;
  }
}

/**
 * Why the tab's page last failed to load, for sites the panel can't probe.
 * Retrying shows the page again, which loads it again.
 */
function usePageLoadError(
  workspaceId: string,
  tabId: string | undefined,
  url: string | null
): { error: string | null; retry: () => void } {
  // A failure belongs to the tab and URL it happened to, so another tab or URL
  // loads afresh.
  const [failure, setFailure] = useState<{ tabId: string; url: string; message: string } | null>(
    null
  );
  useEffect(() => {
    if (!tabId || !url) return;
    return window.api.onDevPreviewNavigationStateChanged((state) => {
      if (state.workspaceId !== workspaceId || state.tabId !== tabId) return;
      setFailure(state.loadError ? { tabId, url, message: state.loadError } : null);
    });
  }, [tabId, url, workspaceId]);
  const retry = useCallback(() => setFailure(null), []);
  const error =
    failure && failure.tabId === tabId && failure.url === url && !isLoopbackUrl(url)
      ? failure.message
      : null;
  return { error, retry };
}

export function InlineDevServerPreviewPanel({
  workspaceId,
  browserId,
  isActive = true,
  isSplitResizeActive = false,
  isCovered = false,
}: InlineDevServerPreviewPanelProps) {
  const reloadKey = useDevServerPreviewStore((s) => s.reloadKeyByWorkspace[browserId] ?? 0);
  const probeKey = useDevServerPreviewStore((s) => s.probeKeyByWorkspace[browserId] ?? 0);
  const defaultAutoReload = useConfigStore(
    (s) => s.config?.defaultDevServerPreviewAutoReload ?? true
  );
  const autoReload = useDevServerPreviewStore(
    (s) => s.autoReloadByWorkspace[workspaceId] ?? defaultAutoReload
  );
  const workspaceForward = useDevServerPreviewStore(
    (s) => (s.remoteForwardByWorkspace ?? {})[browserId]
  );
  const bumpReloadKey = useDevServerPreviewStore((s) => s.bumpReloadKey);
  const lastWorktreeEventAt = useWorktreeEventsStore(
    (s) => s.lastEventByWorkspace[workspaceId] ?? 0
  );

  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const background = useEditorSurfaceBackground();
  const tabsSource = useBrowserTabsSource(browserId);
  const activeTab = getActiveBrowserTab(tabsSource);
  const tabId = activeTab?.id;
  const tabCount = getBrowserTabs(tabsSource).length;
  const persistedUrl = activeTab?.url;
  // The store keeps the tab on screen's tunnel; another tab finds its own still running when shown.
  const remoteForward = workspaceForward?.tabId === tabId ? workspaceForward : undefined;
  const startSshPreviewForward = useDevServerPreviewStore((s) => s.startSshPreviewForward);
  const stopSshPreviewForward = useDevServerPreviewStore((s) => s.stopSshPreviewForward);
  const forwardRemoteUrl = useForwardSshPreviewUrl(workspaceId, browserId);
  const isSshWorkspace = workspace?.backend?.kind === 'ssh';
  const persistedUrlIsRemote = isSshForwardedBrowserTab(workspace, activeTab);

  const forwardedUrl =
    remoteForward?.status === 'active' && remoteForward.forward?.localUrl
      ? appendForwardPath(remoteForward.forward.localUrl, remoteForward.pathSuffix)
      : null;
  const persistedForwardIntent = useMemo(
    () =>
      persistedUrlIsRemote && persistedUrl?.trim()
        ? parseLoopbackForwardIntent(persistedUrl.trim())
        : null,
    [persistedUrl, persistedUrlIsRemote]
  );
  // A tunnel stopped by the user or a workspace stop stays stopped until the
  // saved URL changes, the user forwards again, or the workspace restarts.
  const forwardStopped = remoteForward?.status === 'stopped';
  const hasPersistedUrl = !persistedUrlIsRemote && Boolean(persistedUrl?.trim());
  const hasConfiguredUrl =
    hasPersistedUrl ||
    Boolean(persistedForwardIntent) ||
    (Boolean(remoteForward) && !forwardStopped);
  const terminalScanTrigger = autoReload ? lastWorktreeEventAt : 0;
  const hasWorkspace = workspace !== undefined && tabsSource !== undefined;
  const hasTab = tabId !== undefined;

  // A browser always shows a tab, so one without tabs gets an empty one.
  useEffect(() => {
    if (!isActive || !hasWorkspace || hasTab) return;
    updatePaneBrowserTabs(browserId, (current) =>
      getBrowserTabs(current).length > 0 ? null : addBrowserTab(current)
    );
  }, [browserId, hasTab, hasWorkspace, isActive]);

  const pickUrl = useCallback(
    (candidate: PreviewUrlCandidate) => {
      if (isSshWorkspace && !isLocalTerminalExecutionLocation(candidate.executionLocation)) {
        void forwardRemoteUrl(candidate.url);
        return;
      }
      if (remoteForward) void stopSshPreviewForward(workspaceId, { tabId: remoteForward.tabId });
      updatePaneBrowserTabs(browserId, (current) =>
        setActiveBrowserTabUrl(current, candidate.url, candidate.executionLocation)
      );
    },
    [browserId, forwardRemoteUrl, isSshWorkspace, remoteForward, stopSshPreviewForward, workspaceId]
  );
  const openLink = useCallback(
    (url: string) => {
      recordOpenedRecentLink(workspaceId, url);
      if (remoteForward) void stopSshPreviewForward(workspaceId, { tabId: remoteForward.tabId });
      updatePaneBrowserTabs(browserId, (current) => setActiveBrowserTabUrl(current, url));
    },
    [browserId, remoteForward, stopSshPreviewForward, workspaceId]
  );

  // A saved remote URL forwards on its own when no tunnel exists (first open,
  // or after a restart) and when it was saved after the current tunnel or
  // request. Otherwise pending, failed, and stopped tunnels wait for the user.
  const savedAutoForward =
    isActive && persistedForwardIntent && remoteForward?.savedUrl !== persistedUrl
      ? persistedForwardIntent
      : null;
  // StrictMode runs effects twice with the same values; start each tunnel once.
  const lastSavedAutoForwardRef = useRef<LoopbackForwardIntent | null>(null);
  useEffect(() => {
    if (!savedAutoForward || !tabId) {
      lastSavedAutoForwardRef.current = null;
      return;
    }
    if (lastSavedAutoForwardRef.current === savedAutoForward) return;
    lastSavedAutoForwardRef.current = savedAutoForward;
    void startSshPreviewForward(
      workspaceId,
      tabId,
      savedAutoForward.remotePort,
      savedAutoForward.pathSuffix,
      savedAutoForward.scheme,
      persistedUrl
    );
  }, [persistedUrl, savedAutoForward, startSshPreviewForward, tabId, workspaceId]);

  // First-open scan: when the preview opens with no URL stored, scan the
  // terminals, check which printed URLs still answer and which ports the
  // terminals listen on, then auto-pick or list the choices. Auto-reload
  // worktree events and a poll retrigger the scan while the preview is open,
  // so a server that starts later is picked up without a manual close/reopen.
  // When the stored URL stops answering, the same scan lists what is running.
  const [unreachable, setUnreachable] = useState(false);
  const listingServers = isActive && (!hasConfiguredUrl || unreachable);
  const [pollTick, setPollTick] = useState(0);
  // Each time the pane starts waiting for a server, it looks every second at first again.
  if (!listingServers && pollTick !== 0) setPollTick(0);
  const scannedCandidates = useMemo(() => {
    void terminalScanTrigger;
    void pollTick;
    if (!listingServers) return null;
    // Background runs' output is read on each check rather than followed, as it changes often.
    const scanned = scanWorkspaceTerminalsForLocalhostUrlCandidates(
      workspaceId,
      useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
    );
    // A remote URL that can't be forwarded can't be previewed.
    return scanned.filter(
      (candidate) =>
        !isSshWorkspace ||
        isLocalTerminalExecutionLocation(candidate.executionLocation) ||
        parseLoopbackForwardIntent(candidate.url) !== null
    );
  }, [listingServers, isSshWorkspace, workspaceId, terminalScanTrigger, pollTick]);
  const detectionPorts = useMemo(
    () =>
      scannedCandidates
        ? getCandidatePorts(scannedCandidates, isSshWorkspace)
        : { local: [], remote: [] },
    [isSshWorkspace, scannedCandidates]
  );
  const {
    detection,
    ready: detectionReady,
    pending: detectionPending,
  } = useDevPreviewServices(
    workspaceId,
    detectionPorts,
    scannedCandidates !== null,
    `${terminalScanTrigger}:${pollTick}`
  );
  // While the pane waits for a server or lists choices, look again a few
  // seconds after each answer, every second at first, so servers that start or stop show up.
  useLiveRefresh(listingServers && !detectionPending, setPollTick, liveRefreshDelay(pollTick));
  const mergedCandidates = useMemo(
    () =>
      scannedCandidates && detectionReady
        ? mergeDetectedServices(scannedCandidates, detection, isSshWorkspace)
        : null,
    [detection, detectionReady, isSshWorkspace, scannedCandidates]
  );
  // A printed URL opens on its own only once it is known to answer, so a stale
  // URL left in scrollback never wins over a server that is running. A stored
  // URL is never replaced on its own, even after it stops answering. Only the
  // first tab opens one on its own; a tab added beside it lets the user choose.
  const scanResult = useMemo(() => {
    if (!mergedCandidates || hasConfiguredUrl) return null;
    const decision = decidePreviewCandidate(mergedCandidates);
    return decision.kind === 'auto' && tabCount > 1
      ? { kind: 'pick' as const, candidates: [decision.candidate] }
      : decision;
  }, [hasConfiguredUrl, mergedCandidates, tabCount]);

  const autoPickCandidate = scanResult?.kind === 'auto' ? scanResult.candidate : null;
  const autoPickIsRemote =
    isSshWorkspace &&
    autoPickCandidate !== null &&
    !isLocalTerminalExecutionLocation(autoPickCandidate.executionLocation);
  const detectedForwardIntent =
    autoPickCandidate && autoPickIsRemote
      ? parseLoopbackForwardIntent(autoPickCandidate.url)
      : null;
  const hasRemoteForward = Boolean(remoteForward);

  // StrictMode runs effects mount→cleanup→mount in dev, which would fire two
  // identical `updateWorkspace` writes before the persisted-URL re-render lands.
  // Track the last auto-picked URL so we only persist each one once.
  const lastAutoPickedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoPickCandidate) {
      lastAutoPickedRef.current = null;
      return;
    }
    // After the user stops a tunnel, a detected remote URL waits for a click.
    if (autoPickIsRemote && hasRemoteForward) return;
    const key = `${autoPickCandidate.executionLocation}:${autoPickCandidate.url}`;
    if (lastAutoPickedRef.current === key) return;
    lastAutoPickedRef.current = key;
    pickUrl(autoPickCandidate);
  }, [autoPickCandidate, autoPickIsRemote, hasRemoteForward, pickUrl]);

  const pickerCandidates = scanResult?.kind === 'pick' ? mergedCandidates : null;
  const runningServers =
    hasConfiguredUrl && mergedCandidates
      ? mergedCandidates.filter(
          (candidate) => candidate.live === true && !isNonHttpListener(candidate)
        )
      : [];
  const pickRunningServer = useCallback(
    (candidate: PreviewUrlCandidate) => {
      // The stored URL's server is back: load it again rather than saving it again.
      if (persistedUrl && isSameBrowserUrl(candidate.url, persistedUrl)) bumpReloadKey(browserId);
      else pickUrl(candidate);
    },
    [browserId, bumpReloadKey, persistedUrl, pickUrl]
  );
  const localAutoPickUrl = autoPickCandidate && !autoPickIsRemote ? autoPickCandidate.url : null;
  // A remote URL loads only through its tunnel, never against the desktop.
  const currentUrl = forwardedUrl ?? (hasPersistedUrl ? persistedUrl! : localAutoPickUrl);
  const showEmpty = scanResult?.kind === 'empty';
  const hasLinks = (workspace?.recentLinks?.length ?? 0) > 0;
  // A tab with nothing to show lists the links the terminals print, as well as servers.
  const listingPages = showEmpty || scanResult?.kind === 'pick' || unreachable;
  useEffect(() => {
    if (listingPages) rememberTerminalLinks(workspaceId);
  }, [listingPages, workspaceId]);
  const pickPage = (
    picked: BrowserLinkPick,
    pickServer: (candidate: PreviewUrlCandidate) => void
  ) => (picked.kind === 'server' ? pickServer(picked.candidate) : openLink(picked.link.url));
  const checkingServers = listingServers && scanResult === null;
  // Typed URLs wait for an explicit forward, and so does a saved or detected
  // remote URL after its tunnel was stopped.
  const forwardPrompt =
    remoteForward?.status === 'pending' && remoteForward.remotePort
      ? {
          url: `${remoteForward.scheme ?? 'http'}://localhost:${remoteForward.remotePort}${remoteForward.pathSuffix ?? ''}`,
          remotePort: remoteForward.remotePort,
        }
      : forwardStopped && persistedUrl && persistedForwardIntent
        ? { url: persistedUrl, remotePort: persistedForwardIntent.remotePort }
        : forwardStopped && autoPickCandidate && detectedForwardIntent
          ? { url: autoPickCandidate.url, remotePort: detectedForwardIntent.remotePort }
          : null;
  const autoForward = savedAutoForward ?? (hasRemoteForward ? null : detectedForwardIntent);
  const startingForwardPort =
    remoteForward?.status === 'starting' ? remoteForward.remotePort : autoForward?.remotePort;
  const showForwardStarting = startingForwardPort !== undefined;
  const showForwardFailed = remoteForward?.status === 'failed';
  const [draftRemotePort, setDraftRemotePort] = useState('3000');
  const parsedRemotePort = Number(draftRemotePort);
  const remotePortIsValid =
    Number.isInteger(parsedRemotePort) && parsedRemotePort >= 1 && parsedRemotePort <= 65535;

  const submitRemotePortForward = useCallback(() => {
    if (!remotePortIsValid) return;
    void forwardRemoteUrl(`http://localhost:${parsedRemotePort}`);
  }, [forwardRemoteUrl, parsedRemotePort, remotePortIsValid]);

  // Probe the dev-server URL so we can replace the native view's blank/error page
  // with a friendlier "couldn't reach …" message when the port is closed.
  // The probe also drives the view: it hides while unreachable and becomes
  // visible once a retry finds the server up — so a preview
  // opened against a still-booting dev server recovers without a manual
  // refresh.
  const shouldRenderPreview =
    currentUrl !== null &&
    isActive &&
    !showEmpty &&
    !forwardPrompt &&
    !pickerCandidates &&
    !showForwardStarting &&
    !showForwardFailed;

  // Only servers on this computer are probed: the window may only fetch
  // localhost, and other sites report a failed load from the page itself.
  useEffect(() => {
    if (!shouldRenderPreview || !currentUrl || !isLoopbackUrl(currentUrl)) {
      setUnreachable(false);
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let controller: AbortController | null = null;
    let retryTimer: number | undefined;
    const startedAt = Date.now();

    const probeOnce = async (): Promise<boolean> => {
      controller = new AbortController();
      const probe = controller;
      const timeout = window.setTimeout(() => probe.abort(), PROBE_TIMEOUT_MS);
      try {
        await fetch(currentUrl, { mode: 'no-cors', cache: 'no-store', signal: probe.signal });
        return true;
      } catch {
        return false;
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const run = async () => {
      const reachable = await probeOnce();
      if (cancelled) return;
      if (reachable) {
        // Flipping unreachable back to false shows the native view, so a server
        // that came up mid-retry loads without the user hitting "Try again".
        setUnreachable(false);
        return;
      }
      setUnreachable(true);
      if (Date.now() - startedAt >= RETRY_WINDOW_MS) return;
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      attempt += 1;
      retryTimer = window.setTimeout(run, delay);
    };

    setUnreachable(false);
    void run();

    return () => {
      cancelled = true;
      controller?.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [shouldRenderPreview, currentUrl, reloadKey, probeKey]);

  const { error: pageLoadError, retry: retryPageLoad } = usePageLoadError(
    workspaceId,
    tabId,
    currentUrl
  );

  // Only pages served from this computer reload when the workspace's files
  // change. The tab on screen reloads after each change; a tab that was out
  // of sight reloads once when shown again, if files changed meanwhile.
  const autoReloadApplies =
    autoReload && hasPersistedUrl && !!persistedUrl && isLocalPageUrl(persistedUrl);
  // The latest file change each tab's page has caught up with.
  const caughtUpAtByTabRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!tabId) return;
    const caughtUpAt = caughtUpAtByTabRef.current;
    if (!autoReloadApplies) {
      caughtUpAt.set(tabId, lastWorktreeEventAt);
      return;
    }
    if (!shouldRenderPreview) return;
    const lastCaughtUp = caughtUpAt.get(tabId);
    // A tab's page loads fresh the first time it is shown.
    if (lastCaughtUp === undefined) {
      caughtUpAt.set(tabId, lastWorktreeEventAt);
      return;
    }
    if (lastWorktreeEventAt <= lastCaughtUp) return;

    const eventAt = lastWorktreeEventAt;
    const timer = window.setTimeout(() => {
      caughtUpAt.set(tabId, eventAt);
      bumpReloadKey(browserId);
    }, AUTO_RELOAD_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [
    autoReloadApplies,
    browserId,
    bumpReloadKey,
    lastWorktreeEventAt,
    shouldRenderPreview,
    tabId,
  ]);

  const lastAppliedReloadKeyRef = useRef(reloadKey);

  useEffect(() => {
    if (!shouldRenderPreview) {
      lastAppliedReloadKeyRef.current = reloadKey;
      return;
    }
    if (reloadKey === lastAppliedReloadKeyRef.current) return;
    lastAppliedReloadKeyRef.current = reloadKey;

    if (tabId) void window.api.reloadDevPreview(workspaceId, tabId);
  }, [reloadKey, shouldRenderPreview, tabId, workspaceId]);

  if (!isActive) return null;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      style={{ backgroundColor: background }}
    >
      {/* Keyed by tab, so each tab's toolbar and page start from their own state. */}
      {tabId && (
        <InlineDevServerPreviewHeader
          key={`toolbar:${tabId}`}
          workspaceId={workspaceId}
          browserId={browserId}
        />
      )}
      {!tabId ? null : showForwardStarting ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center text-xs text-muted-foreground">
          <div>Starting SSH tunnel for remote port {startingForwardPort}...</div>
        </div>
      ) : showForwardFailed ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <WarningCircle className="size-8 text-muted-foreground" />
          <div className="space-y-1">
            <div className="text-sm font-medium">
              Couldn&apos;t forward remote port {remoteForward.remotePort}
            </div>
            {remoteForward.error && (
              <div className="max-w-md text-xs text-muted-foreground">{remoteForward.error}</div>
            )}
          </div>
        </div>
      ) : forwardPrompt ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              Forward remote port {forwardPrompt.remotePort}
            </div>
            <div className="max-w-md text-xs text-muted-foreground">
              Load <span className="font-mono">{forwardPrompt.url}</span> through an SSH tunnel.
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void forwardRemoteUrl(forwardPrompt.url)}
          >
            <Plug className="mr-1.5 size-3.5" />
            Forward {forwardPrompt.remotePort}
          </Button>
        </div>
      ) : showEmpty ? (
        // Scrolls once the links below the message don't fit.
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
          <div className="m-auto flex w-full flex-col items-center gap-3 text-center text-xs text-muted-foreground">
            <div className="space-y-1">
              <div>
                {isSshWorkspace
                  ? 'No remote HTTP server detected yet.'
                  : 'No HTTP server detected yet.'}
              </div>
              <div>
                {isSshWorkspace
                  ? 'Start one in a terminal, or forward a remote port manually.'
                  : 'Start one in a terminal, or type a URL above.'}
              </div>
            </div>
            {isSshWorkspace && (
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitRemotePortForward();
                }}
              >
                <label htmlFor={`remote-port-${browserId}`} className="sr-only">
                  Remote port
                </label>
                <input
                  id={`remote-port-${browserId}`}
                  type="number"
                  min={1}
                  max={65535}
                  value={draftRemotePort}
                  onChange={(event) => setDraftRemotePort(event.target.value)}
                  className={cn(
                    'h-8 w-24 rounded-md border bg-background px-2 text-xs text-foreground focus:outline-hidden focus:ring-1',
                    remotePortIsValid
                      ? 'border-border/60 focus:ring-primary/40'
                      : 'border-destructive/60 focus:ring-destructive/40'
                  )}
                />
                <Button type="submit" variant="outline" size="sm" disabled={!remotePortIsValid}>
                  <Plug className="mr-1.5 size-3.5" />
                  Forward
                </Button>
              </form>
            )}
            {hasLinks && (
              <div className="mt-5 w-full max-w-md border-t border-border/40 pt-5 text-left">
                <BrowserLinksList
                  workspaceId={workspaceId}
                  servers={NO_SERVERS}
                  onPick={(picked) => pickPage(picked, pickUrl)}
                  opensExternally={false}
                  emptyText=""
                />
              </div>
            )}
          </div>
        </div>
      ) : pickerCandidates ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-8">
          <div className="mx-auto w-full max-w-md">
            <div className="mb-5 space-y-0.5">
              <div className="text-sm font-medium text-foreground">Choose what to preview</div>
              <div className="text-xs text-muted-foreground">
                Servers and links from this workspace's terminals.
              </div>
            </div>
            <BrowserLinksList
              workspaceId={workspaceId}
              servers={{ candidates: pickerCandidates, ready: true }}
              onPick={(picked) => pickPage(picked, pickUrl)}
              opensExternally={false}
              emptyText="No running servers or links found."
              className="rounded-lg border border-border/60 bg-card/40"
            />
          </div>
        </div>
      ) : !currentUrl ? (
        checkingServers ? (
          <div className="flex h-full items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
            <Spinner size="xs" />
            Checking running servers…
          </div>
        ) : null
      ) : unreachable ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
          <div className="m-auto flex w-full max-w-md flex-col items-center gap-3 text-center">
            <WarningCircle className="size-8 text-muted-foreground" />
            <div className="space-y-1">
              <div className="text-sm font-medium">
                Couldn&apos;t reach <span className="font-mono">{currentUrl}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                No response from the server. Make sure your HTTP server is running on this port.
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => bumpReloadKey(browserId)}>
              <ArrowClockwise className="mr-1.5 size-3.5" />
              Try again
            </Button>
            {(runningServers.length > 0 || hasLinks) && (
              <div className="mt-5 w-full border-t border-border/40 pt-5 text-left">
                <BrowserLinksList
                  workspaceId={workspaceId}
                  servers={{ candidates: runningServers, ready: mergedCandidates !== null }}
                  onPick={(picked) => pickPage(picked, pickRunningServer)}
                  opensExternally={false}
                  emptyText=""
                />
              </div>
            )}
          </div>
        </div>
      ) : pageLoadError ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
          <div className="m-auto flex w-full max-w-md flex-col items-center gap-3 text-center">
            <WarningCircle className="size-8 text-muted-foreground" />
            <div className="space-y-1">
              <div className="text-sm font-medium">
                Couldn&apos;t load <span className="font-mono break-all">{currentUrl}</span>
              </div>
              <div className="font-mono text-xs text-muted-foreground">{pageLoadError}</div>
            </div>
            <Button variant="outline" size="sm" onClick={retryPageLoad}>
              <ArrowClockwise className="mr-1.5 size-3.5" />
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <NativeDevPreviewHost
          key={`page:${tabId}`}
          workspaceId={workspaceId}
          tabId={tabId}
          url={currentUrl}
          visible={shouldRenderPreview && !isSplitResizeActive && !isCovered}
        />
      )}
    </div>
  );
}
