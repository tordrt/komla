/**
 * One read of every process on a machine with its CPU time and memory, Komla's tmux processes
 * on an SSH host, and the machine's cores, CPU counters and memory. Linux is read from /proc, as
 * minimal images ship without ps, and macOS through ps, sysctl and vm_stat. The same POSIX shell
 * commands read this computer and SSH hosts; Windows has its own PowerShell script.
 */

import { MANAGED_TMUX_SOCKET_NAME } from '../../../shared/lib/ssh-tmux-attach';

import type { MachineResources } from '../../../shared/types/resource-usage';

export interface ProcessSample {
  pid: number;
  ppid: number;
  /** Total CPU time so far, in ms, where the system keeps it. */
  cpuTimeMs?: number;
  /**
   * CPU time of the children it collected after they exited, in ms, as Linux keeps it. A build's
   * short-lived compilers end up here, in the process that started them.
   */
  childCpuTimeMs?: number;
  /** CPU percent the system worked out itself, as macOS ps does, which keeps no total. */
  cpuPercent?: number;
  memoryBytes: number;
  /** Start time in ms since the epoch, read where parent PIDs can be stale. */
  startedAt?: number;
}

/** Komla's tmux processes on a machine, which an SSH host runs its terminal sessions in. */
export interface KomlaTmuxProcesses {
  servers: number[];
  /** Clients attached to its sessions: one per terminal a device has open. */
  clients: number[];
  /** The companions' tmux servers and the processes in their panes. */
  companionServers: number[];
  companionPanes: number[];
}

/** How long the machine's cores were busy, and in all, so far, in the same unit. */
export interface CpuTicks {
  busy: number;
  total: number;
}

export interface ProcessSnapshot {
  /** Root PIDs of the panes in each session on Komla's tmux server. */
  panes: Map<string, number[]>;
  tmux: KomlaTmuxProcesses;
  processes: ProcessSample[];
  machine: MachineResources;
  /** The shell or PowerShell that read the processes, which is Komla's reading, not their work. */
  readerPid?: number;
  /** When the processes were read, in ms on the machine's own clock, where it gives one. */
  sampledAt?: number;
  cpuTicks?: CpuTicks;
}

const TMUX_SECTION = '@@komla-tmux';
const PROCESSES_SECTION = '@@komla-processes';
const MACHINE_SECTION = '@@komla-machine';

// Each device's companion runs on a tmux server of its own, `komla-companion-<key>` (see
// remote-companion.service), whose socket sits next to Komla's.
const TMUX_LINES = [
  `printf '%s\\n' '${TMUX_SECTION}'`,
  `tmux -L ${MANAGED_TMUX_SOCKET_NAME} list-panes -a -F 'pane #{pid} #{pane_pid} #{session_name}' 2>/dev/null`,
  `tmux -L ${MANAGED_TMUX_SOCKET_NAME} list-clients -F 'client #{client_pid}' 2>/dev/null`,
  `for socket in "\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"/komla-companion-*; do`,
  `  [ -S "$socket" ] && tmux -S "$socket" list-panes -a -F 'companion #{pid} #{pane_pid}' 2>/dev/null`,
  'done',
];

// Of /proc/<pid>/stat, after the parenthesized name (which may hold spaces and parentheses):
// state, ppid, ..., utime, stime, cutime and cstime (fields 14 to 17), ..., rss in pages (field
// 24). The clock and the machine's CPU counters are read right after the processes. Totals are
// printed apart, as mawk prints large sums in exponent notation.
const PROCESS_AND_MACHINE_LINES = [
  `printf '%s\\n' '${PROCESSES_SECTION}'`,
  'if [ -r /proc/self/stat ]; then',
  `  printf '#proc %s %s\\n' "$(getconf CLK_TCK 2>/dev/null)" "$(getconf PAGESIZE 2>/dev/null)"`,
  `  cat /proc/[0-9]*/stat 2>/dev/null | awk '{ match($0, /.*\\) /); split(substr($0, RLENGTH + 1), f, " "); print $1, f[2], f[12], f[13], f[14], f[15], f[22] }'`,
  'else',
  `  printf '%s\\n' '#ps'`,
  '  ps -A -o pid= -o ppid= -o %cpu= -o rss= 2>/dev/null',
  'fi',
  `printf '%s\\n' '${MACHINE_SECTION}'`,
  'if [ -r /proc/stat ]; then',
  `  printf 'uptime %s\\n' "$(cut -d ' ' -f 1 /proc/uptime 2>/dev/null)"`,
  `  grep '^cpu ' /proc/stat`,
  'fi',
  `printf 'reader %s\\n' "$$"`,
  `printf 'cores %s\\n' "$(getconf _NPROCESSORS_ONLN 2>/dev/null)"`,
  'if [ -r /proc/meminfo ]; then',
  `  awk '/^MemTotal:/ { print "memtotal-kb", $2 } /^MemAvailable:/ { print "memavailable-kb", $2 }' /proc/meminfo 2>/dev/null`,
  'else',
  `  printf 'memtotal %s\\n' "$(sysctl -n hw.memsize 2>/dev/null)"`,
  `  vm_stat 2>/dev/null | awk '/page size of/ { print "pagesize", $8 } /^Pages (free|inactive|speculative):/ { sub(/\\.$/, "", $NF); print "freepages", $NF }'`,
  'fi',
  'true',
];

// ps prints decimal commas in some locales, and ssh can pass on the user's.
const C_LOCALE = 'export LC_ALL=C';

/** Reads this computer; Komla's tmux runs only on SSH hosts. */
export const LOCAL_PROCESS_SNAPSHOT_COMMAND = [C_LOCALE, ...PROCESS_AND_MACHINE_LINES].join('\n');

export const HOST_PROCESS_SNAPSHOT_COMMAND = [
  C_LOCALE,
  ...TMUX_LINES,
  ...PROCESS_AND_MACHINE_LINES,
].join('\n');

function positiveNumber(text: string | undefined): number | null {
  const value = Number(text);
  return text !== undefined && text !== '' && Number.isFinite(value) && value > 0 ? value : null;
}

function parseProcesses(lines: string[]): ProcessSample[] {
  const [format = '', ...rows] = lines;
  const processes: ProcessSample[] = [];
  if (format.startsWith('#proc')) {
    const [, ticks, page] = format.split(' ');
    const ticksPerSecond = positiveNumber(ticks) ?? 100;
    const pageBytes = positiveNumber(page) ?? 4096;
    const ms = (ticks: number) => (ticks * 1000) / ticksPerSecond;
    for (const row of rows) {
      const fields = row.trim().split(/\s+/).map(Number);
      if (fields.length !== 7 || fields.some((field) => !Number.isFinite(field))) continue;
      const [pid, ppid, userTicks, systemTicks, childUserTicks, childSystemTicks, residentPages] =
        fields;
      processes.push({
        pid,
        ppid,
        cpuTimeMs: ms(userTicks + systemTicks),
        childCpuTimeMs: ms(childUserTicks + childSystemTicks),
        memoryBytes: residentPages * pageBytes,
      });
    }
  } else if (format === '#ps') {
    for (const row of rows) {
      const fields = row.trim().split(/\s+/).map(Number);
      if (fields.length !== 4 || fields.some((field) => !Number.isFinite(field))) continue;
      const [pid, ppid, cpuPercent, residentKilobytes] = fields;
      processes.push({ pid, ppid, cpuPercent, memoryBytes: residentKilobytes * 1024 });
    }
  }
  return processes;
}

// The first line of /proc/stat: user, nice, system, idle, iowait, irq, softirq and steal time.
// Guest time is already in user and nice.
function parseCpuTicks(fields: string[] | undefined): CpuTicks | undefined {
  const ticks = fields?.slice(0, 8).map(Number);
  if (ticks?.length !== 8 || ticks.some((tick) => !Number.isFinite(tick))) return undefined;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = ticks;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait };
}

function parseMachine(
  lines: string[]
): Pick<ProcessSnapshot, 'machine' | 'readerPid' | 'sampledAt' | 'cpuTicks'> {
  const values = new Map<string, string[]>();
  let cpuFields: string[] | undefined;
  for (const line of lines) {
    const [key, value, ...rest] = line.trim().split(/\s+/);
    if (key === 'cpu') cpuFields = [value, ...rest];
    else if (key && value !== undefined) values.set(key, [...(values.get(key) ?? []), value]);
  }
  const first = (key: string) => positiveNumber(values.get(key)?.[0]);
  const kilobytes = (key: string) => {
    const value = first(key);
    return value === null ? null : value * 1024;
  };
  const pageBytes = first('pagesize');
  const freePages = values.get('freepages')?.map(Number);
  const uptimeSeconds = first('uptime');
  const readerPid = first('reader');
  const cpuTicks = parseCpuTicks(cpuFields);
  return {
    machine: {
      cores: first('cores'),
      cpuPercent: null,
      memoryTotalBytes: kilobytes('memtotal-kb') ?? first('memtotal'),
      memoryAvailableBytes:
        kilobytes('memavailable-kb') ??
        (pageBytes !== null && freePages?.every(Number.isFinite)
          ? freePages.reduce((sum, pages) => sum + pages, 0) * pageBytes
          : null),
    },
    ...(readerPid !== null ? { readerPid } : {}),
    ...(uptimeSeconds !== null ? { sampledAt: uptimeSeconds * 1000 } : {}),
    ...(cpuTicks ? { cpuTicks } : {}),
  };
}

function parseTmux(lines: string[]): Pick<ProcessSnapshot, 'panes' | 'tmux'> {
  const panes = new Map<string, number[]>();
  const servers = new Set<number>();
  const clients: number[] = [];
  const companionServers = new Set<number>();
  const companionPanes: number[] = [];
  for (const line of lines) {
    const [kind, ...fields] = line.trim().split(' ');
    const [first, second] = fields.map(Number);
    if (!Number.isInteger(first)) continue;
    if (kind === 'pane' && Number.isInteger(second) && fields[2]) {
      servers.add(first);
      panes.set(fields[2], [...(panes.get(fields[2]) ?? []), second]);
    } else if (kind === 'client') {
      clients.push(first);
    } else if (kind === 'companion' && Number.isInteger(second)) {
      companionServers.add(first);
      companionPanes.push(second);
    }
  }
  return {
    panes,
    tmux: {
      servers: [...servers],
      clients,
      companionServers: [...companionServers],
      companionPanes,
    },
  };
}

export function parseProcessSnapshot(output: string): ProcessSnapshot {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of output.split('\n')) {
    if (line === TMUX_SECTION || line === PROCESSES_SECTION || line === MACHINE_SECTION) {
      current = [];
      sections.set(line, current);
    } else if (line.trim()) {
      current?.push(line);
    }
  }

  const { panes, tmux } = parseTmux(sections.get(TMUX_SECTION) ?? []);
  return {
    panes,
    tmux,
    processes: parseProcesses(sections.get(PROCESSES_SECTION) ?? []),
    ...parseMachine(sections.get(MACHINE_SECTION) ?? []),
  };
}

// CPU times are in 100 ns units.
export const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$processes = @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; cpuTimeMs = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000; memoryBytes = [double]$_.WorkingSetSize; startedAt = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }) } })',
  '$sampledAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
  '$system = Get-CimInstance Win32_ComputerSystem',
  '$os = Get-CimInstance Win32_OperatingSystem',
  'ConvertTo-Json -Compress -Depth 3 -InputObject @{ processes = $processes; readerPid = $PID; sampledAt = $sampledAt; cores = [int]$system.NumberOfLogicalProcessors; memoryTotalBytes = [double]$system.TotalPhysicalMemory; memoryAvailableBytes = [double]$os.FreePhysicalMemory * 1024 }',
].join('; ');

/** Parses the JSON the Windows script prints. */
export function parseWindowsProcessSnapshot(output: string): ProcessSnapshot {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  const records = Array.isArray(parsed.processes)
    ? (parsed.processes as unknown[]).filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object'
      )
    : [];
  const processes = records.flatMap((entry): ProcessSample[] => {
    const { pid, ppid, cpuTimeMs, memoryBytes, startedAt } = entry;
    // PID 0, the System Idle Process, counts the cores' idle time as its CPU time.
    if (typeof pid !== 'number' || typeof ppid !== 'number' || pid === 0) return [];
    return [
      {
        pid,
        ppid,
        cpuTimeMs: typeof cpuTimeMs === 'number' ? cpuTimeMs : 0,
        memoryBytes: typeof memoryBytes === 'number' ? memoryBytes : 0,
        ...(typeof startedAt === 'number' ? { startedAt } : {}),
      },
    ];
  });
  const readerPid = number(parsed.readerPid);
  const sampledAt = number(parsed.sampledAt);
  return {
    panes: new Map(),
    tmux: { servers: [], clients: [], companionServers: [], companionPanes: [] },
    processes,
    machine: {
      cores: number(parsed.cores),
      cpuPercent: null,
      memoryTotalBytes: number(parsed.memoryTotalBytes),
      memoryAvailableBytes: number(parsed.memoryAvailableBytes),
    },
    ...(readerPid !== null ? { readerPid } : {}),
    ...(sampledAt !== null ? { sampledAt } : {}),
  };
}
