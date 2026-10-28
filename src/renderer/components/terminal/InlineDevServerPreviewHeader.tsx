import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  ArrowSquareOut,
  Broom,
  CaretDown,
  DotsThree,
  Lightning,
  Plug,
  PlugsConnected,
  StopCircle,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useBrowserTabsSource } from '@/hooks/useBrowserTabsSource';
import { useForwardSshPreviewUrl } from '@/hooks/useForwardSshPreviewUrl';
import { isSshForwardedBrowserTab, updatePaneBrowserTabs } from '@/lib/browser-tabs';
import { recordOpenedRecentLink } from '@/lib/recent-links';
import { parseLoopbackForwardIntent, type LoopbackForwardIntent } from '@/lib/scan-terminal-urls';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useDevServerPreviewStore } from '@/stores/dev-server-preview.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isLocalTerminalExecutionLocation } from '@/types';

import {
  getActiveBrowserTab,
  isBrowserUrl,
  isLocalPageUrl,
  setBrowserTabUrl,
  toBrowserUrl,
} from '../../../shared/lib/browser-tabs';
import { isLoopbackUrl } from '../../../shared/lib/loopback-url';

import { BrowserLinksList, type BrowserLinkPick } from './BrowserLinksList';

import type { DevPreviewNavigationState, TerminalExecutionLocation } from '../../../shared/types';

const DEFAULT_URL = 'http://localhost:3000';

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

function matchesForwardTarget(
  target: { remotePort?: number; pathSuffix?: string; scheme?: string },
  intent: LoopbackForwardIntent
): boolean {
  return (
    target.remotePort === intent.remotePort &&
    (target.pathSuffix ?? '') === intent.pathSuffix &&
    (target.scheme ?? 'http') === intent.scheme
  );
}

function formatRemoteForwardUrl(
  remotePort?: number,
  pathSuffix?: string,
  scheme: 'http' | 'https' = 'http'
): string | undefined {
  if (!remotePort) return undefined;
  return `${scheme}://localhost:${remotePort}${pathSuffix ?? ''}`;
}

function mapForwardedNavigationUrl(
  navigationUrl: string,
  localForwardUrl: string,
  remoteTargetUrl: string
): string {
  try {
    const navigation = new URL(navigationUrl);
    const localForward = new URL(localForwardUrl);
    if (navigation.origin !== localForward.origin) return navigationUrl;

    const remoteTarget = new URL(remoteTargetUrl);
    remoteTarget.pathname = navigation.pathname;
    remoteTarget.search = navigation.search;
    remoteTarget.hash = navigation.hash;
    return remoteTarget.toString();
  } catch {
    return navigationUrl;
  }
}

interface InlineDevServerPreviewHeaderProps {
  workspaceId: string;
  /** The browser pane's surface id. */
  browserId: string;
}

/** A browser's toolbar for its active tab: history, address, reload and more. */
export function InlineDevServerPreviewHeader({
  workspaceId,
  browserId,
}: InlineDevServerPreviewHeaderProps) {
  const workspaceForward = useDevServerPreviewStore(
    (s) => (s.remoteForwardByWorkspace ?? {})[browserId]
  );
  const bumpReloadKey = useDevServerPreviewStore((s) => s.bumpReloadKey);
  const bumpProbeKey = useDevServerPreviewStore((s) => s.bumpProbeKey);
  const requestSshPreviewForward = useDevServerPreviewStore((s) => s.requestSshPreviewForward);
  const stopSshPreviewForward = useDevServerPreviewStore((s) => s.stopSshPreviewForward);
  const defaultAutoReload = useConfigStore(
    (s) => s.config?.defaultDevServerPreviewAutoReload ?? true
  );
  const autoReload = useDevServerPreviewStore(
    (s) => s.autoReloadByWorkspace[workspaceId] ?? defaultAutoReload
  );
  const toggleAutoReload = useDevServerPreviewStore((s) => s.toggleAutoReload);

  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const activeTab = getActiveBrowserTab(useBrowserTabsSource(browserId));
  const tabId = activeTab?.id ?? '';
  const persistedUrl = activeTab?.url;
  const remoteForward = workspaceForward?.tabId === tabId ? workspaceForward : undefined;
  const forwardRemoteUrl = useForwardSshPreviewUrl(workspaceId, browserId);
  const persistedCurrentUrl = persistedUrl?.trim() ? persistedUrl : '';
  const activeForwardUrl =
    remoteForward?.status === 'active' && remoteForward.forward?.localUrl
      ? appendForwardPath(remoteForward.forward.localUrl, remoteForward.pathSuffix)
      : undefined;
  const activeForwardTargetUrl =
    remoteForward?.status === 'active'
      ? formatRemoteForwardUrl(
          remoteForward.remotePort,
          remoteForward.pathSuffix,
          remoteForward.scheme
        )
      : undefined;
  const currentPreviewUrl = activeForwardUrl ?? persistedCurrentUrl;
  const isSshWorkspace = workspace?.backend?.kind === 'ssh';
  // Localhost typed here means the SSH host, unless the tab shows this computer.
  const isRemoteSshPreview =
    isSshWorkspace &&
    !isLocalTerminalExecutionLocation(activeTab?.urlExecutionLocation ?? 'workspace');
  const isForwardedTab = isSshForwardedBrowserTab(workspace, activeTab);
  // Auto reload is a workspace setting, but only pages on this computer reload.
  const autoReloadApplies = !isForwardedTab && isLocalPageUrl(persistedCurrentUrl);
  const autoReloadActive = autoReload && autoReloadApplies;
  // A remote URL opens on this machine only through its tunnel.
  const externalUrl = isForwardedTab ? activeForwardUrl : currentPreviewUrl || undefined;
  const isForwardBusy =
    remoteForward?.status === 'starting' || remoteForward?.status === 'stopping';

  const [draftUrl, setDraftUrl] = useState(persistedCurrentUrl);
  const [navigationState, setNavigationState] = useState<DevPreviewNavigationState>({
    workspaceId,
    tabId,
    url: currentPreviewUrl,
    title: '',
    canGoBack: false,
    canGoForward: false,
    loadError: null,
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  // Several browsers can show at once.
  const autoReloadStatusId = useId();
  const addressFieldRef = useRef<HTMLInputElement>(null);
  const pickerListRef = useRef<HTMLDivElement>(null);
  const [remotePortDialogOpen, setRemotePortDialogOpen] = useState(false);
  const [draftRemotePort, setDraftRemotePort] = useState(
    remoteForward?.remotePort ? String(remoteForward.remotePort) : '3000'
  );
  const draftIsValid = !draftUrl.trim() || toBrowserUrl(draftUrl) !== null;
  const parsedRemotePort = Number(draftRemotePort);
  const remotePortIsValid =
    Number.isInteger(parsedRemotePort) && parsedRemotePort >= 1 && parsedRemotePort <= 65535;

  useEffect(() => {
    setDraftUrl(activeForwardTargetUrl ?? persistedCurrentUrl);
  }, [activeForwardTargetUrl, persistedCurrentUrl]);

  // The toolbar mounts per tab. A tab's saved URL follows its navigation, so
  // history state is left to the page's own updates rather than reset on it.
  useEffect(() => {
    return window.api.onDevPreviewNavigationStateChanged((state) => {
      if (state.workspaceId !== workspaceId || state.tabId !== tabId) return;
      const displayUrl =
        isForwardedTab && activeForwardUrl && activeForwardTargetUrl
          ? mapForwardedNavigationUrl(state.url, activeForwardUrl, activeForwardTargetUrl)
          : state.url;
      setNavigationState({ ...state, url: displayUrl });
      if (isBrowserUrl(displayUrl)) setDraftUrl(displayUrl);
    });
  }, [activeForwardTargetUrl, activeForwardUrl, isForwardedTab, tabId, workspaceId]);

  const persistUrl = useCallback(
    (url: string, executionLocation?: TerminalExecutionLocation) => {
      updatePaneBrowserTabs(browserId, (current) =>
        setBrowserTabUrl(current, tabId, url, executionLocation)
      );
    },
    [browserId, tabId]
  );

  const submitUrl = useCallback(() => {
    // Typing example.com or localhost:3000 is enough; invalid text stays
    // visible so the user can fix it.
    const trimmed = toBrowserUrl(draftUrl);
    if (!trimmed) return;
    if (isRemoteSshPreview && isLoopbackUrl(trimmed)) {
      const intent = parseLoopbackForwardIntent(trimmed);
      if (!intent) return;
      // Re-submitting the open or starting tunnel's URL (e.g. on blur) keeps it.
      if (
        (remoteForward?.status === 'active' || remoteForward?.status === 'starting') &&
        matchesForwardTarget(remoteForward, intent)
      ) {
        return;
      }
      setDraftUrl(trimmed);
      if (remoteForward?.status === 'active' && remoteForward.remotePort === intent.remotePort) {
        void forwardRemoteUrl(trimmed);
        return;
      }
      requestSshPreviewForward(
        workspaceId,
        tabId,
        intent.remotePort,
        intent.pathSuffix,
        intent.scheme,
        persistedUrl
      );
      return;
    }
    if (trimmed === persistedCurrentUrl) return;
    setDraftUrl(trimmed);
    // A page loaded directly no longer needs this tab's tunnel.
    if (remoteForward) void stopSshPreviewForward(workspaceId, { tabId });
    persistUrl(trimmed);
  }, [
    draftUrl,
    forwardRemoteUrl,
    isRemoteSshPreview,
    persistedCurrentUrl,
    persistedUrl,
    persistUrl,
    remoteForward,
    requestSshPreviewForward,
    stopSshPreviewForward,
    tabId,
    workspaceId,
  ]);

  const reload = useCallback(() => {
    bumpReloadKey(browserId);
  }, [browserId, bumpReloadKey]);

  const navigate = useCallback(
    (direction: 'back' | 'forward') => {
      void window.api.navigateDevPreview(workspaceId, tabId, direction);
    },
    [tabId, workspaceId]
  );

  const hardReload = useCallback(async () => {
    const reloadPromise = window.api.reloadDevPreview(workspaceId, tabId, true);
    bumpProbeKey(browserId);
    await reloadPromise;
  }, [browserId, bumpProbeKey, tabId, workspaceId]);

  const resetSiteData = useCallback(async () => {
    await window.api.clearDevPreviewSiteData(workspaceId, tabId);
    bumpReloadKey(browserId);
  }, [browserId, bumpReloadKey, tabId, workspaceId]);

  const openExternal = useCallback(() => {
    if (externalUrl) void window.api.openExternal(externalUrl);
  }, [externalUrl]);

  const pickPage = useCallback(
    (picked: BrowserLinkPick) => {
      setPickerOpen(false);
      const { url, executionLocation } =
        picked.kind === 'server'
          ? picked.candidate
          : { url: picked.link.url, executionLocation: undefined };
      if (picked.kind === 'link') {
        recordOpenedRecentLink(workspaceId, url);
      } else if (isSshWorkspace && !isLocalTerminalExecutionLocation(executionLocation)) {
        void forwardRemoteUrl(url);
        return;
      }
      if (remoteForward) void stopSshPreviewForward(workspaceId, { tabId });
      setDraftUrl(url);
      persistUrl(url, executionLocation);
    },
    [
      forwardRemoteUrl,
      isSshWorkspace,
      persistUrl,
      remoteForward,
      stopSshPreviewForward,
      tabId,
      workspaceId,
    ]
  );

  const submitRemotePort = useCallback(async () => {
    if (!remotePortIsValid) return;
    await forwardRemoteUrl(`http://localhost:${parsedRemotePort}`);
    setRemotePortDialogOpen(false);
  }, [forwardRemoteUrl, parsedRemotePort, remotePortIsValid]);

  if (!activeTab) return null;

  const pickerPopoverContent = (
    <PopoverContent
      align="end"
      sideOffset={6}
      className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-96 max-w-[var(--radix-popover-content-available-width)] flex-col p-0"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        // Opened from the address field, the list leaves focus there for typing.
        if (document.activeElement !== addressFieldRef.current) pickerListRef.current?.focus();
      }}
      onCloseAutoFocus={(event) => {
        if (document.activeElement === addressFieldRef.current) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (event.target === addressFieldRef.current) event.preventDefault();
      }}
    >
      <BrowserLinksList
        workspaceId={workspaceId}
        onPick={pickPage}
        opensExternally={false}
        emptyText="No running servers or links found."
        listRef={pickerListRef}
        className="flex-1"
      />
    </PopoverContent>
  );

  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-1.5 overflow-hidden border-b border-border/60 px-2">
        <div className="flex h-6 shrink-0 items-center">
          {/* Opens over the tab row, so it closes once the pointer leaves the
              button rather than covering the tabs on the way up. */}
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors enabled:hover:bg-muted/80 enabled:hover:text-foreground disabled:opacity-35"
                onClick={() => navigate('back')}
                disabled={!navigationState.canGoBack}
                aria-label="Go back"
              >
                <ArrowLeft className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" avoidCollisions={false}>
              Back
            </TooltipContent>
          </Tooltip>
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors enabled:hover:bg-muted/80 enabled:hover:text-foreground disabled:opacity-35"
                onClick={() => navigate('forward')}
                disabled={!navigationState.canGoForward}
                aria-label="Go forward"
              >
                <ArrowRight className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" avoidCollisions={false}>
              Forward
            </TooltipContent>
          </Tooltip>
        </div>
        <div
          className={cn(
            'flex h-6 min-w-0 flex-1 items-stretch overflow-hidden rounded-md border bg-background focus-within:ring-1',
            draftIsValid
              ? 'border-border/50 focus-within:ring-primary/40'
              : 'border-destructive/60 focus-within:ring-destructive/40'
          )}
        >
          <Tooltip open={!draftIsValid ? undefined : false}>
            <TooltipTrigger asChild>
              <input
                ref={addressFieldRef}
                data-browser-address={browserId}
                type="text"
                value={draftUrl}
                onChange={(e) => {
                  setDraftUrl(e.target.value);
                  setPickerOpen(false);
                }}
                // A click lists the running servers, unless the user is typing a URL.
                onClick={() => {
                  if (draftUrl === persistedCurrentUrl) setPickerOpen(true);
                }}
                onKeyDown={(e) => {
                  // The arrow keys move on into the list.
                  if (e.key === 'ArrowDown' && pickerOpen) {
                    e.preventDefault();
                    pickerListRef.current?.focus();
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    setPickerOpen(false);
                    submitUrl();
                  }
                }}
                onBlur={() => {
                  // Leaving the field unchanged is not a request to forward.
                  if (draftUrl.trim() !== persistedCurrentUrl.trim()) submitUrl();
                }}
                placeholder={DEFAULT_URL}
                spellCheck={false}
                aria-label="Address"
                aria-invalid={!draftIsValid}
                className={cn(
                  'min-w-0 flex-1 bg-transparent px-2 font-mono text-ui placeholder:text-muted-foreground focus:outline-hidden',
                  draftIsValid ? 'text-foreground' : 'text-error'
                )}
              />
            </TooltipTrigger>
            <TooltipContent>
              Enter a web address, such as localhost:3000 or example.com.
            </TooltipContent>
          </Tooltip>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex w-5 shrink-0 items-center justify-center border-l border-border/50 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    aria-label="Pick a running server or link"
                  >
                    <CaretDown className="size-3" />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Pick a running server or link</TooltipContent>
            </Tooltip>
            {pickerPopoverContent}
          </Popover>
        </div>
        <Tooltip disableHoverableContent>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground',
                autoReloadActive && 'text-primary hover:text-primary'
              )}
              onClick={reload}
              aria-label="Reload"
              aria-describedby={autoReloadActive ? autoReloadStatusId : undefined}
            >
              <ArrowClockwise className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" avoidCollisions={false}>
            {autoReloadActive ? 'Reload (auto reload on file changes is on)' : 'Reload'}
          </TooltipContent>
        </Tooltip>
        {autoReloadActive && (
          <span id={autoReloadStatusId} className="sr-only">
            Auto reload on file changes is on
          </span>
        )}
        <DropdownMenu>
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                  aria-label="More preview actions"
                >
                  <DotsThree className="size-4" weight="bold" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" avoidCollisions={false}>
              More preview actions
            </TooltipContent>
          </Tooltip>
          {/* Returning focus to the button would reopen its tooltip over the tabs. */}
          <DropdownMenuContent
            align="end"
            sideOffset={6}
            className="w-56"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuCheckboxItem
              checked={autoReload}
              onCheckedChange={() => toggleAutoReload(workspaceId, defaultAutoReload)}
              indicatorClassName="text-primary"
              uncheckedIndicator={<ArrowsClockwise className="text-muted-foreground" />}
            >
              <span className="flex flex-col">
                <span>Auto reload on changes</span>
                {!autoReloadApplies && (
                  <span className="text-xs text-muted-foreground">
                    Only for pages on this computer
                  </span>
                )}
              </span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {isRemoteSshPreview && (
              <>
                {remoteForward && remoteForward.status !== 'stopped' ? (
                  <DropdownMenuItem
                    onSelect={() =>
                      void stopSshPreviewForward(workspaceId, { keepStopped: true, tabId })
                    }
                    disabled={isForwardBusy}
                  >
                    {isForwardBusy ? <Spinner size="sm" /> : <StopCircle />}
                    Stop SSH port forward
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => setRemotePortDialogOpen(true)}>
                    <Plug />
                    Forward remote port...
                  </DropdownMenuItem>
                )}
                {remoteForward?.status === 'active' && (
                  <DropdownMenuItem disabled>
                    <PlugsConnected />
                    Remote {remoteForward.remotePort} {'->'} local{' '}
                    {remoteForward.forward?.localPort}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => void hardReload()}>
              <Lightning />
              Hard reload
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void resetSiteData()}>
              <Broom />
              Reset site data
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={openExternal} disabled={!externalUrl}>
              <ArrowSquareOut />
              Open in external browser
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog open={remotePortDialogOpen} onOpenChange={setRemotePortDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Forward Remote Port</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRemotePort();
            }}
          >
            <div className="space-y-2">
              <label htmlFor="remote-preview-port" className="block text-sm font-medium">
                Remote port
              </label>
              <Input
                id="remote-preview-port"
                type="number"
                min={1}
                max={65535}
                value={draftRemotePort}
                onChange={(event) => setDraftRemotePort(event.target.value)}
                autoFocus
                aria-invalid={!remotePortIsValid}
              />
              {remoteForward?.status === 'failed' && remoteForward.error && (
                <div className="text-xs text-error">{remoteForward.error}</div>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRemotePortDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!remotePortIsValid || isForwardBusy}>
                {isForwardBusy && <Spinner size="sm" className="mr-1.5" />}
                Forward
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
