/**
 * Finds the TCP ports the current user's processes listen on, with the whole
 * process table so callers can tell which process tree holds each one. Other
 * users' sockets are left out where the platform does not say who holds them.
 */

import { execFile } from 'child_process';
import { readdir, readFile, readlink } from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const COMMAND_OPTIONS = {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  timeout: 5_000,
  windowsHide: true,
} as const;
const TCP_LISTEN_STATE = '0A';

export interface ProcessEntry {
  pid: number;
  ppid: number;
  name: string;
  /** Start time in ms since the epoch, read where parent PIDs can be stale. */
  startedAt?: number;
}

export interface ListeningSocket {
  pid: number;
  address: string;
  port: number;
}

export interface ListeningPortSnapshot {
  processes: ProcessEntry[];
  listeners: ListeningSocket[];
}

/** Maps every process in the roots' trees, including each root, to its root PID. */
export function mapProcessesToRoots(
  processes: ProcessEntry[],
  rootPids: Iterable<number>
): Map<number, number> {
  const startTimes = new Map(processes.map(({ pid, startedAt }) => [pid, startedAt]));
  const children = new Map<number, number[]>();
  for (const { pid, ppid, startedAt } of processes) {
    if (pid === ppid) continue;
    // Windows keeps an exited parent's PID on its children, and that PID can
    // later belong to an unrelated process, such as a terminal's shell, that
    // started after them.
    const parentStartedAt = startTimes.get(ppid);
    if (startedAt !== undefined && parentStartedAt !== undefined && startedAt < parentStartedAt) {
      continue;
    }
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }

  const owners = new Map<number, number>();
  for (const root of rootPids) {
    const queue = [root];
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (owners.has(pid)) continue;
      owners.set(pid, root);
      queue.push(...(children.get(pid) ?? []));
    }
  }
  return owners;
}

/** Whether a page at `localhost:<port>` reaches a socket bound to this address. */
export function isLoopbackReachableAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return (
    normalized === '*' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(normalized)
  );
}

/**
 * Drops every port `pid` listens on. Terminals inherit sockets that Komla's
 * process opened without close-on-exec, so its own ports also show up as held
 * by shells and their children.
 */
export function withoutPortsHeldBy(listeners: ListeningSocket[], pid: number): ListeningSocket[] {
  const heldPorts = new Set(
    listeners.filter((listener) => listener.pid === pid).map(({ port }) => port)
  );
  return listeners.filter(({ port }) => !heldPorts.has(port));
}

export async function collectListeningPorts(): Promise<ListeningPortSnapshot> {
  if (process.platform === 'win32') {
    const snapshot = await readWindowsSnapshot();
    return { ...snapshot, listeners: withoutPortsHeldBy(snapshot.listeners, process.pid) };
  }

  const processes =
    process.platform === 'linux' ? await readLinuxProcesses() : await readPsProcesses();
  const listeners =
    process.platform === 'linux'
      ? await readLinuxListeners(processes.map(({ pid }) => pid))
      : await readLsofListeners();
  return { processes, listeners: withoutPortsHeldBy(listeners, process.pid) };
}

// ── Linux ──────────────────────────────────────────────────────────────────

async function readLinuxProcesses(): Promise<ProcessEntry[]> {
  const entries = await readdir('/proc');
  const processes = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        try {
          return parseProcStat(await readFile(`/proc/${entry}/stat`, 'utf8'));
        } catch {
          // The process exited during the scan.
          return null;
        }
      })
  );
  return processes.filter((entry): entry is ProcessEntry => entry !== null);
}

/** Parses `/proc/<pid>/stat`, whose command name may contain spaces and parentheses. */
export function parseProcStat(content: string): ProcessEntry | null {
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(content.slice(0, open));
  const ppid = Number(
    content
      .slice(close + 1)
      .trim()
      .split(/\s+/)[1]
  );
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) return null;
  return { pid, ppid, name: content.slice(open + 1, close) };
}

async function readLinuxListeners(pids: number[]): Promise<ListeningSocket[]> {
  const tables = await Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map((path) => readFile(path, 'utf8').catch(() => ''))
  );
  const socketsByInode = new Map(
    tables.flatMap(parseProcNetTcp).map((socket) => [socket.inode, socket] as const)
  );
  if (socketsByInode.size === 0) return [];

  const listeners: ListeningSocket[] = [];
  await Promise.all(
    pids.map(async (pid) => {
      for (const inode of await readLinuxSocketInodes(pid)) {
        const socket = socketsByInode.get(inode);
        if (socket) listeners.push({ pid, address: socket.address, port: socket.port });
      }
    })
  );
  return listeners;
}

async function readLinuxSocketInodes(pid: number): Promise<number[]> {
  let fds: string[];
  try {
    fds = await readdir(`/proc/${pid}/fd`);
  } catch {
    // Another user's process, or one that exited during the scan.
    return [];
  }
  const links = await Promise.all(
    fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''))
  );
  return links.flatMap((link) => {
    const match = /^socket:\[(\d+)\]$/.exec(link);
    return match ? [Number(match[1])] : [];
  });
}

/** Parses the listening sockets in `/proc/net/tcp` or `/proc/net/tcp6`. */
export function parseProcNetTcp(
  content: string
): Array<{ inode: number; address: string; port: number }> {
  const sockets: Array<{ inode: number; address: string; port: number }> = [];
  for (const line of content.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== TCP_LISTEN_STATE) continue;
    const [hexAddress, hexPort] = fields[1].split(':');
    const address = decodeProcNetAddress(hexAddress ?? '');
    const port = parseInt(hexPort ?? '', 16);
    const inode = Number(fields[9]);
    if (!address || !(port > 0) || !(inode > 0)) continue;
    sockets.push({ inode, address, port });
  }
  return sockets;
}

// The kernel prints each 32-bit word of the address in host byte order, which
// is little-endian on every architecture Komla ships for.
function decodeProcNetAddress(hex: string): string | null {
  if (!/^(?:[0-9a-f]{8}|[0-9a-f]{32})$/i.test(hex)) return null;
  const bytes: number[] = [];
  for (let word = 0; word < hex.length; word += 8) {
    for (let byte = 3; byte >= 0; byte--) {
      bytes.push(parseInt(hex.slice(word + byte * 2, word + byte * 2 + 2), 16));
    }
  }
  if (bytes.length === 4) return bytes.join('.');
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join('.')}`;
  }
  if (bytes.slice(0, 15).every((byte) => byte === 0)) return bytes[15] === 1 ? '::1' : '::';
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  }
  return groups.join(':');
}

// ── macOS ──────────────────────────────────────────────────────────────────

async function readPsProcesses(): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], COMMAND_OPTIONS);
  return parsePsOutput(stdout);
}

/** Parses `ps -axo pid=,ppid=,comm=`, where macOS prints the executable's full path. */
export function parsePsOutput(output: string): ProcessEntry[] {
  const processes: ProcessEntry[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: match[3].slice(match[3].lastIndexOf('/') + 1),
    });
  }
  return processes;
}

// Without root, lsof lists only the current user's sockets.
async function readLsofListeners(): Promise<ListeningSocket[]> {
  const args = ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'];
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', args, COMMAND_OPTIONS);
    return parseLsofListeners(stdout);
  } catch (error) {
    // lsof exits 1 when no process has a listening socket.
    const { code, stdout } = error as { code?: unknown; stdout?: unknown };
    if (code === 1 && typeof stdout === 'string') return parseLsofListeners(stdout);
    throw error;
  }
}

/** Parses `lsof -F n` output: a `p<pid>` line, then one `n<address>:<port>` line per socket. */
export function parseLsofListeners(output: string): ListeningSocket[] {
  const listeners: ListeningSocket[] = [];
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      continue;
    }
    if (!line.startsWith('n') || !(pid > 0)) continue;
    const name = line.slice(1).replace(/\s*\(LISTEN\)$/, '');
    const separator = name.lastIndexOf(':');
    const port = Number(name.slice(separator + 1));
    if (separator <= 0 || !Number.isInteger(port) || port <= 0) continue;
    listeners.push({ pid, address: name.slice(0, separator).replace(/^\[|\]$/g, ''), port });
  }
  return listeners;
}

// ── Windows ────────────────────────────────────────────────────────────────

const WINDOWS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // Windows PowerShell prints in the console code page otherwise, where a
  // byte of a Japanese or Chinese process name can read as a JSON backslash.
  '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  '$processes = @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; startedAt = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }) } })',
  '$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { @{ pid = [int]$_.OwningProcess; address = [string]$_.LocalAddress; port = [int]$_.LocalPort } })',
  'ConvertTo-Json -Compress -Depth 3 -InputObject @{ processes = $processes; listeners = $listeners }',
].join('; ');

async function readWindowsSnapshot(): Promise<ListeningPortSnapshot> {
  const encoded = Buffer.from(WINDOWS_SNAPSHOT_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    COMMAND_OPTIONS
  );
  return parseWindowsSnapshot(stdout);
}

/** Parses the JSON printed by the Windows snapshot script. */
export function parseWindowsSnapshot(output: string): ListeningPortSnapshot {
  const parsed = JSON.parse(output) as { processes?: unknown; listeners?: unknown };
  const records = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : [];

  const processes = records(parsed.processes).flatMap((entry): ProcessEntry[] => {
    const { pid, ppid, name, startedAt } = entry;
    if (typeof pid !== 'number' || typeof ppid !== 'number' || typeof name !== 'string') return [];
    return [
      {
        pid,
        ppid,
        name: name.replace(/\.exe$/i, ''),
        ...(typeof startedAt === 'number' ? { startedAt } : {}),
      },
    ];
  });
  const listeners = records(parsed.listeners).flatMap((entry): ListeningSocket[] => {
    const { pid, address, port } = entry;
    if (typeof pid !== 'number' || typeof address !== 'string' || typeof port !== 'number') {
      return [];
    }
    return [{ pid, address, port }];
  });
  return { processes, listeners };
}
