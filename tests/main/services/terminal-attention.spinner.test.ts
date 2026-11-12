import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSshWorkspace, createTerminal, createWorkspace } from '../../factories';
import { createAttentionHarness } from '../../helpers/terminal-attention';

import type { HookJournalEntry } from '../../../src/main/services/terminal-attention/hook-journal';
import type {
  AgentHook,
  TerminalAttention,
} from '../../../src/main/services/terminal-attention/terminal-attention';
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

    it('is forgotten once its host is checked after it reconnects or the computer wakes', async () => {
      const { attention, relay, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));

      attention.hostConnected('another-host');
      attention.hostChecked('another-host');
      expect(workspace('ws-42').agentActive).toBe(true);
      // The check reads what this installation missed meanwhile.
      attention.hostConnected('ssh-host-1');
      expect(workspace('ws-42').agentActive).toBe(true);
      attention.hostChecked('ssh-host-1');
      expect(workspace('ws-42').agentActive).toBe(false);

      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));
      attention.machineResumed();
      attention.hostChecked('ssh-host-1');
      expect(workspace('ws-42').agentActive).toBe(false);

      await attention.hook(toTerminal('t1'), working('claude-code'));
      attention.machineResumed();
      attention.hostChecked('ssh-host-1');
      expect(workspace('ws-42').agentActive).toBe(true);
      expect(relay.interrupted).not.toHaveBeenCalled();
    });

    it('stops a minute after its host reconnects or the computer wakes, if no check reads it', async () => {
      const { attention, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));

      attention.machineResumed();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(workspace('ws-42').agentActive).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(workspace('ws-42').agentActive).toBe(false);
    });

    it('stays on once attached here, where its own hooks keep it right', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        sshWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));

      attention.hostConnected('ssh-host-1');
      terminal('t1').status = 'running';
      attention.hostChecked('ssh-host-1');

      expect(workspace('ws-42').agentActive).toBe(true);
    });

    it('is confirmed by a copy that arrives before its host is checked', async () => {
      const { attention, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));

      attention.hostConnected('ssh-host-1');
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));
      attention.hostChecked('ssh-host-1');

      expect(workspace('ws-42').agentActive).toBe(true);
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

    it("tells the session check of a copied done, and of this installation's own hooks", async () => {
      const { attention, toTerminal } = createAttentionHarness([sshWorkspace()]);

      // No copy keeps the spinner on, so the done changes no timeout.
      let mark = attention.hookMark('t1');
      await attention.hook(toTerminal('t1'), { ...done('claude-code'), copy: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attention.hookArrivedSince('t1', mark)).toBe(true);

      // Hooks waiting in its companion's mailbox come as it connects.
      mark = attention.hookMark('t1');
      await attention.hook(toTerminal('t1'), working('claude-code'));
      expect(attention.hookArrivedSince('t1', mark)).toBe(true);
      expect(attention.hookArrivedSince('t2', attention.hookMark('t2'))).toBe(false);
    });

    it("forgets the hooks of a deleted workspace's Terminals", async () => {
      const { attention, remove, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));
      expect(attention.hookArrivedSince('t1', attention.hookMark('t1'))).toBe(false);
      void attention.journalRead('t1', []);
      expect(attention.wantsJournal('t1')).toBe(false);

      remove('ws-42');
      attention.workspaceDeleted('ws-42');

      // As for a Terminal no hook ever came for.
      expect(attention.hookMark('t1')).toEqual(createAttentionHarness().attention.hookMark('t1'));
      expect(attention.wantsJournal('t1')).toBe(true);
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

  describe('a Terminal not attached here whose session the check read', () => {
    it('shows the spinner of a program at work, without announcing anything', () => {
      const { attention, relay, windows, turnActivity, workspace, terminal } =
        createAttentionHarness([sshWorkspace()]);

      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });

      expect(workspace('ws-42').agentActive).toBe(true);
      expect(terminal('t1').agentActive).toBe(true);
      expect(windows.attentionRaised).not.toHaveBeenCalled();
      expect(turnActivity).not.toHaveBeenCalled();
      expect(relay.interrupted).not.toHaveBeenCalled();
    });

    it("doesn't apply an unchanged report again: a server keeps Codex reporting working", async () => {
      const { attention, workspace } = createAttentionHarness([sshWorkspace()]);
      attention.sessionStatusRead('t1', { state: 'working', app: 'codex' });
      expect(workspace('ws-42').agentActive).toBe(true);

      // Its Stop ended the turn where it is attached, so no copy keeps the spinner on.
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(workspace('ws-42').agentActive).toBe(false);
      attention.sessionStatusRead('t1', { state: 'working', app: 'codex' });
      expect(workspace('ws-42').agentActive).toBe(false);

      // A new turn reports again.
      attention.sessionStatusRead('t1', { state: 'idle', app: 'codex' });
      attention.sessionStatusRead('t1', { state: 'working', app: 'codex' });
      expect(workspace('ws-42').agentActive).toBe(true);
    });

    it('applies the same report again once the host reconnects or the computer wakes', async () => {
      const { attention, workspace } = createAttentionHarness([sshWorkspace()]);
      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });
      await vi.advanceTimersByTimeAsync(20 * 60_000);

      // Read again, it keeps the spinner on, for another 30 minutes.
      attention.hostConnected('ssh-host-1');
      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });
      attention.hostChecked('ssh-host-1');
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(workspace('ws-42').agentActive).toBe(true);

      attention.machineResumed();
      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });
      attention.hostChecked('ssh-host-1');
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(workspace('ws-42').agentActive).toBe(true);
    });

    it('only notes a report read while a hook arrived, which is newer', () => {
      const { attention, workspace } = createAttentionHarness([sshWorkspace()]);

      attention.sessionStatusRead('t1', { state: 'working', app: 'codex' }, { hookSince: true });
      attention.sessionStatusRead('t1', { state: 'working', app: 'codex' });

      expect(!!workspace('ws-42').agentActive).toBe(false);
    });

    it('applies the first report after the Terminal was attached here', () => {
      const { attention, workspace, terminal } = createAttentionHarness([sshWorkspace('running')]);
      attention.programStatusChanged('t1', { state: 'idle', app: 'claude-code' });
      // Its own reports are current here.
      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });
      expect(!!workspace('ws-42').agentActive).toBe(false);

      attention.attachmentEnded('t1');
      terminal('t1').status = 'stopped';
      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });
      expect(workspace('ws-42').agentActive).toBe(true);
    });

    it('keeps it on as copies would, until their timeout or the host reconnects', async () => {
      const { attention, workspace } = createAttentionHarness([sshWorkspace()]);

      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });
      expect(attention.persistedSources('ws-42', 't1')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(workspace('ws-42').agentActive).toBe(false);

      attention.hostConnected('ssh-host-1');
      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });
      expect(workspace('ws-42').agentActive).toBe(true);
      attention.hostConnected('ssh-host-1');
      attention.hostChecked('ssh-host-1');
      expect(workspace('ws-42').agentActive).toBe(false);
    });

    it('ends with the copy of its done', async () => {
      const { attention, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });

      await attention.hook(toTerminal('t1'), { ...done('claude-code'), copy: true });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(workspace('ws-42').agentActive).toBe(false);
    });

    it.each(['idle', 'done', 'error', 'blocked'])(
      'leaves a spinner its hooks keep on to them when its program reports %s',
      async (state) => {
        const { attention, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
        await attention.hook(toTerminal('t1'), working('claude-code', { copy: true }));
        // Claude reports done while the background tests its Stop named still hold the turn.
        await attention.hook(toTerminal('t1'), {
          ...done('claude-code'),
          copy: true,
          hookInput: {
            hook_event_name: 'Stop',
            background_tasks: [{ type: 'shell', status: 'running', command: 'npm test' }],
          },
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(workspace('ws-42').agentActive).toBe(true);

        attention.sessionStatusRead('t1', { state, app: 'claude-code' });

        expect(workspace('ws-42').agentActive).toBe(true);
      }
    );

    it("makes the last turn's done old news once its program works again", async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        sshWorkspace(),
      ]);
      await attention.hook(toTerminal('t1'), { ...done('claude-code'), copy: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(terminal('t1').attention?.kind).toBe('turn-complete');

      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });

      expect(terminal('t1').attention).toBeUndefined();
      expect(workspace('ws-42').needsAttention).toBe(false);
    });

    it('leaves the spinner off without a report, or with one Komla ignores', () => {
      const { attention, workspace } = createAttentionHarness([sshWorkspace()]);

      attention.sessionStatusRead('t1', undefined);
      // A record of the program's own, or one that names no program.
      attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code', id: 'agent-1' });
      attention.sessionStatusRead('t1', { state: 'working' });

      expect(!!workspace('ws-42').agentActive).toBe(false);
    });
  });

  describe("a Terminal whose attachment ended during its program's turn", () => {
    const claudeHook = (kind: AgentHook['kind'], hookInput: Record<string, unknown>) =>
      ({
        source: 'claude-code',
        kind,
        deliveryId: `d-${kind}`,
        hookInput: { session_id: 's', ...hookInput },
      }) as AgentHook;
    const stop = (backgroundTasks: unknown[] = []) => ({
      ...claudeHook('turn-complete', { hook_event_name: 'Stop', background_tasks: backgroundTasks }),
      message: 'Fixed the tests',
    });
    const idleReminder = {
      ...claudeHook('idle', { hook_event_name: 'Notification', notification_type: 'idle_prompt' }),
      message: 'Claude is waiting for your input',
    };

    /** Claude in t1 reports a turn at work, as Komla here is attached to it. */
    async function turnAtWork() {
      const harness = createAttentionHarness([sshWorkspace('running')]);
      harness.attention.programStatusChanged('t1', { state: 'idle', app: 'claude-code' });
      harness.attention.programStatusChanged('t1', { state: 'working', app: 'claude-code' });
      await harness.settle(
        harness.toTerminal('t1'),
        claudeHook('activity', { hook_event_name: 'PreToolUse', tool_name: 'Bash' })
      );
      expect(harness.workspace('ws-42').agentActive).toBe(true);
      return harness;
    }

    /** The SSH connection ended, so its done went nowhere, and the host came back. */
    function connectionLost({ attention, terminal }: ReturnType<typeof createAttentionHarness>) {
      attention.attachmentEnded('t1');
      terminal('t1').status = 'stopped';
      attention.machineResumed();
      attention.hostConnected('ssh-host-1');
    }

    it('ends the turn with the Stop that arrived before Komla saw the attachment end', async () => {
      const harness = await turnAtWork();
      await harness.settle(harness.toTerminal('t1'), stop());

      connectionLost(harness);

      expect(!!harness.workspace('ws-42').agentActive).toBe(false);
      expect(harness.terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        message: 'Fixed the tests',
      });
    });

    it('ends the turn with an idle reminder that arrived before Komla saw it end', async () => {
      const harness = await turnAtWork();
      // The reminder replaced the undelivered Stop in this installation's mailbox.
      await harness.settle(harness.toTerminal('t1'), idleReminder);

      connectionLost(harness);

      expect(!!harness.workspace('ws-42').agentActive).toBe(false);
    });

    it('ends the turn with the StopFailure that arrived before Komla saw it end', async () => {
      const harness = await turnAtWork();
      await harness.settle(harness.toTerminal('t1'), {
        ...claudeHook('error', { hook_event_name: 'StopFailure' }),
        message: 'API Error: 529 Overloaded',
      });

      connectionLost(harness);

      expect(!!harness.workspace('ws-42').agentActive).toBe(false);
      expect(harness.terminal('t1').attention).toMatchObject({
        kind: 'error',
        message: 'API Error: 529 Overloaded',
      });
    });

    it("keeps the turn on for another program's idle, which is no reminder", async () => {
      const harness = await turnAtWork();
      await harness.settle(harness.toTerminal('t1'), {
        ...claudeHook('idle', { hook_event_name: 'Notification', notification_type: 'other' }),
      });

      connectionLost(harness);

      expect(harness.workspace('ws-42').agentActive).toBe(true);
    });

    it.each(['done', 'idle', 'error'])(
      'ends the turn quietly when the session check reads its program %s',
      async (state) => {
        const harness = await turnAtWork();
        connectionLost(harness);
        expect(harness.workspace('ws-42').agentActive).toBe(true);

        harness.attention.sessionStatusRead('t1', {
          state,
          app: 'claude-code',
          msg: 'Fixed the tests',
        });

        expect(!!harness.workspace('ws-42').agentActive).toBe(false);
        // The user may have seen it end elsewhere; a copy of its Stop shows the done.
        expect(harness.terminal('t1').attention).toBeUndefined();
        expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      }
    );

    it('keeps the spinner on while the session check reads its program at work', async () => {
      const harness = await turnAtWork();
      connectionLost(harness);

      harness.attention.sessionStatusRead('t1', { state: 'working', app: 'claude-code' });
      harness.attention.hostChecked('ssh-host-1');

      expect(harness.workspace('ws-42').agentActive).toBe(true);
    });

    it('leaves the turn to the hooks once one arrives after the attachment ended', async () => {
      const harness = await turnAtWork();
      connectionLost(harness);
      // The user's next prompt, from another installation, starts a turn its hooks keep on.
      await harness.settle(
        harness.toTerminal('t1'),
        claudeHook('prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: 'And more' })
      );

      harness.attention.sessionStatusRead('t1', { state: 'done', app: 'claude-code' });

      expect(harness.workspace('ws-42').agentActive).toBe(true);
    });

    it('keeps the turn on for the background work its Stop named', async () => {
      const harness = await turnAtWork();
      await harness.settle(
        harness.toTerminal('t1'),
        stop([{ type: 'shell', status: 'running', id: 'b1', command: 'npm test' }])
      );
      connectionLost(harness);

      // Claude reports done while that work holds the turn.
      harness.attention.sessionStatusRead('t1', { state: 'done', app: 'claude-code' });

      expect(harness.workspace('ws-42').agentActive).toBe(true);
    });
  });

  describe('a Terminal not attached here whose Hook Journal the check read', () => {
    const claude = (
      kind: 'prompt-submit' | 'activity' | 'turn-complete',
      deliveryId: string,
      hookInput: Record<string, unknown> = {}
    ): AgentHook & { deliveryId: string } => ({
      kind,
      source: 'claude-code',
      deliveryId,
      hookInput: {
        hook_event_name: {
          'prompt-submit': 'UserPromptSubmit',
          activity: 'PreToolUse',
          'turn-complete': 'Stop',
        }[kind],
        session_id: 's1',
        ...hookInput,
      },
    });
    /** A hook the journal kept, which ran `ago` ms before now, sent to `owner`. */
    const journaled = (
      hook: AgentHook & { deliveryId: string },
      ago: number,
      owner = 'other-installation',
      copiedTo: string[] = []
    ): HookJournalEntry => ({
      owner,
      copiedTo,
      writtenAt: Date.now() - ago,
      hook: { cwd: '/repo', terminalId: 't1', ...hook } as HookJournalEntry['hook'],
    });
    /** Takes in the journal, letting the done it may end with settle. */
    async function read(
      attention: TerminalAttention,
      journal: HookJournalEntry[],
      options: Parameters<TerminalAttention['journalRead']>[2] = {}
    ) {
      const reading = attention.journalRead('t1', journal, {
        installationKey: 'this-installation',
        ...options,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await reading;
    }
    const backgroundTests = {
      background_tasks: [{ type: 'shell', status: 'running', command: 'npm test' }],
    };

    it('turns the spinner on for a turn at work, without announcing anything', async () => {
      const { attention, windows, store, promptSubmitted, workspace, terminal } =
        createAttentionHarness([sshWorkspace()]);

      const prompt = journaled(claude('prompt-submit', 'd1', { prompt: 'fix it' }), 5 * 60_000);
      await read(attention, [journaled(claude('activity', 'd2'), 60_000), prompt]);

      expect(workspace('ws-42').agentActive).toBe(true);
      // Working since its prompt, not since the journal was read.
      expect(terminal('t1').agentActiveSince).toBe(prompt.writtenAt);
      expect(workspace('ws-42').agentActiveSince).toBe(prompt.writtenAt);
      expect(windows.attentionRaised).not.toHaveBeenCalled();
      expect(promptSubmitted).not.toHaveBeenCalled();
      // Saved as taken, apart from what this installation's own mailbox took.
      expect(terminal('t1').lastJournalDeliveryId).toBe('d2');
      expect(terminal('t1').lastAcceptedHookDeliveryId).toBeUndefined();
      expect(store.save).toHaveBeenCalled();
      expect(attention.persistedSources('ws-42', 't1')).toBeUndefined();
    });

    it('shows the done of a turn that ended meanwhile on the card alone', async () => {
      const { attention, windows, agentReplied, workspace, terminal, toTerminal } =
        createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), { ...claude('activity', 'd1'), copy: true });

      await read(attention, [
        journaled(claude('prompt-submit', 'd0'), 10 * 60_000),
        journaled(claude('turn-complete', 'd3'), 2 * 60_000),
      ]);

      expect(workspace('ws-42').agentActive).toBe(false);
      expect(terminal('t1').attention?.kind).toBe('turn-complete');
      expect(windows.attentionRaised).not.toHaveBeenCalled();
      expect(agentReplied).not.toHaveBeenCalled();
    });

    it('counts the workspace as working since a replayed turn that started before its own', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        createSshWorkspace({
          id: 'ws-42',
          terminals: [createTerminal({ id: 't1', status: 'stopped' }), createTerminal({ id: 't2' })],
        }),
      ]);
      await attention.hook(toTerminal('t2'), working('codex'));

      const prompt = journaled(claude('prompt-submit', 'd1'), 20 * 60_000);
      await read(attention, [prompt, journaled(claude('activity', 'd2'), 60_000)]);

      expect(terminal('t1').agentActiveSince).toBe(prompt.writtenAt);
      expect(workspace('ws-42').agentActiveSince).toBe(prompt.writtenAt);
    });

    it('counts the copies’ timeout from when its newest hook ran', async () => {
      const { attention, workspace } = createAttentionHarness([sshWorkspace()]);

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 40 * 60_000),
        journaled(claude('activity', 'd2'), 25 * 60_000),
      ]);
      expect(workspace('ws-42').agentActive).toBe(true);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(workspace('ws-42').agentActive).toBe(false);
    });

    it('keeps a turn background work holds working, and counts the hold from its Stop', async () => {
      const { attention, workspace, terminal } = createAttentionHarness([sshWorkspace()]);

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 12 * 60_000),
        journaled(claude('turn-complete', 'd2', backgroundTests), 10 * 60_000),
      ]);
      expect(workspace('ws-42').agentActive).toBe(true);
      expect(terminal('t1').attention).toBeUndefined();

      // As for copies taken live: their spinner lasts 30 minutes from the last one it took.
      await vi.advanceTimersByTimeAsync(18 * 60_000);
      expect(workspace('ws-42').agentActive).toBe(false);
      expect(terminal('t1').attention).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(terminal('t1').attention?.kind).toBe('turn-complete');
    });

    it('takes nothing it already took, as the copy of the newest hook', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        sshWorkspace(),
      ]);
      const copied = attention.hook(toTerminal('t1'), {
        ...claude('turn-complete', 'd2'),
        copy: true,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await copied;
      attention.dismissed('t1');
      expect(terminal('t1').attention).toBeUndefined();

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000),
        journaled(claude('turn-complete', 'd2'), 1_000),
      ]);

      expect(terminal('t1').attention).toBeUndefined();
      expect(!!workspace('ws-42').agentActive).toBe(false);
    });

    it("leaves this installation's own hooks to its mailbox", async () => {
      const { attention, workspace } = createAttentionHarness([sshWorkspace()]);

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000, 'this-installation'),
        journaled(claude('activity', 'd2'), 1_000, 'this-installation'),
      ]);

      expect(!!workspace('ws-42').agentActive).toBe(false);
    });

    it('leaves a copy of the newest hook to its mailbox, which brings it announced', async () => {
      const { attention, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);

      const copiedHere = ['other-installation', 'this-installation'];
      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000, 'other-installation', copiedHere),
        journaled(claude('activity', 'd2'), 1_000, 'other-installation', copiedHere),
      ]);
      expect(!!workspace('ws-42').agentActive).toBe(false);

      await attention.hook(toTerminal('t1'), { ...claude('prompt-submit', 'd1'), copy: true });
      expect(workspace('ws-42').agentActive).toBe(true);
    });

    it('after a restart, turns back on the spinner copies kept on, but not a done seen', async () => {
      const working = sshWorkspace();
      working.terminals[0].lastAcceptedHookDeliveryId = 'd2';
      const first = createAttentionHarness([working]);
      await read(first.attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000),
        journaled(claude('activity', 'd2'), 1_000),
      ]);
      expect(first.workspace('ws-42').agentActive).toBe(true);

      const ended = sshWorkspace();
      ended.terminals[0].lastAcceptedHookDeliveryId = 'd2';
      const second = createAttentionHarness([ended]);
      await read(second.attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000),
        journaled(claude('turn-complete', 'd2'), 1_000),
      ]);
      expect(second.terminal('t1').attention).toBeUndefined();

      // Nor a request for input the user dismissed: what Komla shows is saved.
      const blocked = sshWorkspace();
      blocked.terminals[0].lastAcceptedHookDeliveryId = 'd2';
      const third = createAttentionHarness([blocked]);
      await read(third.attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000),
        journaled({ ...claude('activity', 'd2'), kind: 'input-required' }, 1_000),
      ]);
      expect(third.terminal('t1').attention).toBeUndefined();
    });

    it('confirms a copied spinner after its host reconnects', async () => {
      const { attention, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), { ...claude('activity', 'd2'), copy: true });

      attention.hostConnected('ssh-host-1');
      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000),
        journaled(claude('activity', 'd2'), 1_000),
      ]);
      attention.hostChecked('ssh-host-1');

      expect(workspace('ws-42').agentActive).toBe(true);
    });

    it('only confirms what it read while a hook arrived, which is newer', async () => {
      const { attention, workspace } = createAttentionHarness([sshWorkspace()]);

      await read(attention, [journaled(claude('prompt-submit', 'd1'), 1_000)], {
        hookSince: true,
      });

      expect(!!workspace('ws-42').agentActive).toBe(false);
    });

    it('takes a journal in once while a check before is still taking it in', async () => {
      const journal = [
        journaled(claude('prompt-submit', 'd1'), 60_000),
        journaled(claude('activity', 'd2'), 30_000),
      ];
      const { attention } = createAttentionHarness([sshWorkspace()]);
      const taken = vi.spyOn(attention, 'hook');

      const first = attention.journalRead('t1', journal, { installationKey: 'this-installation' });
      const second = attention.journalRead('t1', journal, { installationKey: 'this-installation' });
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all([first, second]);

      expect(taken).toHaveBeenCalledTimes(2);
    });

    it('takes in only what came after the last hook it took', async () => {
      const { attention, terminal, turnActivity, toTerminal } = createAttentionHarness([
        sshWorkspace(),
      ]);
      const stop = attention.hook(toTerminal('t1'), {
        ...claude('turn-complete', 'd2'),
        copy: true,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await stop;
      attention.dismissed('t1');
      turnActivity.mockClear();
      const taken = vi.spyOn(attention, 'hook');

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000),
        journaled(claude('turn-complete', 'd2'), 30_000),
        journaled({ ...claude('activity', 'd3'), source: 'codex' }, 1_000),
      ]);

      expect(taken).toHaveBeenCalledTimes(1);
      expect(taken).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ deliveryId: 'd3' })
      );
      // The done the user saw stays seen, and old news doesn't make the workspace recent.
      expect(terminal('t1').attention).toBeUndefined();
      expect(turnActivity).not.toHaveBeenCalled();
    });

    it('leaves a copy that waited in its mailbox while the journal brought newer ones', async () => {
      const { attention, workspace, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000),
        journaled(claude('activity', 'd2'), 30_000),
        journaled(claude('turn-complete', 'd3'), 1_000),
      ]);
      expect(!!workspace('ws-42').agentActive).toBe(false);

      // Copied to it in the moments after it stopped answering.
      const outcome = await attention.hook(toTerminal('t1'), {
        ...claude('activity', 'd2'),
        copy: true,
      });

      expect(outcome).toBe('ignored');
      expect(!!workspace('ws-42').agentActive).toBe(false);
    });

    it('after a restart, sees past a subagent’s hook to its agent at work', async () => {
      const restored = sshWorkspace();
      restored.terminals[0].lastAcceptedHookDeliveryId = 'd3';
      const { attention, workspace } = createAttentionHarness([restored]);

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000),
        journaled(claude('activity', 'd2'), 30_000),
        journaled(claude('turn-complete', 'd3', { agent_id: 'subagent-1' }), 1_000),
      ]);

      expect(workspace('ws-42').agentActive).toBe(true);
    });

    it('takes in how a turn ended though hooks Komla ignores came after', async () => {
      const { attention, workspace, terminal } = createAttentionHarness([sshWorkspace()]);

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 60_000),
        journaled(claude('turn-complete', 'd2'), 30_000),
        journaled(
          {
            ...claude('turn-complete', 'd3'),
            hookInput: { hook_event_name: 'SubagentStop', session_id: 's1' },
          },
          1_000
        ),
      ]);

      expect(!!workspace('ws-42').agentActive).toBe(false);
      expect(terminal('t1').attention?.kind).toBe('turn-complete');
    });

    it('is read once, and again after its host reconnects or the computer wakes', () => {
      const { attention } = createAttentionHarness([sshWorkspace()]);
      expect(attention.wantsJournal('t1')).toBe(true);

      void attention.journalRead('t1', [], { installationKey: 'this-installation' });
      expect(attention.wantsJournal('t1')).toBe(false);
      attention.hostConnected('another-host');
      expect(attention.wantsJournal('t1')).toBe(false);
      attention.hostConnected('ssh-host-1');
      expect(attention.wantsJournal('t1')).toBe(true);

      void attention.journalRead('t1', [], { installationKey: 'this-installation' });
      attention.machineResumed();
      expect(attention.wantsJournal('t1')).toBe(true);
    });

    it("leaves the status of the program whose hooks it holds to them: Codex's server", () => {
      const { attention, workspace } = createAttentionHarness([sshWorkspace()]);
      void attention.journalRead('t1', [
        journaled({ ...claude('turn-complete', 'd1'), source: 'codex' }, 1_000, 'this-installation'),
      ]);

      attention.sessionStatusRead('t1', { state: 'working', app: 'codex' });

      expect(!!workspace('ws-42').agentActive).toBe(false);
    });

    it('stops the replay once a hook arrives meanwhile', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        sshWorkspace(),
      ]);

      const reading = attention.journalRead(
        't1',
        [
          journaled(claude('turn-complete', 'd1'), 60_000),
          journaled(claude('prompt-submit', 'd2'), 1_000),
        ],
        { installationKey: 'this-installation' }
      );
      // The replayed done settles, and a copy of the next turn's tool activity arrives.
      await attention.hook(toTerminal('t1'), { ...claude('activity', 'd3'), copy: true });
      await vi.advanceTimersByTimeAsync(1_000);
      await reading;

      expect(workspace('ws-42').agentActive).toBe(true);
      expect(terminal('t1').lastAcceptedHookDeliveryId).toBeUndefined();
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
