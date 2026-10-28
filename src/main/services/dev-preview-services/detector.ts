import { managedTmuxSessionName } from '../../../shared/lib/ssh-tmux-attach';
import { isLocalTerminalExecutionLocation } from '../../../shared/types/terminal';
import { createLogger } from '../../lib/logger';

import {
  isLoopbackReachableAddress,
  mapProcessesToRoots,
  type ListeningPortSnapshot,
  type ProcessEntry,
} from './listening-ports';

import type { RemoteListeningPortSnapshot } from './remote-listening-ports';
import type {
  DevPreviewOtherServer,
  DevPreviewService,
  DevPreviewServiceDetection,
} from '../../../shared/types';
import type { TerminalExecutionLocation } from '../../../shared/types/terminal';
import type { Workspace } from '../../../shared/types/workspace';

const logger = createLogger('DevPreviewServices');

const MAX_SERVICES = 20;
// Systems hand out ports from here up to programs that ask for any free one
// (Linux from 32768, macOS and Windows from 49152), so outside Komla such a
// port almost always belongs to an app's internals rather than a page.
const FIRST_EPHEMERAL_PORT = 32_768;
// Servers outside Komla that never serve a page. Probing them would only add
// errors to their logs, as Postgres and Redis log every probe.
const NOT_WEB_SERVER_PROCESSES = new Set([
  'ControlCenter', // the macOS AirPlay Receiver
  'mariadbd',
  'memcached',
  'mongod',
  'mysqld',
  'postgres',
  'redis-server',
  'sqlservr',
  'sshd', // SSH port forwards, Komla's own included
  'sshd-session', // the same since OpenSSH 9.8
  'svchost',
  'System',
]);
// While the preview waits for a server, worktree events can ask again several
// times a second; answer those from the last scan instead of starting another.
const RESULT_REUSE_MS = 1_000;

type HttpScheme = DevPreviewService['scheme'];
type DetectorWorkspace = Pick<Workspace, 'backend' | 'terminals'>;

interface TerminalRoot {
  /** Missing for a background run, which has no terminal. */
  terminalId?: string;
  executionLocation: TerminalExecutionLocation;
}

interface Listener {
  port: number;
  pid: number;
  processName: string;
}

interface AttributedListener extends Listener {
  root: TerminalRoot;
}

export interface DevPreviewServiceDetectorDeps {
  getWorkspace: (workspaceId: string) => DetectorWorkspace | undefined;
  getTerminalPid: (terminalId: string) => number | undefined;
  /** The workspace's background runs on this machine: its setup steps and Quick Commands. */
  getBackgroundPids: (workspaceId: string) => number[];
  /** Komla's main process, whose tree holds Komla's helpers and every local terminal. */
  komlaPid: number;
  collectListeningPorts: () => Promise<ListeningPortSnapshot>;
  probeHttpScheme: (port: number) => Promise<HttpScheme>;
  isLoopbackPortOpen: (port: number) => Promise<boolean>;
  collectRemoteListeningPorts: (hostId: string) => Promise<RemoteListeningPortSnapshot>;
  probeRemoteHttpSchemes: (hostId: string, ports: number[]) => Promise<Map<number, HttpScheme>>;
  now?: () => number;
}

export interface DevPreviewServiceDetector {
  /**
   * Lists the ports that processes started from the workspace's terminals and
   * background runs listen on, the HTTP servers outside Komla on the machine they run on (the
   * SSH host for an SSH workspace), which of `ports` accept loopback
   * connections on this machine, and which of `remotePorts` something listens
   * on at an SSH workspace's host. `ports` and `remotePorts` are the ports of
   * URLs the terminals printed. `ownPorts` are other ports on the workspace's
   * machine, such as virtual desktops', which count as open only while one of
   * this user's processes listens on them.
   */
  detect(
    workspaceId: string,
    ports: number[],
    remotePorts?: number[],
    ownPorts?: number[]
  ): Promise<DevPreviewServiceDetection>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRemoteTerminal(
  workspace: DetectorWorkspace,
  executionLocation: TerminalExecutionLocation
): boolean {
  return workspace.backend?.kind === 'ssh' && !isLocalTerminalExecutionLocation(executionLocation);
}

/**
 * Assigns each loopback-reachable port to the terminal or background run whose
 * process tree listens on it. One serving one of `printedPorts` keeps only those:
 * its other ports belong to the same server (a debugger, internal sockets, as
 * with the eight `wrangler dev` opens), so they are neither listed nor probed.
 */
function attributeListeners(
  snapshot: ListeningPortSnapshot,
  roots: Map<number, TerminalRoot>,
  printedPorts: Set<number>
): AttributedListener[] {
  const owners = mapProcessesToRoots(snapshot.processes, roots.keys());
  const processNames = new Map(snapshot.processes.map(({ pid, name }) => [pid, name]));
  const listeners = new Map<number, AttributedListener>();
  for (const { pid, address, port } of snapshot.listeners) {
    const rootPid = owners.get(pid);
    if (rootPid === undefined || listeners.has(port) || !isLoopbackReachableAddress(address)) {
      continue;
    }
    listeners.set(port, {
      port,
      pid,
      processName: processNames.get(pid) ?? '',
      root: roots.get(rootPid)!,
    });
  }
  const servingRoots = new Set(
    [...listeners.values()].filter(({ port }) => printedPorts.has(port)).map(({ root }) => root)
  );
  return [...listeners.values()]
    .filter(({ port, root }) => printedPorts.has(port) || !servingRoots.has(root))
    .sort((a, b) => a.port - b.port)
    .slice(0, MAX_SERVICES);
}

/** The processes that started `pid`, such as the dev tool running Komla from source. */
function ancestorsOf(processes: ProcessEntry[], pid: number): Set<number> {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const ancestors = new Set<number>();
  let child = byPid.get(pid);
  while (child && child.ppid > 0 && !ancestors.has(child.ppid)) {
    const parent = byPid.get(child.ppid);
    // Windows keeps an exited parent's PID, which a later process can reuse.
    if (
      parent?.startedAt !== undefined &&
      child.startedAt !== undefined &&
      child.startedAt < parent.startedAt
    ) {
      break;
    }
    ancestors.add(child.ppid);
    child = parent;
  }
  return ancestors;
}

/**
 * The loopback-reachable listeners of processes outside Komla: neither in the
 * trees under `komlaRoots` (Komla itself, or every managed tmux pane on an SSH
 * host) nor among `launchers`, the processes that started Komla.
 */
function findOutsideListeners(
  snapshot: ListeningPortSnapshot,
  komlaRoots: Iterable<number>,
  launchers = new Set<number>()
): Listener[] {
  const inKomla = mapProcessesToRoots(snapshot.processes, komlaRoots);
  // A process that inherited a socket from a terminal holds the same port.
  const komlaPorts = new Set(
    snapshot.listeners
      .filter(({ pid }) => inKomla.has(pid) || launchers.has(pid))
      .map(({ port }) => port)
  );
  const processNames = new Map(snapshot.processes.map(({ pid, name }) => [pid, name]));
  const listeners = new Map<number, Listener>();
  for (const { pid, address, port } of snapshot.listeners) {
    const processName = processNames.get(pid);
    if (
      processName === undefined ||
      komlaPorts.has(port) ||
      listeners.has(port) ||
      port >= FIRST_EPHEMERAL_PORT ||
      NOT_WEB_SERVER_PROCESSES.has(processName) ||
      !isLoopbackReachableAddress(address)
    ) {
      continue;
    }
    listeners.set(port, { port, pid, processName });
  }
  return [...listeners.values()].sort((a, b) => a.port - b.port).slice(0, MAX_SERVICES);
}

/**
 * The loopback-reachable ports this user's processes listen on. Listings name the
 * processes of the caller's own user only, so another user's sockets have no listener.
 */
function ownListeningPorts(listeners: ListeningPortSnapshot['listeners']): Set<number> {
  return new Set(
    listeners.filter(({ address }) => isLoopbackReachableAddress(address)).map(({ port }) => port)
  );
}

/** The listeners that answered HTTP or HTTPS, as servers on the workspace's machine. */
function toOtherServers(
  listeners: Listener[],
  schemes: Array<HttpScheme | undefined>
): DevPreviewOtherServer[] {
  return listeners.flatMap(({ port, processName }, index) => {
    const scheme = schemes[index];
    return scheme ? [{ port, scheme, processName, executionLocation: 'workspace' as const }] : [];
  });
}

function toService(
  { port, pid, processName, root }: AttributedListener,
  scheme: HttpScheme
): DevPreviewService {
  return {
    port,
    scheme,
    pid,
    processName,
    terminalId: root.terminalId,
    executionLocation: root.executionLocation,
  };
}

export function createDevPreviewServiceDetector(
  deps: DevPreviewServiceDetectorDeps
): DevPreviewServiceDetector {
  const now = deps.now ?? Date.now;
  const recent = new Map<
    string,
    { result: Promise<DevPreviewServiceDetection>; settledAt?: number }
  >();
  // Probing a port can log errors in the server holding it (workerd prints an
  // RPC error for each HTTP request on its internal ports), so each listener
  // is probed once and its answer kept while the same process holds the port.
  const knownSchemes = new Map<string, Map<string, Promise<HttpScheme | undefined>>>();

  /**
   * The scheme of each listener, probing only those `scope` has not seen.
   * Undefined marks a port the probe could not check; it is probed again next time.
   */
  async function probeOnce(
    scope: string,
    listeners: Listener[],
    probe: (ports: number[]) => Promise<Map<number, HttpScheme>>
  ): Promise<Array<HttpScheme | undefined>> {
    const listenerKey = ({ pid, port }: Listener): string => `${pid}:${port}`;
    const previous = knownSchemes.get(scope);
    const unprobed = listeners.filter((listener) => !previous?.has(listenerKey(listener)));
    const probed =
      unprobed.length > 0
        ? probe(unprobed.map(({ port }) => port)).catch(() => new Map<number, HttpScheme>())
        : Promise.resolve(new Map<number, HttpScheme>());
    const entries = listeners.map((listener) => {
      const key = listenerKey(listener);
      const scheme: Promise<HttpScheme | undefined> =
        previous?.get(key) ?? probed.then((schemes) => schemes.get(listener.port));
      return [key, scheme] as const;
    });
    const known = new Map(entries);
    knownSchemes.set(scope, known);

    const schemes = await Promise.all(entries.map(([, scheme]) => scheme));
    entries.forEach(([key], index) => {
      if (schemes[index] === undefined) known.delete(key);
    });
    return schemes;
  }

  async function findLocalServers(
    workspaceId: string,
    workspace: DetectorWorkspace,
    printedPorts: number[]
  ): Promise<
    Pick<DevPreviewServiceDetection, 'services' | 'otherServers'> & {
      ownPorts: Set<number> | null;
    }
  > {
    const roots = new Map<number, TerminalRoot>();
    for (const terminal of workspace.terminals) {
      const executionLocation = terminal.executionLocation ?? 'workspace';
      if (isRemoteTerminal(workspace, executionLocation)) continue;
      const pid = deps.getTerminalPid(terminal.id);
      if (pid) roots.set(pid, { terminalId: terminal.id, executionLocation });
    }
    // Background runs on this machine run in an SSH workspace's Local copy.
    const backgroundLocation = workspace.backend?.kind === 'ssh' ? 'local-mirror' : 'workspace';
    for (const pid of deps.getBackgroundPids(workspaceId)) {
      roots.set(pid, { executionLocation: backgroundLocation });
    }
    // An SSH workspace's other servers are on the SSH host.
    const listsOtherServers = workspace.backend?.kind !== 'ssh';
    if (roots.size === 0 && !listsOtherServers) {
      return { services: [], otherServers: [], ownPorts: null };
    }

    let snapshot: ListeningPortSnapshot;
    try {
      snapshot = await deps.collectListeningPorts();
    } catch (error) {
      logger.warn('Failed to list listening ports', { error: errorMessage(error) });
      return { services: [], otherServers: [], ownPorts: null };
    }
    const listeners =
      roots.size > 0 ? attributeListeners(snapshot, roots, new Set(printedPorts)) : [];
    const outside = listsOtherServers
      ? findOutsideListeners(
          snapshot,
          [deps.komlaPid],
          ancestorsOf(snapshot.processes, deps.komlaPid)
        )
      : [];
    const schemes = await probeOnce(
      `local:${workspaceId}`,
      [...listeners, ...outside],
      async (ports) =>
        new Map(
          await Promise.all(
            ports.map(async (port) => [port, await deps.probeHttpScheme(port)] as const)
          )
        )
    );
    return {
      services: listeners.map((listener, index) => toService(listener, schemes[index] ?? null)),
      otherServers: toOtherServers(outside, schemes.slice(listeners.length)),
      ownPorts: ownListeningPorts(snapshot.listeners),
    };
  }

  async function findRemoteServers(
    workspaceId: string,
    workspace: DetectorWorkspace,
    remotePorts: number[]
  ): Promise<{
    services: DevPreviewService[];
    otherServers: DevPreviewOtherServer[];
    openPorts: number[] | null;
    ownPorts: Set<number> | null;
  }> {
    if (workspace.backend?.kind !== 'ssh') {
      return { services: [], otherServers: [], openPorts: null, ownPorts: null };
    }
    const { hostId } = workspace.backend;
    const remoteTerminals = workspace.terminals.flatMap((terminal) => {
      const executionLocation = terminal.executionLocation ?? 'workspace';
      return isRemoteTerminal(workspace, executionLocation)
        ? [{ terminalId: terminal.id, executionLocation }]
        : [];
    });

    let snapshot: RemoteListeningPortSnapshot;
    try {
      snapshot = await deps.collectRemoteListeningPorts(hostId);
    } catch (error) {
      logger.warn('Failed to list listening ports on SSH host', { error: errorMessage(error) });
      return { services: [], otherServers: [], openPorts: null, ownPorts: null };
    }

    const roots = new Map<number, TerminalRoot>();
    for (const root of remoteTerminals) {
      for (const pid of snapshot.panePids.get(managedTmuxSessionName(root.terminalId)) ?? []) {
        roots.set(pid, root);
      }
    }
    const listeners =
      roots.size > 0 ? attributeListeners(snapshot, roots, new Set(remotePorts)) : [];
    // Every managed tmux pane on the host belongs to Komla, whichever workspace it serves.
    const outside = findOutsideListeners(snapshot, [...snapshot.panePids.values()].flat());
    const schemes = await probeOnce(`ssh:${workspaceId}`, [...listeners, ...outside], (ports) =>
      deps.probeRemoteHttpSchemes(hostId, ports).catch((error: unknown) => {
        logger.warn('Failed to probe ports on SSH host', { error: errorMessage(error) });
        throw error;
      })
    );
    // A port the probe could not check is offered as HTTP rather than hidden.
    const services = listeners.map((listener, index) => {
      const scheme = schemes[index];
      return toService(listener, scheme === undefined ? 'http' : scheme);
    });
    const listening = snapshot.listeningPorts;
    return {
      services,
      otherServers: toOtherServers(outside, schemes.slice(listeners.length)),
      openPorts: listening ? remotePorts.filter((port) => listening.has(port)) : null,
      // Without ss or lsof on the host, no socket is known to be listening, nor to be closed.
      ownPorts: snapshot.listenersListed ? ownListeningPorts(snapshot.listeners) : null,
    };
  }

  async function detectNow(
    workspaceId: string,
    ports: number[],
    remotePorts: number[],
    ownPorts: number[]
  ): Promise<DevPreviewServiceDetection> {
    const checkedAt = now();
    const workspace = deps.getWorkspace(workspaceId);
    if (!workspace) {
      return { services: [], otherServers: [], openPorts: [], remoteOpenPorts: null };
    }

    const local = findLocalServers(workspaceId, workspace, ports).then(async (servers) => {
      // A port a detected server listens on is open without connecting again.
      const servicePorts = new Set(
        [...servers.services, ...servers.otherServers].map(({ port }) => port)
      );
      const open = await Promise.all(
        ports.map(async (port) => servicePorts.has(port) || deps.isLoopbackPortOpen(port))
      );
      return { ...servers, openPorts: ports.filter((_, index) => open[index]) };
    });
    // The SSH host is read alongside, so local checks never wait on it.
    const [localResult, remote] = await Promise.all([
      local,
      findRemoteServers(workspaceId, workspace, remotePorts),
    ]);
    const own = workspace.backend?.kind === 'ssh' ? remote.ownPorts : localResult.ownPorts;
    return {
      services: [...localResult.services, ...remote.services],
      otherServers: [...localResult.otherServers, ...remote.otherServers],
      openPorts: localResult.openPorts,
      remoteOpenPorts: remote.openPorts,
      ...(ownPorts.length > 0
        ? { ownOpenPorts: own ? ownPorts.filter((port) => own.has(port)) : null, checkedAt }
        : {}),
    };
  }

  return {
    detect(workspaceId, ports, remotePorts = [], ownPorts = []) {
      const uniquePorts = [...new Set(ports)].sort((a, b) => a - b);
      const uniqueRemotePorts = [...new Set(remotePorts)].sort((a, b) => a - b);
      const uniqueOwnPorts = [...new Set(ownPorts)].sort((a, b) => a - b);
      const key = `${workspaceId}:${uniquePorts.join(',')}:${uniqueRemotePorts.join(',')}:${uniqueOwnPorts.join(',')}`;
      const startedAt = now();
      for (const [entryKey, entry] of recent) {
        if (entry.settledAt !== undefined && startedAt - entry.settledAt >= RESULT_REUSE_MS) {
          recent.delete(entryKey);
        }
      }
      const reusable = recent.get(key);
      if (reusable) return reusable.result;

      const entry: { result: Promise<DevPreviewServiceDetection>; settledAt?: number } = {
        result: detectNow(workspaceId, uniquePorts, uniqueRemotePorts, uniqueOwnPorts),
      };
      const settle = (): void => {
        entry.settledAt = now();
      };
      entry.result.then(settle, settle);
      recent.set(key, entry);
      return entry.result;
    },
  };
}
