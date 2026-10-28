import { describe, expect, it } from 'vitest';

import {
  agentsWorkingHere,
  commandsWorkingHere,
  canStop,
  classifyTerminalExecution,
  decodeManagedExecution,
  diesOnAppRestart,
  encodeTerminalExecution,
  endsIfGoneFromHost,
  foundOnHost,
  isHiddenByHideStopped,
  isMonitored,
  isResumable,
  isRunningHere,
  isRunningOnSshHost,
  needsHostCheck,
  paneOffer,
  persistedRemoteSessionActive,
  probesOnSelect,
  reconnectableTerminals,
  sessionEndedHere,
  showsRunning,
  showsWorking,
  takesFreeSshSlot,
  type PaneOffer,
  type TerminalExecutionState,
} from '../../../src/shared/lib/terminal-execution-state';

import type { Terminal } from '../../../src/shared/types/terminal';
import type { Workspace } from '../../../src/shared/types/workspace';

type Fields = Pick<
  Terminal,
  | 'status'
  | 'executionLocation'
  | 'remoteSessionActive'
  | 'remoteSessionResumable'
  | 'remoteSessionOnHost'
  | 'agentActive'
  | 'commandActive'
>;

const SSH_BACKEND: Workspace['backend'] = {
  kind: 'ssh',
  hostId: 'host-1',
  remoteDirectory: '/home/dev/work',
  remoteRepoPath: '/home/dev/repo.git',
  remoteProjectRoot: '/home/dev',
  gitUrl: 'git@example.com:repo.git',
};

function workspace(
  kind: 'local' | 'ssh',
  terminals: Array<Partial<Fields>>,
  extra: { agentActive?: boolean; provisioning?: boolean; showsPaneSurfaces?: boolean } = {}
) {
  return {
    backend: kind === 'ssh' ? SSH_BACKEND : undefined,
    terminals: terminals.map((fields) => ({ status: 'stopped' as const, ...fields })),
    ...extra,
  };
}

function offerName(offer: PaneOffer): string {
  if (offer.connecting) return offer.managedSession ? 'connecting+tmux' : 'connecting';
  if (offer.stopped === 'reconnect') return 'reconnect';
  if (offer.stopped === 'restart') return offer.managedSession ? 'restart+tmux' : 'restart';
  return offer.managedSession ? 'attached+tmux' : 'none';
}

interface Row {
  kind: 'local' | 'ssh';
  terminal: Partial<Fields>;
  state: TerminalExecutionState;
  runningHere: boolean;
  showsRunning: boolean;
  stops: boolean;
  /** With agentActive set. */
  showsWorking: boolean;
  hidden: boolean;
  monitored: boolean;
  reconnects: boolean;
  probes: boolean;
  offer: string;
  dies: boolean;
  resumable: boolean;
  endedHere: boolean;
  hostCheck: boolean;
  /** A sync that finds its session gone from the host records it ended. */
  endsIfGone: boolean;
  onHost: boolean;
}

const T = true;
const F = false;

// One reachable situation per row, in a workspace with only that Terminal.
const ROWS: Record<string, Row> = {
  'local workspace, running': {
    kind: 'local',
    terminal: { status: 'running' },
    state: 'unmanaged-running',
    runningHere: T,
    showsRunning: T,
    stops: T,
    showsWorking: T,
    hidden: F,
    monitored: F,
    reconnects: F,
    probes: F,
    offer: 'none',
    dies: T,
    resumable: F,
    endedHere: F,
    hostCheck: F,
    endsIfGone: F,
    onHost: F,
  },
  'local workspace, stopped': {
    kind: 'local',
    terminal: { status: 'stopped', remoteSessionActive: false },
    state: 'unmanaged-stopped',
    runningHere: F,
    showsRunning: F,
    stops: F,
    showsWorking: F,
    hidden: T,
    monitored: F,
    reconnects: F,
    probes: F,
    offer: 'none',
    dies: F,
    resumable: F,
    endedHere: F,
    hostCheck: F,
    endsIfGone: F,
    onHost: F,
  },
  'Local copy, running': {
    kind: 'ssh',
    terminal: { status: 'running', executionLocation: 'local-mirror' },
    state: 'unmanaged-running',
    runningHere: T,
    showsRunning: T,
    stops: T,
    showsWorking: T,
    hidden: F,
    monitored: F,
    reconnects: F,
    probes: F,
    offer: 'none',
    dies: T,
    resumable: F,
    endedHere: F,
    hostCheck: F,
    endsIfGone: F,
    onHost: F,
  },
  'Local copy, stopped': {
    kind: 'ssh',
    terminal: { status: 'stopped', executionLocation: 'local-mirror' },
    state: 'unmanaged-stopped',
    runningHere: F,
    showsRunning: F,
    stops: F,
    showsWorking: F,
    hidden: T,
    monitored: F,
    reconnects: F,
    probes: F,
    offer: 'none',
    dies: F,
    resumable: F,
    endedHere: F,
    hostCheck: F,
    endsIfGone: F,
    onHost: F,
  },
  // Kept on purpose: its tmux session survives a restart, but the tab isn't saved until tmux
  // support is known, so the restart loses it here.
  'starting, tmux support unknown': {
    kind: 'ssh',
    terminal: { status: 'starting' },
    state: 'starting',
    runningHere: T,
    showsRunning: T,
    stops: T,
    showsWorking: T,
    hidden: F,
    monitored: T,
    reconnects: F,
    probes: F,
    offer: 'connecting',
    dies: T,
    resumable: F,
    endedHere: F,
    hostCheck: F,
    endsIfGone: F,
    onHost: F,
  },
  'starting, in tmux': {
    kind: 'ssh',
    terminal: { status: 'starting', remoteSessionResumable: true },
    state: 'starting',
    runningHere: T,
    showsRunning: T,
    stops: T,
    showsWorking: T,
    hidden: F,
    monitored: T,
    reconnects: F,
    probes: F,
    offer: 'connecting+tmux',
    dies: F,
    resumable: T,
    endedHere: F,
    hostCheck: F,
    endsIfGone: F,
    onHost: F,
  },
  'attached, in tmux': {
    kind: 'ssh',
    terminal: { status: 'running', remoteSessionResumable: true },
    state: 'attached',
    runningHere: T,
    showsRunning: T,
    stops: T,
    showsWorking: T,
    hidden: F,
    monitored: T,
    reconnects: F,
    probes: F,
    offer: 'attached+tmux',
    dies: F,
    resumable: T,
    endedHere: F,
    hostCheck: F,
    endsIfGone: F,
    onHost: F,
  },
  'attached, host without tmux': {
    kind: 'ssh',
    terminal: { status: 'running', remoteSessionResumable: false },
    state: 'attached',
    runningHere: T,
    showsRunning: T,
    stops: T,
    showsWorking: T,
    hidden: F,
    monitored: T,
    reconnects: F,
    probes: F,
    offer: 'none',
    dies: T,
    resumable: F,
    endedHere: F,
    hostCheck: F,
    endsIfGone: F,
    onHost: F,
  },
  // Another device may have taken the session over, which the fields can't tell; a sync checks.
  detached: {
    kind: 'ssh',
    terminal: { remoteSessionActive: true, remoteSessionResumable: true },
    state: 'detached',
    runningHere: T,
    showsRunning: T,
    stops: T,
    showsWorking: T,
    hidden: F,
    monitored: T,
    reconnects: T,
    probes: T,
    offer: 'reconnect',
    dies: F,
    resumable: T,
    endedHere: F,
    hostCheck: T,
    endsIfGone: T,
    onHost: F,
  },
  'stopped here': {
    kind: 'ssh',
    terminal: { remoteSessionActive: false, remoteSessionResumable: true },
    state: 'ended-here',
    runningHere: F,
    showsRunning: F,
    stops: F,
    showsWorking: F,
    hidden: T,
    monitored: F,
    reconnects: F,
    probes: F,
    offer: 'restart+tmux',
    dies: F,
    resumable: T,
    endedHere: T,
    hostCheck: T,
    endsIfGone: F,
    onHost: F,
  },
  'ended, seen here': {
    kind: 'ssh',
    terminal: { remoteSessionActive: false, remoteSessionResumable: false },
    state: 'ended-here',
    runningHere: F,
    showsRunning: F,
    stops: F,
    showsWorking: F,
    hidden: T,
    monitored: F,
    reconnects: F,
    probes: F,
    offer: 'restart',
    dies: F,
    resumable: F,
    endedHere: T,
    hostCheck: T,
    endsIfGone: F,
    onHost: F,
  },
  'never checked here': {
    kind: 'ssh',
    terminal: { remoteSessionResumable: true },
    state: 'unchecked',
    runningHere: F,
    showsRunning: F,
    stops: F,
    showsWorking: F,
    hidden: F,
    monitored: F,
    reconnects: T,
    probes: T,
    offer: 'reconnect',
    dies: F,
    resumable: T,
    endedHere: F,
    hostCheck: T,
    endsIfGone: F,
    onHost: F,
  },
  'found on host': {
    kind: 'ssh',
    terminal: { remoteSessionResumable: true, remoteSessionOnHost: true },
    state: 'found-on-host',
    runningHere: F,
    showsRunning: T,
    stops: T,
    showsWorking: T,
    hidden: F,
    monitored: T,
    reconnects: T,
    probes: T,
    offer: 'reconnect',
    dies: F,
    resumable: T,
    endedHere: F,
    hostCheck: T,
    endsIfGone: T,
    onHost: T,
  },
  'restarted elsewhere': {
    kind: 'ssh',
    terminal: {
      remoteSessionActive: false,
      remoteSessionResumable: true,
      remoteSessionOnHost: true,
    },
    state: 'restarted-elsewhere',
    runningHere: F,
    showsRunning: T,
    stops: T,
    showsWorking: T,
    hidden: F,
    monitored: T,
    reconnects: T,
    probes: T,
    offer: 'reconnect',
    dies: F,
    resumable: T,
    endedHere: T,
    hostCheck: T,
    endsIfGone: T,
    onHost: T,
  },
  'restarted elsewhere after it ended here': {
    kind: 'ssh',
    terminal: {
      remoteSessionActive: false,
      remoteSessionResumable: false,
      remoteSessionOnHost: true,
    },
    state: 'restarted-elsewhere',
    runningHere: F,
    showsRunning: T,
    stops: T,
    showsWorking: T,
    hidden: F,
    monitored: T,
    reconnects: T,
    probes: T,
    offer: 'reconnect',
    dies: F,
    resumable: F,
    endedHere: T,
    hostCheck: T,
    endsIfGone: T,
    onHost: T,
  },
  // Kept on purpose: the sync may have read the host before the session started, so actions
  // don't trust it; only the sidebar shows it stopped.
  'missing from host': {
    kind: 'ssh',
    terminal: { remoteSessionResumable: true, remoteSessionOnHost: false },
    state: 'missing',
    runningHere: F,
    showsRunning: F,
    stops: F,
    showsWorking: F,
    hidden: T,
    monitored: F,
    reconnects: T,
    probes: T,
    offer: 'reconnect',
    dies: F,
    resumable: T,
    endedHere: F,
    hostCheck: T,
    endsIfGone: F,
    onHost: F,
  },
  'ended on a host without tmux': {
    kind: 'ssh',
    terminal: { remoteSessionResumable: false },
    state: 'unchecked',
    runningHere: F,
    showsRunning: F,
    stops: F,
    showsWorking: F,
    hidden: T,
    monitored: F,
    reconnects: F,
    probes: F,
    offer: 'restart',
    dies: F,
    resumable: F,
    endedHere: F,
    hostCheck: T,
    endsIfGone: F,
    onHost: F,
  },
};

describe('Terminal Execution State', () => {
  it.each(Object.keys(ROWS))('%s', (name) => {
    const row = ROWS[name];
    const ws = workspace(row.kind, [row.terminal], { agentActive: true });
    const [terminal] = ws.terminals;
    expect({
      state: classifyTerminalExecution(ws, terminal),
      runningHere: isRunningHere(ws),
      showsRunning: showsRunning(ws),
      stops: canStop(ws),
      showsWorking: showsWorking(ws),
      hidden: isHiddenByHideStopped(ws),
      monitored: isMonitored(ws),
      reconnects: reconnectableTerminals(ws).includes(terminal),
      probes: probesOnSelect(ws),
      offer: offerName(paneOffer(ws, terminal)),
      dies: diesOnAppRestart(ws, terminal),
      resumable: isResumable(ws, terminal),
      endedHere: sessionEndedHere(ws, terminal),
      hostCheck: needsHostCheck(ws, terminal),
      endsIfGone: endsIfGoneFromHost(ws, terminal),
      onHost: foundOnHost(ws, terminal),
    }).toEqual({ ...row, kind: undefined, terminal: undefined });
  });

  it('answers for a workspace from all of its Terminals', () => {
    const ws = workspace('ssh', [
      { remoteSessionActive: false, remoteSessionResumable: true },
      { remoteSessionResumable: true, remoteSessionOnHost: true },
    ]);
    expect(isRunningHere(ws)).toBe(false);
    expect(showsRunning(ws)).toBe(true);
    expect(reconnectableTerminals(ws)).toEqual([ws.terminals[1]]);
  });

  it('treats a workspace without Terminals, or none at all, as stopped', () => {
    expect(isRunningHere(workspace('ssh', []))).toBe(false);
    expect(isRunningHere(undefined)).toBe(false);
    expect(showsRunning(null)).toBe(false);
    expect(paneOffer(undefined, undefined)).toBe(
      paneOffer(workspace('local', [{}]), { status: 'running' })
    );
  });

  it('keeps a workspace running while a window shows its browser or note pane', () => {
    const ws = workspace('ssh', [], { showsPaneSurfaces: true });

    expect(isRunningHere(ws)).toBe(true);
    expect(showsRunning(ws)).toBe(true);
    expect(canStop(ws)).toBe(true);
    expect(isHiddenByHideStopped(ws)).toBe(false);
  });

  it('counts toward the free SSH limit only what runs on the host', () => {
    const attached = workspace('ssh', [{ status: 'running' }]);
    const detached = workspace('ssh', [{ remoteSessionActive: true }]);
    const localCopy = workspace('ssh', [{ status: 'running', executionLocation: 'local-mirror' }]);
    const paneOnly = workspace('ssh', [], { showsPaneSurfaces: true });
    const local = workspace('local', [{ status: 'running' }]);

    expect([attached, detached, localCopy, paneOnly, local].map(isRunningOnSshHost)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(takesFreeSshSlot(workspace('ssh', [], { provisioning: true }))).toBe(true);
    expect(takesFreeSshSlot(workspace('local', [], { provisioning: true }))).toBe(false);
    expect(takesFreeSshSlot(attached)).toBe(true);
    expect(takesFreeSshSlot(localCopy)).toBe(false);
  });

  it('never hides a workspace that is still being created', () => {
    expect(isHiddenByHideStopped(workspace('local', [], { provisioning: true }))).toBe(false);
    expect(isHiddenByHideStopped(workspace('local', []))).toBe(true);
  });

  it('shows the spinner only while the agent is active', () => {
    expect(showsWorking(workspace('local', [{ status: 'running' }]))).toBe(false);
  });

  it('returns the same offer object for the same answer, so selectors stay stable', () => {
    const ws = workspace('ssh', [{ remoteSessionResumable: true }]);
    expect(paneOffer(ws, ws.terminals[0])).toBe(
      paneOffer(ws, { status: 'stopped', remoteSessionResumable: true, remoteSessionOnHost: false })
    );
    expect(Object.isFrozen(paneOffer(ws, ws.terminals[0]))).toBe(true);
  });
});

describe('encodeTerminalExecution', () => {
  it.each([
    [
      'attached',
      { kind: 'unknown' },
      'supported',
      { status: 'running', remoteSessionActive: undefined, remoteSessionResumable: true },
    ],
    [
      'starting',
      { kind: 'unknown', lastObserved: 'present' },
      'unknown',
      { status: 'starting', remoteSessionActive: true, remoteSessionResumable: undefined },
    ],
    [
      'absent',
      { kind: 'present' },
      'supported',
      { status: 'stopped', remoteSessionActive: true, remoteSessionResumable: true },
    ],
    [
      'absent',
      { kind: 'absent' },
      'unsupported',
      { status: 'stopped', remoteSessionActive: false, remoteSessionResumable: false },
    ],
  ] as const)(
    'writes the registry state %s / %j / %s and forgets the last host check',
    (attachment, remoteSession, persistence, expected) => {
      expect(
        encodeTerminalExecution({ kind: 'managed', attachment, remoteSession, persistence })
      ).toEqual({ ...expected, remoteSessionOnHost: undefined });
    }
  );

  it('keeps the last host check when only the generation moved on', () => {
    expect(
      encodeTerminalExecution({
        kind: 'managed',
        attachment: 'absent',
        remoteSession: { kind: 'unknown' },
        persistence: 'supported',
        keepHostCheck: true,
      })
    ).not.toHaveProperty('remoteSessionOnHost');
  });

  it('reads back what the registry wrote', () => {
    const terminal = {
      status: 'stopped' as const,
      ...encodeTerminalExecution({
        kind: 'managed',
        attachment: 'absent',
        remoteSession: { kind: 'absent' },
        persistence: 'supported',
      }),
    };
    expect(decodeManagedExecution(terminal)).toEqual({
      attachment: 'absent',
      remoteSession: { kind: 'absent' },
      persistence: 'supported',
    });
  });

  it('restores a saved Terminal as resumable, keeping only a saved boolean', () => {
    expect(encodeTerminalExecution({ kind: 'restored', persistedActive: true })).toEqual({
      remoteSessionResumable: true,
      remoteSessionActive: true,
    });
    expect(encodeTerminalExecution({ kind: 'restored', persistedActive: 'yes' })).toEqual({
      remoteSessionResumable: true,
      remoteSessionActive: undefined,
    });
  });

  it('saves a session running at save time as present', () => {
    expect(persistedRemoteSessionActive({ status: 'running' })).toBe(true);
    expect(persistedRemoteSessionActive({ status: 'starting' })).toBe(true);
    expect(persistedRemoteSessionActive({ status: 'stopped', remoteSessionActive: false })).toBe(
      false
    );
  });

  it('records and forgets a host check, and drops tmux when moving to a Local copy', () => {
    expect(encodeTerminalExecution({ kind: 'host-checked', onHost: true })).toEqual({
      remoteSessionOnHost: true,
    });
    expect(encodeTerminalExecution({ kind: 'host-checked', onHost: undefined })).toEqual({
      remoteSessionOnHost: undefined,
    });
    expect(encodeTerminalExecution({ kind: 'moved-to-local-copy' })).toEqual({
      remoteSessionResumable: undefined,
    });
  });
});

describe('agentsWorkingHere', () => {
  const running = { status: 'running' as const };

  it('counts working terminals that run on this computer', () => {
    expect(
      agentsWorkingHere(
        workspace(
          'local',
          [
            { ...running, agentActive: true },
            { ...running, agentActive: true },
          ],
          {
            agentActive: true,
          }
        )
      )
    ).toBe(2);
    // An agent in tmux on the host works on while this computer sleeps; a Local copy's doesn't.
    expect(
      agentsWorkingHere(
        workspace(
          'ssh',
          [
            { ...running, agentActive: true },
            { ...running, agentActive: true, executionLocation: 'local-mirror' },
            { remoteSessionOnHost: true, agentActive: true },
          ],
          { agentActive: true }
        )
      )
    ).toBe(1);
  });

  it("counts a local workspace's own spinner, but not an SSH workspace's", () => {
    expect(agentsWorkingHere(workspace('local', [running], { agentActive: true }))).toBe(1);
    expect(agentsWorkingHere(workspace('ssh', [running], { agentActive: true }))).toBe(0);
    expect(agentsWorkingHere(workspace('local', [running]))).toBe(0);
    expect(agentsWorkingHere(workspace('local', [{}], { agentActive: true }))).toBe(0);
  });
});

describe('commandsWorkingHere', () => {
  const running = { status: 'running' as const };

  it('counts the working terminals that only run `komla notify --` commands', () => {
    const local = workspace(
      'local',
      [
        { ...running, agentActive: true, commandActive: true },
        { ...running, agentActive: true },
      ],
      { agentActive: true }
    );
    expect(agentsWorkingHere(local)).toBe(2);
    expect(commandsWorkingHere(local)).toBe(1);
    expect(
      commandsWorkingHere(
        workspace('ssh', [{ remoteSessionOnHost: true, agentActive: true, commandActive: true }], {
          agentActive: true,
        })
      )
    ).toBe(0);
  });
});
