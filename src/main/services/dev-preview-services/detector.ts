import { realpath } from 'fs/promises';

import { managedTmuxSessionName } from '../../../shared/lib/ssh-tmux-attach';
import { isLocalTerminalExecutionLocation } from '../../../shared/types/terminal';
import { createLogger } from '../../lib/logger';
import { isWithinRoot, samePathKey } from '../../lib/same-path';

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
type DetectorWorkspace = Pick<
  Workspace,
  'backend' | 'terminals' | 'workingDirectory' | 'isWorktree'
>;

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
  /** With `cwds`, the snapshot also has the working directory of each process that listens. */
  collectListeningPorts: (options: { cwds: boolean }) => Promise<ListeningPortSnapshot>;
  probeHttpScheme: (port: number) => Promise<HttpScheme>;
  isLoopbackPortOpen: (port: number) => Promise<boolean>;
  collectRemoteListeningPorts: (hostId: string) => Promise<RemoteListeningPortSnapshot>;
  probeRemoteHttpSchemes: (hostId: string, ports: number[]) => Promise<Map<number, HttpScheme>>;
  now?: () => number;
}

export interface DevPreviewServiceDetector {
  /**
   * Lists the ports that processes started from the workspace's terminals and
   * background runs listen on, or processes outside Komla working in the
   * workspace's folder, the HTTP servers outside Komla on the machine they run on (the
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

/** Whether `directory` is `folder` or inside it, comparing whole path segments. */
function isInFolder(directory: string, folder: string): boolean {
  const base = folder.replace(/\/+$/, '');
  return directory === base || directory.startsWith(`${base}/`);
}

/**
 * Whether processes working in the workspace's folder count as its own: only in a worktree, a
 * folder of its own that no other workspace's folder is in, unlike a directory workspace, which can
 * be a folder of projects or the home folder, and only for an absolute POSIX path, since working
 * directories are never read on Windows.
 */
function claimsProcessesInFolder(workspace: DetectorWorkspace, folder: string): boolean {
  return workspace.isWorktree && folder.startsWith('/');
}

/**
 * The listening processes outside Komla working in the workspace's folder, each as a root of
 * its own, such as a server an agent started in the background from a shell
 * that has since exited, leaving it a child of init. A process in a terminal's
 * tree stays that terminal's, whichever workspace it serves; `inKomla` maps
 * Komla's processes, and `launchers` are those that started Komla. Of a parent
 * and its child both in the folder, the parent is the root, so the child's
 * internal ports belong to the server it serves.
 */
function folderRoots(
  snapshot: ListeningPortSnapshot,
  inFolder: (cwd: string) => boolean,
  inKomla: Map<number, number>,
  launchers = new Set<number>()
): Map<number, TerminalRoot> {
  const roots = new Map<number, TerminalRoot>();
  const { cwds } = snapshot;
  if (!cwds || cwds.size === 0) return roots;
  const processNames = new Map(snapshot.processes.map(({ pid, name }) => [pid, name]));
  const candidates = new Set<number>();
  for (const { pid } of snapshot.listeners) {
    const cwd = cwds.get(pid);
    if (
      cwd === undefined ||
      inKomla.has(pid) ||
      launchers.has(pid) ||
      NOT_WEB_SERVER_PROCESSES.has(processNames.get(pid) ?? '') ||
      !inFolder(cwd)
    ) {
      continue;
    }
    candidates.add(pid);
  }
  const parents = new Map(snapshot.processes.map(({ pid, ppid }) => [pid, ppid]));
  for (const pid of candidates) {
    let hasCandidateAncestor = false;
    const seen = new Set([pid]);
    for (let parent = parents.get(pid); parent !== undefined && parent > 0;) {
      if (seen.has(parent)) break;
      if (candidates.has(parent)) {
        hasCandidateAncestor = true;
        break;
      }
      seen.add(parent);
      parent = parents.get(parent);
    }
    if (!hasCandidateAncestor) roots.set(pid, { executionLocation: 'workspace' });
  }
  return roots;
}

/**
 * Assigns each loopback-reachable port to the terminal or background run whose
 * process tree listens on it, then the rest to the processes in the workspace's
 * folder from `folderRoots`. One serving one of `printedPorts` keeps only those:
 * its other ports belong to the same server (a debugger, internal sockets, as
 * with the eight `wrangler dev` opens), so they are neither listed nor probed.
 */
function attributeListeners(
  snapshot: ListeningPortSnapshot,
  roots: Map<number, TerminalRoot>,
  printedPorts: Set<number>,
  inFolder = new Map<number, TerminalRoot>()
): AttributedListener[] {
  // Terminals' trees come first, so a process in the folder never claims one of theirs.
  const owners = mapProcessesToRoots(snapshot.processes, [...roots.keys(), ...inFolder.keys()]);
  const processNames = new Map(snapshot.processes.map(({ pid, name }) => [pid, name]));
  const listeners = new Map<number, AttributedListener>();
  for (const tier of [roots, inFolder]) {
    for (const { pid, address, port } of snapshot.listeners) {
      const root = tier.get(owners.get(pid) ?? -1);
      if (!root || listeners.has(port) || !isLoopbackReachableAddress(address)) continue;
      // Outside a terminal, a port the system picked is an editor's or a kernel's, unless a
      // terminal printed it, as of a server an agent started in the background.
      if (tier === inFolder && port >= FIRST_EPHEMERAL_PORT && !printedPorts.has(port)) continue;
      listeners.set(port, { port, pid, processName: processNames.get(pid) ?? '', root });
    }
  }
  const servingRoots = new Set(
    [...listeners.values()].filter(({ port }) => printedPorts.has(port)).map(({ root }) => root)
  );
  // The terminals' servers first, so processes in the folder never crowd them out.
  const folderRootSet = new Set(inFolder.values());
  const tier = ({ root }: AttributedListener) => (folderRootSet.has(root) ? 1 : 0);
  return [...listeners.values()]
    .filter(({ port, root }) => printedPorts.has(port) || !servingRoots.has(root))
    .sort((a, b) => tier(a) - tier(b) || a.port - b.port)
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
 * The workspace's services, leaving out those of processes in its folder that don't answer HTTP:
 * started outside its terminals, such a port is a debugger's or a tool's, not one the user started.
 */
function ownServices(
  services: DevPreviewService[],
  listeners: AttributedListener[],
  inFolder: Map<number, TerminalRoot>
): DevPreviewService[] {
  const folderRootSet = new Set(inFolder.values());
  return services.filter(
    (service, index) => service.scheme !== null || !folderRootSet.has(listeners[index].root)
  );
}

/** `inKomla` with the trees of the workspace's processes in its folder, whose ports are its own. */
function withFolderTrees(
  snapshot: ListeningPortSnapshot,
  inKomla: Map<number, number>,
  inFolder: Map<number, TerminalRoot>
): Map<number, number> {
  if (inFolder.size === 0) return inKomla;
  return new Map([...inKomla, ...mapProcessesToRoots(snapshot.processes, inFolder.keys())]);
}

/**
 * The loopback-reachable listeners of processes outside Komla: neither in
 * `inKomla`, the trees under Komla itself or every managed tmux pane on an SSH
 * host and those of the workspace's processes in its folder, nor among
 * `launchers`, the processes that started Komla.
 */
function findOutsideListeners(
  snapshot: ListeningPortSnapshot,
  inKomla: Map<number, number>,
  launchers = new Set<number>()
): Listener[] {
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
  // Answers are kept by machine, as every workspace on it sees the same servers,
  // and a port that never answers costs a probe its whole timeout.
  const knownSchemes = new Map<
    string,
    { schemes: Map<string, Promise<HttpScheme | undefined>>; prunedBy: number }
  >();
  // Orders the scans, as the clock can step back.
  let scans = 0;
  const listenerKey = ({ pid, port }: { pid: number; port: number }): string => `${pid}:${port}`;

  /**
   * The scheme of each listener, probing only those not yet seen on the machine
   * (`scope`), whose `snapshot`, the `scan`th begun, says which listeners still hold
   * their ports. Undefined marks a port the probe could not check; it is probed again
   * next time.
   */
  async function probeOnce(
    scope: string,
    snapshot: ListeningPortSnapshot,
    scan: number,
    listeners: Listener[],
    probe: (ports: number[]) => Promise<Map<number, HttpScheme>>
  ): Promise<Array<HttpScheme | undefined>> {
    let entry = knownSchemes.get(scope);
    if (!entry) {
      entry = { schemes: new Map(), prunedBy: 0 };
      knownSchemes.set(scope, entry);
    }
    const known = entry.schemes;
    // Another workspace's scan, begun later, may have found listeners this one predates,
    // and a scan that lists none more likely failed than found every server stopped.
    if (scan > entry.prunedBy && snapshot.listeners.length > 0) {
      entry.prunedBy = scan;
      const holding = new Set(snapshot.listeners.map(listenerKey));
      for (const key of known.keys()) {
        if (!holding.has(key)) known.delete(key);
      }
    }
    const unprobed = listeners.filter((listener) => !known.has(listenerKey(listener)));
    const probed =
      unprobed.length > 0
        ? probe(unprobed.map(({ port }) => port)).catch(() => new Map<number, HttpScheme>())
        : Promise.resolve(new Map<number, HttpScheme>());
    const entries = listeners.map((listener) => {
      const key = listenerKey(listener);
      let scheme = known.get(key);
      if (!scheme) {
        scheme = probed.then((schemes) => schemes.get(listener.port));
        known.set(key, scheme);
      }
      return [key, scheme] as const;
    });

    const schemes = await Promise.all(entries.map(([, scheme]) => scheme));
    entries.forEach(([key, scheme], index) => {
      if (schemes[index] === undefined && known.get(key) === scheme) known.delete(key);
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
    const backgroundLocation = workspace.backend?.kind === 'ssh' ? 'local-copy' : 'workspace';
    for (const pid of deps.getBackgroundPids(workspaceId)) {
      roots.set(pid, { executionLocation: backgroundLocation });
    }
    // An SSH workspace's other servers are on the SSH host.
    const listsOtherServers = workspace.backend?.kind !== 'ssh';
    if (roots.size === 0 && !listsOtherServers) {
      return { services: [], otherServers: [], ownPorts: null };
    }

    // An SSH workspace's folder is on the SSH host, so no working directory here is in it.
    const claimsFolder =
      workspace.backend?.kind !== 'ssh' &&
      claimsProcessesInFolder(workspace, workspace.workingDirectory);
    let snapshot: ListeningPortSnapshot;
    const scan = ++scans;
    try {
      snapshot = await deps.collectListeningPorts({ cwds: claimsFolder });
    } catch (error) {
      logger.warn('Failed to list listening ports', { error: errorMessage(error) });
      return { services: [], otherServers: [], ownPorts: null };
    }
    const launchers = ancestorsOf(snapshot.processes, deps.komlaPid);
    const inKomla = mapProcessesToRoots(snapshot.processes, [deps.komlaPid]);
    // Working directories are real paths, so the folder is compared as its real path too.
    const realFolder = claimsFolder
      ? samePathKey(
          await realpath(workspace.workingDirectory).catch(() => workspace.workingDirectory)
        )
      : '';
    const inFolder = claimsFolder
      ? folderRoots(
          snapshot,
          (cwd) => isWithinRoot(realFolder, samePathKey(cwd)),
          inKomla,
          launchers
        )
      : new Map<number, TerminalRoot>();
    const listeners = attributeListeners(snapshot, roots, new Set(printedPorts), inFolder);
    const outside = listsOtherServers
      ? findOutsideListeners(snapshot, withFolderTrees(snapshot, inKomla, inFolder), launchers)
      : [];
    const schemes = await probeOnce(
      'local',
      snapshot,
      scan,
      [...listeners, ...outside],
      async (ports) =>
        new Map(
          await Promise.all(
            ports.map(async (port) => [port, await deps.probeHttpScheme(port)] as const)
          )
        )
    );
    return {
      services: ownServices(
        listeners.map((listener, index) => toService(listener, schemes[index] ?? null)),
        listeners,
        inFolder
      ),
      otherServers: toOtherServers(outside, schemes.slice(listeners.length)),
      ownPorts: ownListeningPorts(snapshot.listeners),
    };
  }

  async function findRemoteServers(
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
    const scan = ++scans;
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
    // Every managed tmux pane on the host belongs to Komla, whichever workspace it serves.
    const inKomla = mapProcessesToRoots(snapshot.processes, [...snapshot.panePids.values()].flat());
    const { remoteDirectory } = workspace.backend;
    const inFolder = claimsProcessesInFolder(workspace, remoteDirectory)
      ? folderRoots(snapshot, (cwd) => isInFolder(cwd, remoteDirectory), inKomla)
      : new Map<number, TerminalRoot>();
    const listeners = attributeListeners(snapshot, roots, new Set(remotePorts), inFolder);
    const outside = findOutsideListeners(snapshot, withFolderTrees(snapshot, inKomla, inFolder));
    const schemes = await probeOnce(
      `ssh:${hostId}`,
      snapshot,
      scan,
      [...listeners, ...outside],
      (ports) =>
        deps.probeRemoteHttpSchemes(hostId, ports).catch((error: unknown) => {
          logger.warn('Failed to probe ports on SSH host', { error: errorMessage(error) });
          throw error;
        })
    );
    // A port the probe could not check is offered as HTTP rather than hidden.
    const services = ownServices(
      listeners.map((listener, index) => {
        const scheme = schemes[index];
        return toService(listener, scheme === undefined ? 'http' : scheme);
      }),
      listeners,
      inFolder
    );
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
      findRemoteServers(workspace, remotePorts),
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
