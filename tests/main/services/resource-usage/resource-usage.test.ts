import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import {
  HOST_PROCESS_SNAPSHOT_COMMAND,
  LOCAL_PROCESS_SNAPSHOT_COMMAND,
  parseProcessSnapshot,
  parseWindowsProcessSnapshot,
} from '../../../../src/main/services/resource-usage/process-snapshot';
import {
  attributeProcesses,
  cpuPercents,
  cpuTimesOf,
  electronLaunchers,
  machineCpuPercent,
  mergeKomlaProcesses,
  type ProcessCpu,
} from '../../../../src/main/services/resource-usage/resource-usage';

const MB = 1024 ** 2;

describe('process snapshot', () => {
  it("reads Linux processes, Komla's tmux processes, and the machine", () => {
    const snapshot = parseProcessSnapshot(
      [
        '@@komla-tmux',
        'pane 90 100 komla-term-1',
        'pane 90 105 komla-term-1',
        'client 120',
        'client 121',
        'companion 130 131',
        'companion oops',
        '@@komla-processes',
        '#proc 100 4096',
        '100 1 250 50 40 10 2560',
        '101 100 1000 0 0 0 25600',
        'garbage',
        '@@komla-machine',
        'uptime 5000.25',
        'cpu  100 20 30 900 50 5 5 10 7 0',
        'reader 140',
        'cores 16',
        'memtotal-kb 32096952',
        'memavailable-kb 10542356',
      ].join('\n')
    );

    expect(snapshot.panes).toEqual(new Map([['komla-term-1', [100, 105]]]));
    expect(snapshot.tmux).toEqual({
      servers: [90],
      clients: [120, 121],
      companionServers: [130],
      companionPanes: [131],
    });
    expect(snapshot.processes).toEqual([
      { pid: 100, ppid: 1, cpuTimeMs: 3000, childCpuTimeMs: 500, memoryBytes: 10 * MB },
      { pid: 101, ppid: 100, cpuTimeMs: 10_000, childCpuTimeMs: 0, memoryBytes: 100 * MB },
    ]);
    expect(snapshot.machine).toEqual({
      cores: 16,
      cpuPercent: null,
      memoryTotalBytes: 32096952 * 1024,
      memoryAvailableBytes: 10542356 * 1024,
    });
    expect(snapshot.readerPid).toBe(140);
    expect(snapshot.sampledAt).toBe(5_000_250);
    // Idle and iowait aren't busy; guest time is already in user time.
    expect(snapshot.cpuTicks).toEqual({ busy: 170, total: 1120 });
  });

  it('reads macOS processes and memory', () => {
    const snapshot = parseProcessSnapshot(
      [
        '@@komla-tmux',
        '@@komla-processes',
        '#ps',
        '  412     1  12.5  20480',
        '@@komla-machine',
        'cores 10',
        'memtotal 17179869184',
        'pagesize 16384',
        'freepages 1000',
        'freepages 2000',
        'freepages 500',
      ].join('\n')
    );

    expect(snapshot.processes).toEqual([
      { pid: 412, ppid: 1, cpuPercent: 12.5, memoryBytes: 20 * MB },
    ]);
    expect(snapshot.machine).toEqual({
      cores: 10,
      cpuPercent: null,
      memoryTotalBytes: 17179869184,
      memoryAvailableBytes: 3500 * 16384,
    });
    expect(snapshot.cpuTicks).toBeUndefined();
  });

  it('reads the Windows script output', () => {
    const snapshot = parseWindowsProcessSnapshot(
      JSON.stringify({
        processes: [
          // The System Idle Process, whose CPU time is the cores' idle time.
          { pid: 0, ppid: 0, cpuTimeMs: 9_000_000, memoryBytes: 8 },
          { pid: 8, ppid: 4, cpuTimeMs: 1500, memoryBytes: 1024, startedAt: 7 },
          { pid: 'x' },
        ],
        readerPid: 77,
        sampledAt: 1_700_000_000_000,
        cores: 12,
        memoryTotalBytes: 64,
        memoryAvailableBytes: 32,
      })
    );

    expect(snapshot.processes).toEqual([
      { pid: 8, ppid: 4, cpuTimeMs: 1500, memoryBytes: 1024, startedAt: 7 },
    ]);
    expect(snapshot.machine).toEqual({
      cores: 12,
      cpuPercent: null,
      memoryTotalBytes: 64,
      memoryAvailableBytes: 32,
    });
    expect(snapshot.readerPid).toBe(77);
    expect(snapshot.sampledAt).toBe(1_700_000_000_000);
  });

  it.runIf(process.platform !== 'win32').each([
    ['this computer', LOCAL_PROCESS_SNAPSHOT_COMMAND],
    ['an SSH host', HOST_PROCESS_SNAPSHOT_COMMAND],
  ])('reads %s, whatever the locale', (_, command) => {
    // Away from any tmux server Komla runs here.
    const tmuxDirectory = mkdtempSync(join(tmpdir(), 'resource-usage-tmux-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LANG: 'de_DE.UTF-8',
      TMUX_TMPDIR: tmuxDirectory,
    };
    delete env.LC_ALL;
    let output: string;
    try {
      output = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', env });
    } finally {
      rmSync(tmuxDirectory, { recursive: true, force: true });
    }
    const snapshot = parseProcessSnapshot(output);

    const self = snapshot.processes.find((sample) => sample.pid === process.pid);
    expect(self?.memoryBytes).toBeGreaterThan(MB);
    expect(snapshot.processes.map(({ pid }) => pid)).toContain(snapshot.readerPid);
    expect(snapshot.machine.cores).toBeGreaterThan(0);
    expect(snapshot.machine.memoryTotalBytes).toBeGreaterThan(
      snapshot.machine.memoryAvailableBytes!
    );
    if (process.platform === 'linux') {
      expect(snapshot.cpuTicks!.total).toBeGreaterThan(snapshot.cpuTicks!.busy);
      expect(snapshot.sampledAt).toBeGreaterThan(0);
    }
  });
});

describe('resource usage', () => {
  const cpu = (own: number | null, withChildren = own): ProcessCpu => ({ own, withChildren });

  it('works out CPU from the time used since the previous read', () => {
    const before = cpuTimesOf(
      [
        { pid: 1, ppid: 0, cpuTimeMs: 1000, memoryBytes: 0 },
        { pid: 2, ppid: 1, cpuTimeMs: 500, memoryBytes: 0 },
      ],
      { at: 10_000, readAt: 50_000 },
      undefined
    );
    const after = [
      { pid: 1, ppid: 0, cpuTimeMs: 2000, memoryBytes: 0 },
      // Started since the previous read.
      { pid: 3, ppid: 1, cpuTimeMs: 250, memoryBytes: 0 },
      { pid: 4, ppid: 1, cpuPercent: 7, memoryBytes: 0 },
    ];
    // Timed by the machine's clock, not by when Komla got the answer.
    const now = { at: 12_000, readAt: 53_000 };

    expect(cpuPercents(after, undefined, now, 4)).toEqual(
      new Map([
        [1, cpu(null)],
        [3, cpu(null)],
        [4, cpu(7)],
      ])
    );
    expect(cpuPercents(after, before, now, 4)).toEqual(
      new Map([
        [1, cpu(50)],
        [3, cpu(12.5)],
        [4, cpu(7)],
      ])
    );
    // A read from before the popover was last closed is too old to compare with.
    expect(cpuPercents(after, before, { at: 3_600_000, readAt: 3_650_000 }, 4).get(1)).toEqual(
      cpu(null)
    );
  });

  it('counts children that exited since in the process that collected them, once', () => {
    // A shell running make, which runs a compiler.
    const before = cpuTimesOf(
      [
        { pid: 10, ppid: 1, cpuTimeMs: 1000, childCpuTimeMs: 0, memoryBytes: 0 },
        { pid: 11, ppid: 10, cpuTimeMs: 100, childCpuTimeMs: 0, memoryBytes: 0 },
        { pid: 12, ppid: 11, cpuTimeMs: 500, childCpuTimeMs: 0, memoryBytes: 0 },
      ],
      { at: 10_000, readAt: 50_000 },
      undefined
    );
    // Both have exited: make collected the compiler at 1500 ms, and the shell collected make.
    const after = [{ pid: 10, ppid: 1, cpuTimeMs: 1010, childCpuTimeMs: 1650, memoryBytes: 0 }];

    // 10 ms of the shell's own, 50 of make's and 1000 of the compiler's in 2 s.
    expect(cpuPercents(after, before, { at: 12_000, readAt: 52_000 }, 4).get(10)).toEqual(
      cpu(0.5, 53)
    );
    // No more than every core for the whole time.
    expect(cpuPercents(after, before, { at: 12_000, readAt: 52_000 }, 0.25).get(10)).toEqual(
      cpu(0.5, 25)
    );
  });

  it("works out the machine's CPU from its own counters", () => {
    const before = cpuTimesOf([], { at: 10_000, readAt: 50_000 }, { busy: 1000, total: 4000 });

    expect(
      machineCpuPercent(before, { at: 12_000, readAt: 52_000 }, { busy: 2000, total: 6000 }, 4)
    ).toBe(200);
    expect(machineCpuPercent(undefined, { at: 12_000, readAt: 52_000 }, undefined, 4)).toBeNull();
    expect(
      machineCpuPercent(before, { at: 90_000, readAt: 130_000 }, { busy: 2000, total: 6000 }, 4)
    ).toBeNull();
  });

  it("adds up each terminal's process tree by workspace, Komla's own, and the rest apart", () => {
    const sample = (pid: number, ppid: number, memoryMb: number) => ({
      pid,
      ppid,
      memoryBytes: memoryMb * MB,
    });
    const snapshot = {
      panes: new Map([
        ['komla-agent', [10]],
        ['komla-tests', [20]],
        ['komla-elsewhere', [30]],
      ]),
      processes: [
        sample(1, 0, 5),
        sample(10, 9, 10),
        sample(11, 10, 300),
        sample(20, 9, 10),
        sample(21, 20, 900),
        sample(22, 21, 100),
        sample(30, 9, 50),
        // Komla's tmux server, a client attached to a session, and a companion.
        sample(9, 1, 8),
        sample(50, 1, 6),
        sample(60, 1, 3),
        sample(61, 60, 4),
        sample(99, 1, 2),
      ],
      machine: { cores: 2, cpuPercent: null, memoryTotalBytes: null, memoryAvailableBytes: null },
    };
    // Children a process collected count in terminals, where the process is its own parent.
    const processCpu = new Map(
      snapshot.processes.map(({ pid }) => [pid, pid === 21 ? cpu(140, 150) : cpu(1, 40)])
    );

    const usage = attributeProcesses(
      snapshot,
      [
        { workspaceId: 'api', terminalId: 'agent', rootPids: [10] },
        { workspaceId: 'web', terminalId: 'tests', rootPids: [20] },
      ],
      processCpu,
      {
        countOtherSessions: true,
        excludedPids: new Set([99]),
        komlaProcesses: new Map([
          [9, 'tmux-server'],
          [50, 'connections'],
          [60, 'companion'],
        ]),
        komlaTrees: new Map([[61, 'companion']]),
      }
    );

    expect(usage.komla).toEqual([
      { kind: 'tmux-server', cpuPercent: 1, memoryBytes: 8 * MB, processCount: 1 },
      { kind: 'connections', cpuPercent: 1, memoryBytes: 6 * MB, processCount: 1 },
      { kind: 'companion', cpuPercent: 2, memoryBytes: 7 * MB, processCount: 2 },
    ]);

    expect(usage.workspaces).toEqual([
      {
        workspaceId: 'web',
        cpuPercent: 230,
        memoryBytes: 1010 * MB,
        terminals: [{ terminalId: 'tests', cpuPercent: 230, memoryBytes: 1010 * MB }],
      },
      {
        workspaceId: 'api',
        cpuPercent: 80,
        memoryBytes: 310 * MB,
        terminals: [{ terminalId: 'agent', cpuPercent: 80, memoryBytes: 310 * MB }],
      },
    ]);
    expect(usage.otherSessions).toEqual({ cpuPercent: 40, memoryBytes: 50 * MB, count: 1 });
    // The init process; the one the caller reads otherwise is left out.
    expect(usage.otherProcesses).toEqual({ cpuPercent: 1, memoryBytes: 5 * MB });
  });

  it("counts what Komla's main process started outside terminals as its background", () => {
    const sample = (pid: number, ppid: number) => ({ pid, ppid, memoryBytes: MB });
    const usage = attributeProcesses(
      {
        panes: new Map(),
        processes: [
          sample(1, 0),
          sample(5, 1),
          sample(6, 5),
          sample(7, 5),
          sample(8, 7),
          sample(9, 5),
          // The shell reading these, and what it runs.
          sample(11, 5),
          sample(12, 11),
        ],
        readerPid: 11,
      },
      [{ workspaceId: 'web', terminalId: 'shell', rootPids: [7] }],
      new Map(),
      { excludedPids: new Set([5, 6]), komlaTrees: new Map([[5, 'background']]) }
    );

    expect(usage.komla).toEqual([
      { kind: 'background', cpuPercent: null, memoryBytes: MB, processCount: 1 },
    ]);
    expect(usage.workspaces[0]).toMatchObject({ workspaceId: 'web', memoryBytes: 2 * MB });
    expect(usage.otherProcesses).toEqual({ cpuPercent: null, memoryBytes: MB });
  });

  it("finds the processes between Komla's main process and Electron's", () => {
    const sample = (pid: number, ppid: number) => ({ pid, ppid, memoryBytes: 0 });
    const processes = [
      sample(1, 0),
      sample(5, 1),
      // Zygotes, and the window and GPU process they started.
      sample(6, 5),
      sample(7, 5),
      sample(8, 6),
      sample(9, 7),
      // A terminal's shell, and an Electron process outside the main process's tree.
      sample(10, 5),
      sample(20, 1),
      sample(21, 20),
    ];

    expect(electronLaunchers(processes, new Set([5, 8, 9, 21]), 5)).toEqual(new Set([6, 7]));
  });

  it('adds up parts of the same kind', () => {
    expect(
      mergeKomlaProcesses([
        { kind: 'main', cpuPercent: 1, memoryBytes: 5, processCount: 1 },
        { kind: 'helpers', cpuPercent: 2.25, memoryBytes: 10, processCount: 2 },
        { kind: 'helpers', cpuPercent: null, memoryBytes: 20, processCount: 2 },
        { kind: 'helpers', cpuPercent: 0.1, memoryBytes: 1, processCount: 1 },
      ])
    ).toEqual([
      { kind: 'main', cpuPercent: 1, memoryBytes: 5, processCount: 1 },
      { kind: 'helpers', cpuPercent: 2.4, memoryBytes: 31, processCount: 5 },
    ]);
  });
});
