import {
  MAX_BROWSER_URL_LENGTH,
  isBrowserUrl,
  isLocalPageUrl,
  parseBrowserUrl,
} from './browser-tabs';

import type { WorkspaceRecentLink } from '../types/workspace';

export const MAX_RECENT_LINKS = 50;
// A link you opened ranks as if a terminal had printed it this much later.
const OPENED_LINK_BOOST_MS = 2 * 60 * 60_000;
// A link printed again this soon after keeps its time, so a program that redraws a link,
// as a status line does, doesn't change the list each time; the list shows minutes.
const REPRINT_RESOLUTION_MS = 60_000;

/**
 * Whether a URL belongs in a workspace's recent links: a web page on another site.
 * Pages on this computer are listed with the running servers instead, and so are the
 * addresses dev servers print for the local network.
 */
export function isRecentLinkUrl(url: string): boolean {
  // The saved form spells out characters such as é, and must still fit.
  return (
    isBrowserUrl(url) &&
    !isLocalPageUrl(url) &&
    !isLocalNetworkHost(parseBrowserUrl(url)?.hostname ?? '') &&
    canonical(url).length <= MAX_BROWSER_URL_LENGTH
  );
}

/** Every address, as in `http://[::]:8000/`, or a private, shared or link-local one. */
function isLocalNetworkHost(hostname: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return hostname === '[::]' || /^\[(f[cd]|fe[89ab])[\da-f]*:/i.test(hostname);
}

// So `https://example.com` and `https://example.com/` are one link.
function canonical(url: string): string {
  return parseBrowserUrl(url)?.toString() ?? url;
}

function rank({ openedAt, printedAt }: WorkspaceRecentLink): number {
  const latest = Math.max(openedAt ?? 0, printedAt ?? 0);
  return openedAt === undefined ? latest : latest + OPENED_LINK_BOOST_MS;
}

/** Most recently printed or opened first, opened links boosted; ties keep their order. */
function ordered(links: WorkspaceRecentLink[]): WorkspaceRecentLink[] {
  return [...links].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_RECENT_LINKS);
}

/** Marks `url` as opened at `now`, adding it if the list doesn't have it. */
export function recordOpenedLink(
  links: WorkspaceRecentLink[],
  url: string,
  now: number
): WorkspaceRecentLink[] {
  if (!isRecentLinkUrl(url)) return links;
  const opened = canonical(url);
  const existing = links.find((link) => link.url === opened);
  return ordered([
    { ...existing, url: opened, openedAt: now },
    ...links.filter((link) => link.url !== opened),
  ]);
}

/**
 * Adds the links the terminals show, each at its latest print. A link printed at an
 * unknown time keeps the time it was last seen, or counts as printed `now` when it's new.
 */
export function mergePrintedLinks(
  links: WorkspaceRecentLink[],
  prints: Array<{ url: string; printedAt?: number }>,
  now: number
): WorkspaceRecentLink[] {
  const byUrl = new Map(links.map((link) => [link.url, link]));
  const printed = new Map<string, WorkspaceRecentLink>();
  for (const { url: raw, printedAt } of prints) {
    if (!isRecentLinkUrl(raw)) continue;
    const url = canonical(raw);
    const saved = byUrl.get(url)?.printedAt;
    const latest = printed.get(url)?.printedAt ?? saved;
    let time = Math.max(printedAt ?? latest ?? now, latest ?? 0);
    if (saved !== undefined && time - saved < REPRINT_RESOLUTION_MS) time = saved;
    printed.set(url, { ...byUrl.get(url), url, printedAt: time });
  }
  return ordered([...printed.values(), ...links.filter((link) => !printed.has(link.url))]);
}

export function sameRecentLinks(a: WorkspaceRecentLink[], b: WorkspaceRecentLink[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (link, i) =>
        link.url === b[i].url &&
        link.openedAt === b[i].openedAt &&
        link.printedAt === b[i].printedAt
    )
  );
}

function savedTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Scrubs a saved list, as from a hand-edited file. */
export function normalizeRecentLinks(value: unknown): WorkspaceRecentLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const urls = new Set<string>();
  const links: WorkspaceRecentLink[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { url: saved, openedAt, printedAt } = entry as Record<string, unknown>;
    if (typeof saved !== 'string' || !isRecentLinkUrl(saved)) continue;
    const url = canonical(saved);
    if (urls.has(url)) continue;
    urls.add(url);
    const link: WorkspaceRecentLink = { url };
    if (savedTime(openedAt) !== undefined) link.openedAt = savedTime(openedAt);
    if (savedTime(printedAt) !== undefined) link.printedAt = savedTime(printedAt);
    links.push(link);
  }
  const result = ordered(links);
  return result.length > 0 ? result : undefined;
}
