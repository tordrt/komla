import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSshWorkspace, createTerminal, createWorkspace } from '../../factories';
import { createAttentionHarness } from '../../helpers/terminal-attention';

import type { AgentHook } from '../../../src/main/services/terminal-attention/terminal-attention';
import type { TerminalStatus } from '../../../src/shared/types';

vi.mock('electron', async () => (await import('../../mocks/electron')).mockElectron());

const prompted = (source: string): AgentHook => ({ kind: 'prompt-submit', source });
const working = (source: string, options: { copy?: boolean } = {}): AgentHook => ({
  kind: 'activity',
  source,
  ...options,
});
const done = (source: string): AgentHook => ({ kind: 'turn-complete', source });
const idle = (source: string): AgentHook => ({ kind: 'idle', source });
const needsInput = (source: string): AgentHook => ({ kind: 'input-required', source });

/** Local workspace ws-1 with Terminals t1, t2, … */
function localWorkspace(terminalCount = 2) {
  return createWorkspace({
    id: 'ws-1',
    terminals: Array.from({ length: terminalCount }, (_, index) =>
      createTerminal({ id: `t${index + 1}` })
    ),
  });
}

/** SSH workspace ws-42 on ssh-host-1 with Terminal t1; stopped while another installation is attached. */
function sshWorkspace(status: TerminalStatus = 'stopped') {
  return createSshWorkspace({ id: 'ws-42', terminals: [createTerminal({ id: 't1', status })] });
}

describe('Terminal Attention State: spinner and attention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the workspace spinner', () => {
    it('turns on for a prompt that names no Terminal', async () => {
      const { attention, workspace, terminal, toWorkspace } = createAttentionHarness([
        localWorkspace(),
      ]);

      await attention.hook(toWorkspace('ws-1'), prompted('claude-code'));

      expect(workspace('ws-1').agentActive).toBe(true);
      expect(!!terminal('t1').agentActive).toBe(false);
    });

    it('stays off for a prompt from a Terminal that is gone, whose done could not stop it', async () => {
      const { attention, workspace, toWorkspace } = createAttentionHarness([localWorkspace()]);

      await attention.hook(toWorkspace('ws-1', { hasInvalidTerminalId: true }), prompted('codex'));

      expect(!!workspace('ws-1').agentActive).toBe(false);
    });

    it('stops every prompt of a source when a done hook names no Terminal', async () => {
      const { attention, workspace, toWorkspace } = createAttentionHarness([localWorkspace()]);

      await attention.hook(toWorkspace('ws-1'), prompted('codex'));
      await attention.hook(toWorkspace('ws-1'), prompted('codex'));
      await attention.hook(toWorkspace('ws-1'), done('codex'));

      expect(workspace('ws-1').agentActive).toBe(false);
    });

    it('stays on while another source is still working', async () => {
      const { attention, workspace, toWorkspace } = createAttentionHarness([localWorkspace()]);

      await attention.hook(toWorkspace('ws-1'), prompted('claude-code'));
      // Codex never started here.
      await attention.hook(toWorkspace('ws-1'), done('codex'));
      expect(workspace('ws-1').agentActive).toBe(true);

      await attention.hook(toWorkspace('ws-1'), prompted('codex'));
      await attention.hook(toWorkspace('ws-1'), done('codex'));
      expect(workspace('ws-1').agentActive).toBe(true);

      await attention.hook(toWorkspace('ws-1'), done('claude-code'));
      expect(workspace('ws-1').agentActive).toBe(false);
    });

    it('turns on and off by hand', () => {
      const { attention, workspace } = createAttentionHarness([localWorkspace()]);

      attention.spinnerToggled('ws-1', true);
      expect(workspace('ws-1').agentActive).toBe(true);

      attention.spinnerToggled('ws-1', false);
      expect(workspace('ws-1').agentActive).toBe(false);
    });

    it('turned off by hand stops every source', async () => {
      const { attention, workspace, terminal, toTerminal, toWorkspace } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toWorkspace('ws-1'), prompted('claude-code'));
      await attention.hook(toWorkspace('ws-1'), prompted('codex'));
      await attention.hook(toTerminal('t1'), working('codex'));

      attention.spinnerToggled('ws-1', false);

      expect(workspace('ws-1').agentActive).toBe(false);
      expect(terminal('t1').agentActive).toBe(false);
    });

    it('ignores hooks and toggles for unknown workspaces', async () => {
      const { attention, store, toWorkspace } = createAttentionHarness([localWorkspace()]);

      await expect(attention.hook(toWorkspace('missing'), prompted('claude-code'))).resolves.toBe(
        'unmatched'
      );
      expect(() => {
        attention.spinnerToggled('missing', true);
        attention.spinnerToggled('missing', false);
      }).not.toThrow();
      expect(store.broadcast).not.toHaveBeenCalled();
    });

    it('broadcasts only when a spinner turns on or off', async () => {
      const { attention, store, toTerminal, toWorkspace } = createAttentionHarness([
        localWorkspace(),
      ]);

      await attention.hook(toTerminal('t1'), working('claude-code'));
      expect(store.broadcast).toHaveBeenCalledTimes(1);

      // Another hook for a working source, and a new source, leave it on.
      await attention.hook(toTerminal('t1'), working('claude-code'));
      await attention.hook(toTerminal('t1'), working('codex'));
      await attention.hook(toWorkspace('ws-1'), prompted('claude-code'));
      expect(store.broadcast).toHaveBeenCalledTimes(1);

      attention.aborted('t1');
      expect(store.broadcast).toHaveBeenCalledTimes(2);

      attention.aborted('t1');
      expect(store.broadcast).toHaveBeenCalledTimes(2);
    });
  });

  describe("a Terminal's spinner", () => {
    it('keeps the workspace spinner on while another Terminal is still working', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);

      await attention.hook(toTerminal('t1'), prompted('codex'));
      await attention.hook(toTerminal('t2'), prompted('codex'));

      expect(workspace('ws-1').agentActive).toBe(true);
      expect(terminal('t1').agentActive).toBe(true);
      expect(terminal('t2').agentActive).toBe(true);

      attention.ended('t1');

      expect(workspace('ws-1').agentActive).toBe(true);
      expect(terminal('t1').agentActive).toBe(false);
      expect(terminal('t2').agentActive).toBe(true);

      attention.ended('t2');

      expect(workspace('ws-1').agentActive).toBe(false);
      expect(terminal('t2').agentActive).toBe(false);
    });

    it('records when each Terminal started working, until it stops', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);

      vi.setSystemTime(1_000_000);
      await attention.hook(toTerminal('t1'), prompted('codex'));
      vi.setSystemTime(1_005_000);
      await attention.hook(toTerminal('t2'), prompted('codex'));
      // Activity mid-turn doesn't restart the clock.
      await attention.hook(toTerminal('t1'), working('codex'));

      expect(workspace('ws-1').agentActiveSince).toBe(1_000_000);
      expect(terminal('t1').agentActiveSince).toBe(1_000_000);
      expect(terminal('t2').agentActiveSince).toBe(1_005_000);

      attention.ended('t1');

      expect(terminal('t1').agentActiveSince).toBeUndefined();
      expect(workspace('ws-1').agentActiveSince).toBe(1_000_000);

      attention.ended('t2');

      expect(workspace('ws-1').agentActiveSince).toBeUndefined();
    });

    it('stops the spinner of a prompt that named no Terminal when any Terminal stops here', async () => {
      const { attention, workspace, terminal, toTerminal, toWorkspace } = createAttentionHarness([
        localWorkspace(),
      ]);

      await attention.hook(toWorkspace('ws-1'), prompted('claude-code'));
      await attention.hook(toTerminal('t2'), prompted('codex'));

      expect(workspace('ws-1').agentActive).toBe(true);
      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t2').agentActive).toBe(true);

      attention.aborted('t1');

      expect(workspace('ws-1').agentActive).toBe(true);
      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t2').agentActive).toBe(true);

      attention.aborted('t2');

      expect(workspace('ws-1').agentActive).toBe(false);
      expect(terminal('t2').agentActive).toBe(false);
    });

    it("stops the spinner turned on by hand when a Terminal's agent finishes", async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);

      attention.spinnerToggled('ws-1', true);
      await attention.hook(toTerminal('t2'), prompted('codex'));

      expect(workspace('ws-1').agentActive).toBe(true);
      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t2').agentActive).toBe(true);

      await attention.hook(toTerminal('t2'), done('codex'));

      expect(workspace('ws-1').agentActive).toBe(false);
      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t2').agentActive).toBe(false);
    });

    it.each<[string, AgentHook]>([
      ['a done', done('codex')],
      [
        'a failed turn',
        { kind: 'error', source: 'claude-code', hookInput: { hook_event_name: 'StopFailure' } },
      ],
      ['an interrupt', { kind: 'interrupted', source: 'codex' }],
    ])('stops the spinner turned on by hand for %s from any Terminal', async (_, hook) => {
      const { attention, workspace, toTerminal } = createAttentionHarness([localWorkspace()]);
      attention.spinnerToggled('ws-1', true);

      await attention.hook(toTerminal('t1'), hook);

      expect(workspace('ws-1').agentActive).toBe(false);
    });

    it('stops the spinner turned on by hand for a done hook that names no Terminal', async () => {
      const { attention, workspace, toWorkspace } = createAttentionHarness([localWorkspace()]);
      attention.spinnerToggled('ws-1', true);

      await attention.hook(toWorkspace('ws-1'), done('codex'));

      expect(workspace('ws-1').agentActive).toBe(false);
    });

    it("keeps the spinner turned on by hand for an idle reminder, or a command's end", async () => {
      const { attention, workspace, toTerminal } = createAttentionHarness([localWorkspace()]);
      attention.spinnerToggled('ws-1', true);

      // An idle reminder follows a turn that ended earlier.
      await attention.hook(toTerminal('t1'), idle('claude-code'));
      // A command run with `komla notify --` is no agent.
      await attention.hook(toTerminal('t2'), prompted('command'));
      await attention.hook(toTerminal('t2'), done('command'));
      await attention.hook(toTerminal('t2'), prompted('command'));
      await attention.hook(toTerminal('t2'), { kind: 'interrupted', source: 'command' });

      expect(workspace('ws-1').agentActive).toBe(true);
    });

    it('stops the spinner turned on by hand when the attached installation relays an interrupt', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        sshWorkspace(),
      ]);
      attention.spinnerToggled('ws-42', true);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));

      await attention.hook(toTerminal('t1'), {
        kind: 'interrupted',
        source: 'claude-code',
        copy: true,
      });

      expect(workspace('ws-42').agentActive).toBe(false);
      expect(terminal('t1').agentActive).toBe(false);
    });

    it('keeps the spinner turned on by hand for a done hook from a Terminal that is gone', async () => {
      const { attention, workspace, toWorkspace } = createAttentionHarness([localWorkspace()]);
      attention.spinnerToggled('ws-1', true);

      await attention.hook(toWorkspace('ws-1', { hasInvalidTerminalId: true }), done('codex'));

      expect(workspace('ws-1').agentActive).toBe(true);
    });

    it('stops only the spinner of the Terminal aborted here', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), prompted('codex'));
      await attention.hook(toTerminal('t2'), prompted('codex'));

      attention.aborted('t1');

      expect(workspace('ws-1').agentActive).toBe(true);
      expect(terminal('t1').agentActive).toBe(false);
      expect(terminal('t2').agentActive).toBe(true);
    });

    it('stays on for a done hook that names no Terminal, or one that is gone', async () => {
      const { attention, workspace, terminal, toTerminal, toWorkspace } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), prompted('codex'));

      await attention.hook(toWorkspace('ws-1'), done('codex'));
      await attention.hook(toWorkspace('ws-1', { hasInvalidTerminalId: true }), done('codex'));

      expect(workspace('ws-1').agentActive).toBe(true);
      expect(terminal('t1').agentActive).toBe(true);
    });

    it('saves one count per source however many hooks keep it on', async () => {
      const { attention, toTerminal } = createAttentionHarness([sshWorkspace('running')]);

      await attention.hook(toTerminal('t1'), prompted('claude-code'));
      // Midstream hooks within the turn.
      await attention.hook(toTerminal('t1'), working('claude-code'));
      await attention.hook(toTerminal('t1'), needsInput('claude-code'));

      expect(attention.persistedSources('ws-42', 't1')).toEqual({ 'claude-code': 1 });
    });

    it('takes an alert for an Antigravity prompt only in the Terminal Antigravity is working in', async () => {
      const { attention, terminal, toTerminal } = createAttentionHarness([localWorkspace()]);
      await attention.hook(toTerminal('t1'), working('antigravity'));

      attention.alertRaised({ terminalId: 't2', message: 'Allow running npm test?' });
      expect(terminal('t2').attention).toBeUndefined();

      attention.alertRaised({ terminalId: 't1', message: 'Allow running npm test?' });
      expect(terminal('t1').attention).toMatchObject({
        kind: 'input-required',
        source: 'antigravity',
        terminalId: 't1',
      });

      await attention.hook(toTerminal('t1'), done('antigravity'));
      attention.alertRaised({ terminalId: 't1', message: 'Allow running npm test?' });
      expect(terminal('t1').attention?.kind).toBe('turn-complete');
    });
  });

  describe('stopping an agent here tells the other installations showing it', () => {
    it.each(['aborted', 'ended', 'replaced', 'removed'] as const)(
      'relays the interrupt when the Terminal is %s here',
      async (event) => {
        const { attention, relay, workspace, toTerminal } = createAttentionHarness([
          sshWorkspace('running'),
        ]);
        await attention.hook(toTerminal('t1'), working('claude-code'));

        if (event === 'removed') attention.removed('ws-42', 't1');
        else attention[event]('t1');

        expect(workspace('ws-42').agentActive).toBe(false);
        expect(relay.interrupted).toHaveBeenCalledWith(workspace('ws-42'), 't1', ['claude-code']);
      }
    );

    it('relays an interrupt only while the spinner is on', async () => {
      const { attention, relay, workspace, toTerminal } = createAttentionHarness([
        sshWorkspace('running'),
      ]);
      await attention.hook(toTerminal('t1'), working('claude-code'));

      attention.aborted('t1');
      attention.aborted('t1');

      expect(workspace('ws-42').agentActive).toBe(false);
      // Esc also closes menus, so it's relayed only while the spinner is on.
      expect(relay.interrupted).toHaveBeenCalledTimes(1);
      expect(relay.interrupted).toHaveBeenCalledWith(workspace('ws-42'), 't1', ['claude-code']);
    });

    it('relays the sources of each Terminal when the workspace stops here', async () => {
      const { attention, relay, workspace, toTerminal } = createAttentionHarness([
        sshWorkspace('running'),
      ]);
      await attention.hook(toTerminal('t1'), working('codex'));

      attention.workspaceStopped('ws-42');

      expect(workspace('ws-42').agentActive).toBe(false);
      expect(relay.interrupted).toHaveBeenCalledWith(workspace('ws-42'), 't1', ['codex']);
    });
  });

  describe('a spinner only copied hooks keep on', () => {
    it('stops after 30 minutes without a copy', async () => {
      const { attention, relay, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(workspace('ws-42').agentActive).toBe(true);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(workspace('ws-42').agentActive).toBe(false);
      expect(relay.interrupted).not.toHaveBeenCalled();
    });

    it("stays on while this installation's own hooks keep it on", async () => {
      const { attention, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));
      await attention.hook(toTerminal('t1'), working('claude-code'));

      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(workspace('ws-42').agentActive).toBe(true);
    });

    it('is saved only while its own hooks keep it on', async () => {
      const { attention, toTerminal } = createAttentionHarness([sshWorkspace()]);

      // Copies stop while this installation is away, so a saved one could be stale on restart.
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));
      expect(attention.persistedSources('ws-42', 't1')).toBeUndefined();

      await attention.hook(toTerminal('t1'), working('claude-code'));
      expect(attention.persistedSources('ws-42', 't1')).toEqual({ 'claude-code': 1 });
    });

    it("turned off by hand doesn't interrupt the agent another installation runs", async () => {
      const { attention, relay, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));

      attention.spinnerToggled('ws-42', false);

      expect(workspace('ws-42').agentActive).toBe(false);
      expect(relay.interrupted).not.toHaveBeenCalled();
    });

    it('is forgotten when its host reconnects or the computer wakes', async () => {
      const { attention, relay, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));

      attention.hostConnected('another-host');
      expect(workspace('ws-42').agentActive).toBe(true);
      attention.hostConnected('ssh-host-1');
      expect(workspace('ws-42').agentActive).toBe(false);

      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));
      attention.machineResumed();
      expect(workspace('ws-42').agentActive).toBe(false);

      await attention.hook(toTerminal('t1'), working('claude-code'));
      attention.machineResumed();
      expect(workspace('ws-42').agentActive).toBe(true);
      expect(relay.interrupted).not.toHaveBeenCalled();
    });

    it('loses its 30-minute timeout once it stops some other way', async () => {
      const { attention, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), working('codex', { copy: true }));
      attention.sessionGone('t1');
      expect(workspace('ws-42').agentActive).toBe(false);

      // Codex's working title turns the spinner back on without a hook.
      attention.titleChanged('t1', '⠋ Working');
      expect(workspace('ws-42').agentActive).toBe(true);
      await vi.advanceTimersByTimeAsync(31 * 60_000);

      expect(workspace('ws-42').agentActive).toBe(true);
    });

    it('tells the session check whether a copy arrived since its mark', async () => {
      const { attention, toTerminal } = createAttentionHarness([sshWorkspace()]);

      const mark = attention.hookMark('t1');
      expect(attention.hookArrivedSince('t1', mark)).toBe(false);

      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));
      expect(attention.hookArrivedSince('t1', mark)).toBe(true);
      expect(attention.hookArrivedSince('t1', attention.hookMark('t1'))).toBe(false);
    });
  });

  describe('a Terminal whose session is gone from its host', () => {
    it('stops its spinner without telling anyone', async () => {
      const { attention, relay, workspace, terminal, toTerminal } = createAttentionHarness([
        sshWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));

      attention.sessionGone('t1');

      expect(workspace('ws-42').agentActive).toBe(false);
      expect(terminal('t1').agentActive).toBe(false);
      expect(relay.interrupted).not.toHaveBeenCalled();
    });
  });

  describe('saved spinners', () => {
    it('are restored without a broadcast', () => {
      const restoredWorkspace = sshWorkspace();
      const { attention, store, workspace, terminal } = createAttentionHarness([restoredWorkspace]);

      attention.restored(restoredWorkspace, new Map([['t1', new Map([['codex', 1]])]]));

      expect(workspace('ws-42').agentActive).toBe(true);
      expect(terminal('t1').agentActive).toBe(true);
      expect(store.broadcast).not.toHaveBeenCalled();
      expect(attention.persistedSources('ws-42', 't1')).toEqual({ codex: 1 });

      attention.sessionGone('t1');
      expect(workspace('ws-42').agentActive).toBe(false);
    });
  });

  describe('attention', () => {
    it("shows a hook's attention on the workspace", async () => {
      vi.setSystemTime(2000);
      const { attention, windows, workspace, toWorkspace } = createAttentionHarness([
        localWorkspace(),
      ]);

      await attention.hook(toWorkspace('ws-1'), {
        kind: 'input-required',
        source: 'claude-code',
        message: 'Needs approval',
      });

      expect(workspace('ws-1').attention).toEqual({
        kind: 'input-required',
        source: 'claude-code',
        updatedAt: 2000,
        message: 'Needs approval',
      });
      expect(workspace('ws-1').needsAttention).toBe(true);
      expect(windows.badge).toHaveBeenLastCalledWith(1);
    });

    it("shows a Terminal's attention on it and its workspace until it clears", async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);

      await attention.hook(toTerminal('t1'), needsInput('codex'));

      const shown = terminal('t1').attention;
      expect(shown).toMatchObject({ kind: 'input-required', source: 'codex', terminalId: 't1' });
      expect(workspace('ws-1').attention).toEqual(shown);

      await attention.hook(toTerminal('t1'), prompted('codex'));

      expect(workspace('ws-1').attention).toBeUndefined();
      expect(terminal('t1').attention).toBeUndefined();
    });

    it("keeps showing another Terminal's prompt when one Terminal's attention clears", async () => {
      const { attention, windows, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toTerminal('t2'), needsInput('claude-code'));
      await attention.hook(toTerminal('t1'), needsInput('codex'));
      const second = terminal('t2').attention;
      expect(workspace('ws-1').attention?.terminalId).toBe('t1');

      attention.dismissed('t1');

      expect(workspace('ws-1').needsAttention).toBe(true);
      expect(workspace('ws-1').attention).toEqual(second);
      expect(terminal('t1').attention).toBeUndefined();
      expect(terminal('t2').attention).toEqual(second);
      expect(windows.badge).not.toHaveBeenCalledWith(0);
    });

    it("keeps counting the workspace on the badge when another Terminal's notification is left", async () => {
      const { attention, windows, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toTerminal('t2'), { kind: 'generic', source: 'claude-code' });
      await attention.hook(toTerminal('t1'), needsInput('codex'));

      attention.dismissed('t1');

      expect(workspace('ws-1').needsAttention).toBe(true);
      expect(workspace('ws-1').attention).toEqual(terminal('t2').attention);
      expect(terminal('t2').attention?.kind).toBe('generic');
      expect(windows.badge).toHaveBeenLastCalledWith(1);
    });

    it("keeps a done while another Terminal's agent works, and shows no idle reminder after the user dismisses it", async () => {
      const stop: AgentHook = {
        kind: 'turn-complete',
        source: 'claude-code',
        hookInput: { hook_event_name: 'Stop' },
      };
      const idleReminder: AgentHook = {
        kind: 'idle',
        source: 'claude-code',
        hookInput: { hook_event_name: 'Notification' },
      };
      const { attention, settle, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);

      await attention.hook(toTerminal('t2'), working('codex'));
      await settle(toTerminal('t1'), stop);
      const done = terminal('t1').attention;
      expect(done?.kind).toBe('turn-complete');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(terminal('t1').attention).toBe(done);
      await settle(toTerminal('t1'), idleReminder);
      expect(terminal('t1').attention).toBe(done);

      attention.aborted('t2');
      await settle(toTerminal('t1'), stop);
      expect(terminal('t1').attention?.kind).toBe('turn-complete');
      attention.dismissed('t1');
      expect(terminal('t1').attention).toBeUndefined();
      await settle(toTerminal('t1'), idleReminder);
      expect(terminal('t1').attention).toBeUndefined();
    });

    it('clears from the card and the Terminal when the user opens it on the phone remote', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), needsInput('codex'));

      attention.viewedRemotely('ws-1', 't1');

      expect(terminal('t1').attention).toBeUndefined();
      expect(workspace('ws-1').attention).toBeUndefined();
      expect(workspace('ws-1').needsAttention).toBe(false);
    });

    it("keeps another Terminal's done when the user opens one Terminal on the phone remote", async () => {
      const { attention, windows, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), done('codex'));
      await attention.hook(toTerminal('t2'), done('claude-code'));

      attention.viewedRemotely('ws-1', 't2');

      expect(terminal('t2').attention).toBeUndefined();
      expect(workspace('ws-1').attention).toEqual(terminal('t1').attention);
      expect(windows.badge).toHaveBeenLastCalledWith(1);
    });

    it('goes, with its spinner, when something new replaces the Terminal', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(1),
      ]);
      await attention.hook(toTerminal('t1'), prompted('codex'));
      await attention.hook(toTerminal('t1'), needsInput('codex'));

      attention.replaced('t1');

      expect(terminal('t1').agentActive).toBe(false);
      expect(workspace('ws-1').agentActive).toBe(false);
      expect(terminal('t1').attention).toBeUndefined();
      expect(workspace('ws-1').attention).toBeUndefined();
      expect(workspace('ws-1').needsAttention).toBe(false);
    });

    it('goes, with its spinner and badge count, when the Terminal is removed', async () => {
      const { attention, windows, workspace, toTerminal } = createAttentionHarness([
        localWorkspace(1),
      ]);
      await attention.hook(toTerminal('t1'), prompted('codex'));
      await attention.hook(toTerminal('t1'), needsInput('codex'));
      expect(windows.badge).toHaveBeenLastCalledWith(1);

      attention.removed('ws-1', 't1');

      expect(workspace('ws-1').agentActive).toBe(false);
      expect(workspace('ws-1').attention).toBeUndefined();
      expect(workspace('ws-1').needsAttention).toBe(false);
      expect(windows.badge).toHaveBeenLastCalledWith(0);
    });

    it("stops the workspace's own spinner although session recovery already took the Terminal out", async () => {
      const { attention, workspace, toWorkspace } = createAttentionHarness([localWorkspace(1)]);
      await attention.hook(toWorkspace('ws-1'), prompted('codex'));
      expect(workspace('ws-1').agentActive).toBe(true);
      workspace('ws-1').terminals = [];

      attention.removed('ws-1', 't1');

      expect(workspace('ws-1').agentActive).toBe(false);
    });

    it('leaves the workspace and the badge although session recovery already took the Terminal out', async () => {
      const { attention, windows, workspace, toTerminal } = createAttentionHarness([
        localWorkspace(1),
      ]);
      await attention.hook(toTerminal('t1'), needsInput('codex'));
      workspace('ws-1').terminals = [];

      attention.removed('ws-1', 't1');

      expect(workspace('ws-1').attention).toBeUndefined();
      expect(workspace('ws-1').needsAttention).toBe(false);
      expect(windows.badge).toHaveBeenLastCalledWith(0);
    });
  });

  describe('the user seeing a workspace', () => {
    it('clears its attention and badge count', async () => {
      const { attention, windows, workspace, toWorkspace } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toWorkspace('ws-1'), done('codex'));
      expect(workspace('ws-1').needsAttention).toBe(true);

      attention.workspaceSeen('ws-1');

      expect(workspace('ws-1').needsAttention).toBe(false);
      expect(workspace('ws-1').attention).toBeUndefined();
      expect(windows.badge).toHaveBeenLastCalledWith(0);
    });

    it("keeps each Terminal's attention, and shows it again", async () => {
      const { attention, windows, workspace, terminal, toTerminal, toWorkspace } =
        createAttentionHarness([localWorkspace()]);
      await attention.hook(toTerminal('t1'), done('codex'));
      const shown = terminal('t1').attention;
      await attention.hook(toWorkspace('ws-1'), needsInput('codex'));
      expect(workspace('ws-1').attention?.terminalId).toBeUndefined();

      attention.workspaceSeen('ws-1');

      expect(workspace('ws-1').attention).toEqual(shown);
      expect(workspace('ws-1').needsAttention).toBe(true);
      expect(terminal('t1').attention).toEqual(shown);
      expect(windows.badge).toHaveBeenLastCalledWith(1);
    });

    it('broadcasts the workspace when it showed attention', async () => {
      const { attention, store, toWorkspace } = createAttentionHarness([localWorkspace()]);
      await attention.hook(toWorkspace('ws-1'), done('codex'));
      store.broadcast.mockClear();

      attention.workspaceSeen('ws-1');

      expect(store.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ws-1', needsAttention: false, attention: undefined })
      );
    });

    it('does not broadcast when there was no attention to clear', () => {
      const { attention, store } = createAttentionHarness([localWorkspace()]);

      attention.workspaceSeen('ws-1');

      expect(store.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('the user seeing a Terminal without focusing it', () => {
    it('takes its done off the workspace and the badge, and keeps it on the Terminal', async () => {
      const { attention, windows, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), done('codex'));

      attention.terminalSeen('t1');

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', seen: true });
      expect(workspace('ws-1').attention).toBeUndefined();
      expect(workspace('ws-1').needsAttention).toBe(false);
      expect(windows.badge).toHaveBeenLastCalledWith(0);
    });

    it("shows another Terminal's done the user hasn't seen", async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), done('codex'));
      await attention.hook(toTerminal('t2'), done('claude-code'));

      attention.terminalSeen('t2');

      expect(workspace('ws-1').attention).toEqual(terminal('t1').attention);
      expect(workspace('ws-1').needsAttention).toBe(true);
    });

    it("shows the latest of the other Terminals' dones, as the card does", async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(3),
      ]);
      await attention.hook(toTerminal('t1'), done('codex'));
      await vi.advanceTimersByTimeAsync(1000);
      await attention.hook(toTerminal('t2'), done('codex'));
      await vi.advanceTimersByTimeAsync(1000);
      await attention.hook(toTerminal('t3'), done('codex'));

      attention.terminalSeen('t3');

      expect(workspace('ws-1').attention).toEqual(terminal('t2').attention);
    });

    it('keeps a prompt or an error until the user focuses its Terminal', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), {
        kind: 'error',
        source: 'claude-code',
        message: 'API error',
      });
      await attention.hook(toTerminal('t2'), needsInput('codex'));
      const prompt = terminal('t2').attention;

      attention.terminalSeen('t1');
      attention.terminalSeen('t2');

      expect(terminal('t1').attention).not.toHaveProperty('seen');
      expect(terminal('t2').attention).toBe(prompt);
      expect(workspace('ws-1').attention).toBe(prompt);
    });

    it("shows the Terminal's next done", async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        localWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), done('codex'));
      attention.terminalSeen('t1');

      await attention.hook(toTerminal('t1'), prompted('codex'));
      await attention.hook(toTerminal('t1'), done('codex'));

      expect(terminal('t1').attention).not.toHaveProperty('seen');
      expect(workspace('ws-1').attention).toEqual(terminal('t1').attention);
    });

    it('clears a seen done when the user focuses its Terminal', async () => {
      const { attention, terminal, toTerminal } = createAttentionHarness([localWorkspace()]);
      await attention.hook(toTerminal('t1'), done('codex'));
      attention.terminalSeen('t1');

      attention.dismissed('t1');

      expect(terminal('t1').attention).toBeUndefined();
    });

    it('broadcasts only when it marks something seen', async () => {
      const { attention, store, toTerminal } = createAttentionHarness([localWorkspace()]);
      await attention.hook(toTerminal('t1'), done('codex'));
      store.broadcast.mockClear();

      attention.terminalSeen('t1');
      attention.terminalSeen('t1');
      attention.terminalSeen('t2');

      expect(store.broadcast).toHaveBeenCalledTimes(1);
    });
  });
});
