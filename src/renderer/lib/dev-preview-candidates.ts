import { parseLoopbackUrl } from '../../shared/lib/loopback-url';
import {
  isLocalTerminalExecutionLocation,
  type TerminalExecutionLocation,
} from '../../shared/types/terminal';

import {
  isRootlessUrl,
  parseLoopbackForwardIntent,
  type ScannedTerminalUrl,
} from './scan-terminal-urls';

import type {
  DevPreviewOtherServer,
  DevPreviewService,
  DevPreviewServiceDetection,
} from '../../shared/types';

// Matches the IPC schema's limit on ports checked per request.
export const MAX_CHECKED_PORTS = 32;

/** A URL the preview can open: printed in a terminal, found listening, or both. */
export interface PreviewUrlCandidate extends ScannedTerminalUrl {
  /**
   * The terminal that printed the URL or started its server; missing for a background run's
   * server and a server outside Komla.
   */
  terminalId?: string;
  /** Whether something listens on the port where the URL points; undefined when unchecked. */
  live?: boolean;
  /** The listening process, when one of the workspace's terminals or background runs started it. */
  service?: DevPreviewService;
  /** No terminal printed this URL; it comes only from a listening port. */
  listenerOnly?: boolean;
  /** An HTTP server on the workspace's machine that no Komla terminal started. */
  otherServer?: DevPreviewOtherServer;
}

export type PreviewCandidateDecision =
  | { kind: 'empty' }
  | { kind: 'auto'; candidate: PreviewUrlCandidate }
  | { kind: 'pick'; candidates: PreviewUrlCandidate[] };

function urlPort(input: string): number | null {
  return parseLoopbackForwardIntent(input)?.remotePort ?? null;
}

/** Whether the URL points at the SSH host rather than this machine. */
function isRemoteLocation(
  executionLocation: TerminalExecutionLocation,
  isSshWorkspace: boolean
): boolean {
  return isSshWorkspace && !isLocalTerminalExecutionLocation(executionLocation);
}

/** A listening port that did not answer HTTP, so the preview likely cannot show it. */
export function isNonHttpListener(candidate: PreviewUrlCandidate): boolean {
  return candidate.listenerOnly === true && candidate.service?.scheme === null;
}

/**
 * Ports of the scanned URLs, split by whether they point at this machine or
 * the SSH host, so main can check which still answer.
 */
export function getCandidatePorts(
  candidates: ScannedTerminalUrl[],
  isSshWorkspace: boolean
): { local: number[]; remote: number[] } {
  const local = new Set<number>();
  const remote = new Set<number>();
  for (const candidate of candidates) {
    const port = urlPort(candidate.url);
    if (port === null) continue;
    (isRemoteLocation(candidate.executionLocation, isSshWorkspace) ? remote : local).add(port);
  }
  return {
    local: [...local].slice(0, MAX_CHECKED_PORTS),
    remote: [...remote].slice(0, MAX_CHECKED_PORTS),
  };
}

// Running and unchecked URLs first, then URLs nothing answers on, then ports
// that do not speak HTTP. The sort is stable, so each group keeps the
// scanner's order and printed URLs stay ahead of bare listening ports.
function candidateRank(candidate: PreviewUrlCandidate): number {
  if (isNonHttpListener(candidate)) return 2;
  return candidate.live === false ? 1 : 0;
}

/**
 * Marks which scanned URLs still answer and adds the ports the workspace's
 * terminals listen on that no terminal printed a URL for, then the servers
 * outside Komla. In an SSH workspace, URLs and ports on the SSH host are
 * matched separately from this machine's.
 */
export function mergeDetectedServices(
  scanned: ScannedTerminalUrl[],
  detection: DevPreviewServiceDetection | null,
  isSshWorkspace: boolean
): PreviewUrlCandidate[] {
  if (!detection) return scanned;
  const endpointKey = (executionLocation: TerminalExecutionLocation, port: number): string =>
    `${isRemoteLocation(executionLocation, isSshWorkspace) ? 'remote' : 'local'}:${port}`;
  const servicesByEndpoint = new Map(
    detection.services.map((service) => [
      endpointKey(service.executionLocation, service.port),
      service,
    ])
  );
  const localOpenPorts = new Set(detection.openPorts);
  const remoteOpenPorts = detection.remoteOpenPorts ? new Set(detection.remoteOpenPorts) : null;
  const printedEndpoints = new Set<string>();

  const merged: PreviewUrlCandidate[] = scanned.map((candidate) => {
    const port = urlPort(candidate.url);
    if (port === null) return candidate;
    const key = endpointKey(candidate.executionLocation, port);
    printedEndpoints.add(key);
    const service = servicesByEndpoint.get(key);
    if (service) return { ...candidate, live: true, service };
    const openPorts = isRemoteLocation(candidate.executionLocation, isSshWorkspace)
      ? remoteOpenPorts
      : localOpenPorts;
    return openPorts ? { ...candidate, live: openPorts.has(port) } : candidate;
  });
  for (const service of detection.services) {
    if (printedEndpoints.has(endpointKey(service.executionLocation, service.port))) continue;
    merged.push({
      url: `${service.scheme ?? 'http'}://localhost:${service.port}/`,
      terminalId: service.terminalId,
      executionLocation: service.executionLocation,
      live: true,
      service,
      listenerOnly: true,
    });
  }
  for (const server of detection.otherServers) {
    if (printedEndpoints.has(endpointKey(server.executionLocation, server.port))) continue;
    merged.push({
      url: `${server.scheme}://localhost:${server.port}/`,
      executionLocation: server.executionLocation,
      live: true,
      otherServer: server,
    });
  }
  return merged.sort((a, b) => candidateRank(a) - candidateRank(b));
}

function equivalentLoopbackUrlKey(input: string): string {
  const url = parseLoopbackUrl(input);
  if (!url) return input;
  return `${url.protocol}//localhost:${url.port}${url.pathname}${url.search}${url.hash}`;
}

function collapseEquivalentLoopbackUrls(candidates: PreviewUrlCandidate[]): PreviewUrlCandidate[] {
  const seen = new Set<string>();
  const collapsed: PreviewUrlCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.executionLocation}:${equivalentLoopbackUrlKey(candidate.url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    collapsed.push(candidate);
  }
  return collapsed;
}

export interface PreviewCandidateGroups {
  /** URLs a terminal printed that still answer (first) or could not be checked. */
  printed: PreviewUrlCandidate[];
  /** Ports the workspace's terminals listen on that no terminal printed, HTTP first. */
  otherPorts: PreviewUrlCandidate[];
  /** HTTP servers outside Komla on the workspace's machine. */
  otherServers: PreviewUrlCandidate[];
  /** Printed URLs nothing answers on. */
  stopped: PreviewUrlCandidate[];
}

/** Sorts candidates into the sections the pickers show, merging localhost and 127.0.0.1 aliases. */
export function groupPreviewCandidates(candidates: PreviewUrlCandidate[]): PreviewCandidateGroups {
  const collapsed = collapseEquivalentLoopbackUrls(candidates);
  const printed = collapsed.filter(
    (candidate) => !candidate.listenerOnly && !candidate.otherServer
  );
  const otherPorts = collapsed.filter((candidate) => candidate.listenerOnly);
  return {
    printed: [
      ...printed.filter((candidate) => candidate.live === true),
      ...printed.filter((candidate) => candidate.live === undefined),
    ],
    otherPorts: [
      ...otherPorts.filter((candidate) => !isNonHttpListener(candidate)),
      ...otherPorts.filter(isNonHttpListener),
    ],
    otherServers: collapsed.filter((candidate) => candidate.otherServer),
    stopped: printed.filter((candidate) => candidate.live === false),
  };
}

/**
 * Which ports the workspace's terminals listen on stay in view. A port whose page has a
 * title of its own is an app; the rest are more often a tool's internals, as the
 * inspector and helper ports `wrangler dev` opens. Once a printed URL or a titled page is
 * in view, the others fold away, as does a port showing the same page as one in view.
 * Ports that don't answer HTTP always fold away.
 */
export function splitListeningPorts(
  printed: PreviewUrlCandidate[],
  otherPorts: PreviewUrlCandidate[],
  titleOf: (candidate: PreviewUrlCandidate) => string | undefined
): { shown: PreviewUrlCandidate[]; folded: PreviewUrlCandidate[] } {
  const http = otherPorts.filter((candidate) => !isNonHttpListener(candidate));
  const titlesInView = new Set(printed.map(titleOf));
  const titled: PreviewUrlCandidate[] = [];
  for (const candidate of http) {
    const title = titleOf(candidate);
    if (!title || titlesInView.has(title)) continue;
    titlesInView.add(title);
    titled.push(candidate);
  }
  const shown = printed.length > 0 || titled.length > 0 ? titled : http;
  const inView = new Set(shown);
  return { shown, folded: otherPorts.filter((candidate) => !inView.has(candidate)) };
}

/**
 * The links popover's servers: printed URLs that answer and titled pages first
 * (`shown`), then behind "Show more" the other ports and printed URLs nothing answers
 * on. When nothing stands out, the stopped URLs come into view instead. Servers
 * outside Komla are kept apart (`outside`), for a section of their own after the links.
 */
export function rankPopoverServers(
  candidates: PreviewUrlCandidate[],
  titleOf: (candidate: PreviewUrlCandidate) => string | undefined
): { shown: PreviewUrlCandidate[]; more: PreviewUrlCandidate[]; outside: PreviewUrlCandidate[] } {
  const { printed, otherPorts, otherServers, stopped } = groupPreviewCandidates(candidates);
  const ports = splitListeningPorts(printed, otherPorts, titleOf);
  const httpPorts = ports.folded.filter((candidate) => !isNonHttpListener(candidate));
  const nonHttpPorts = ports.folded.filter(isNonHttpListener);
  const shown = [...printed, ...ports.shown];
  if (shown.length > 0) {
    return { shown, more: [...httpPorts, ...nonHttpPorts, ...stopped], outside: otherServers };
  }
  return { shown: stopped, more: [...httpPorts, ...nonHttpPorts], outside: otherServers };
}

/** A URL as the pickers show it: no `http://`, and no trailing `/` on the root. */
export function formatPreviewUrl(input: string): string {
  try {
    const url = new URL(input);
    const scheme = url.protocol === 'http:' ? '' : `${url.protocol}//`;
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${scheme}${url.host}${path}${url.search}${url.hash}`;
  } catch {
    return input;
  }
}

/**
 * Opens a URL on its own only when there's a clear winner — exactly one
 * rootless URL, or a single URL of any shape — among the printed URLs that
 * still answer. Otherwise the scan can't disambiguate (Vite vs Prisma Studio
 * both print rootless URLs the same way; deep request logs from multiple ports
 * are equally ambiguous), so the user picks. A bare listening port never opens
 * on its own because it may belong to the agent rather than a dev server, and
 * servers outside Komla are only offered, never weighed.
 */
export function decidePreviewCandidate(
  candidates: PreviewUrlCandidate[]
): PreviewCandidateDecision {
  const previewable = collapseEquivalentLoopbackUrls(
    candidates.filter((candidate) => !isNonHttpListener(candidate))
  );
  if (previewable.length === 0) return { kind: 'empty' };

  const fromTerminals = previewable.filter((candidate) => !candidate.otherServer);
  const printed = fromTerminals.filter((candidate) => !candidate.listenerOnly);
  const answering = printed.filter((candidate) => candidate.live !== false);
  const pool =
    answering.length > 0
      ? answering
      : fromTerminals.some((candidate) => candidate.listenerOnly)
        ? []
        : printed;
  const rootless = pool.filter(({ url }) => isRootlessUrl(url));
  if (rootless.length === 1) return { kind: 'auto', candidate: rootless[0] };
  if (pool.length === 1) return { kind: 'auto', candidate: pool[0] };
  return { kind: 'pick', candidates: previewable };
}
