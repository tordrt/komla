import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminal, createWorkspace } from '../../factories';
import { createAttentionHarness } from '../../helpers/terminal-attention';

import {
  CODEX_INTERRUPT_IDLE_MS,
  CODEX_STARTUP_MS,
  type AgentHook,
  type TerminalAttention,
} from '../../../src/main/services/terminal-attention/terminal-attention';

vi.mock('electron', async () => (await import('../../mocks/electron')).mockElectron());

/** Local workspace ws-1 with Terminals t1 and t2, and ws-2 with t3. */
function harness() {
  return createAttentionHarness([
    createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 't1' }), createTerminal({ id: 't2' })],
    }),
    createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 't3' })] }),
  ]);
}

const codex = (state: string, kind?: string) => ({ app: 'codex', state, ...(kind && { kind }) });

/** Codex started in the Terminal a while ago, and is ready for a prompt. */
function started(attention: TerminalAttention, terminalId: string) {
  attention.programStatusChanged(terminalId, codex('idle'));
  attention.programStatusChanged(terminalId, codex('working'));
  attention.programStatusChanged(terminalId, codex('idle'));
  vi.advanceTimersByTime(CODEX_STARTUP_MS);
}

const prompt = (session = 's', text = 'Fix the tests', turn?: string): AgentHook => ({
  source: 'codex',
  kind: 'prompt-submit',
  hookInput: {
    hook_event_name: 'UserPromptSubmit',
    session_id: session,
    prompt: text,
    ...(turn && { turn_id: turn }),
  },
});
const stop = (session = 's', reply = 'Fixed', turn?: string): AgentHook => ({
  source: 'codex',
  kind: 'turn-complete',
  message: reply,
  hookInput: {
    hook_event_name: 'Stop',
    session_id: session,
    last_assistant_message: reply,
    ...(turn && { turn_id: turn }),
  },
});
const approval = (command: string, session = 's'): AgentHook => ({
  source: 'codex',
  kind: 'input-required',
  message: command,
  hookInput: {
    hook_event_name: 'PermissionRequest',
    session_id: session,
    tool_name: 'Bash',
    tool_input: { command },
  },
});
const interrupt = (session = 's'): AgentHook => ({
  source: 'codex',
  kind: 'interrupted',
  hookInput: { hook_event_name: 'Interrupt', session_id: session },
});
const activity = (command: string, session = 's'): AgentHook => ({
  source: 'codex',
  kind: 'activity',
  hookInput: {
    hook_event_name: 'PreToolUse',
    session_id: session,
    tool_name: 'Bash',
    tool_input: { command },
  },
});

describe('Terminal Attention State: the status Codex reports in its Terminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spins only the Terminal Codex reports working in', () => {
    const { attention, terminal, workspace } = harness();

    started(attention, 't2');
    attention.programStatusChanged('t2', codex('working'));

    expect(terminal('t2').agentActive).toBe(true);
    expect(!!terminal('t1').agentActive).toBe(false);
    expect(workspace('ws-1').agentActive).toBe(true);
  });

  it('shows nothing for the work Codex does as it starts, which no prompt started', () => {
    const { attention, terminal, windows } = harness();

    attention.programStatusChanged('t1', codex('idle'));
    vi.advanceTimersByTime(150);
    attention.programStatusChanged('t1', codex('working'));

    expect(!!terminal('t1').agentActive).toBe(false);

    vi.advanceTimersByTime(6000);
    attention.programStatusChanged('t1', codex('idle'));

    expect(terminal('t1').attention).toBeUndefined();
    expect(windows.attentionRaised).not.toHaveBeenCalled();
  });

  it('shows a turn that Codex started with a prompt as it started', async () => {
    const { attention, terminal, toWorkspace } = harness();

    attention.programStatusChanged('t1', codex('idle'));
    attention.programStatusChanged('t1', codex('working'));
    await attention.hook(toWorkspace('ws-1'), prompt());

    expect(terminal('t1').agentActive).toBe(true);

    attention.programStatusChanged('t1', codex('idle'));

    expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });
  });

  it('shows a done for a turn when Codex runs no hooks, or reports nothing as it starts', () => {
    const { attention, terminal } = harness();

    attention.programStatusChanged('t1', codex('idle'));
    vi.advanceTimersByTime(CODEX_STARTUP_MS);
    attention.programStatusChanged('t1', codex('working'));

    expect(terminal('t1').agentActive).toBe(true);

    attention.programStatusChanged('t1', codex('idle'));

    expect(!!terminal('t1').agentActive).toBe(false);
    expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });
  });

  it('asks for input while Codex is blocked, until it works again', () => {
    const { attention, terminal } = harness();

    started(attention, 't1');
    attention.programStatusChanged('t1', codex('working'));
    attention.programStatusChanged('t1', codex('blocked', 'permission'));

    expect(terminal('t1').attention).toMatchObject({ kind: 'input-required', source: 'codex' });

    attention.programStatusChanged('t1', codex('working'));

    expect(terminal('t1').attention).toBeUndefined();
    expect(terminal('t1').agentActive).toBe(true);
  });

  it('shows an error when Codex reports a failed turn', () => {
    const { attention, terminal } = harness();

    started(attention, 't1');
    attention.programStatusChanged('t1', codex('working'));
    attention.programStatusChanged('t1', codex('error'));

    expect(!!terminal('t1').agentActive).toBe(false);
    expect(terminal('t1').attention).toMatchObject({ kind: 'error', source: 'codex' });
  });

  it('stops the spinner when Codex quits, and keeps its attention', () => {
    const { attention, terminal } = harness();

    started(attention, 't1');
    attention.programStatusChanged('t1', codex('working'));
    attention.programStatusChanged('t1', codex('blocked'));
    attention.programStatusChanged('t1', { state: 'clear' });

    expect(!!terminal('t1').agentActive).toBe(false);
    expect(terminal('t1').attention).toMatchObject({ kind: 'input-required' });
  });

  it('leaves the turn of another program that replaced Codex to that program', () => {
    const { attention, terminal } = harness();

    started(attention, 't1');
    attention.programStatusChanged('t1', codex('working'));
    attention.programStatusChanged('t1', { app: 'pi', state: 'idle' });

    expect(!!terminal('t1').agentActive).toBe(false);
    expect(terminal('t1').attention).toBeUndefined();
  });

  describe('the end of a prompted turn', () => {
    it('shows a done when Codex 0.164 reports one, and records the reply its Stop then carries', async () => {
      const { attention, terminal, windows, agentReplied, toTerminal } = harness();

      started(attention, 't2');
      attention.programStatusChanged('t2', codex('working'));
      // The shared process gives every session's hooks the ids of t1, which started it.
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t2', codex('done'));

      expect(!!terminal('t2').agentActive).toBe(false);
      expect(terminal('t2').attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });

      await attention.hook(toTerminal('t1'), stop());
      attention.programStatusChanged('t2', codex('idle'));

      expect(agentReplied).toHaveBeenCalledWith('ws-1', 'Fixed', 't2');
      expect(windows.attentionRaised).toHaveBeenCalledTimes(1);
    });

    it('shows a done at the idle Codex before 0.164 ends every turn with, and records the later reply', async () => {
      const { attention, terminal, windows, agentReplied, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      attention.programStatusChanged('t1', codex('idle'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });

      await attention.hook(toWorkspace('ws-1'), stop());

      expect(agentReplied).toHaveBeenCalledWith('ws-1', 'Fixed', 't1');
      expect(windows.attentionRaised).toHaveBeenCalledTimes(1);
    });

    it('shows a done with the reply at the idle that follows the Stop', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      await attention.hook(toWorkspace('ws-1'), stop());

      expect(terminal('t1').agentActive).toBe(true);

      attention.programStatusChanged('t1', codex('idle'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        source: 'codex',
        message: 'Fixed',
      });
    });

    it('asks for input with the command its approval hook names', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      await attention.hook(toWorkspace('ws-1'), approval('npm install'));
      attention.programStatusChanged('t1', codex('blocked', 'permission'));

      expect(terminal('t1').attention).toMatchObject({
        kind: 'input-required',
        message: 'npm install',
      });

      attention.programStatusChanged('t1', codex('working'));
      attention.programStatusChanged('t1', codex('blocked', 'permission'));

      expect(terminal('t1').attention?.message).toBeUndefined();
    });

    it('spins until the background terminals Codex works on after the Stop exit', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      await attention.hook(toWorkspace('ws-1'), activity('sleep 45'));
      await attention.hook(toWorkspace('ws-1'), stop());
      vi.advanceTimersByTime(60_000);

      expect(terminal('t1').agentActive).toBe(true);
      expect(terminal('t1').attention).toBeUndefined();

      attention.programStatusChanged('t1', codex('idle'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });
    });

    it('stops spinning at the Stop of a turn that started a server, and at its later Stops', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      await attention.hook(toWorkspace('ws-1'), activity('npm run dev'));
      await attention.hook(toWorkspace('ws-1'), stop());

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });

      // The server keeps Codex working, so it reports nothing new at the next prompt.
      await attention.hook(toWorkspace('ws-1'), prompt('s', 'Now the docs'));

      expect(terminal('t1').agentActive).toBe(true);
      expect(terminal('t1').attention).toBeUndefined();

      await attention.hook(toWorkspace('ws-1'), stop('s', 'Done the docs'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });

      // Stopping the server shows nothing more.
      attention.programStatusChanged('t1', codex('done'));
      attention.programStatusChanged('t1', codex('working'));

      expect(terminal('t1').agentActive).toBe(true);
    });

    it('binds each session to its own Terminal, whichever Terminal the hooks name', async () => {
      const { attention, terminal, promptSubmitted, toTerminal } = harness();

      started(attention, 't1');
      started(attention, 't2');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toTerminal('t1'), prompt('a'));
      attention.programStatusChanged('t2', codex('working'));
      await attention.hook(toTerminal('t1'), prompt('b', 'Write the docs'));

      expect(promptSubmitted).toHaveBeenLastCalledWith('ws-1', 'Write the docs', 't2');

      attention.programStatusChanged('t2', codex('idle'));
      await attention.hook(toTerminal('t1'), stop('b'));

      expect(!!terminal('t2').agentActive).toBe(false);
      expect(terminal('t2').attention).toMatchObject({ kind: 'turn-complete' });
      expect(terminal('t1').agentActive).toBe(true);
      expect(terminal('t1').attention).toBeUndefined();
    });

    it('leaves a turn that started a server spinning at the late Stop of the turn before', async () => {
      const { attention, terminal, agentReplied, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt('s', 'Fix the tests', 'turn-1'));
      attention.programStatusChanged('t1', codex('idle'));
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt('s', 'Start the app', 'turn-2'));
      await attention.hook(toWorkspace('ws-1'), activity('npm run dev'));
      await attention.hook(toWorkspace('ws-1'), stop('s', 'Fixed', 'turn-1'));

      expect(terminal('t1').agentActive).toBe(true);
      expect(terminal('t1').attention).toBeUndefined();

      await attention.hook(toWorkspace('ws-1'), stop('s', 'Started', 'turn-2'));

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });
      expect(agentReplied).toHaveBeenLastCalledWith('ws-1', 'Started', 't1');
    });

    it('binds a prompt to the Terminal that started working, not one a server keeps working', async () => {
      const { attention, terminal, toTerminal } = harness();

      started(attention, 't1');
      started(attention, 't2');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toTerminal('t1'), prompt('a'));
      await attention.hook(toTerminal('t1'), activity('npm run dev', 'a'));
      await attention.hook(toTerminal('t1'), stop('a'));
      attention.programStatusChanged('t2', codex('working'));
      // The shared process gives every session's hooks the ids of t1, which started it.
      await attention.hook(toTerminal('t1'), prompt('b', 'Write the docs'));

      expect(!!terminal('t1').agentActive).toBe(false);

      attention.programStatusChanged('t2', codex('idle'));
      await attention.hook(toTerminal('t1'), stop('b'));

      expect(terminal('t2').attention).toMatchObject({ kind: 'turn-complete' });
    });

    it('shows a done for a turn Codex before 0.164 ends without a Stop, as after /review', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt('s', '/review'));
      attention.programStatusChanged('t1', codex('idle'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });
    });

    it('shows a done when Codex 0.164 reports one without a Stop', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      attention.programStatusChanged('t1', codex('done'));

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });
    });

    it('shows nothing when the session reports an interrupt', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      await attention.hook(toWorkspace('ws-1'), interrupt());
      attention.programStatusChanged('t1', codex('idle'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toBeUndefined();
    });

    it('shows nothing when the user interrupted it here', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      attention.aborted('t1', true);

      expect(!!terminal('t1').agentActive).toBe(false);

      attention.programStatusChanged('t1', codex('idle'));

      expect(terminal('t1').attention).toBeUndefined();
    });

    it('stops spinning quietly when the session interrupts a turn that started a server', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      await attention.hook(toWorkspace('ws-1'), activity('npm run dev'));
      await attention.hook(toWorkspace('ws-1'), interrupt());

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toBeUndefined();
    });

    it('ends later turns at their Stops after the user interrupted one Codex still works on', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      attention.aborted('t1', true);
      await attention.hook(toWorkspace('ws-1'), prompt('s', 'Now the docs'));
      await attention.hook(toWorkspace('ws-1'), stop());

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });
    });

    it('shows nothing when Codex goes idle just after a keypress that may have interrupted it', async () => {
      const { attention, terminal, windows, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      attention.aborted('t1');
      vi.advanceTimersByTime(50);
      attention.programStatusChanged('t1', codex('idle'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toBeUndefined();
      expect(windows.attentionRaised).not.toHaveBeenCalled();
    });

    it('shows a done when Codex goes idle well after a keypress that did not interrupt it', async () => {
      const { attention, terminal, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      await attention.hook(toWorkspace('ws-1'), prompt());
      attention.aborted('t1');
      vi.advanceTimersByTime(CODEX_INTERRUPT_IDLE_MS);
      attention.programStatusChanged('t1', codex('idle'));

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });
    });

    it('keeps spinning through a keypress that did not interrupt it', () => {
      const { attention, terminal } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      attention.aborted('t1');

      expect(terminal('t1').agentActive).toBe(true);
    });
  });

  it("dismisses the last turn's error at the next prompt", async () => {
    const { attention, terminal, toWorkspace } = harness();

    started(attention, 't1');
    attention.programStatusChanged('t1', codex('working'));
    attention.programStatusChanged('t1', codex('error'));
    attention.programStatusChanged('t1', codex('working'));
    await attention.hook(toWorkspace('ws-1'), prompt());

    expect(terminal('t1').attention).toBeUndefined();
    expect(terminal('t1').agentActive).toBe(true);
  });

  describe("Codex's hooks", () => {
    it('count as received for the milestone, and the statuses Codex reports do not', async () => {
      const { attention, milestone, toWorkspace } = harness();

      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));
      attention.programStatusChanged('t1', codex('done'));

      expect(milestone).not.toHaveBeenCalled();

      await attention.hook(toWorkspace('ws-1'), prompt());

      expect(milestone).toHaveBeenCalledWith('notification:prompt-submit:codex', {
        notificationKind: 'prompt-submit',
        source: 'codex',
      });
    });

    it("leave the spinners to the Terminals' own statuses", async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', codex('idle'));

      await attention.hook(toTerminal('t1'), prompt());
      await attention.hook(toTerminal('t1'), {
        source: 'codex',
        kind: 'activity',
        hookInput: { hook_event_name: 'PreToolUse', session_id: 's' },
      });

      expect(!!terminal('t1').agentActive).toBe(false);
    });

    it('still name the workspace and record the reply', async () => {
      const { attention, promptSubmitted, agentReplied, toTerminal } = harness();
      attention.programStatusChanged('t1', codex('idle'));

      await attention.hook(toTerminal('t1'), prompt());
      await attention.hook(toTerminal('t1'), stop());

      expect(promptSubmitted).toHaveBeenCalledWith('ws-1', 'Fix the tests', 't1');
      expect(agentReplied).toHaveBeenCalledWith('ws-1', 'Fixed', 't1');
    });

    it('copied from the device that owns the Terminal leave the spinner, name and reply to it', async () => {
      const { attention, terminal, promptSubmitted, agentReplied, toTerminal } = harness();
      attention.programStatusChanged('t1', codex('idle'));

      await attention.hook(toTerminal('t1'), { ...prompt(), copy: true });
      await attention.hook(toTerminal('t1'), {
        source: 'codex',
        kind: 'activity',
        copy: true,
        hookInput: { hook_event_name: 'PreToolUse', session_id: 's' },
      });
      await attention.hook(toTerminal('t1'), { ...stop(), copy: true });

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(promptSubmitted).not.toHaveBeenCalled();
      expect(agentReplied).not.toHaveBeenCalled();
    });

    it("copied from the device that owns the Terminal leave Codex's summary to it", async () => {
      const { attention, agentReplied, toTerminal } = harness();
      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));

      await attention.hook(toTerminal('t1'), { ...prompt(), copy: true });
      attention.programStatusChanged('t1', { app: 'codex', state: 'done', msg: 'Summary' });

      expect(agentReplied).not.toHaveBeenCalled();
    });

    it('copied from the device that owns the Terminal leave the reply of a turn that started a server to it', async () => {
      const { attention, agentReplied, toTerminal } = harness();
      started(attention, 't1');
      attention.programStatusChanged('t1', codex('working'));

      await attention.hook(toTerminal('t1'), { ...prompt(), copy: true });
      await attention.hook(toTerminal('t1'), { ...activity('npm run dev'), copy: true });
      await attention.hook(toTerminal('t1'), { ...stop(), copy: true });

      expect(agentReplied).not.toHaveBeenCalled();
    });

    it('drive the spinner again once Codex has quit', async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', codex('idle'));
      attention.programStatusChanged('t1', { state: 'clear' });

      await attention.hook(toTerminal('t1'), prompt());

      expect(terminal('t1').agentActive).toBe(true);
    });
  });

  it('forgets the status when the Terminal is replaced', async () => {
    const { attention, terminal, toTerminal } = harness();
    attention.programStatusChanged('t1', codex('idle'));

    attention.replaced('t1');
    await attention.hook(toTerminal('t1'), prompt());

    expect(terminal('t1').agentActive).toBe(true);
  });
});
