import { isLoopbackUrl, normalizeLocalDevServerUrl } from '../../shared/lib/loopback-url';

import { readableRunOutput } from './setup-activity-output';
import {
  getRecentTerminalRendererOutput,
  getTerminalRendererOutputSinceLastScan,
} from './terminal-renderer-runtime';

import type { TerminalExecutionLocation } from '../../shared/types/terminal';
import type { Workspace } from '../../shared/types/workspace';

const URL_REGEX = /https?:\/\/[^\s<>"'`]+/g;
// No URL holds a backslash, but a typed command's `\n` or `\e` may follow one.
const LINK_REGEX = /https?:\/\/[^\s<>"'`\\]+/g;
const LINK_CONTINUATION_REGEX = /^\s*([^\s<>"'`\\]+)/;
const TRAILING_PUNCT_REGEX = /[.,;:!?)\]'"`]+$/;
const MAX_LINES_PER_TERMINAL = 500;
const MAX_RESULTS = 10;
// Links to other sites are listed for as long as the terminal still shows them.
const MAX_LINK_LINES_PER_TERMINAL = 10_000;

export interface LoopbackForwardIntent {
  remotePort: number;
  pathSuffix: string;
  scheme: 'http' | 'https';
}

export interface ScannedTerminalUrl {
  url: string;
  /** Missing for a URL a background run printed. */
  terminalId?: string;
  executionLocation: TerminalExecutionLocation;
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(TRAILING_PUNCT_REGEX, '');
}

function normalizeScannedLocalUrl(input: string): string {
  try {
    const url = new URL(normalizeLocalDevServerUrl(input));
    // Round-trip through URL so trailing-slash variants of the same URL
    // (e.g. `http://127.0.0.1:4321` and `http://127.0.0.1:4321/`) collapse to
    // one canonical form and dedupe via the Set in the caller.
    return url.toString();
  } catch {
    return input;
  }
}

export function isRootlessUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return !path || path === '/';
  } catch {
    return false;
  }
}

export function parseLoopbackForwardIntent(input: string): LoopbackForwardIntent | null {
  if (!isLoopbackUrl(input)) return null;
  try {
    const url = new URL(input);
    const remotePort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return null;
    const pathSuffix =
      url.pathname === '/' && !url.search && !url.hash
        ? ''
        : `${url.pathname}${url.search}${url.hash}`;
    return {
      remotePort,
      pathSuffix,
      scheme: url.protocol === 'https:' ? 'https' : 'http',
    };
  } catch {
    return null;
  }
}

/** The lines of the workspace's running background runs, which have no terminal. */
function backgroundRunOutput(
  workspace: Pick<Workspace, 'setupActivities'>
): Array<{ executionLocation: TerminalExecutionLocation; logicalLines: string[] }> {
  return (workspace.setupActivities ?? []).flatMap((run) => {
    if (run.state !== 'running') return [];
    const logicalLines = readableRunOutput(run.output).split('\n').slice(-MAX_LINES_PER_TERMINAL);
    return [{ executionLocation: run.executionLocation ?? 'workspace', logicalLines }];
  });
}

/**
 * The localhost URLs the workspace's running background runs printed, when `workspace` is given,
 * then those its terminals did. The runs come first, as one was likely started for its server.
 */
export function scanWorkspaceTerminalsForLocalhostUrlCandidates(
  workspaceId: string,
  workspace?: Pick<Workspace, 'setupActivities'>
): ScannedTerminalUrl[] {
  const found = new Map<string, ScannedTerminalUrl>();
  const outputs: Array<{
    terminalId?: string;
    executionLocation: TerminalExecutionLocation;
    logicalLines: string[];
  }> = [
    ...(workspace ? backgroundRunOutput(workspace) : []),
    ...getRecentTerminalRendererOutput(workspaceId, MAX_LINES_PER_TERMINAL),
  ];

  for (const { terminalId, executionLocation, logicalLines } of outputs) {
    // Walk newest line first so the most recent occurrence of a URL wins
    // after Set dedup, and the picker surfaces freshly printed URLs at the
    // top when output spans multiple terminals.
    for (let i = logicalLines.length - 1; i >= 0; i--) {
      const text = logicalLines[i];
      if (!text) continue;

      URL_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = URL_REGEX.exec(text)) !== null) {
        const url = normalizeScannedLocalUrl(stripTrailingPunctuation(match[0]));
        if (isLoopbackUrl(url)) {
          const key = `${executionLocation}:${url}`;
          if (!found.has(key)) {
            found.set(key, { url, terminalId, executionLocation });
          }
          if (found.size >= MAX_RESULTS) return sortCandidatesByRootlessFirst([...found.values()]);
        }
      }
    }
  }

  return sortCandidatesByRootlessFirst([...found.values()]);
}

export interface ScannedTerminalLink {
  url: string;
  /**
   * The start of the next line, when the URL ends its line: a program that wraps lines
   * itself may have put the rest of the URL there.
   */
  continuation?: string;
  /** When the line was written, to within a couple of seconds, when known. */
  printedAt?: number;
}

/** The http(s) URLs on one line, left to right. */
function linksInLine(
  text: string,
  nextLine: string | undefined,
  printedAt: number | undefined
): ScannedTerminalLink[] {
  const links: ScannedTerminalLink[] = [];
  LINK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_REGEX.exec(text)) !== null) {
    const continuation =
      match.index + match[0].length === text.length
        ? nextLine?.match(LINK_CONTINUATION_REGEX)?.[1]
        : undefined;
    links.push({
      url: stripTrailingPunctuation(match[0]),
      ...(continuation ? { continuation } : {}),
      ...(printedAt !== undefined ? { printedAt } : {}),
    });
  }
  return links;
}

/**
 * The http(s) URLs the workspace's terminals printed since the last scan, or show on screen,
 * newest line first, each line left to right.
 */
export function scanWorkspaceTerminalsForLinks(workspaceId: string): ScannedTerminalLink[] {
  const links: ScannedTerminalLink[] = [];
  for (const { logicalLines, printedAt } of getTerminalRendererOutputSinceLastScan(
    workspaceId,
    MAX_LINK_LINES_PER_TERMINAL,
    'links'
  )) {
    for (let i = logicalLines.length - 1; i >= 0; i--) {
      if (logicalLines[i]) {
        links.push(...linksInLine(logicalLines[i], logicalLines[i + 1], printedAt?.[i]));
      }
    }
  }
  return links;
}

export function scanWorkspaceTerminalsForLocalhostUrls(workspaceId: string): string[] {
  return [
    ...new Set(scanWorkspaceTerminalsForLocalhostUrlCandidates(workspaceId).map(({ url }) => url)),
  ];
}

// Rootless URLs (no path or just `/`) almost always represent the dev-server
// root the user wants to preview; path-bearing URLs are usually request logs
// or deep links. Stable sort preserves the newest-line-first order within
// each group so recency still breaks ties.
function sortCandidatesByRootlessFirst(candidates: ScannedTerminalUrl[]): ScannedTerminalUrl[] {
  return candidates.sort((a, b) => {
    const aRoot = isRootlessUrl(a.url);
    const bRoot = isRootlessUrl(b.url);
    if (aRoot === bRoot) return 0;
    return aRoot ? -1 : 1;
  });
}
