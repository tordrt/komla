import { managedTmuxSessionName } from '../../../shared/lib/ssh-tmux-attach';
import { mapProcessesToRoots } from '../dev-preview-services/listening-ports';

import type { CpuTicks, ProcessSample, ProcessSnapshot } from './process-snapshot';
import type {
  KomlaProcessKind,
  KomlaProcessUsage,
  MachineResourceUsage,
  ResourceUsage,
  WorkspaceResourceUsage,
} from '../../../shared/types/resource-usage';

/** A terminal whose processes count toward its workspace, by its tree's root PIDs. */
export interface TerminalRoots {
  workspaceId: string;
  terminalId: string;
  rootPids: number[];
}

/** When a machine's processes were read: on its own clock where it gives one, and on Komla's. */
export interface ReadTime {
  at: number;
  readAt: number;
}

/** A machine's CPU times at its previous read, to tell how busy it was since. */
export interface CpuTimes extends ReadTime {
  processes: Map<number, { ppid: number; cpuTimeMs: number; childCpuTimeMs: number }>;
  machine?: CpuTicks;
}

/** CPU a process used since the previous read, in percent of one core. */
export interface ProcessCpu {
  own: number | null;
  /** With the children it collected after they exited, such as a build's compilers. */
  withChildren: number | null;
}

// Reads come every few seconds while the popover is open; one older than this, such as from
// before it was last closed, would average over that whole time.
const MAX_BASELINE_AGE_MS = 15_000;

function freshBaseline(previous: CpuTimes | undefined, now: ReadTime): CpuTimes | undefined {
  return previous && now.readAt - previous.readAt <= MAX_BASELINE_AGE_MS && now.at > previous.at
    ? previous
    : undefined;
}

// A PID whose CPU time went down belongs to another process now.
function sameProcess(
  before: { cpuTimeMs: number; childCpuTimeMs: number },
  after: ProcessSample
): boolean {
  return (
    (after.cpuTimeMs ?? 0) >= before.cpuTimeMs &&
    (after.childCpuTimeMs ?? 0) >= before.childCpuTimeMs
  );
}

/**
 * CPU time to take back from each process's children's time: a child that has exited since the
 * previous read is in the time of the ancestor that collected it, usually its nearest one still
 * running, along with the time it had already used by then.
 */
function collectedBefore(
  baseline: CpuTimes,
  live: Map<number, ProcessSample>
): Map<number, number> {
  const isRunning = (pid: number) => {
    const before = baseline.processes.get(pid);
    const after = live.get(pid);
    return !!before && !!after && sameProcess(before, after);
  };
  const collected = new Map<number, number>();
  for (const [pid, before] of baseline.processes) {
    if (isRunning(pid)) continue;
    let ancestor = before.ppid;
    const seen = new Set([pid]);
    while (!isRunning(ancestor) && !seen.has(ancestor)) {
      seen.add(ancestor);
      const parent = baseline.processes.get(ancestor)?.ppid;
      if (parent === undefined) break;
      ancestor = parent;
    }
    if (isRunning(ancestor)) {
      collected.set(
        ancestor,
        (collected.get(ancestor) ?? 0) + before.cpuTimeMs + before.childCpuTimeMs
      );
    }
  }
  return collected;
}

/**
 * CPU each process used since the previous read. A process that read had no entry for started
 * since, so all its CPU time falls in between. Unknown on the first read, or after a long gap.
 */
export function cpuPercents(
  processes: ProcessSample[],
  previous: CpuTimes | undefined,
  now: ReadTime,
  cores: number | null
): Map<number, ProcessCpu> {
  const baseline = freshBaseline(previous, now);
  const elapsed = baseline ? now.at - baseline.at : 0;
  const live = new Map(processes.map((sample) => [sample.pid, sample]));
  const collected = baseline ? collectedBefore(baseline, live) : new Map<number, number>();
  // Children's time can't be more than every core for the whole time.
  const ceiling = cores === null ? Infinity : cores * 100;
  const percent = (ms: number) => (Math.max(0, ms) / elapsed) * 100;
  return new Map(
    processes.map((sample): [number, ProcessCpu] => {
      if (sample.cpuPercent !== undefined) {
        return [sample.pid, { own: sample.cpuPercent, withChildren: sample.cpuPercent }];
      }
      if (sample.cpuTimeMs === undefined || !baseline || elapsed <= 0) {
        return [sample.pid, { own: null, withChildren: null }];
      }
      const before = baseline.processes.get(sample.pid);
      const known = before && sameProcess(before, sample) ? before : undefined;
      const own = sample.cpuTimeMs - (known?.cpuTimeMs ?? 0);
      const children =
        (sample.childCpuTimeMs ?? 0) -
        (known?.childCpuTimeMs ?? 0) -
        (collected.get(sample.pid) ?? 0);
      return [
        sample.pid,
        {
          own: percent(own),
          withChildren: Math.min(ceiling, percent(own + Math.max(0, children))),
        },
      ];
    })
  );
}

export function cpuTimesOf(
  processes: ProcessSample[],
  time: ReadTime,
  machine: CpuTicks | undefined
): CpuTimes {
  return {
    ...time,
    processes: new Map(
      processes.flatMap((sample) =>
        sample.cpuTimeMs === undefined
          ? []
          : [
              [
                sample.pid,
                {
                  ppid: sample.ppid,
                  cpuTimeMs: sample.cpuTimeMs,
                  childCpuTimeMs: sample.childCpuTimeMs ?? 0,
                },
              ],
            ]
      )
    ),
    ...(machine ? { machine } : {}),
  };
}

/** Percent of one core the whole machine used since the previous read, by its own counters. */
export function machineCpuPercent(
  previous: CpuTimes | undefined,
  now: ReadTime,
  ticks: CpuTicks | undefined,
  cores: number | null
): number | null {
  const before = freshBaseline(previous, now)?.machine;
  if (!before || !ticks || cores === null) return null;
  const total = ticks.total - before.total;
  const busy = ticks.busy - before.busy;
  if (total <= 0 || busy < 0) return null;
  return Math.round((busy / total) * cores * 1000) / 10;
}

function emptyUsage(): ResourceUsage {
  return { cpuPercent: null, memoryBytes: 0 };
}

class UsageTotals {
  private readonly totals = new Map<string, ResourceUsage & { processCount: number }>();

  add(key: string, sample: ProcessSample, cpuPercent: number | null | undefined): void {
    const total = this.totals.get(key) ?? { ...emptyUsage(), processCount: 0 };
    total.memoryBytes += sample.memoryBytes;
    total.processCount += 1;
    if (cpuPercent !== null && cpuPercent !== undefined) {
      total.cpuPercent = (total.cpuPercent ?? 0) + cpuPercent;
    }
    this.totals.set(key, total);
  }

  get(key: string): ResourceUsage {
    const { cpuPercent, memoryBytes } = this.totals.get(key) ?? emptyUsage();
    return { cpuPercent, memoryBytes };
  }

  processCount(key: string): number {
    return this.totals.get(key)?.processCount ?? 0;
  }
}

/** The total a process counts toward, and whether the children it collected count with it. */
interface ProcessGroup {
  key: string;
  withChildren: boolean;
}

// What attributeProcesses can find of Komla's own processes, in the order they're listed.
const ATTRIBUTED_KOMLA_KINDS: KomlaProcessKind[] = [
  'helpers',
  'background',
  'tmux-server',
  'connections',
  'companion',
];

function roundUsage<T extends ResourceUsage>(usage: T): T {
  return {
    ...usage,
    cpuPercent: usage.cpuPercent === null ? null : Math.round(usage.cpuPercent * 10) / 10,
  };
}

/**
 * Processes between Komla's main process and Electron's own, such as Linux's zygotes, which start
 * its windows and GPU process but aren't in Electron's metrics.
 */
export function electronLaunchers(
  processes: ProcessSample[],
  electronPids: Set<number>,
  mainPid: number
): Set<number> {
  const parentOf = new Map(processes.map(({ pid, ppid }) => [pid, ppid]));
  const launchers = new Set<number>();
  for (const pid of electronPids) {
    const between: number[] = [];
    let parent = parentOf.get(pid);
    while (parent !== undefined && parent !== mainPid && !electronPids.has(parent)) {
      if (between.includes(parent)) break;
      between.push(parent);
      parent = parentOf.get(parent);
    }
    if (parent === mainPid) for (const launcher of between) launchers.add(launcher);
  }
  return launchers;
}

/** Adds up parts of the same kind, such as Electron's helpers from its metrics and from a read. */
export function mergeKomlaProcesses(parts: KomlaProcessUsage[]): KomlaProcessUsage[] {
  const merged = new Map<KomlaProcessKind, KomlaProcessUsage>();
  for (const part of parts) {
    const current = merged.get(part.kind);
    if (!current) {
      merged.set(part.kind, part);
      continue;
    }
    const cpuPercent =
      current.cpuPercent === null && part.cpuPercent === null
        ? null
        : (current.cpuPercent ?? 0) + (part.cpuPercent ?? 0);
    merged.set(
      part.kind,
      roundUsage({
        kind: part.kind,
        cpuPercent,
        memoryBytes: current.memoryBytes + part.memoryBytes,
        processCount: current.processCount + part.processCount,
      })
    );
  }
  return [...merged.values()];
}

/** Pane PIDs of Komla's tmux sessions that none of `terminals` runs in, such as another device's. */
function otherSessionRoots(
  panes: ProcessSnapshot['panes'],
  terminals: TerminalRoots[]
): Map<number, string> {
  const known = new Set(terminals.map(({ terminalId }) => managedTmuxSessionName(terminalId)));
  const roots = new Map<number, string>();
  for (const [session, pids] of panes) {
    if (known.has(session)) continue;
    for (const pid of pids) roots.set(pid, session);
  }
  return roots;
}

function workspaceTotals(
  terminals: TerminalRoots[],
  totals: UsageTotals
): WorkspaceResourceUsage[] {
  const workspaces = new Map<string, WorkspaceResourceUsage>();
  for (const { workspaceId, terminalId } of terminals) {
    const workspace = workspaces.get(workspaceId) ?? {
      workspaceId,
      ...emptyUsage(),
      terminals: [],
    };
    workspaces.set(workspaceId, workspace);
    if (workspace.terminals.some((terminal) => terminal.terminalId === terminalId)) continue;
    const usage = totals.get(`terminal:${terminalId}`);
    workspace.terminals.push(roundUsage({ terminalId, ...usage }));
    workspace.memoryBytes += usage.memoryBytes;
    if (usage.cpuPercent !== null) {
      workspace.cpuPercent = (workspace.cpuPercent ?? 0) + usage.cpuPercent;
    }
  }
  return [...workspaces.values()]
    .filter((workspace) => workspace.memoryBytes > 0)
    .map(roundUsage)
    .sort((a, b) => b.memoryBytes - a.memoryBytes);
}

/**
 * Adds up each terminal's process tree, then each workspace's terminals. Komla's own processes,
 * given one by one or as trees, count by kind; on an SSH host, trees of Komla's tmux sessions no
 * terminal here has count as other sessions. Processes outside all of them, not in `excludedPids`,
 * which the caller reads otherwise, and not under the snapshot's reader count as other processes.
 * Terminals count the children their processes collected after they exited; elsewhere, a child
 * may have been collected by a process other than its parent, so only processes' own CPU counts.
 */
export function attributeProcesses(
  snapshot: Pick<ProcessSnapshot, 'panes' | 'processes' | 'readerPid'>,
  terminals: TerminalRoots[],
  cpu: Map<number, ProcessCpu>,
  options: {
    excludedPids?: Set<number>;
    countOtherSessions?: boolean;
    komlaProcesses?: Map<number, KomlaProcessKind>;
    komlaTrees?: Map<number, KomlaProcessKind>;
  } = {}
): Pick<MachineResourceUsage, 'komla' | 'workspaces' | 'otherSessions' | 'otherProcesses'> {
  const terminalByRoot = new Map<number, TerminalRoots>();
  for (const terminal of terminals) {
    for (const pid of terminal.rootPids) terminalByRoot.set(pid, terminal);
  }
  const sessionRoots = options.countOtherSessions
    ? otherSessionRoots(snapshot.panes, terminals)
    : new Map<number, string>();
  const komlaTrees = options.komlaTrees ?? new Map<number, KomlaProcessKind>();
  const reader = snapshot.readerPid;
  // The reader's tree is claimed first, then a terminal's, though Komla's main process is the
  // parent of both.
  const owners = mapProcessesToRoots(
    snapshot.processes.map(({ pid, ppid, startedAt }) => ({ pid, ppid, name: '', startedAt })),
    [
      ...(reader === undefined ? [] : [reader]),
      ...terminalByRoot.keys(),
      ...sessionRoots.keys(),
      ...komlaTrees.keys(),
    ]
  );

  const groupOf = (pid: number, root: number | undefined): ProcessGroup => {
    const komlaKind =
      options.komlaProcesses?.get(pid) ?? (root === undefined ? undefined : komlaTrees.get(root));
    if (komlaKind) return { key: `komla:${komlaKind}`, withChildren: false };
    if (root === undefined) return { key: 'other', withChildren: false };
    const terminal = terminalByRoot.get(root);
    return {
      key: terminal ? `terminal:${terminal.terminalId}` : 'other-sessions',
      withChildren: true,
    };
  };

  const totals = new UsageTotals();
  for (const sample of snapshot.processes) {
    if (options.excludedPids?.has(sample.pid)) continue;
    const root = owners.get(sample.pid);
    if (root !== undefined && root === reader) continue;
    const group = groupOf(sample.pid, root);
    const processCpu = cpu.get(sample.pid);
    totals.add(group.key, sample, group.withChildren ? processCpu?.withChildren : processCpu?.own);
  }

  return {
    komla: ATTRIBUTED_KOMLA_KINDS.flatMap((kind): KomlaProcessUsage[] => {
      const processCount = totals.processCount(`komla:${kind}`);
      return processCount > 0
        ? [{ kind, ...roundUsage(totals.get(`komla:${kind}`)), processCount }]
        : [];
    }),
    workspaces: workspaceTotals(terminals, totals),
    ...(options.countOtherSessions
      ? {
          otherSessions: {
            ...roundUsage(totals.get('other-sessions')),
            count: new Set(sessionRoots.values()).size,
          },
        }
      : {}),
    otherProcesses: roundUsage(totals.get('other')),
  };
}
