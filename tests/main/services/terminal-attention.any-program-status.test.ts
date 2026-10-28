import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminal, createWorkspace } from '../../factories';
import { createAttentionHarness } from '../../helpers/terminal-attention';

import { BACKGROUND_HOLD_LIMIT_MS } from '../../../src/main/services/terminal-attention/notification-lifecycle';
import {
  ANSWER_REPORT_WAIT_MS,
  STOP_HOOK_WAIT_MS,
  type AgentHook,
} from '../../../src/main/services/terminal-attention/terminal-attention';

vi.mock('electron', async () => (await import('../../mocks/electron')).mockElectron());

/** Local workspace ws-1 with Terminals t1 and t2. */
function harness() {
  return createAttentionHarness([
    createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 't1' }), createTerminal({ id: 't2' })],
    }),
  ]);
}

const pi = (state: string, msg?: string) => ({ app: 'pi', state, ...(msg && { msg }) });
const claude = (state: string, extra: { kind?: string; msg?: string; id?: string } = {}) => ({
  app: 'claude-code',
  state,
  ...extra,
});

const claudeHook = (kind: AgentHook['kind'], hookInput: Record<string, unknown> = {}) =>
  ({
    source: 'claude-code',
    kind,
    hookInput: { session_id: 's', ...hookInput },
  }) as AgentHook;
const prompt = (text = 'Fix the tests') =>
  claudeHook('prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: text });
const stop = (reply = 'Fixed', backgroundTasks: unknown[] = []) => ({
  ...claudeHook('turn-complete', {
    hook_event_name: 'Stop',
    last_assistant_message: reply,
    background_tasks: backgroundTasks,
  }),
  message: reply,
});
const runningShell = { type: 'shell', status: 'running', id: 'b1', command: 'sleep 20' };

describe('Terminal Attention State: the status any program reports in its Terminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('a program without hooks, as Pi reports', () => {
    it('spins while it works, and shows a done with its message when it is done', () => {
      const { attention, terminal, windows } = harness();

      attention.programStatusChanged('t1', pi('idle'));
      attention.programStatusChanged('t1', pi('working'));

      expect(terminal('t1').agentActive).toBe(true);

      attention.programStatusChanged('t1', pi('done', 'fixed the tests'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        source: 'pi',
        message: 'fixed the tests',
      });
      expect(windows.attentionRaised).toHaveBeenCalledTimes(1);
    });

    it('spins at once when it starts working with a prompt it was started with', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', pi('working'));

      expect(terminal('t1').agentActive).toBe(true);
    });

    it('stops quietly when it goes idle without a done, as when the user cancelled it', () => {
      const { attention, terminal, windows } = harness();

      attention.programStatusChanged('t1', pi('idle'));
      attention.programStatusChanged('t1', pi('working'));
      attention.programStatusChanged('t1', pi('idle'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toBeUndefined();
      expect(windows.attentionRaised).not.toHaveBeenCalled();
    });

    it('asks for input with its message while blocked, until it works again', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', pi('working'));
      attention.programStatusChanged('t1', {
        ...pi('blocked', 'Approve the plan'),
        kind: 'question',
      });

      expect(terminal('t1').attention).toMatchObject({
        kind: 'input-required',
        source: 'pi',
        message: 'Approve the plan',
      });

      attention.programStatusChanged('t1', pi('working'));

      expect(terminal('t1').attention).toBeUndefined();
      expect(terminal('t1').agentActive).toBe(true);
    });

    it('shows an error with its message', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', pi('working'));
      attention.programStatusChanged('t1', pi('error', 'rate limited'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'error', message: 'rate limited' });
    });

    it('records no reply from its done, without hooks to tell whose device records it', () => {
      const { attention, agentReplied } = harness();

      attention.programStatusChanged('t1', pi('working'));
      attention.programStatusChanged('t1', pi('done', 'fixed the tests'));

      expect(agentReplied).not.toHaveBeenCalled();
    });

    it('keeps spinning through a keypress that did not interrupt it', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', pi('working'));
      attention.aborted('t1');

      expect(terminal('t1').agentActive).toBe(true);
    });

    it('ignores a status that names no program', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', { state: 'working' });

      expect(!!terminal('t1').agentActive).toBe(false);
    });
  });

  describe("Claude Code's statuses", () => {
    it('ask for input with the command its permission prompt names', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged(
        't1',
        claude('blocked', { kind: 'permission', msg: 'approve Bash: npm install' })
      );

      expect(terminal('t1').attention).toMatchObject({
        kind: 'input-required',
        source: 'claude-code',
        message: 'approve Bash: npm install',
      });
    });

    it('end a turn the user interrupted quietly', () => {
      const { attention, terminal, windows } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('idle'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(windows.attentionRaised).not.toHaveBeenCalled();
    });

    it('fill in the done with the summary Claude reports a moment later, without raising it again', () => {
      const { attention, terminal, workspace, windows } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      attention.programStatusChanged('t1', claude('done', { msg: "replied 'hi'" }));

      expect(terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        message: "replied 'hi'",
      });
      expect(workspace('ws-1').attention?.message).toBe("replied 'hi'");
      expect(windows.attentionRaised).toHaveBeenCalledTimes(1);
    });

    it("leave the Terminal's state to its records, not a subagent's", () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('working', { id: 'a1' }));
      attention.programStatusChanged('t1', { state: 'clear', id: 'a1' });

      expect(terminal('t1').agentActive).toBe(true);
    });

    it('stop the spinner when Claude quits, keeping its attention', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('blocked', { kind: 'permission' }));
      attention.programStatusChanged('t1', { state: 'clear' });

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'input-required' });
    });

    it('keep asking for input after the user looked, until the prompt is answered', () => {
      const { attention, terminal, workspace } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('blocked', { kind: 'permission' }));
      attention.dismissed('t1');

      expect(terminal('t1').attention).toMatchObject({ kind: 'input-required' });
      expect(workspace('ws-1').attention).toMatchObject({ kind: 'input-required' });

      attention.programStatusChanged('t1', claude('working'));

      expect(terminal('t1').attention).toBeUndefined();
      expect(workspace('ws-1').attention).toBeUndefined();
    });

    it('keep asking for input across a reconnect, without asking again', () => {
      const { attention, terminal, windows } = harness();
      const prompt = claude('blocked', { kind: 'permission', msg: 'approve Bash: npm install' });

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', prompt);
      // An SSH Terminal's connection ends, and its host repeats the status once Komla is back.
      attention.attachmentEnded('t1');
      attention.programStatusChanged('t1', prompt);
      attention.dismissed('t1');

      expect(windows.attentionRaised).toHaveBeenCalledTimes(1);
      expect(terminal('t1').attention).toMatchObject({
        kind: 'input-required',
        message: 'approve Bash: npm install',
      });

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });
    });

    it('ask again for the same prompt once the last one was answered', () => {
      const { attention, windows } = harness();
      const prompt = claude('blocked', { kind: 'permission', msg: 'approve Bash: npm install' });

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', prompt);
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', prompt);

      expect(windows.attentionRaised).toHaveBeenCalledTimes(2);
    });

    it('stop asking for input when the user cancels the prompt', () => {
      const { attention, terminal, workspace } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('blocked', { kind: 'question' }));
      attention.dismissed('t1');
      attention.programStatusChanged('t1', claude('idle'));

      expect(terminal('t1').attention).toBeUndefined();
      expect(workspace('ws-1').attention).toBeUndefined();
      expect(!!terminal('t1').agentActive).toBe(false);
    });

    it('let the user dismiss the input request once Claude quit', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('blocked', { kind: 'permission' }));
      attention.dismissed('t1');
      attention.programStatusChanged('t1', { state: 'clear' });
      attention.dismissed('t1');

      expect(terminal('t1').attention).toBeUndefined();
    });

    it('stop asking for input when Claude reports nothing after a key that answers, as when it died', () => {
      const { attention, terminal, workspace } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('blocked', { kind: 'permission' }));
      attention.answerKeyPressed('t1');
      vi.advanceTimersByTime(ANSWER_REPORT_WAIT_MS - 1);

      expect(terminal('t1').attention).toMatchObject({ kind: 'input-required' });

      vi.advanceTimersByTime(1);

      expect(terminal('t1').attention).toBeUndefined();
      expect(workspace('ws-1').attention).toBeUndefined();
    });

    it('keep asking for input when Claude reports the next prompt after the key', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged(
        't1',
        claude('blocked', { kind: 'question', msg: 'answer: A' })
      );
      attention.answerKeyPressed('t1');
      attention.programStatusChanged(
        't1',
        claude('blocked', { kind: 'question', msg: 'answer: B' })
      );
      vi.advanceTimersByTime(ANSWER_REPORT_WAIT_MS);
      attention.dismissed('t1');

      expect(terminal('t1').attention).toMatchObject({
        kind: 'input-required',
        message: 'answer: B',
      });
    });

    it('show the done of a turn that ended on the prompt', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('blocked', { kind: 'permission' }));
      attention.programStatusChanged('t1', claude('done'));
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });
    });

    it('show the error of a turn that failed on the prompt', () => {
      const { attention, terminal } = harness();

      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('blocked', { kind: 'permission' }));
      attention.programStatusChanged('t1', claude('error', { msg: 'Overloaded' }));

      expect(terminal('t1').attention).toMatchObject({ kind: 'error', message: 'Overloaded' });
    });
  });

  describe("Claude Code's hooks while Claude reports", () => {
    it('leave the spinner to the statuses', async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));

      await attention.hook(toTerminal('t1'), prompt());
      await attention.hook(
        toTerminal('t1'),
        claudeHook('activity', { hook_event_name: 'PreToolUse' })
      );

      expect(!!terminal('t1').agentActive).toBe(false);
    });

    it('leave the spinner to the statuses when copied from the device that owns the Terminal', async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));

      await attention.hook(toTerminal('t1'), { ...prompt(), copy: true });
      await attention.hook(toTerminal('t1'), {
        ...claudeHook('activity', { hook_event_name: 'PreToolUse' }),
        copy: true,
      });

      expect(!!terminal('t1').agentActive).toBe(false);
    });

    it('show the done once when the Stop is copied, leaving the name and reply to its owner', async () => {
      const { attention, terminal, windows, promptSubmitted, agentReplied, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), { ...prompt(), copy: true });
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      await attention.hook(toTerminal('t1'), { ...stop(), copy: true });

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', message: 'Fixed' });
      expect(windows.attentionRaised).toHaveBeenCalledTimes(1);
      expect(promptSubmitted).not.toHaveBeenCalled();
      expect(agentReplied).not.toHaveBeenCalled();
    });

    it('still name the workspace, dismiss the last error and record the reply', async () => {
      const { attention, terminal, promptSubmitted, agentReplied, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('error', { msg: 'overloaded' }));

      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      await attention.hook(toTerminal('t1'), stop());

      expect(terminal('t1').attention).toBeUndefined();
      expect(promptSubmitted).toHaveBeenCalledWith('ws-1', 'Fix the tests', 't1');
      expect(agentReplied).toHaveBeenCalledWith('ws-1', 'Fixed', 't1');
    });

    it('show the done once the Stop arrives, with its reply', async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));

      expect(terminal('t1').agentActive).toBe(true);
      expect(terminal('t1').attention).toBeUndefined();

      await attention.hook(toTerminal('t1'), stop());

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', message: 'Fixed' });
    });

    it('show the done at once when the Stop came first', async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      await attention.hook(toTerminal('t1'), stop());
      attention.programStatusChanged('t1', claude('done'));

      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', message: 'Fixed' });
    });

    it('show the done without a Stop after a moment, as after a /compact', async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });
    });

    it('hold the done while background work its Stop names runs, until Claude resumes and is done', async () => {
      const { attention, terminal, windows, promptSubmitted, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      await attention.hook(toTerminal('t1'), stop('Started', [runningShell]));
      vi.advanceTimersByTime(60_000);

      expect(terminal('t1').agentActive).toBe(true);
      expect(terminal('t1').attention).toBeUndefined();

      // Claude resumes the turn as the background work ends.
      await attention.hook(toTerminal('t1'), prompt('<task-notification>b1 completed'));
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      await attention.hook(toTerminal('t1'), stop('It finished'));

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        message: 'It finished',
      });
      expect(windows.attentionRaised).toHaveBeenCalledTimes(1);
      expect(promptSubmitted).toHaveBeenCalledTimes(1);
    });

    it('show the summary of the last done, not the reply from before the background work, when no Stop follows', async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      await attention.hook(toTerminal('t1'), stop('Started', [runningShell]));
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done', { msg: 'The tests pass' }));
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);

      expect(terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        message: 'The tests pass',
      });
    });

    it('record the summary a later done carries as the reply, over the Stop’s', async () => {
      const { attention, agentReplied, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      await attention.hook(toTerminal('t1'), stop());
      attention.programStatusChanged('t1', claude('done', { msg: 'The tests pass' }));

      expect(agentReplied).toHaveBeenLastCalledWith('ws-1', 'The tests pass', 't1');
    });

    it('keep the summary as the reply when the Stop comes after it', async () => {
      const { attention, agentReplied, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done', { msg: 'The tests pass' }));
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);
      await attention.hook(toTerminal('t1'), stop());

      expect(agentReplied).toHaveBeenCalledExactlyOnceWith('ws-1', 'The tests pass', 't1');
    });

    it('leave the summary to the device the Stop is copied from', async () => {
      const { attention, agentReplied, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), { ...prompt(), copy: true });
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      await attention.hook(toTerminal('t1'), { ...stop(), copy: true });
      attention.programStatusChanged('t1', claude('done', { msg: 'The tests pass' }));

      expect(agentReplied).not.toHaveBeenCalled();
    });

    it('record no summary of a turn that failed', async () => {
      const { attention, agentReplied, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      await attention.hook(toTerminal('t1'), {
        ...claudeHook('error', { hook_event_name: 'StopFailure' }),
        message: 'Overloaded',
      });
      attention.programStatusChanged('t1', claude('done'));
      attention.programStatusChanged('t1', claude('done', { msg: 'Nothing changed' }));

      expect(agentReplied).not.toHaveBeenCalled();
    });

    it('record no summary of a turn whose StopFailure comes after its done shows', async () => {
      const { attention, agentReplied, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);
      await attention.hook(toTerminal('t1'), {
        ...claudeHook('error', { hook_event_name: 'StopFailure' }),
        message: 'Overloaded',
      });
      attention.programStatusChanged('t1', claude('done', { msg: 'Nothing changed' }));

      expect(agentReplied).not.toHaveBeenCalled();
    });

    it('show the error a StopFailure reports, though Claude reported the turn done', async () => {
      const { attention, terminal, toTerminal } = harness();
      const stopFailure = {
        ...claudeHook('error', { hook_event_name: 'StopFailure' }),
        message: 'Overloaded',
      };
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      await attention.hook(toTerminal('t1'), stopFailure);

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'error', message: 'Overloaded' });

      attention.dismissed('t1');
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      await attention.hook(toTerminal('t1'), stopFailure);
      attention.programStatusChanged('t1', claude('done'));

      expect(terminal('t1').attention).toMatchObject({ kind: 'error', message: 'Overloaded' });
    });

    it('show a held done once the hold runs out', async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      await attention.hook(toTerminal('t1'), stop('Started', [runningShell]));
      attention.programStatusChanged('t1', claude('done'));
      vi.advanceTimersByTime(BACKGROUND_HOLD_LIMIT_MS);

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(terminal('t1').attention).toMatchObject({ kind: 'turn-complete', message: 'Started' });
    });

    it('end a held turn quietly when the user interrupts it', async () => {
      const { attention, terminal, windows, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('done'));
      await attention.hook(toTerminal('t1'), stop('Started', [runningShell]));
      attention.aborted('t1', true);
      vi.advanceTimersByTime(BACKGROUND_HOLD_LIMIT_MS);

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(windows.attentionRaised).not.toHaveBeenCalled();
    });

    it('name the workspace from a prompt sent just after the user interrupted the last turn', async () => {
      const { attention, promptSubmitted, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt('Try again'));

      expect(promptSubmitted).toHaveBeenLastCalledWith('ws-1', 'Try again', 't1');
    });

    it('end a turn the user interrupted quietly, though a Stop is due', async () => {
      const { attention, terminal, windows, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('idle'));
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', claude('working'));
      attention.programStatusChanged('t1', claude('idle'));
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(windows.attentionRaised).not.toHaveBeenCalled();
    });
  });

  describe('a program that ends every turn idle, whose hooks tell how it ended, as OpenCode 2', () => {
    const opencode = (state: string) => ({ app: 'opencode', state });
    const openCodeHook = (kind: AgentHook['kind'], event: string, message?: string) =>
      ({
        source: 'opencode',
        kind,
        message,
        hookInput: { hook_event_name: event, sessionID: 'ses_1' },
      }) as AgentHook;

    async function promptedTurn(h: ReturnType<typeof harness>) {
      h.attention.programStatusChanged('t1', opencode('idle'));
      await h.attention.hook(
        h.toTerminal('t1'),
        openCodeHook('prompt-submit', 'UserPromptSubmit', 'Fix the tests')
      );
      h.attention.programStatusChanged('t1', opencode('working'));
    }

    it('stops spinning at the idle, and shows the done its Stop then reports', async () => {
      const h = harness();
      await promptedTurn(h);
      h.attention.programStatusChanged('t1', opencode('idle'));

      expect(!!h.terminal('t1').agentActive).toBe(false);
      expect(h.terminal('t1').attention).toBeUndefined();

      await h.attention.hook(
        h.toTerminal('t1'),
        openCodeHook('turn-complete', 'Stop', 'OpenCode finished')
      );

      expect(h.terminal('t1').attention).toMatchObject({
        kind: 'turn-complete',
        source: 'opencode',
        message: 'OpenCode finished',
      });
    });

    it('shows the done at the idle when its Stop came first', async () => {
      const h = harness();
      await promptedTurn(h);
      await h.attention.hook(
        h.toTerminal('t1'),
        openCodeHook('turn-complete', 'Stop', 'OpenCode finished')
      );

      expect(h.terminal('t1').agentActive).toBe(true);

      h.attention.programStatusChanged('t1', opencode('idle'));

      expect(!!h.terminal('t1').agentActive).toBe(false);
      expect(h.terminal('t1').attention).toMatchObject({ kind: 'turn-complete' });
    });

    it('shows the error its StopFailure reports, before or after the idle', async () => {
      const h = harness();
      await promptedTurn(h);
      h.attention.programStatusChanged('t1', opencode('idle'));
      await h.attention.hook(
        h.toTerminal('t1'),
        openCodeHook('error', 'StopFailure', 'Invalid API key')
      );

      expect(h.terminal('t1').attention).toMatchObject({
        kind: 'error',
        message: 'Invalid API key',
      });

      h.attention.dismissed('t1');
      await promptedTurn(h);
      await h.attention.hook(
        h.toTerminal('t1'),
        openCodeHook('error', 'StopFailure', 'Rate limited')
      );
      h.attention.programStatusChanged('t1', opencode('idle'));

      expect(h.terminal('t1').attention).toMatchObject({ kind: 'error', message: 'Rate limited' });
    });

    it('shows the done of a turn that went on working after a StopFailure', async () => {
      const h = harness();
      await promptedTurn(h);
      await h.attention.hook(h.toTerminal('t1'), openCodeHook('error', 'StopFailure', 'Timeout'));
      h.attention.programStatusChanged('t1', opencode('working'));
      await h.attention.hook(h.toTerminal('t1'), openCodeHook('turn-complete', 'Stop', 'Fixed'));
      h.attention.programStatusChanged('t1', opencode('idle'));

      expect(h.terminal('t1').attention).toMatchObject({ kind: 'turn-complete', message: 'Fixed' });
    });

    it('takes hooks naming no Terminal for the one Terminal of the workspace the program reports in', async () => {
      const h = harness();
      h.attention.programStatusChanged('t2', opencode('idle'));
      // OpenCode 2 runs plugins in a service its sessions share, so they name only the folder.
      await h.attention.hook(
        h.toWorkspace('ws-1'),
        openCodeHook('prompt-submit', 'UserPromptSubmit', 'Fix the tests')
      );
      h.attention.programStatusChanged('t2', opencode('working'));
      h.attention.programStatusChanged('t2', opencode('idle'));
      await h.attention.hook(
        h.toWorkspace('ws-1'),
        openCodeHook('turn-complete', 'Stop', 'OpenCode finished')
      );

      expect(h.promptSubmitted).toHaveBeenCalledWith('ws-1', 'Fix the tests', 't2');
      expect(h.terminal('t2').attention).toMatchObject({ kind: 'turn-complete' });
      expect(h.workspace('ws-1').attention?.terminalId).toBe('t2');
      expect(!!h.workspace('ws-1').agentActive).toBe(false);
    });

    it('ends quietly when its Interrupt reports the turn cancelled, or no hook says', async () => {
      const h = harness();
      await promptedTurn(h);
      h.attention.programStatusChanged('t1', opencode('idle'));
      await h.attention.hook(h.toTerminal('t1'), openCodeHook('interrupted', 'Interrupt'));
      await h.attention.hook(
        h.toTerminal('t1'),
        openCodeHook('turn-complete', 'Stop', 'OpenCode finished')
      );

      expect(h.terminal('t1').attention).toBeUndefined();

      await promptedTurn(h);
      h.attention.programStatusChanged('t1', opencode('idle'));
      vi.advanceTimersByTime(STOP_HOOK_WAIT_MS);
      await h.attention.hook(
        h.toTerminal('t1'),
        openCodeHook('turn-complete', 'Stop', 'OpenCode finished')
      );

      expect(h.terminal('t1').attention).toBeUndefined();
      expect(h.windows.attentionRaised).not.toHaveBeenCalled();
    });
  });

  describe("another agent's hooks that the program in the Terminal runs", () => {
    it("don't drive its spinner, as when Grok runs Claude Code's hooks", async () => {
      const { attention, terminal, promptSubmitted, toTerminal } = harness();
      attention.programStatusChanged('t1', { app: 'grok-build', state: 'idle' });

      await attention.hook(toTerminal('t1'), prompt());

      expect(!!terminal('t1').agentActive).toBe(false);
      expect(promptSubmitted).toHaveBeenCalledWith('ws-1', 'Fix the tests', 't1');

      attention.programStatusChanged('t1', { app: 'grok-build', state: 'working' });
      await attention.hook(toTerminal('t1'), stop());

      expect(terminal('t1').agentActive).toBe(true);
      expect(terminal('t1').attention).toBeUndefined();
    });

    it("record their Stop's reply, not the program's summary", async () => {
      const { attention, agentReplied, toTerminal } = harness();
      attention.programStatusChanged('t1', { app: 'grok-build', state: 'idle' });
      await attention.hook(toTerminal('t1'), prompt());
      attention.programStatusChanged('t1', { app: 'grok-build', state: 'working' });
      await attention.hook(toTerminal('t1'), stop());
      attention.programStatusChanged('t1', { app: 'grok-build', state: 'done', msg: 'Summary' });

      expect(agentReplied).toHaveBeenCalledExactlyOnceWith('ws-1', 'Fixed', 't1');
    });

    it('leave a notice sent by hand to show as usual', async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', claude('working'));

      await attention.hook(toTerminal('t1'), {
        source: 'agent',
        kind: 'generic',
        message: 'Build finished',
      });

      expect(terminal('t1').attention).toMatchObject({ message: 'Build finished' });
    });

    it("still drive another Terminal's spinner", async () => {
      const { attention, terminal, toTerminal } = harness();
      attention.programStatusChanged('t1', { app: 'grok-build', state: 'idle' });

      await attention.hook(toTerminal('t2'), prompt());

      expect(terminal('t2').agentActive).toBe(true);
    });
  });

  it("leaves Antigravity's approval alerts to the status it reports", () => {
    const { attention, terminal } = harness();

    attention.programStatusChanged('t1', { app: 'antigravity', state: 'working' });
    attention.alertRaised({ terminalId: 't1', message: 'Approve running npm install?' });
    vi.advanceTimersByTime(5000);

    expect(terminal('t1').attention).toBeUndefined();
    expect(terminal('t1').agentActive).toBe(true);
  });
});
