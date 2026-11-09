import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSshWorkspace, createTerminal, createWorkspace } from '../../factories';
import { createAttentionHarness } from '../../helpers/terminal-attention';

import { STOP_HOOK_WAIT_MS } from '../../../src/main/services/terminal-attention/terminal-attention';

import type { HookJournalEntry } from '../../../src/main/services/terminal-attention/hook-journal';
import type {
  AgentHook,
  TerminalAttention,
} from '../../../src/main/services/terminal-attention/terminal-attention';
import type { TerminalStatus } from '../../../src/shared/types';

vi.mock('electron', async () => (await import('../../mocks/electron')).mockElectron());

/** SSH workspace ws-42 on ssh-host-1 with Terminal t1; stopped while another installation is attached. */
function sshWorkspace(status: TerminalStatus = 'stopped') {
  return createSshWorkspace({
    id: 'ws-42',
    terminals: [createTerminal({ id: 't1', status })],
  });
}

const claude = (
  kind: 'prompt-submit' | 'activity' | 'turn-complete',
  deliveryId: string,
  options: { copy?: boolean } = {}
): AgentHook => ({
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
  },
  ...options,
});

/** Another installation's word that the user saw the done that `turn` delivered. */
const seenElsewhere = (turn: string, deliveryId = `seen-${turn}`): AgentHook => ({
  kind: 'seen',
  source: 'claude-code',
  deliveryId,
  copy: true,
  hookInput: { seen_delivery_id: turn },
});

describe('Terminal Attention State: a done seen on another installation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the user seeing a done here', () => {
    it('tells the other installations once, whether seen on screen or focused', async () => {
      const { attention, relay, workspace, settle, toTerminal } = createAttentionHarness([
        sshWorkspace(),
      ]);
      await settle(toTerminal('t1'), claude('turn-complete', 'd1', { copy: true }));

      attention.terminalSeen('t1');
      attention.dismissed('t1');

      expect(relay.seen).toHaveBeenCalledTimes(1);
      expect(relay.seen).toHaveBeenCalledWith(workspace('ws-42'), 't1', 'claude-code', 'd1');
    });

    it('tells them when the user focuses a done without seeing it first', async () => {
      const { attention, relay, workspace, settle, toTerminal } = createAttentionHarness([
        sshWorkspace('running'),
      ]);
      await settle(toTerminal('t1'), claude('turn-complete', 'd1'));

      attention.dismissed('t1');

      expect(relay.seen).toHaveBeenCalledWith(workspace('ws-42'), 't1', 'claude-code', 'd1');
    });

    it('tells them once the hook delivering a done it saw arrives, as after its program showed it first', async () => {
      const { attention, relay, workspace, toTerminal } = createAttentionHarness([
        sshWorkspace('running'),
      ]);
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'idle' });
      await attention.hook(toTerminal('t1'), claude('prompt-submit', 'd1'));
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'working' });
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'done' });
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);

      attention.terminalSeen('t1');
      expect(relay.seen).not.toHaveBeenCalled();
      await attention.hook(toTerminal('t1'), claude('turn-complete', 'd2'));

      expect(relay.seen).toHaveBeenCalledWith(workspace('ws-42'), 't1', 'claude-code', 'd2');
    });

    it('names on the card too the done a late Stop names', async () => {
      const { attention, workspace, terminal, toTerminal } = createAttentionHarness([
        sshWorkspace('running'),
      ]);
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'idle' });
      await attention.hook(toTerminal('t1'), claude('prompt-submit', 'd1'));
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'working' });
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'done' });
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);

      await attention.hook(toTerminal('t1'), claude('turn-complete', 'd2'));

      expect(workspace('ws-42').attention).toBe(terminal('t1').attention);
      expect(terminal('t1').attention).toMatchObject({ deliveryId: 'd2' });
    });

    it("tells them nothing of a later turn's done for one it saw before its hook arrived", async () => {
      const { attention, relay, terminal, toTerminal } = createAttentionHarness([
        sshWorkspace('running'),
      ]);
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'idle' });
      await attention.hook(toTerminal('t1'), claude('prompt-submit', 'd1'));
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'working' });
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'done' });
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);
      attention.dismissed('t1');

      // A turn no prompt hook told of.
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'working' });
      await attention.hook(toTerminal('t1'), claude('turn-complete', 'd2'));
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'done' });

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', deliveryId: 'd2' });
      expect(relay.seen).not.toHaveBeenCalled();
    });

    it('tells them nothing again of a done seen before a restart', async () => {
      const restored = sshWorkspace();
      restored.terminals[0].attention = {
        kind: 'turn-complete',
        source: 'claude-code',
        updatedAt: 1,
        terminalId: 't1',
        deliveryId: 'd1',
        seen: true,
      };
      const { attention, relay } = createAttentionHarness([restored]);

      attention.terminalSeen('t1');
      attention.dismissed('t1');

      expect(relay.seen).not.toHaveBeenCalled();
    });

    it('tells them again when the user sees it again after telling them failed', async () => {
      const { attention, relay, settle, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await settle(toTerminal('t1'), claude('turn-complete', 'd1', { copy: true }));
      relay.seen.mockResolvedValueOnce(false);

      attention.terminalSeen('t1');
      await vi.advanceTimersByTimeAsync(0);
      attention.dismissed('t1');

      expect(relay.seen).toHaveBeenCalledTimes(2);
    });

    it('tells them nothing of a done in a local workspace, which no other installation shows', async () => {
      const { attention, relay, settle, toTerminal } = createAttentionHarness([
        createWorkspace({
          id: 'ws-1',
          terminals: [createTerminal({ id: 't1' })],
        }),
      ]);
      await settle(toTerminal('t1'), claude('turn-complete', 'd1'));

      attention.terminalSeen('t1');

      expect(relay.seen).not.toHaveBeenCalled();
    });

    it('tells them nothing of a done no hook delivered, which they can’t tell apart', async () => {
      const { attention, relay, settle, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await settle(toTerminal('t1'), {
        kind: 'turn-complete',
        source: 'claude-code',
      });

      attention.terminalSeen('t1');

      expect(relay.seen).not.toHaveBeenCalled();
    });
  });

  describe('word that the user saw it elsewhere', () => {
    it('leaves the done on its pane alone, off the card and the badge', async () => {
      const { attention, relay, windows, workspace, terminal, settle, toTerminal } =
        createAttentionHarness([sshWorkspace()]);
      await settle(toTerminal('t1'), claude('turn-complete', 'd1', { copy: true }));
      expect(workspace('ws-42').attention?.kind).toBe('turn-complete');

      const outcome = await attention.hook(toTerminal('t1'), seenElsewhere('d1'));

      expect(outcome).toBe('ignored');
      expect(terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        seen: true,
      });
      expect(workspace('ws-42').attention).toBeUndefined();
      expect(windows.badge).toHaveBeenLastCalledWith(0);
      // Seeing it here too isn't news to the installation it came from.
      attention.dismissed('t1');
      expect(relay.seen).not.toHaveBeenCalled();
    });

    it('arriving before the Stop its program waits for, has the done show seen', async () => {
      const { attention, windows, terminal, toTerminal } = createAttentionHarness([
        sshWorkspace('running'),
      ]);
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'idle' });
      await attention.hook(toTerminal('t1'), claude('prompt-submit', 'd1'));
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'working' });
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'done' });

      await attention.hook(toTerminal('t1'), seenElsewhere('d2'));
      await attention.hook(toTerminal('t1'), claude('turn-complete', 'd2'));

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', seen: true });
      expect(windows.attentionRaised).not.toHaveBeenCalled();
    });

    it("leaves the workspace's own news on its card", async () => {
      const { attention, workspace, settle, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await settle(
        { workspace: workspace('ws-42'), hasInvalidTerminalId: false },
        { kind: 'turn-complete', source: 'command', message: 'Deployed' }
      );
      await attention.hook(toTerminal('t1'), seenElsewhere('d1'));

      await settle(toTerminal('t1'), claude('turn-complete', 'd1', { copy: true }));

      expect(workspace('ws-42').attention).toMatchObject({ message: 'Deployed' });
    });

    it('arriving before its done, has the done show seen and unannounced', async () => {
      const { attention, windows, workspace, terminal, settle, toTerminal } =
        createAttentionHarness([sshWorkspace()]);

      await attention.hook(toTerminal('t1'), seenElsewhere('d1'));
      await settle(toTerminal('t1'), claude('turn-complete', 'd1', { copy: true }));

      expect(terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        seen: true,
      });
      expect(workspace('ws-42').attention).toBeUndefined();
      expect(windows.attentionRaised).not.toHaveBeenCalled();
    });

    it("leaves a later turn's done the user hasn't seen", async () => {
      const { attention, workspace, terminal, settle, toTerminal } = createAttentionHarness([
        sshWorkspace(),
      ]);
      await settle(toTerminal('t1'), claude('turn-complete', 'd1', { copy: true }));
      await attention.hook(toTerminal('t1'), claude('prompt-submit', 'd2', { copy: true }));
      await settle(toTerminal('t1'), claude('turn-complete', 'd3', { copy: true }));

      await attention.hook(toTerminal('t1'), seenElsewhere('d1'));

      expect(terminal('t1').attention).not.toHaveProperty('seen');
      expect(workspace('ws-42').attention?.kind).toBe('turn-complete');
    });

    it("leaves the next turn's done, though nothing delivered it", async () => {
      const { attention, terminal, settle, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await settle(toTerminal('t1'), claude('turn-complete', 'd1', { copy: true }));
      await attention.hook(toTerminal('t1'), seenElsewhere('d1'));

      // As a program reports its done before the Stop that delivers it.
      await attention.hook(toTerminal('t1'), claude('prompt-submit', 'd2', { copy: true }));
      await settle(toTerminal('t1'), {
        kind: 'turn-complete',
        source: 'claude-code',
        copy: true,
      });

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });
      expect(terminal('t1').attention).not.toHaveProperty('seen');
    });

    it('leaves a done its program shows after a turn no hook told of, though it saw the last', async () => {
      const { attention, terminal, toTerminal } = createAttentionHarness([sshWorkspace('running')]);
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'idle' });
      await attention.hook(toTerminal('t1'), claude('prompt-submit', 'd1'));
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'working' });
      await attention.hook(toTerminal('t1'), claude('turn-complete', 'd2'));
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'done' });
      await attention.hook(toTerminal('t1'), seenElsewhere('d2'));
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', seen: true });

      attention.programStatusChanged('t1', { app: 'claude-code', state: 'working' });
      attention.programStatusChanged('t1', { app: 'claude-code', state: 'done' });
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });
      expect(terminal('t1').attention).not.toHaveProperty('seen');
    });

    it('is accepted only as a copy from another installation', async () => {
      const { attention, terminal, settle, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await settle(toTerminal('t1'), claude('turn-complete', 'd1', { copy: true }));

      await attention.hook(toTerminal('t1'), {
        ...seenElsewhere('d1'),
        copy: false,
      });

      expect(terminal('t1').attention).not.toHaveProperty('seen');
    });

    it("doesn't end a replay of the Terminal's Hook Journal as a newer hook would", async () => {
      const { attention, toTerminal } = createAttentionHarness([sshWorkspace()]);
      const mark = attention.hookMark('t1');

      await attention.hook(toTerminal('t1'), seenElsewhere('d1'));

      expect(attention.hookArrivedSince('t1', mark)).toBe(false);
    });
  });

  describe("a Terminal's Hook Journal", () => {
    /** A hook the journal kept, which ran `ago` ms before now, sent to `owner`. */
    const journaled = (
      hook: AgentHook,
      ago: number,
      owner = 'other-installation'
    ): HookJournalEntry => ({
      owner,
      copiedTo: [],
      writtenAt: Date.now() - ago,
      hook: {
        cwd: '/repo',
        terminalId: 't1',
        ...hook,
        copy: true,
      } as HookJournalEntry['hook'],
    });
    async function read(attention: TerminalAttention, journal: HookJournalEntry[]) {
      const reading = attention.journalRead('t1', journal, {
        installationKey: 'this-installation',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await reading;
    }

    it('brings a turn that ended while this installation was away as done, unseen elsewhere', async () => {
      const { attention, workspace, terminal } = createAttentionHarness([sshWorkspace()]);

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 10 * 60_000),
        journaled(claude('turn-complete', 'd2'), 5 * 60_000),
      ]);

      expect(terminal('t1').attention).not.toHaveProperty('seen');
      expect(workspace('ws-42').attention?.kind).toBe('turn-complete');
    });

    it('brings one the user saw on the installation it ran on as seen', async () => {
      const { attention, relay, workspace, terminal } = createAttentionHarness([sshWorkspace()]);

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 10 * 60_000),
        journaled(claude('turn-complete', 'd2'), 5 * 60_000),
        journaled(seenElsewhere('d2', 'd3'), 4 * 60_000),
      ]);

      expect(terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        seen: true,
      });
      expect(workspace('ws-42').attention).toBeUndefined();
      expect(!!workspace('ws-42').agentActive).toBe(false);
      expect(relay.seen).not.toHaveBeenCalled();
    });

    it('brings the done it missed though word that the user saw it was copied here', async () => {
      const { attention, workspace, terminal } = createAttentionHarness([sshWorkspace()]);
      const seen = journaled(seenElsewhere('d2', 'd3'), 4 * 60_000);

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 10 * 60_000),
        journaled(claude('turn-complete', 'd2'), 5 * 60_000),
        { ...seen, copiedTo: ['this-installation'] },
      ]);

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', seen: true });
      expect(!!workspace('ws-42').agentActive).toBe(false);
    });

    it('brings the done it missed though word that the user saw it came here first', async () => {
      const { attention, terminal, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), seenElsewhere('d2', 'd3'));

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 10 * 60_000),
        journaled(claude('turn-complete', 'd2'), 5 * 60_000),
        journaled(seenElsewhere('d2', 'd3'), 4 * 60_000),
      ]);

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', seen: true });
    });

    it('brings a turn it missed though this installation told of a done since', async () => {
      const restored = sshWorkspace();
      Object.assign(restored.terminals[0], {
        lastAcceptedHookDeliveryId: 'd0',
        attention: {
          kind: 'turn-complete',
          source: 'claude-code',
          updatedAt: 1,
          terminalId: 't1',
          deliveryId: 'd0',
          seen: true,
        },
      });
      const { attention, workspace, terminal } = createAttentionHarness([restored]);

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 10 * 60_000),
        journaled(claude('turn-complete', 'd2'), 5 * 60_000),
        journaled(seenElsewhere('d0', 'd3'), 4 * 60_000, 'this-installation'),
      ]);

      expect(terminal('t1').attention).not.toHaveProperty('seen');
      expect(workspace('ws-42').attention?.kind).toBe('turn-complete');
    });

    it('keeps word of a newer done it had when it reads word of an older one', async () => {
      const { attention, terminal, settle, toTerminal } = createAttentionHarness([sshWorkspace()]);
      await attention.hook(toTerminal('t1'), seenElsewhere('d2', 'seen-2'));

      await read(attention, [
        journaled(claude('turn-complete', 'd1'), 5 * 60_000),
        journaled(seenElsewhere('d1', 'seen-1'), 4 * 60_000),
      ]);
      await settle(toTerminal('t1'), claude('turn-complete', 'd2', { copy: true }));

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', seen: true });
    });

    it('after a restart, takes a done shown before as seen once the user saw it elsewhere', async () => {
      const restored = sshWorkspace();
      Object.assign(restored.terminals[0], {
        lastAcceptedHookDeliveryId: 'd2',
        attention: {
          kind: 'turn-complete',
          source: 'claude-code',
          updatedAt: 1,
          terminalId: 't1',
          deliveryId: 'd2',
        },
      });
      restored.attention = restored.terminals[0].attention;
      const { attention, workspace, terminal } = createAttentionHarness([restored]);

      await read(attention, [
        journaled(claude('prompt-submit', 'd1'), 10 * 60_000),
        journaled(claude('turn-complete', 'd2'), 5 * 60_000),
        journaled(seenElsewhere('d2', 'd3'), 60_000),
      ]);

      expect(terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        seen: true,
      });
      expect(workspace('ws-42').attention).toBeUndefined();
      // Its prompt isn't taken in again, which would turn the spinner back on.
      expect(!!workspace('ws-42').agentActive).toBe(false);
    });
  });
});
