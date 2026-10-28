/**
 * Finds the TCP ports listened on by processes in an SSH workspace's managed
 * tmux sessions, and which of them answer HTTP. Everything runs as two remote
 * shell commands so a scan costs two round trips however many ports it finds.
 */

import { MANAGED_TMUX_SOCKET_NAME } from '../../../shared/lib/ssh-tmux-attach';

import {
  isLoopbackReachableAddress,
  parseLsofListeners,
  parseProcStat,
  parsePsOutput,
  type ListeningPortSnapshot,
  type ListeningSocket,
  type ProcessEntry,
} from './listening-ports';

export type RunRemoteCommand = (command: string) => Promise<string>;

export interface RemoteListeningPortSnapshot extends ListeningPortSnapshot {
  /** Root PIDs of the panes in each session on Komla's tmux server. */
  panePids: Map<string, number[]>;
  /** Every port the host listens on that loopback reaches; null when no tool could list them all. */
  listeningPorts: Set<number> | null;
  /** Whether a tool listed the listening sockets, so `listeners` are all of this user's. */
  listenersListed: boolean;
}

const PANES_SECTION = '@@komla-panes';
const PROCESSES_SECTION = '@@komla-processes';
const LISTENERS_SECTION = '@@komla-listeners';

// Linux hosts are read through /proc because minimal images ship without ps.
// `ss -p` names only the caller's own processes, which is all Komla runs, but
// lists every socket; lsof without root lists only the caller's own sockets.
// A failing ss falls back to lsof so its empty output never reads as no ports.
// Only pid, name, state and parent are kept from /proc so the output stays small.
export const REMOTE_SNAPSHOT_COMMAND = [
  `printf '%s\\n' '${PANES_SECTION}'`,
  `tmux -L ${MANAGED_TMUX_SOCKET_NAME} list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null`,
  `printf '%s\\n' '${PROCESSES_SECTION}'`,
  `if [ -r /proc/self/stat ]; then printf '%s\\n' '#proc'; cat /proc/[0-9]*/stat 2>/dev/null | sed -n 's/^\\([0-9]*\\) (\\(.*\\)) \\([A-Za-z]\\) \\([0-9]*\\) .*/\\1 (\\2) \\3 \\4/p'; else printf '%s\\n' '#ps'; ps -A -o pid= -o ppid= -o comm= 2>/dev/null; fi`,
  `printf '%s\\n' '${LISTENERS_SECTION}'`,
  `if command -v ss >/dev/null 2>&1 && listeners=$(ss -ltnp 2>/dev/null); then printf '%s\\n' '#ss' "$listeners"; elif command -v lsof >/dev/null 2>&1; then printf '%s\\n' '#lsof'; lsof -nP -iTCP -sTCP:LISTEN -Fpn 2>/dev/null; fi`,
  'true',
].join('\n');

/** Parses `ss -ltnp`, whose column layout differs between iproute2 versions. */
export function parseSsListeners(
  output: string
): Array<{ address: string; port: number; pids: number[] }> {
  const sockets: Array<{ address: string; port: number; pids: number[] }> = [];
  for (const line of output.split('\n')) {
    // The local address is the first column ending in a numeric port; the
    // peer column of a listening socket ends in `*`.
    const local = line
      .trim()
      .split(/\s+/)
      .find((field) => /:\d+$/.test(field));
    if (!local) continue;
    const separator = local.lastIndexOf(':');
    const address = local
      .slice(0, separator)
      .replace(/^\[|\]$/g, '')
      .replace(/%.*$/, '');
    const port = Number(local.slice(separator + 1));
    if (!address || port <= 0 || port > 65535) continue;
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
    sockets.push({ address, port, pids });
  }
  return sockets;
}

export function parseRemoteSnapshot(output: string): RemoteListeningPortSnapshot {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of output.split('\n')) {
    if (line === PANES_SECTION || line === PROCESSES_SECTION || line === LISTENERS_SECTION) {
      current = [];
      sections.set(line, current);
    } else {
      current?.push(line);
    }
  }

  const panePids = new Map<string, number[]>();
  for (const line of sections.get(PANES_SECTION) ?? []) {
    const match = /^(\S+) (\d+)$/.exec(line.trim());
    if (!match) continue;
    panePids.set(match[1], [...(panePids.get(match[1]) ?? []), Number(match[2])]);
  }

  const [processFormat, ...processLines] = sections.get(PROCESSES_SECTION) ?? [];
  const processes: ProcessEntry[] =
    processFormat === '#ps'
      ? parsePsOutput(processLines.join('\n'))
      : processLines.flatMap((line) => parseProcStat(line) ?? []);

  const [listenerFormat, ...listenerLines] = sections.get(LISTENERS_SECTION) ?? [];
  let listeners: ListeningSocket[] = [];
  let listeningPorts: Set<number> | null = null;
  if (listenerFormat === '#ss') {
    const sockets = parseSsListeners(listenerLines.join('\n')).filter(({ address }) =>
      isLoopbackReachableAddress(address)
    );
    listeners = sockets.flatMap(({ address, port, pids }) =>
      pids.map((pid) => ({ pid, address, port }))
    );
    listeningPorts = new Set(sockets.map(({ port }) => port));
  } else if (listenerFormat === '#lsof') {
    // Ports other users' processes hold are missing, so whether a port is free stays unknown.
    listeners = parseLsofListeners(listenerLines.join('\n'));
  }

  return {
    panePids,
    processes,
    listeners,
    listeningPorts,
    listenersListed: listenerFormat === '#ss' || listenerFormat === '#lsof',
  };
}

export async function collectRemoteListeningPorts(
  run: RunRemoteCommand
): Promise<RemoteListeningPortSnapshot> {
  return parseRemoteSnapshot(await run(REMOTE_SNAPSHOT_COMMAND));
}

/**
 * Probes each port with curl in parallel. A plain request that times out
 * counts as HTTP, as in the local probe, because dev servers such as Next.js
 * compile a page before answering. Prints nothing when curl is missing.
 */
export function buildRemoteProbeCommand(ports: number[]): string {
  const portList = ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return [
    'probe() {',
    `  status=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -m 1 "http://localhost:$1/"); code=$?`,
    // nginx and Go servers such as Caddy answer plain HTTP on a TLS port with a 400.
    `  if [ "$code" -eq 28 ] || { [ "$code" -eq 0 ] && [ "$status" != 400 ]; }; then echo "$1 http"; return; fi`,
    `  curl --noproxy '*' -sk -o /dev/null -m 1 "https://localhost:$1/"; tls=$?`,
    `  if [ "$tls" -eq 0 ] || [ "$tls" -eq 28 ]; then echo "$1 https"; return; fi`,
    `  if [ "$code" -eq 0 ]; then echo "$1 http"; else echo "$1 none"; fi`,
    '}',
    'if command -v curl >/dev/null 2>&1; then',
    `  for port in ${portList.join(' ')}; do probe "$port" & done`,
    '  wait',
    'fi',
  ].join('\n');
}

/** Maps each port curl checked to its scheme; ports it could not check are left out. */
export function parseRemoteProbe(output: string): Map<number, 'http' | 'https' | null> {
  const results = new Map<number, 'http' | 'https' | null>();
  for (const line of output.split('\n')) {
    const match = /^(\d+) (http|https|none)$/.exec(line.trim());
    if (match)
      results.set(Number(match[1]), match[2] === 'none' ? null : (match[2] as 'http' | 'https'));
  }
  return results;
}

export async function probeRemoteHttpSchemes(
  run: RunRemoteCommand,
  ports: number[]
): Promise<Map<number, 'http' | 'https' | null>> {
  if (ports.length === 0) return new Map();
  return parseRemoteProbe(await run(buildRemoteProbeCommand(ports)));
}
