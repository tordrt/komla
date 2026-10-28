import { scanWorkspaceTerminalsForLinks, type ScannedTerminalLink } from '@/lib/scan-terminal-urls';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import {
  isRecentLinkUrl,
  mergePrintedLinks,
  recordOpenedLink,
  sameRecentLinks,
} from '../../shared/lib/recent-links';

import type { WorkspaceRecentLink } from '../../shared/types';

// Hyperlinks arrive with terminal output, so they're saved at most this often.
const HYPERLINK_SAVE_INTERVAL_MS = 2000;
// Each workspace's hyperlinks waiting to be saved, by URL to when it was last printed, oldest first.
const pendingHyperlinks = new Map<string, Map<string, number>>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function updateRecentLinks(
  workspaceId: string,
  change: (links: WorkspaceRecentLink[]) => WorkspaceRecentLink[]
): void {
  const { workspaces, updateWorkspace } = useWorkspacesStore.getState();
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return;
  const current = workspace.recentLinks ?? [];
  const next = change(current);
  if (sameRecentLinks(current, next)) return;
  updateWorkspace(workspaceId, { recentLinks: next });
  void window.api.updateWorkspace(workspaceId, { recentLinks: next });
}

function flushHyperlinks(workspaceId: string): void {
  clearTimeout(pendingTimers.get(workspaceId));
  pendingTimers.delete(workspaceId);
  const printed = pendingHyperlinks.get(workspaceId);
  pendingHyperlinks.delete(workspaceId);
  if (printed) {
    const newestFirst = [...printed].reverse().map(([url, printedAt]) => ({ url, printedAt }));
    updateRecentLinks(workspaceId, (links) => mergePrintedLinks(links, newestFirst, Date.now()));
  }
}

/** Adds a link to the workspace's recent links as one you opened. */
export function recordOpenedRecentLink(workspaceId: string, url: string): void {
  flushHyperlinks(workspaceId);
  updateRecentLinks(workspaceId, (links) => recordOpenedLink(links, url, Date.now()));
}

/** Adds the target of an OSC 8 hyperlink a terminal printed. */
export function notePrintedHyperlink(workspaceId: string, url: string): void {
  if (!isRecentLinkUrl(url)) return;
  const printed = pendingHyperlinks.get(workspaceId) ?? new Map<string, number>();
  printed.delete(url);
  printed.set(url, Date.now());
  pendingHyperlinks.set(workspaceId, printed);
  if (pendingTimers.has(workspaceId)) return;
  pendingTimers.set(
    workspaceId,
    setTimeout(() => flushHyperlinks(workspaceId), HYPERLINK_SAVE_INTERVAL_MS)
  );
}

/**
 * Adds the URLs the workspace's terminals show as text. A URL that ends its line, and
 * that another known link continues with the next line's start, is that link cut where
 * the program wrapped it.
 */
export function rememberTerminalLinks(workspaceId: string): void {
  flushHyperlinks(workspaceId);
  const scanned = scanWorkspaceTerminalsForLinks(workspaceId);
  updateRecentLinks(workspaceId, (links) => {
    const known = [...links.map((link) => link.url), ...scanned.map((link) => link.url)];
    const isCutOff = ({ url, continuation }: ScannedTerminalLink): boolean =>
      !!continuation &&
      known.some(
        (other) =>
          other.length > url.length &&
          other.startsWith(url) &&
          other.slice(url.length).startsWith(continuation)
      );
    return mergePrintedLinks(
      links,
      scanned.filter((link) => !isCutOff(link)),
      Date.now()
    );
  });
}
