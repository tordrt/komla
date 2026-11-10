import { describe, expect, it } from 'vitest';

import {
  exitWaiters,
  isCurrent,
  liveHolds,
  nextPtyPhase,
  reportedStatus,
  type LiveHolds,
  type PtyEvent,
  type PtyPhase,
} from '../../../src/main/lib/pty-phase';

const holds = (): LiveHolds => ({ sizeWait: null, command: null });

const phases = (): Record<PtyPhase['kind'], PtyPhase> => ({
  starting: { kind: 'starting', startupTimer: null, holds: holds() },
  running: { kind: 'running', holds: holds() },
  'shutting-down': { kind: 'shutting-down', reported: 'starting', exitWaiters: new Set() },
  exiting: { kind: 'exiting', exitWaiters: new Set() },
  exited: { kind: 'exited' },
});

const EVENTS: Record<string, PtyEvent> = {
  output: { kind: 'ready', signal: 'output' },
  'startup-timeout': { kind: 'ready', signal: 'startup-timeout' },
  'remote-ready': { kind: 'ready', signal: 'remote-ready' },
  shutdown: { kind: 'shutdown' },
  kill: { kind: 'kill' },
  exit: { kind: 'exit' },
  abandon: { kind: 'abandon' },
};

/** Where each event takes each phase, as `kind` or `shutting-down:<reported>`; null changes nothing. */
function table(startupMode: 'echo-command' | 'wait-for-marker') {
  const result: Record<string, Record<string, string | null>> = {};
  for (const [kind, phase] of Object.entries(phases())) {
    result[kind] = {};
    for (const [name, event] of Object.entries(EVENTS)) {
      const next = nextPtyPhase(phase, event, startupMode);
      result[kind][name] =
        next === null
          ? null
          : next.kind === 'shutting-down'
            ? `shutting-down:${next.reported}`
            : next.kind;
    }
  }
  return result;
}

describe('nextPtyPhase', () => {
  it('moves a local shell on at its first output or the startup fallback', () => {
    expect(table('echo-command')).toEqual({
      starting: {
        output: 'running',
        'startup-timeout': 'running',
        'remote-ready': null,
        shutdown: 'shutting-down:starting',
        kill: 'exiting',
        exit: 'exited',
        abandon: null,
      },
      running: {
        output: null,
        'startup-timeout': null,
        'remote-ready': null,
        shutdown: 'shutting-down:running',
        kill: 'exiting',
        exit: 'exited',
        abandon: null,
      },
      'shutting-down': {
        output: 'shutting-down:running',
        'startup-timeout': 'shutting-down:running',
        'remote-ready': null,
        shutdown: null,
        kill: 'exiting',
        exit: 'exited',
        abandon: null,
      },
      exiting: {
        output: null,
        'startup-timeout': null,
        'remote-ready': null,
        shutdown: null,
        kill: null,
        exit: 'exited',
        abandon: 'exited',
      },
      exited: {
        output: null,
        'startup-timeout': null,
        'remote-ready': null,
        shutdown: null,
        kill: null,
        exit: null,
        abandon: null,
      },
    });
  });

  it('moves a remote shell on only at the remote-ready marker', () => {
    const remote = table('wait-for-marker');
    for (const kind of ['starting', 'running', 'shutting-down', 'exiting', 'exited']) {
      expect(remote[kind].output).toBeNull();
      expect(remote[kind]['startup-timeout']).toBeNull();
    }
    expect(remote.starting['remote-ready']).toBe('running');
    expect(remote['shutting-down']['remote-ready']).toBe('shutting-down:running');
    expect(remote.running['remote-ready']).toBeNull();
  });

  it('keeps the holds into running, and the exit waiters into exiting', () => {
    const { starting, 'shutting-down': shuttingDown } = phases();

    expect(liveHolds(nextPtyPhase(starting, EVENTS.output, 'echo-command')!)).toBe(
      liveHolds(starting)
    );
    expect(exitWaiters(nextPtyPhase(shuttingDown, EVENTS.kill, 'echo-command')!)).toBe(
      exitWaiters(shuttingDown)
    );
    expect(exitWaiters(nextPtyPhase(shuttingDown, EVENTS.output, 'echo-command')!)).toBe(
      exitWaiters(shuttingDown)
    );
  });
});

describe('what a phase reports', () => {
  it('reports starting or running while live, as before while shutting down, else stopped', () => {
    const all = phases();
    expect(Object.values(all).map((phase) => [phase.kind, reportedStatus(phase)])).toEqual([
      ['starting', 'starting'],
      ['running', 'running'],
      ['shutting-down', 'starting'],
      ['exiting', 'stopped'],
      ['exited', 'stopped'],
    ]);
    expect(Object.values(all).map(isCurrent)).toEqual([true, true, true, false, false]);
    expect(Object.values(all).map((phase) => liveHolds(phase) !== null)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(Object.values(all).map((phase) => exitWaiters(phase) !== null)).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
  });
});
