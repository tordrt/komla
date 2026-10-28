import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';

import { app } from 'electron';

import { managedTmuxSessionName } from '../../../shared/lib/ssh-tmux-attach';
import { isLocalTerminalExecutionLocation } from '../../../shared/types/terminal';
import { needsSshPrompt } from '../../lib/ssh-client';
import { ptyService } from '../pty.service';
import { sshWorkspaceService } from '../ssh-workspace.service';
import { workspaceService } from '../workspace.service';

import {
  HOST_PROCESS_SNAPSHOT_COMMAND,
  LOCAL_PROCESS_SNAPSHOT_COMMAND,
  WINDOWS_PROCESS_SNAPSHOT_SCRIPT,
  parseProcessSnapshot,
  parseWindowsProcessSnapshot,
  type CpuTicks,
  type ProcessSnapshot,
} from './process-snapshot';
import {
  attributeProcesses,
  cpuPercents,
  cpuTimesOf,
  electronLaunchers,
  machineCpuPercent,
  mergeKomlaProcesses,
  type CpuTimes,
  type ProcessCpu,
  type TerminalRoots,
} from './resource-usage';

import type {
  KomlaProcessKind,
  KomlaProcessUsage,
  MachineResourceUsage,
} from '../../../shared/types/resource-usage';
import type { Workspace } from '../../../shared/types/workspace';

const execFileAsync = promisify(execFile);

const COMMAND_OPTIONS = {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  timeout: 10_000,
  windowsHide: true,
} as const;
// The popover and the status bar ask a machine again a few seconds after each answer; a host
// that doesn't answer gives up after this.
const HOST_TIMEOUT_MS = 10_000;
const LOCAL = 'local';

export interface ResourceUsageReadOptions {
  /** False keeps ssh from asking for a password, as for the status bar, which reads unasked. */
  prompt?: boolean;
  /** A reading younger than this, in ms, serves instead of a new one, as for each window's bar. */
  maxAgeMs?: number;
}

function isRemoteTerminal(workspace: Workspace, terminal: Workspace['terminals'][number]) {
  return (
    workspace.backend?.kind === 'ssh' &&
    !isLocalTerminalExecutionLocation(terminal.executionLocation)
  );
}

async function readLocalSnapshot(): Promise<ProcessSnapshot> {
  if (process.platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_PROCESS_SNAPSHOT_SCRIPT, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      COMMAND_OPTIONS
    );
    return parseWindowsProcessSnapshot(stdout);
  }
  const { stdout } = await execFileAsync('/bin/sh', ['-c', LOCAL_PROCESS_SNAPSHOT_COMMAND], {
    ...COMMAND_OPTIONS,
    // The command parses ps and sysctl output, which the locale can change.
    env: { ...process.env, LC_ALL: 'C' },
  });
  return parseProcessSnapshot(stdout);
}

/** This computer's CPU counters, which every platform keeps. */
function localCpuTicks(): CpuTicks {
  let busy = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    const used = times.user + times.nice + times.sys + times.irq;
    busy += used;
    total += used + times.idle;
  }
  return { busy, total };
}

/** Electron's processes, as Electron reports them: the main process, renderers and helpers. */
function appProcesses(): { usage: KomlaProcessUsage[]; pids: Set<number> } {
  const usage = new Map<KomlaProcessKind, KomlaProcessUsage>(
    (['main', 'windows', 'helpers'] as const).map((kind) => [
      kind,
      { kind, cpuPercent: 0, memoryBytes: 0, processCount: 0 },
    ])
  );
  const pids = new Set<number>();
  for (const metric of app.getAppMetrics()) {
    pids.add(metric.pid);
    const group = usage.get(
      metric.type === 'Browser' ? 'main' : metric.type === 'Tab' ? 'windows' : 'helpers'
    )!;
    group.cpuPercent = (group.cpuPercent ?? 0) + metric.cpu.percentCPUUsage;
    group.memoryBytes += metric.memory.workingSetSize * 1024;
    group.processCount += 1;
  }
  return {
    usage: [...usage.values()].map((group) => ({
      ...group,
      cpuPercent: Math.round((group.cpuPercent ?? 0) * 10) / 10,
    })),
    pids,
  };
}

/**
 * CPU and memory by workspace on this computer and on SSH hosts, read while the popover is open
 * and, for the machine it counts, while the status bar shows anything more than Komla's own.
 * CPU comes from the change in each process's CPU time between reads of the same machine, and
 * the machine's own total from its CPU counters.
 */
class ResourceUsageService {
  private readonly cpuTimes = new Map<string, CpuTimes>();
  private readonly reads = new Map<string, Promise<MachineResourceUsage>>();
  private readonly latest = new Map<string, { readAt: number; usage: MachineResourceUsage }>();

  /** This computer, or an SSH host. Windows asking at once share one read. */
  get(
    hostId: string | null,
    { prompt = true, maxAgeMs = 0 }: ResourceUsageReadOptions = {}
  ): Promise<MachineResourceUsage> {
    const machine = hostId === null ? LOCAL : `host:${hostId}`;
    const latest = this.latest.get(machine);
    if (latest && Date.now() - latest.readAt < maxAgeMs) return Promise.resolve(latest.usage);
    // A read that may ask for a password isn't one that can't, and the other way round.
    const key = hostId === null || prompt ? machine : `${machine}:no-prompt`;
    const pending = this.reads.get(key);
    if (pending) return pending;
    const read = (hostId === null ? this.local() : this.readHost(hostId, prompt))
      .then((usage) => {
        if (!usage.error) this.latest.set(machine, { readAt: Date.now(), usage });
        return usage;
      })
      .finally(() => this.reads.delete(key));
    this.reads.set(key, read);
    return read;
  }

  /** CPU since the machine's previous read, timed by its own clock where it gives one. */
  private cpuSince(
    machine: string,
    snapshot: ProcessSnapshot,
    startedAt: number,
    ticks: CpuTicks | undefined
  ): { processes: Map<number, ProcessCpu>; machine: number | null } {
    const now = { at: snapshot.sampledAt ?? startedAt, readAt: Date.now() };
    const previous = this.cpuTimes.get(machine);
    const { cores } = snapshot.machine;
    this.cpuTimes.set(machine, cpuTimesOf(snapshot.processes, now, ticks));
    return {
      processes: cpuPercents(snapshot.processes, previous, now, cores),
      machine: machineCpuPercent(previous, now, ticks, cores),
    };
  }

  private async local(): Promise<MachineResourceUsage> {
    const electron = appProcesses();
    const terminals: TerminalRoots[] = [];
    for (const workspace of workspaceService.list()) {
      for (const terminal of workspace.terminals) {
        if (isRemoteTerminal(workspace, terminal)) continue;
        const pid = ptyService.getPid(terminal.id);
        if (pid !== undefined) {
          terminals.push({ workspaceId: workspace.id, terminalId: terminal.id, rootPids: [pid] });
        }
      }
    }
    try {
      const startedAt = Date.now();
      const snapshot = await readLocalSnapshot();
      const cpu = this.cpuSince(LOCAL, snapshot, startedAt, localCpuTicks());
      const launchers = electronLaunchers(snapshot.processes, electron.pids, process.pid);
      const { komla, ...usage } = attributeProcesses(snapshot, terminals, cpu.processes, {
        excludedPids: electron.pids,
        komlaProcesses: new Map([...launchers].map((pid) => [pid, 'helpers'])),
        // Everything else Komla's main process started outside terminals.
        komlaTrees: new Map([[process.pid, 'background']]),
      });
      return {
        machine: { ...snapshot.machine, cpuPercent: cpu.machine },
        komla: mergeKomlaProcesses([...electron.usage, ...komla]),
        ...usage,
      };
    } catch (error) {
      return {
        machine: {
          cores: null,
          cpuPercent: null,
          memoryTotalBytes: null,
          memoryAvailableBytes: null,
        },
        komla: electron.usage,
        workspaces: [],
        otherProcesses: { cpuPercent: null, memoryBytes: 0 },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readHost(hostId: string, prompt: boolean): Promise<MachineResourceUsage> {
    try {
      const startedAt = Date.now();
      const output = await sshWorkspaceService.run(
        sshWorkspaceService.getHost(hostId),
        HOST_PROCESS_SNAPSHOT_COMMAND,
        { purpose: { kind: 'interactive' }, timeout: HOST_TIMEOUT_MS, prompt }
      );
      const snapshot = parseProcessSnapshot(output);
      const machine = `host:${hostId}`;
      const cpu = this.cpuSince(machine, snapshot, startedAt, snapshot.cpuTicks);
      const terminals: TerminalRoots[] = [];
      for (const workspace of workspaceService.list()) {
        if (workspace.backend?.kind !== 'ssh' || workspace.backend.hostId !== hostId) continue;
        for (const terminal of workspace.terminals) {
          const rootPids = snapshot.panes.get(managedTmuxSessionName(terminal.id));
          if (rootPids && isRemoteTerminal(workspace, terminal)) {
            terminals.push({ workspaceId: workspace.id, terminalId: terminal.id, rootPids });
          }
        }
      }
      const { servers, clients, companionServers, companionPanes } = snapshot.tmux;
      const komlaProcesses = new Map<number, KomlaProcessKind>([
        ...servers.map((pid) => [pid, 'tmux-server'] as const),
        ...clients.map((pid) => [pid, 'connections'] as const),
        ...companionServers.map((pid) => [pid, 'companion'] as const),
      ]);
      return {
        hostId,
        machine: { ...snapshot.machine, cpuPercent: cpu.machine },
        ...attributeProcesses(snapshot, terminals, cpu.processes, {
          countOtherSessions: true,
          komlaProcesses,
          komlaTrees: new Map(companionPanes.map((pid) => [pid, 'companion'])),
        }),
      };
    } catch (error) {
      return {
        hostId,
        machine: {
          cores: null,
          cpuPercent: null,
          memoryTotalBytes: null,
          memoryAvailableBytes: null,
        },
        komla: [],
        workspaces: [],
        otherProcesses: { cpuPercent: null, memoryBytes: 0 },
        error:
          !prompt && needsSshPrompt(error)
            ? 'Needs a password or passphrase; open resource usage to enter it'
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }
  }
}

export const resourceUsageService = new ResourceUsageService();
