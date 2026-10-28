import { readFileSync } from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKGROUND_HOLD_LIMIT_MS,
  COMPLETION_SETTLE_MS,
  INPUT_REQUIRED_SETTLE_MS,
} from '../../../src/main/services/terminal-attention/notification-lifecycle';
import {
  LATE_ACTIVITY_AFTER_INTERRUPT_MS,
  LATE_ACTIVITY_AFTER_UNCONFIRMED_INTERRUPT_MS,
} from '../../../src/main/services/terminal-attention/terminal-attention';
import {
  createSshWorkspace,
  createTerminal,
  createWorkspace,
  resetIdCounter,
} from '../../factories';
import { createAttentionHarness, type AttentionHarness } from '../../helpers/terminal-attention';

import type { AgentHook } from '../../../src/main/services/terminal-attention/terminal-attention';
import type { Terminal, WorkspaceAttention } from '../../../src/shared/types';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function localWorkspace(terminals: Terminal[] = [createTerminal({ id: 'term-1' })]) {
  return createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app', terminals });
}

/** Seeds spinner sources on Terminals, as if restored with the workspace. */
function sources(entries: Record<string, Record<string, number>>) {
  return new Map(
    Object.entries(entries).map(([terminalId, counts]) => [
      terminalId,
      new Map(Object.entries(counts)),
    ])
  );
}

beforeEach(() => {
  resetIdCounter();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agent hooks', () => {
  it.each(['codex', 'claude-code'])(
    'turns on the spinner for %s activity without naming the workspace or raising attention',
    async (source) => {
      const harness = createAttentionHarness([localWorkspace()]);
      const workspace = harness.workspace('ws-1');

      const outcome = await harness.settle(harness.toTerminal('term-1'), {
        cwd: '/projects/my-app',
        source,
        kind: 'activity',
        hookInput: { hook_event_name: 'PreToolUse', session_id: 'session-1' },
      });

      expect(outcome).toBe('taken');
      expect(harness.terminal('term-1').agentActive).toBe(true);
      expect(workspace.agentActive).toBe(true);
      expect(harness.store.broadcast).toHaveBeenCalledWith(workspace);
      expect(harness.promptSubmitted).not.toHaveBeenCalled();
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      expect(workspace.attention).toBeUndefined();
    }
  );

  it.each(['codex', 'claude-code', 'gemini', 'opencode'])(
    'lets %s activity cancel a settling completion, which is still taken',
    async (source) => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      const base = { cwd: '/projects/my-app', source };

      const stop = harness.attention.hook(target, {
        ...base,
        kind: 'turn-complete',
        hookInput: { hook_event_name: 'Stop', session_id: 'session-1', turn_id: 'turn-1' },
      });
      await vi.advanceTimersByTimeAsync(100);
      await harness.settle(target, {
        ...base,
        kind: 'activity',
        hookInput: {
          hook_event_name: source === 'gemini' ? 'BeforeTool' : 'PreToolUse',
          session_id: 'session-1',
          turn_id: 'turn-1',
        },
      });

      // Its delivery is still made durable.
      await expect(stop).resolves.toBe('taken');
      expect(harness.terminal('term-1').attention).toBeUndefined();
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      expect(harness.terminal('term-1').agentActive).toBe(true);
    }
  );

  it.each(['turn-complete', 'idle', 'input-required', 'error'] as const)(
    'lets activity clear only stale completion attention (%s)',
    async (kind) => {
      const shown: WorkspaceAttention = {
        kind,
        source: 'codex',
        updatedAt: Date.now(),
        terminalId: 'term-1',
      };
      const harness = createAttentionHarness([
        createWorkspace({
          id: 'ws-1',
          workingDirectory: '/projects/my-app',
          attention: shown,
          needsAttention: kind !== 'idle',
          terminals: [createTerminal({ id: 'term-1', attention: shown })],
        }),
      ]);

      await harness.settle(harness.toTerminal('term-1'), {
        cwd: '/projects/my-app',
        source: 'codex',
        kind: 'activity',
      });

      if (kind === 'turn-complete' || kind === 'idle') {
        expect(harness.terminal('term-1').attention).toBeUndefined();
        expect(harness.workspace('ws-1').attention).toBeUndefined();
      } else {
        expect(harness.terminal('term-1').attention).toBe(shown);
        expect(harness.workspace('ws-1').attention).toBe(shown);
      }
      expect(harness.promptSubmitted).not.toHaveBeenCalled();
    }
  );

  it('shows a root completion only after it settles', async () => {
    const harness = createAttentionHarness([localWorkspace()]);
    let outcome: string | undefined;

    void harness.attention
      .hook(harness.toTerminal('term-1'), {
        cwd: '/projects/my-app',
        source: 'codex',
        kind: 'turn-complete',
        hookInput: { hook_event_name: 'Stop', session_id: 's', turn_id: 't' },
      })
      .then((result) => (outcome = result));
    await vi.advanceTimersByTimeAsync(700);

    expect(outcome).toBeUndefined();
    expect(harness.terminal('term-1').attention).toBeUndefined();
    expect(harness.windows.attentionRaised).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(outcome).toBe('taken');
    expect(harness.terminal('term-1').attention).toEqual(
      expect.objectContaining({ kind: 'turn-complete', terminalId: 'term-1' })
    );
    expect(harness.workspace('ws-1').needsAttention).toBe(true);
    expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        attention: expect.objectContaining({ kind: 'turn-complete', terminalId: 'term-1' }),
      })
    );
  });

  describe('a permission request OpenCode answers automatically', () => {
    const base = { cwd: '/projects/my-app', source: 'opencode' };
    const request: AgentHook = {
      ...base,
      kind: 'input-required',
      hookInput: {
        hook_event_name: 'PermissionRequest',
        sessionID: 'ses_1',
        permissionID: 'per_1',
        tool_name: 'bash',
      },
    };
    const reply: AgentHook = {
      ...base,
      kind: 'activity',
      hookInput: { hook_event_name: 'PreToolUse', sessionID: 'ses_1', permissionID: 'per_1' },
    };

    it('raises no attention when the reply arrives while the request settles', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');

      const asked = harness.attention.hook(target, request);
      await vi.advanceTimersByTimeAsync(30);
      await harness.settle(target, reply);

      await expect(asked).resolves.toBe('taken');
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      expect(harness.terminal('term-1').attention).toBeUndefined();
      expect(harness.terminal('term-1').agentActive).toBe(true);
    });

    it('raises no attention when the reply arrives soon after an Esc', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      // A single Esc doesn't interrupt OpenCode, so the turn carries on.
      harness.attention.aborted('term-1');

      const asked = harness.attention.hook(target, request);
      await vi.advanceTimersByTimeAsync(30);
      await harness.settle(target, reply);

      await expect(asked).resolves.toBe('taken');
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
    });

    it('still raises it when only a parallel tool call starts', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');

      const asked = harness.attention.hook(target, request);
      await vi.advanceTimersByTimeAsync(8);
      await harness.attention.hook(target, {
        ...base,
        kind: 'activity',
        hookInput: { hook_event_name: 'PreToolUse', sessionID: 'ses_1', tool_name: 'read' },
      });
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(INPUT_REQUIRED_SETTLE_MS);

      await expect(asked).resolves.toBe('taken');
      expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
        expect.objectContaining({
          attention: expect.objectContaining({ kind: 'input-required', terminalId: 'term-1' }),
        })
      );
    });
  });

  describe('an idle reminder after a Stop', () => {
    const stop: AgentHook = {
      cwd: '/projects/my-app',
      source: 'claude-code',
      kind: 'turn-complete',
      hookInput: { hook_event_name: 'Stop', session_id: 'session-1', prompt_id: 'p1' },
    };
    const idle: AgentHook = {
      cwd: '/projects/my-app',
      source: 'claude-code',
      kind: 'idle',
      hookInput: {
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        session_id: 'session-1',
      },
    };

    it('keeps the shown completion', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      await harness.settle(harness.toTerminal('term-1'), stop);
      const done = harness.terminal('term-1').attention;
      expect(done).toEqual(expect.objectContaining({ kind: 'turn-complete' }));

      const outcome = await harness.settle(harness.toTerminal('term-1'), idle);

      expect(outcome).toBe('taken');
      expect(harness.terminal('term-1').attention).toBe(done);
      expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
    });

    it("keeps the completion while another Terminal's agent works", async () => {
      const harness = createAttentionHarness([
        localWorkspace([createTerminal({ id: 'term-1' }), createTerminal({ id: 'term-2' })]),
      ]);
      await harness.settle(harness.toTerminal('term-2'), {
        cwd: '/projects/my-app',
        source: 'codex',
        kind: 'activity',
      });
      await harness.settle(harness.toTerminal('term-1'), stop);
      const done = harness.terminal('term-1').attention;
      expect(done).toEqual(expect.objectContaining({ kind: 'turn-complete' }));
      await vi.advanceTimersByTimeAsync(2_000);

      const outcome = await harness.settle(harness.toTerminal('term-1'), idle);

      expect(outcome).toBe('taken');
      expect(harness.terminal('term-1').attention).toBe(done);
      expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
    });

    it('shows nothing once the user dismissed the completion', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      await harness.settle(harness.toTerminal('term-1'), stop);
      harness.attention.dismissed('term-1');

      const outcome = await harness.settle(harness.toTerminal('term-1'), idle);

      expect(outcome).toBe('taken');
      expect(harness.terminal('term-1').attention).toBeUndefined();
      expect(harness.workspace('ws-1').attention).toBeUndefined();
      expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['turn-complete', 'input-required', 'error'] as const)(
    'keeps a shown %s when idle arrives for the same terminal without a Stop',
    async (kind) => {
      const shown: WorkspaceAttention = {
        kind,
        source: 'claude-code',
        updatedAt: 1,
        terminalId: 'term-1',
      };
      const harness = createAttentionHarness([
        createWorkspace({
          id: 'ws-1',
          workingDirectory: '/projects/my-app',
          attention: shown,
          needsAttention: true,
          terminals: [createTerminal({ id: 'term-1', attention: shown })],
        }),
      ]);

      await harness.settle(harness.toTerminal('term-1'), {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'idle',
      });

      expect(harness.terminal('term-1').attention).toBe(shown);
      expect(harness.workspace('ws-1').attention).toBe(shown);
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
    }
  );

  describe('turns that end without a Stop', () => {
    const toolUse: AgentHook = {
      cwd: '/projects/my-app',
      source: 'claude-code',
      kind: 'activity',
      hookInput: { hook_event_name: 'PreToolUse', session_id: 's', prompt_id: 'p1' },
    };

    it('ends a Claude turn that fails on an API error, unlike an error a script reports from a hook', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, toolUse);

      await harness.settle(target, {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'error',
        message: '529 Overloaded',
        hookInput: { hook_event_name: 'StopFailure', session_id: 's', error: 'server_error' },
      });

      expect(harness.terminal('term-1').agentActive).toBe(false);
      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ kind: 'error', message: '529 Overloaded' })
      );
      // Tool activity from before the failure, arriving late, is old news.
      await harness.settle(target, toolUse);
      expect(harness.terminal('term-1').agentActive).toBe(false);
    });

    it('keeps the spinner on when a script reports an error from some other hook', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, toolUse);

      await harness.settle(target, {
        cwd: '/projects/my-app',
        source: 'my-script',
        kind: 'error',
        message: 'Deploy failed',
      });
      // `komla notify --kind error` in a Claude PostToolUse hook passes Claude's input along.
      await harness.settle(target, {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'error',
        message: 'Lint failed',
        hookInput: { hook_event_name: 'PostToolUse', session_id: 's' },
      });

      expect(harness.terminal('term-1').agentActive).toBe(true);
    });

    it('stops the spinner without news when Codex reports an interrupt', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      const codexToolUse: AgentHook = {
        cwd: '/projects/my-app',
        source: 'codex',
        kind: 'activity',
        hookInput: { hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't1' },
      };
      await harness.settle(target, codexToolUse);

      const outcome = await harness.settle(target, {
        cwd: '/projects/my-app',
        source: 'codex',
        kind: 'interrupted',
        hookInput: { hook_event_name: 'Interrupt', session_id: 's', turn_id: 't1' },
      });

      expect(outcome).toBe('taken');
      expect(harness.terminal('term-1').agentActive).toBe(false);
      expect(harness.terminal('term-1').attention).toBeUndefined();
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      // The hook itself reaches the other installations showing the Terminal.
      expect(harness.relay.interrupted).not.toHaveBeenCalled();
      await harness.settle(target, codexToolUse);
      expect(harness.terminal('term-1').agentActive).toBe(false);
    });

    it('keeps a settling Stop when tool activity from before an interrupt arrives late', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, toolUse);
      harness.attention.aborted('term-1', true);

      void harness.attention.hook(target, {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'turn-complete',
        hookInput: { hook_event_name: 'Stop', session_id: 's', prompt_id: 'p1' },
      });
      await vi.advanceTimersByTimeAsync(100);
      void harness.attention.hook(target, toolUse);
      await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);

      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ kind: 'turn-complete' })
      );
      expect(harness.terminal('term-1').agentActive).toBe(false);
    });

    it('ignores tool activity reported just after an interrupt, until a new prompt', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      harness.attention.aborted('term-1', true);
      await harness.settle(target, toolUse);
      expect(harness.terminal('term-1').agentActive).toBeFalsy();
      expect(harness.turnActivity).not.toHaveBeenCalled();

      await harness.settle(target, {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'prompt-submit',
        hookInput: { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt_id: 'p2' },
      });
      // The new turn's tool activity is current again, so it cancels a settling Stop.
      void harness.attention.hook(target, {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'turn-complete',
        hookInput: { hook_event_name: 'Stop', session_id: 's', prompt_id: 'p2' },
      });
      await vi.advanceTimersByTimeAsync(100);
      void harness.attention.hook(target, {
        ...toolUse,
        hookInput: { hook_event_name: 'PreToolUse', session_id: 's', prompt_id: 'p2' },
      });
      await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);

      expect(harness.terminal('term-1').attention).toBeUndefined();
      expect(harness.terminal('term-1').agentActive).toBe(true);
    });

    it('shows a manual compact as done once an interrupt the title confirmed ended the turn', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      const compact = {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'turn-complete',
        message: 'Compacted the conversation',
        hookInput: { hook_event_name: 'PostCompact', session_id: 's', trigger: 'manual' },
      } as const;
      await harness.settle(target, {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'prompt-submit',
        hookInput: { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt_id: 'p1' },
      });
      // A Ctrl-C may only clear typed text while /code-review's turn runs on.
      harness.attention.aborted('term-1', false);
      await harness.settle(target, compact);
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();

      harness.attention.aborted('term-1', true);
      await harness.settle(target, compact);
      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ kind: 'turn-complete', message: 'Compacted the conversation' })
      );
    });

    it('treats tool activity as late news after an interrupt, briefly unless the title confirmed it', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      // Claude keeps a static title under tmux, as in every SSH workspace, so no title confirms
      // the Esc there. A tool call it reported just before still arrives late through the
      // mailbox, but an Esc that only closed a menu soon lets the next tool call through.
      await harness.settle(target, toolUse);
      harness.attention.aborted('term-1', false);
      expect(harness.terminal('term-1').agentActive).toBe(false);
      await harness.settle(target, toolUse);
      expect(harness.terminal('term-1').agentActive).toBe(false);
      await vi.advanceTimersByTimeAsync(LATE_ACTIVITY_AFTER_UNCONFIRMED_INTERRUPT_MS);
      await harness.settle(target, toolUse);
      expect(harness.terminal('term-1').agentActive).toBe(true);

      // An interrupt the title confirmed holds back longer, and a second keypress doesn't cut it.
      harness.attention.aborted('term-1', true);
      harness.attention.aborted('term-1', false);
      await vi.advanceTimersByTimeAsync(LATE_ACTIVITY_AFTER_UNCONFIRMED_INTERRUPT_MS);
      await harness.settle(target, toolUse);
      expect(harness.terminal('term-1').agentActive).toBe(false);
      await vi.advanceTimersByTimeAsync(LATE_ACTIVITY_AFTER_INTERRUPT_MS);
      await harness.settle(target, toolUse);
      expect(harness.terminal('term-1').agentActive).toBe(true);

      // The title spinning again shows the agent working, say after an approval it waited on.
      harness.attention.aborted('term-1', true);
      harness.attention.titleChanged('term-1', '✳ Fix tests');
      await harness.settle(target, toolUse);
      expect(harness.terminal('term-1').agentActive).toBe(false);
      harness.attention.titleChanged('term-1', '◐ Fix tests');
      await harness.settle(target, toolUse);
      expect(harness.terminal('term-1').agentActive).toBe(true);
    });
  });

  describe('a command run with `komla notify --`', () => {
    // The hooks the CLI sends for `komla notify -- npm run build`.
    const command = (hook: Partial<AgentHook>, event: string): AgentHook => ({
      cwd: '/projects/my-app',
      source: 'command',
      message: '',
      hookInput: { hook_event_name: event },
      ...hook,
    });
    const started = command({ kind: 'prompt-submit' }, 'UserPromptSubmit');

    const agentStarted: AgentHook = {
      cwd: '/projects/my-app',
      source: 'claude-code',
      kind: 'prompt-submit',
      message: 'Fix the build',
      hookInput: { hook_event_name: 'UserPromptSubmit' },
    };

    it('shows the Terminal working without naming the workspace after the command', async () => {
      const harness = createAttentionHarness([localWorkspace()]);

      await harness.settle(harness.toTerminal('term-1'), started);

      expect(harness.terminal('term-1').agentActive).toBe(true);
      expect(harness.promptSubmitted).not.toHaveBeenCalled();
    });

    it('marks the Terminal as running a command until an agent works there too', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');

      await harness.settle(target, started);
      expect(harness.terminal('term-1').commandActive).toBe(true);

      await harness.settle(target, agentStarted);
      expect(harness.terminal('term-1').commandActive).toBe(false);
    });

    it('records no agent milestone', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');

      await harness.settle(target, started);
      await harness.settle(target, command({ kind: 'turn-complete', title: 'Done' }, 'Stop'));

      expect(harness.milestone).not.toHaveBeenCalled();
    });

    it.each([
      ['finishes', 'turn-complete', 'Stop'],
      ['fails', 'error', 'StopFailure'],
      ['is interrupted', 'interrupted', 'Interrupt'],
    ] as const)(
      'leaves an agent in the same Terminal working when the command %s',
      async (_, kind, event) => {
        const harness = createAttentionHarness([localWorkspace()]);
        const target = harness.toTerminal('term-1');
        await harness.settle(target, agentStarted);
        await harness.settle(target, started);

        await harness.settle(target, command({ kind }, event));

        expect(harness.terminal('term-1').agentActive).toBe(true);
        expect(harness.terminal('term-1').commandActive).toBeFalsy();
      }
    );

    it.each([
      ['finishes', 'turn-complete', 'Stop', 'Done'],
      ['fails', 'error', 'StopFailure', 'Failed'],
    ] as const)('stops the spinner and notifies when it %s', async (_, kind, event, title) => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, started);

      const body = 'npm run build finished in 3m 12s';
      await harness.settle(target, command({ kind, title, body }, event));

      expect(harness.terminal('term-1').agentActive).toBe(false);
      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ kind, source: 'command', title, body })
      );
    });

    it('stops the spinner without a notification after Ctrl-C', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, started);

      await harness.settle(target, command({ kind: 'interrupted' }, 'Interrupt'));

      expect(harness.terminal('term-1').agentActive).toBe(false);
      expect(harness.terminal('term-1').attention).toBeUndefined();
    });

    it('keeps running past a Ctrl-C or Ctrl-D typed in the Terminal, which stops an agent', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, agentStarted);
      await harness.settle(target, started);

      harness.attention.aborted('term-1');

      expect(harness.terminal('term-1').agentActive).toBe(true);
      expect(harness.terminal('term-1').commandActive).toBe(true);
    });

    it('shows a Done at once, so the next command starting keeps it', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, started);

      await harness.attention.hook(
        target,
        command({ kind: 'turn-complete', title: 'Done' }, 'Stop')
      );
      await harness.attention.hook(target, started);

      expect(harness.terminal('term-1').agentActive).toBe(true);
      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ kind: 'turn-complete', source: 'command' })
      );
    });

    it("leaves an agent's settling Stop and shown news alone", async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, agentStarted);
      const agentStop: AgentHook = {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'turn-complete',
        hookInput: { hook_event_name: 'Stop' },
      };

      const settling = harness.attention.hook(target, agentStop);
      await harness.attention.hook(target, started);
      await vi.advanceTimersByTimeAsync(COMPLETION_SETTLE_MS);
      await settling;
      await harness.attention.hook(target, started);

      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ kind: 'turn-complete', source: 'claude-code' })
      );
      expect(harness.terminal('term-1').commandActive).toBe(true);
    });

    it("leaves Codex's title fallback to Codex", async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, { cwd: '/projects/my-app', source: 'codex', kind: 'activity' });
      harness.attention.titleChanged('term-1', '⠋ project');

      await harness.settle(target, started);
      await harness.settle(target, command({ kind: 'turn-complete', title: 'Done' }, 'Stop'));
      harness.attention.titleChanged('term-1', 'project');
      await vi.advanceTimersByTimeAsync(2000);

      expect(harness.terminal('term-1').agentActive).toBe(false);
      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ kind: 'turn-complete', source: 'codex' })
      );
    });
  });

  describe('recorded Claude runs', () => {
    type TraceEvent = { at: number; payload: AgentHook & { terminalId: string } };

    // Replays hooks the komla CLI sent for a real Claude run, with their real timing, and
    // checks that nothing before the final Stop ends the turn.
    async function replayClaudeTrace(
      fixture: string,
      keep: (event: TraceEvent, index: number) => boolean = () => true
    ) {
      const harness = createAttentionHarness([localWorkspace()]);
      const trace = readFileSync(`${__dirname}/../../fixtures/claude/${fixture}`, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as TraceEvent)
        .filter(keep);
      const lastStop = trace.map(({ payload }) => payload.kind).lastIndexOf('turn-complete');
      let now = 0;
      for (const [index, { at, payload }] of trace.entries()) {
        await vi.advanceTimersByTimeAsync(at - now);
        now = at;
        if (index > 0 && index <= lastStop) {
          // Stops held for background work do not end the turn.
          expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
          expect(harness.terminal('term-1').attention).toBeUndefined();
          expect(harness.terminal('term-1').agentActive).toBe(true);
        }
        const { terminalId, ...hook } = payload;
        void harness.attention.hook(harness.toTerminal(terminalId), hook);
      }
      return harness;
    }

    function expectOneFinishedTurn(harness: AttentionHarness): void {
      expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
      expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          attention: expect.objectContaining({ kind: 'turn-complete', terminalId: 'term-1' }),
        })
      );
      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ kind: 'turn-complete', terminalId: 'term-1' })
      );
      expect(harness.workspace('ws-1').needsAttention).toBe(true);
      expect(harness.terminal('term-1').agentActive).toBe(false);
    }

    // Claude 2.1.292: Stop arrives while a background subagent runs; the last Stop lists the
    // `sleep 25` shell the subagent left running, and the recording ends before it exits.
    it('holds a background-subagent run for its shell', async () => {
      // Recorded with Subagent hooks, which Komla no longer installs.
      const harness = await replayClaudeTrace(
        'background-subagent-2.1.292.jsonl',
        ({ payload }) => !String(payload.hookInput?.hook_event_name).startsWith('Subagent')
      );
      await vi.advanceTimersByTimeAsync(6_000);

      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      expect(harness.terminal('term-1').attention).toBeUndefined();
      expect(harness.terminal('term-1').agentActive).toBe(true);
    });

    // Claude 2.1.296: the first Stop lists a running `npm test`, and Claude resumes the turn
    // with a <task-notification> prompt when the command exits.
    it('shows a background-shell run as one finished turn', async () => {
      const harness = await replayClaudeTrace('background-shell-2.1.296.jsonl');
      await vi.advanceTimersByTimeAsync(6_000);

      expectOneFinishedTurn(harness);
    });

    // Claude 2.1.296: a subagent starts `npm test` in the background and returns. The shell
    // outlives it, and Claude resumes the main turn when the command exits.
    it('shows a run whose subagent leaves a background shell as one finished turn', async () => {
      const harness = await replayClaudeTrace('background-subagent-shell-2.1.296.jsonl');
      await vi.advanceTimersByTimeAsync(6_000);

      expectOneFinishedTurn(harness);
    });

    // Claude 2.1.300: a manual /compact while a background subagent runs. The subagent hands
    // back over a minute later and Claude resumes the turn.
    it('shows a run compacted while its background subagent works as one finished turn', async () => {
      // Ends at the final Stop; the /compact and /exit run covers leaving Claude.
      const harness = await replayClaudeTrace(
        'compact-during-background-subagent-2.1.300.jsonl',
        ({ payload }) => payload.hookInput?.hook_event_name !== 'SessionEnd'
      );
      await vi.advanceTimersByTimeAsync(6_000);

      expectOneFinishedTurn(harness);
      // Only the user's prompt names the workspace, not the subagent's hand-back.
      expect(harness.promptSubmitted).toHaveBeenCalledTimes(1);
      expect(harness.promptSubmitted).toHaveBeenCalledWith(
        'ws-1',
        expect.stringMatching(/^Launch exactly one general-purpose subagent/),
        'term-1'
      );
    });

    // Claude 2.1.304: /code-review reviews in a background subagent and sends no Stop until the
    // review hands back, so a /compact meanwhile lands mid-turn.
    it('shows a run compacted while /code-review works as one finished turn', async () => {
      // Starts at /code-review, after a first turn, and ends at the final Stop.
      const harness = await replayClaudeTrace(
        'compact-during-code-review-2.1.304.jsonl',
        ({ payload }, index) => index >= 2 && payload.hookInput?.hook_event_name !== 'SessionEnd'
      );
      await vi.advanceTimersByTimeAsync(6_000);

      expectOneFinishedTurn(harness);
      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/^The `\/code-review` run finished/),
        })
      );
    });

    // Claude 2.1.296: a turn, then /compact and /exit. Neither sends a Stop, and each runs under
    // its own prompt id.
    it('shows a recorded Claude /compact as a finished turn and /exit as stopping the spinner', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const trace = readFileSync(
        `${__dirname}/../../fixtures/claude/compact-and-exit-2.1.296.jsonl`,
        'utf-8'
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as TraceEvent);
      const send = async (index: number) => {
        const { terminalId, ...hook } = trace[index].payload;
        await harness.settle(harness.toTerminal(terminalId), hook);
      };
      await send(0);
      await send(1);
      expectOneFinishedTurn(harness);
      harness.windows.attentionRaised.mockClear();

      await send(2);
      expectOneFinishedTurn(harness);
      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ message: 'Compacted the conversation' })
      );
      harness.windows.attentionRaised.mockClear();

      await send(3);
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      expect(harness.terminal('term-1').agentActive).toBe(false);
      // Claude quit, so tool activity that lands now is old news.
      await harness.settle(harness.toTerminal('term-1'), {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'activity',
        hookInput: { hook_event_name: 'PreToolUse', session_id: 's' },
      });
      expect(harness.terminal('term-1').agentActive).toBe(false);
    });

    it('completes a held turn at the hold limit when its background work never resumes it', async () => {
      // Ends at the Stop that lists the running `npm test`.
      const harness = await replayClaudeTrace(
        'background-shell-2.1.296.jsonl',
        (_event, index) => index < 3
      );
      await vi.advanceTimersByTimeAsync(BACKGROUND_HOLD_LIMIT_MS - 1_000);
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      expect(harness.terminal('term-1').agentActive).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);

      expectOneFinishedTurn(harness);
      // No hook delivery makes this completion durable.
      expect(harness.store.saveNow).toHaveBeenCalledWith('ws-1');
    });
  });

  it('ends a running Claude turn quietly on an idle prompt when Stop was missed', async () => {
    const harness = createAttentionHarness([localWorkspace()]);
    const workspace = harness.workspace('ws-1');
    harness.attention.restored(workspace, sources({ 'term-1': { 'claude-code': 1 } }));
    expect(workspace.agentActive).toBe(true);

    await harness.settle(harness.toTerminal('term-1'), {
      cwd: '/projects/my-app',
      source: 'claude-code',
      kind: 'idle',
    });

    expect(harness.terminal('term-1').agentActive).toBe(false);
    expect(workspace.agentActive).toBe(false);
    expect(harness.terminal('term-1').attention).toBeUndefined();
    expect(workspace.attention).toBeUndefined();
    expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
  });

  const taskNotification = '<task-notification>\n<task-id>a1</task-id>';
  // Claude 2.1.300 hands a background subagent's report back as an agent message.
  const agentMessage =
    '<agent-message from="a1">\n[Subagent hand-back] The report follows:\n  done\n</agent-message>';

  it.each([
    ['background work', 'terminal', taskNotification],
    ['a background subagent', 'terminal', agentMessage],
    ['a background subagent, after a newline,', 'terminal', `\n${agentMessage}`],
    ['background work', 'workspace', taskNotification],
  ] as const)(
    'starts the spinner but does not name the workspace from the Claude resume after %s (%s hook)',
    async (_work, scope, resume) => {
      const terminalHook = scope === 'terminal';
      const harness = createAttentionHarness([localWorkspace(terminalHook ? undefined : [])]);
      const target = terminalHook ? harness.toTerminal('term-1') : harness.toWorkspace('ws-1');
      const submit = (prompt: string) =>
        harness.settle(target, {
          cwd: '/projects/my-app',
          source: 'claude-code',
          kind: 'prompt-submit',
          hookInput: { hook_event_name: 'UserPromptSubmit', prompt },
        });

      await submit(resume);
      const spinner = terminalHook ? harness.terminal('term-1') : harness.workspace('ws-1');
      expect(spinner.agentActive).toBe(true);
      expect(harness.promptSubmitted).not.toHaveBeenCalled();
      // The agent works again, so the workspace is in use.
      expect(harness.turnActivity).toHaveBeenCalledWith('ws-1');

      await submit('Fix the build');
      expect(harness.promptSubmitted).toHaveBeenCalledTimes(1);
      expect(harness.promptSubmitted).toHaveBeenCalledWith(
        'ws-1',
        'Fix the build',
        terminalHook ? 'term-1' : undefined
      );
    }
  );

  it.each(['prompt-submit', 'activity', 'turn-complete', 'input-required', 'error'] as const)(
    'counts %s hooks as workspace activity',
    async (kind) => {
      const harness = createAttentionHarness([localWorkspace()]);

      await harness.settle(harness.toTerminal('term-1'), {
        cwd: '/projects/my-app',
        source: 'codex',
        kind,
      });

      expect(harness.turnActivity).toHaveBeenCalledWith('ws-1');
    }
  );

  it.each([
    ['an idle reminder', { kind: 'idle', hookInput: { hook_event_name: 'Notification' } }],
    ['a generic notification', { kind: 'generic', message: 'Claude is waiting for your input' }],
    ['Claude quitting', { kind: 'interrupted', hookInput: { hook_event_name: 'SessionEnd' } }],
  ] as const)('does not count %s as workspace activity', async (_hook, hook) => {
    const harness = createAttentionHarness([localWorkspace()]);

    const outcome = await harness.settle(harness.toTerminal('term-1'), {
      cwd: '/projects/my-app',
      source: 'claude-code',
      ...hook,
    });

    expect(outcome).toBe('taken');
    expect(harness.turnActivity).not.toHaveBeenCalled();
  });

  it('counts activity once the hook has changed the workspace', async () => {
    const harness = createAttentionHarness([localWorkspace()]);
    harness.turnActivity.mockImplementation(() => {
      expect(harness.terminal('term-1').attention?.kind).toBe('input-required');
    });

    await harness.settle(harness.toTerminal('term-1'), {
      cwd: '/projects/my-app',
      source: 'codex',
      kind: 'input-required',
    });

    expect(harness.turnActivity).toHaveBeenCalledOnce();
  });

  it('shows a workspace-matched completion and counts it on the badge', async () => {
    const harness = createAttentionHarness([localWorkspace([])]);

    const outcome = await harness.attention.hook(harness.toWorkspace('ws-1'), {
      cwd: '/projects/my-app',
      message: 'Turn completed',
      kind: 'turn-complete',
      source: 'codex',
    });

    expect(outcome).toBe('taken');
    expect(harness.workspace('ws-1').attention).toEqual(
      expect.objectContaining({ kind: 'turn-complete', message: 'Turn completed' })
    );
    expect(harness.workspace('ws-1').needsAttention).toBe(true);
    expect(harness.windows.badge).toHaveBeenLastCalledWith(1);
  });

  it('shows a custom notification with its presentation', async () => {
    const harness = createAttentionHarness([localWorkspace([])]);
    const presentation = {
      title: 'Review ready',
      body: 'Authentication changes are waiting.',
      color: 'oklch(62% 0.2 285)',
      badge: 'Review',
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      iconColor: 'foreground',
    };

    const outcome = await harness.attention.hook(harness.toWorkspace('ws-1'), {
      cwd: '/projects/my-app',
      ...presentation,
    });

    expect(outcome).toBe('taken');
    expect(harness.workspace('ws-1').attention).toEqual(
      expect.objectContaining({ kind: 'generic', ...presentation })
    );
    expect(harness.workspace('ws-1').attention?.terminalId).toBeUndefined();
    expect(harness.workspace('ws-1').needsAttention).toBe(true);
    expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        attention: expect.objectContaining(presentation),
      })
    );
  });

  it('keeps custom source labels verbatim', async () => {
    const harness = createAttentionHarness([localWorkspace([])]);
    const target = harness.toWorkspace('ws-1');
    await harness.settle(target, {
      cwd: '/projects/my-app',
      kind: 'prompt-submit',
      source: 'my-agent',
    });
    expect(harness.workspace('ws-1').agentActive).toBe(true);

    await harness.settle(target, {
      cwd: '/projects/my-app',
      kind: 'turn-complete',
      source: 'my-agent',
    });

    // Its spinner is the one the label turned on.
    expect(harness.workspace('ws-1').agentActive).toBe(false);
    expect(harness.workspace('ws-1').attention).toEqual(
      expect.objectContaining({ kind: 'turn-complete', source: 'my-agent' })
    );
    expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        attention: expect.objectContaining({ source: 'my-agent' }),
      })
    );
  });

  it('stores attention from a hook whose Terminal is gone on the workspace only', async () => {
    const harness = createAttentionHarness([localWorkspace()]);

    const outcome = await harness.attention.hook(
      harness.toWorkspace('ws-1', { hasInvalidTerminalId: true }),
      {
        cwd: '/projects/my-app',
        kind: 'input-required',
        source: 'codex',
        message: 'Needs approval',
      }
    );

    expect(outcome).toBe('taken');
    expect(harness.workspace('ws-1').attention).toEqual(
      expect.objectContaining({ kind: 'input-required', message: 'Needs approval' })
    );
    expect(harness.workspace('ws-1').attention?.terminalId).toBeUndefined();
    expect(harness.workspace('ws-1').needsAttention).toBe(true);
    expect(harness.terminal('term-1').attention).toBeUndefined();
  });

  it('is unmatched without a workspace and records no milestone', async () => {
    const harness = createAttentionHarness([]);

    const outcome = await harness.settle(harness.toWorkspace('ws-missing'), {
      cwd: '/projects/missing',
      kind: 'idle',
      source: 'codex',
    });

    expect(outcome).toBe('unmatched');
    expect(harness.milestone).not.toHaveBeenCalled();
    expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
  });

  describe('milestones', () => {
    it('records the first routed notification keyed by kind and source', async () => {
      const harness = createAttentionHarness([localWorkspace([])]);

      await harness.settle(harness.toWorkspace('ws-1'), {
        cwd: '/projects/my-app',
        kind: 'idle',
        source: 'codex',
      });

      expect(harness.milestone).toHaveBeenCalledWith('notification:idle:codex', {
        notificationKind: 'idle',
        source: 'codex',
      });
    });

    it('falls back to an unknown source in the key when none is sent', async () => {
      const harness = createAttentionHarness([localWorkspace([])]);

      await harness.settle(harness.toWorkspace('ws-1'), { cwd: '/projects/my-app' });

      expect(harness.milestone).toHaveBeenCalledWith('notification:generic:unknown', {
        notificationKind: 'generic',
        source: undefined,
      });
    });
  });

  describe('subagent and background hooks', () => {
    it('ignores Codex subagent completion', async () => {
      const harness = createAttentionHarness([localWorkspace([])]);

      const outcome = await harness.settle(harness.toWorkspace('ws-1'), {
        cwd: '/projects/my-app',
        source: 'codex',
        kind: 'turn-complete',
        hookInput: { hook_event_name: 'Stop', agent_id: 'child' },
      });

      expect(outcome).toBe('ignored');
      expect(harness.workspace('ws-1').attention).toBeUndefined();
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
    });

    it('ignores Claude subagent completion without a milestone', async () => {
      const harness = createAttentionHarness([localWorkspace([])]);

      const outcome = await harness.settle(harness.toWorkspace('ws-1'), {
        cwd: '/projects/my-app',
        kind: 'turn-complete',
        source: 'claude-code',
        hookInput: { hook_event_name: 'Stop', agent_id: 'agent-abc123', agent_type: 'Explore' },
      });

      expect(outcome).toBe('ignored');
      expect(harness.workspace('ws-1').attention).toBeUndefined();
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      expect(harness.milestone).not.toHaveBeenCalled();
    });

    it('is unmatched for an ignored Claude subagent hook without a workspace', async () => {
      const harness = createAttentionHarness([]);

      const outcome = await harness.settle(harness.toWorkspace('ws-missing'), {
        cwd: '/projects/missing',
        kind: 'turn-complete',
        source: 'claude-code',
        hookInput: {
          hook_event_name: 'SubagentStop',
          agent_id: 'agent-abc123',
          agent_type: 'Explore',
        },
      });

      expect(outcome).toBe('unmatched');
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
    });

    it('ignores Claude SubagentStop without stopping the foreground spinner', async () => {
      const harness = createAttentionHarness([localWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, {
        cwd: '/projects/my-app',
        source: 'claude-code',
        kind: 'activity',
        hookInput: { hook_event_name: 'PreToolUse' },
      });

      const outcome = await harness.settle(target, {
        cwd: '/projects/my-app',
        kind: 'turn-complete',
        source: 'claude-code',
        hookInput: {
          hook_event_name: 'SubagentStop',
          agent_id: 'agent-abc123',
          agent_type: 'Explore',
        },
      });

      expect(outcome).toBe('ignored');
      expect(harness.terminal('term-1').agentActive).toBe(true);
      expect(harness.terminal('term-1').attention).toBeUndefined();
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
    });

    it('ignores Claude background needs-input notifications', async () => {
      const harness = createAttentionHarness([localWorkspace([])]);

      const outcome = await harness.settle(harness.toWorkspace('ws-1'), {
        cwd: '/projects/my-app',
        kind: 'input-required',
        source: 'claude-code',
        message: 'Background agent needs input',
        hookInput: { notification_type: 'agent_needs_input' },
      });

      expect(outcome).toBe('ignored');
      expect(harness.workspace('ws-1').attention).toBeUndefined();
      expect(harness.workspace('ws-1').agentActive).toBeFalsy();
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
    });

    it('ignores Claude background completion without stopping the foreground spinner', async () => {
      const shown: WorkspaceAttention = {
        kind: 'input-required',
        source: 'claude-code',
        updatedAt: 1,
        message: 'Claude needs permission',
        terminalId: 'term-1',
      };
      const harness = createAttentionHarness([
        createWorkspace({
          id: 'ws-1',
          workingDirectory: '/projects/my-app',
          attention: shown,
          needsAttention: true,
          terminals: [createTerminal({ id: 'term-1', attention: shown })],
        }),
      ]);
      harness.attention.restored(
        harness.workspace('ws-1'),
        sources({ 'term-1': { 'claude-code': 1 } })
      );

      const outcome = await harness.settle(harness.toTerminal('term-1'), {
        cwd: '/projects/my-app',
        kind: 'turn-complete',
        source: 'claude-code',
        message: 'Background agent update',
        hookInput: { notification_type: 'agent_completed' },
      });

      expect(outcome).toBe('ignored');
      expect(harness.terminal('term-1').attention).toBe(shown);
      expect(harness.workspace('ws-1').attention).toBe(shown);
      expect(harness.terminal('term-1').agentActive).toBe(true);
      expect(harness.workspace('ws-1').agentActive).toBe(true);
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
    });
  });

  describe('copies of hooks for a terminal another device is attached to', () => {
    // Another device is attached to the Terminal, so it is stopped here.
    const sshWorkspace = () =>
      createSshWorkspace({
        id: 'ws-1',
        terminals: [createTerminal({ id: 'term-1', status: 'stopped' })],
      });
    const copy = (hook: AgentHook): AgentHook => ({
      cwd: '/home/dev/repo',
      source: 'claude-code',
      copy: true,
      ...hook,
    });

    it('shows a copied permission prompt and keeps the spinner on like the attached device', async () => {
      const harness = createAttentionHarness([sshWorkspace()]);
      const mark = harness.attention.hookMark('term-1');

      const outcome = await harness.settle(
        harness.toTerminal('term-1'),
        copy({ kind: 'input-required' })
      );

      expect(outcome).toBe('taken');
      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ kind: 'input-required', terminalId: 'term-1' })
      );
      expect(harness.workspace('ws-1').needsAttention).toBe(true);
      expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          attention: expect.objectContaining({ kind: 'input-required', terminalId: 'term-1' }),
        })
      );
      expect(harness.terminal('term-1').agentActive).toBe(true);
      expect(harness.attention.hookArrivedSince('term-1', mark)).toBe(true);
      // The device attached to the terminal records that its hooks are wired.
      expect(harness.milestone).not.toHaveBeenCalled();

      // Only a copy keeps the spinner on, so it may be stale once the host reconnects.
      harness.attention.hostConnected('ssh-host-1');

      expect(harness.terminal('term-1').agentActive).toBe(false);
      expect(harness.terminal('term-1').attention).toEqual(
        expect.objectContaining({ kind: 'input-required' })
      );
    });

    it('turns on the spinner for copied prompts and tool activity without naming the workspace', async () => {
      const done: WorkspaceAttention = {
        kind: 'turn-complete',
        source: 'claude-code',
        updatedAt: 1,
        terminalId: 'term-1',
      };
      const workspace = sshWorkspace();
      workspace.attention = done;
      workspace.needsAttention = true;
      workspace.terminals[0].attention = done;
      const harness = createAttentionHarness([workspace]);

      for (const kind of ['prompt-submit', 'activity'] as const) {
        const outcome = await harness.settle(
          harness.toTerminal('term-1'),
          copy({ kind, hookInput: { prompt: 'Fix the build' } })
        );
        expect(outcome).toBe('taken');
      }

      expect(harness.terminal('term-1').agentActive).toBe(true);
      expect(workspace.agentActive).toBe(true);
      // A prompt typed on the attached device dismisses the alert shown here too.
      expect(harness.terminal('term-1').attention).toBeUndefined();
      expect(workspace.attention).toBeUndefined();
      // The attached device names the workspace, and the name syncs.
      expect(harness.promptSubmitted).not.toHaveBeenCalled();
      // Activity on the host counts on every device showing the workspace.
      expect(harness.turnActivity).toHaveBeenCalledWith('ws-1');
      // Copies only change what's shown.
      expect(harness.store.saveNow).not.toHaveBeenCalled();

      // Only copies keep the spinner on, and none arrive while the computer sleeps.
      harness.attention.machineResumed();

      expect(harness.terminal('term-1').agentActive).toBe(false);
    });

    it('leaves the spinner timeout alone for a copy from an older turn', async () => {
      const harness = createAttentionHarness([sshWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(
        target,
        copy({
          kind: 'prompt-submit',
          hookInput: {
            session_id: 'session',
            turn_id: 'turn-2',
            hook_event_name: 'UserPromptSubmit',
          },
        })
      );
      expect(harness.terminal('term-1').agentActive).toBe(true);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      const mark = harness.attention.hookMark('term-1');

      const outcome = await harness.settle(
        target,
        copy({
          kind: 'activity',
          hookInput: { session_id: 'session', turn_id: 'turn-1', hook_event_name: 'PreToolUse' },
        })
      );

      expect(outcome).toBe('taken');
      expect(harness.attention.hookArrivedSince('term-1', mark)).toBe(false);
      expect(harness.terminal('term-1').agentActive).toBe(true);
      // The spinner stops 30 minutes after the prompt's copy, not after the older turn's.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(harness.terminal('term-1').agentActive).toBe(false);
    });

    it('stops the spinner when the attached device relays an interrupt', async () => {
      const harness = createAttentionHarness([sshWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, copy({ kind: 'activity' }));
      expect(harness.terminal('term-1').agentActive).toBe(true);

      const outcome = await harness.settle(target, copy({ kind: 'interrupted' }));

      expect(outcome).toBe('ignored');
      expect(harness.terminal('term-1').agentActive).toBe(false);
      expect(harness.workspace('ws-1').agentActive).toBe(false);
      expect(harness.terminal('term-1').attention).toBeUndefined();
      expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
      // The device that saw the interrupt already told the others.
      expect(harness.relay.interrupted).not.toHaveBeenCalled();
    });

    it("lets this device's own hooks drive the spinner", async () => {
      const harness = createAttentionHarness([sshWorkspace()]);
      const target = harness.toTerminal('term-1');
      await harness.settle(target, copy({ kind: 'activity' }));

      await harness.settle(target, copy({ kind: 'activity', copy: undefined }));
      harness.attention.machineResumed();

      expect(harness.terminal('term-1').agentActive).toBe(true);
    });
  });
});
