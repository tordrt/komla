import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminal, createWorkspace, resetIdCounter } from '../../factories';
import { createAttentionHarness, type AttentionHarness } from '../../helpers/terminal-attention';

import type {
  AgentHook,
  AgentHookKind,
} from '../../../src/main/services/terminal-attention/terminal-attention';
import type { Terminal, Workspace, WorkspaceAttention } from '../../../src/shared/types';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function workspaceWith(terminals: Terminal[] = [], overrides: Partial<Workspace> = {}) {
  return createWorkspace({
    id: 'ws-1',
    workingDirectory: '/projects/my-app',
    terminals,
    ...overrides,
  });
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

/** The dock badge count last shown; nothing shown yet counts as none. */
function badgeCount(harness: AttentionHarness): number {
  return harness.windows.badge.mock.lastCall?.[0] ?? 0;
}

function raisedWith(harness: AttentionHarness, attention: Partial<WorkspaceAttention>) {
  return harness.windows.attentionRaised.mock.calls.some(
    ([event]) =>
      event.workspaceId === 'ws-1' &&
      Object.entries(attention).every(
        ([key, value]) => (event.attention as Record<string, unknown>)[key] === value
      )
  );
}

beforeEach(() => {
  resetIdCounter();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Codex title fallback', () => {
  function codexHook(kind: AgentHookKind, turn = 'current'): AgentHook {
    return {
      source: 'codex',
      kind,
      hookInput: {
        hook_event_name: kind === 'turn-complete' ? 'Stop' : kind,
        session_id: 'root',
        turn_id: turn,
      },
    };
  }

  it('recovers a Codex /review spinner from a complete title cycle without Stop', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const terminal = harness.terminal('term-1');
    await harness.attention.hook(harness.toTerminal('term-1'), {
      source: 'codex',
      kind: 'activity',
    });
    expect(terminal.agentActive).toBe(true);

    harness.attention.titleChanged('term-1', '⠋ project');
    harness.attention.titleChanged('term-1', 'project');
    await vi.advanceTimersByTimeAsync(2000);

    expect(terminal.agentActive).toBe(false);
    expect(terminal.attention).toMatchObject({
      kind: 'turn-complete',
      source: 'codex',
      terminalId: 'term-1',
    });
    expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        attention: expect.objectContaining({ kind: 'turn-complete', terminalId: 'term-1' }),
      })
    );
  });

  it.each(['prompt-submit', 'activity', 'title'])(
    'ignores a late Stop after an inferred completion and shows the next one after %s',
    async (resume) => {
      const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
      const terminal = harness.terminal('term-1');
      const target = harness.toTerminal('term-1');

      await harness.settle(target, codexHook('activity'));
      harness.attention.titleChanged('term-1', '⠋ project');
      harness.attention.titleChanged('term-1', 'project');
      await vi.advanceTimersByTimeAsync(2000);
      expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);

      // Dismissed attention must not reappear when the authoritative hook arrives.
      harness.attention.dismissed('term-1');
      expect(await harness.settle(target, codexHook('turn-complete'))).toBe('taken');
      expect(await harness.settle(target, codexHook('turn-complete'))).toBe('taken');
      expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
      expect(terminal.attention).toBeUndefined();

      const turn = resume === 'prompt-submit' ? 'next' : 'current';
      if (resume === 'title') harness.attention.titleChanged('term-1', '⠙ project');
      else await harness.settle(target, codexHook(resume as AgentHookKind, turn));
      await harness.settle(target, codexHook('turn-complete', turn));

      expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(2);
      expect(terminal.attention).toMatchObject({ kind: 'turn-complete', terminalId: 'term-1' });
    }
  );

  it.each(['valid', 'stale', 'subagent'])(
    'handles a %s Stop near the title completion deadline without duplicate attention',
    async (hookType) => {
      const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
      const target = harness.toTerminal('term-1');
      await harness.attention.hook(target, {
        source: 'codex',
        kind: 'activity',
        hookInput: { hook_event_name: 'PreToolUse', session_id: 'root', turn_id: 'current' },
      });
      harness.attention.titleChanged('term-1', '⠋ project');
      harness.attention.titleChanged('term-1', 'project');
      await vi.advanceTimersByTimeAsync(1900);

      void harness.attention.hook(target, {
        source: 'codex',
        kind: 'turn-complete',
        hookInput: {
          hook_event_name: 'Stop',
          session_id: 'root',
          turn_id: hookType === 'stale' ? 'old' : 'current',
          ...(hookType === 'subagent' ? { agent_id: 'child' } : {}),
        },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(hookType === 'valid' ? 0 : 1);

      await vi.advanceTimersByTimeAsync(650);
      expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
      expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          attention: expect.objectContaining({ kind: 'turn-complete', terminalId: 'term-1' }),
        })
      );
    }
  );

  it('completes a first Codex turn while the unnamed-thread spinner outlives Stop', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const terminal = harness.terminal('term-1');
    const target = harness.toTerminal('term-1');
    await harness.attention.hook(target, codexHook('prompt-submit', 'first'));
    harness.attention.titleChanged('term-1', '⠋ ⠋ | project');

    const stop = harness.attention.hook(target, codexHook('turn-complete', 'first'));
    // Codex keeps spinning in the thread-title slot until it has named the thread.
    for (const frame of ['⠴', '⠦', '⠧', '⠇', '⠏', '⠋', '⠙', '⠹', '⠸']) {
      harness.attention.titleChanged('term-1', `${frame} | project`);
      await vi.advanceTimersByTimeAsync(100);
    }
    harness.attention.titleChanged('term-1', 'project');
    harness.attention.titleChanged('term-1', 'Respond to greeting | project');
    await vi.advanceTimersByTimeAsync(5000);

    await expect(stop).resolves.toBe('taken');
    expect(terminal.agentActive).toBe(false);
    expect(terminal.attention).toMatchObject({ kind: 'turn-complete', terminalId: 'term-1' });
    expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
  });

  it('keeps a settling root Stop cancelled while Codex continues emitting working titles', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const terminal = harness.terminal('term-1');
    const target = harness.toTerminal('term-1');
    await harness.attention.hook(target, { source: 'codex', kind: 'activity' });
    harness.attention.titleChanged('term-1', '⠋ project');

    const stop = harness.attention.hook(target, {
      source: 'codex',
      kind: 'turn-complete',
      hookInput: { hook_event_name: 'Stop' },
    });
    await vi.advanceTimersByTimeAsync(0);
    harness.attention.titleChanged('term-1', '⠙ project');
    await vi.advanceTimersByTimeAsync(1000);

    await expect(stop).resolves.toBe('taken');
    expect(terminal.agentActive).toBe(true);
    expect(terminal.attention).toBeUndefined();
    expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
  });
});

describe('terminal OSC fallback', () => {
  it('surfaces an alert only after the fallback delay, without stopping the spinner', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const workspace = harness.workspace('ws-1');
    const terminal = harness.terminal('term-1');
    harness.attention.restored(workspace, sources({ 'term-1': { 'claude-code': 1 } }));

    harness.attention.alertRaised({ terminalId: 'term-1', title: 'Agent', message: 'Finished' });

    await vi.advanceTimersByTimeAsync(1999);
    expect(terminal.attention).toBeUndefined();
    expect(harness.windows.attentionRaised).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const expected = {
      kind: 'generic',
      source: 'terminal-osc',
      message: 'Agent: Finished',
      terminalId: 'term-1',
    };
    expect(terminal.attention).toMatchObject(expected);
    expect(workspace.attention).toMatchObject(expected);
    expect(workspace.needsAttention).toBe(true);
    expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        attention: expect.objectContaining(expected),
      })
    );
    expect(badgeCount(harness)).toBe(1);
    expect(terminal.agentActive).toBe(true);
  });

  it('drops a pending alert when an agent hook arrives for the Terminal', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const terminal = harness.terminal('term-1');

    harness.attention.alertRaised({ terminalId: 'term-1', message: 'Finished' });
    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(raisedWith(harness, { source: 'terminal-osc' })).toBe(false);
    expect(terminal.attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });
  });

  it("keeps a Terminal's alert when a command notifies its whole workspace", async () => {
    const commandDone = {
      kind: 'turn-complete' as const,
      source: 'command',
      hookInput: { hook_event_name: 'Stop' },
    };
    for (const order of ['alert first', 'command first']) {
      const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);

      if (order === 'alert first') {
        harness.attention.alertRaised({ terminalId: 'term-1', message: 'Finished' });
      }
      await harness.attention.hook(harness.toWorkspace('ws-1'), commandDone);
      if (order === 'command first') {
        harness.attention.alertRaised({ terminalId: 'term-1', message: 'Finished' });
      }
      await vi.advanceTimersByTimeAsync(2000);

      expect(raisedWith(harness, { source: 'terminal-osc' }), order).toBe(true);
    }
  });

  it('suppresses an alert when an agent hook arrived first for the Terminal', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const terminal = harness.terminal('term-1');

    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    harness.attention.alertRaised({ terminalId: 'term-1', message: 'Finished' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(raisedWith(harness, { source: 'terminal-osc' })).toBe(false);
    expect(terminal.attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });
  });

  it.each([
    {
      name: 'SubagentStop',
      kind: 'turn-complete' as const,
      hookInput: { hook_event_name: 'SubagentStop', agent_id: 'agent-abc123' },
    },
    {
      name: 'agent_completed',
      kind: 'generic' as const,
      hookInput: { hook_event_name: 'Notification', notification_type: 'agent_completed' },
    },
    {
      name: 'agent_needs_input',
      kind: 'input-required' as const,
      hookInput: { hook_event_name: 'Notification', notification_type: 'agent_needs_input' },
    },
  ])('suppresses alerts after ignoring Claude $name', async (testCase) => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const terminal = harness.terminal('term-1');

    harness.attention.alertRaised({ terminalId: 'term-1', message: 'Finished first' });
    const outcome = await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: testCase.kind,
      source: 'claude-code',
      hookInput: testCase.hookInput,
    });
    expect(outcome).toBe('ignored');

    harness.attention.alertRaised({ terminalId: 'term-1', message: 'Finished second' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
    expect(terminal.attention).toBeUndefined();
  });

  it('shows an Antigravity alert during its turn as needing input right away', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const workspace = harness.workspace('ws-1');
    const terminal = harness.terminal('term-1');

    // Tool results keep arriving right up to the approval prompt.
    await harness.attention.hook(harness.toTerminal('term-1'), {
      source: 'antigravity',
      kind: 'activity',
    });
    harness.attention.alertRaised({
      terminalId: 'term-1',
      message: 'Antigravity CLI needs approval for run_command',
    });

    expect(terminal.attention).toMatchObject({
      kind: 'input-required',
      source: 'antigravity',
      message: 'Antigravity CLI needs approval for run_command',
      terminalId: 'term-1',
    });
    expect(workspace.needsAttention).toBe(true);
    expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
  });

  it("leaves Antigravity's end-of-turn alert to its Stop hook", async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const workspace = harness.workspace('ws-1');
    const terminal = harness.terminal('term-1');
    harness.attention.restored(workspace, sources({ 'term-1': { antigravity: 1 } }));

    harness.attention.alertRaised({
      terminalId: 'term-1',
      message: 'Antigravity CLI is ready for input',
    });
    await harness.attention.hook(harness.toTerminal('term-1'), {
      source: 'antigravity',
      kind: 'turn-complete',
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
    expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        attention: expect.objectContaining({ kind: 'turn-complete', source: 'antigravity' }),
      })
    );
    expect(terminal.attention).toMatchObject({ kind: 'turn-complete', source: 'antigravity' });
    expect(workspace.needsAttention).toBe(true);
  });

  it('does not let an alert replace attention that needs action', async () => {
    const prompt: WorkspaceAttention = {
      kind: 'input-required',
      source: 'claude-code',
      updatedAt: 1000,
      terminalId: 'term-1',
    };
    const harness = createAttentionHarness([
      workspaceWith([createTerminal({ id: 'term-1', attention: prompt })], {
        attention: prompt,
        needsAttention: true,
      }),
    ]);
    const workspace = harness.workspace('ws-1');

    harness.attention.alertRaised({ terminalId: 'term-1', message: 'Finished' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
    expect(workspace.attention).toEqual(prompt);
    expect(harness.terminal('term-1').attention).toEqual(prompt);
  });
});

describe('attention from agent hooks', () => {
  it('raises generic attention for a hook without a kind and counts it on the badge', async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');

    const outcome = await harness.attention.hook(harness.toWorkspace('ws-1'), {
      cwd: '/projects/my-app',
    });

    expect(outcome).toBe('taken');
    expect(workspace.attention).toMatchObject({ kind: 'generic', source: 'generic' });
    expect(workspace.needsAttention).toBe(true);
    expect(harness.windows.attentionRaised).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        attention: expect.objectContaining({ kind: 'generic', source: 'generic' }),
      })
    );
    expect(badgeCount(harness)).toBe(1);
  });

  it('shows Claude permission prompts as input-required that needs action', async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'input-required',
      source: 'claude-code',
      message: 'Claude needs permission',
      hookInput: {
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        agent_id: 'agent-abc123',
      },
    });

    expect(workspace.attention).toMatchObject({
      kind: 'input-required',
      source: 'claude-code',
      message: 'Claude needs permission',
    });
    expect(workspace.needsAttention).toBe(true);
    expect(harness.windows.attentionRaised).toHaveBeenCalledOnce();
    expect(badgeCount(harness)).toBe(1);
  });

  it('shows nothing for a Claude idle reminder', async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'idle',
      source: 'claude-code',
      message: 'Claude is waiting',
    });

    expect(workspace.attention).toBeUndefined();
    expect(workspace.needsAttention).toBeFalsy();
    expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
    expect(badgeCount(harness)).toBe(0);
  });
});

describe('Claude permission prompts', () => {
  const curl = { command: 'curl -sI https://example.com' };

  function permissionRequest(toolInput: unknown = curl, agentId?: string): AgentHook {
    return {
      kind: 'input-required',
      source: 'claude-code',
      message: 'curl -sI https://example.com',
      hookInput: {
        hook_event_name: 'PermissionRequest',
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: toolInput,
        ...(agentId && { agent_id: agentId }),
      },
    };
  }

  function toolEnd(toolInput: unknown = curl, event = 'PostToolUse', agentId?: string): AgentHook {
    return {
      kind: 'activity',
      source: 'claude-code',
      hookInput: {
        hook_event_name: event,
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: toolInput,
        ...(agentId && { agent_id: agentId }),
      },
    };
  }

  const permissionNotification: AgentHook = {
    kind: 'input-required',
    source: 'claude-code',
    message: 'Claude needs your permission',
    hookInput: {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      session_id: 's1',
    },
  };

  it('ignores the Notification that repeats a permission prompt 6 s later', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const target = harness.toTerminal('term-1');

    await harness.attention.hook(target, permissionRequest());
    expect(await harness.attention.hook(target, permissionNotification)).toBe('ignored');

    expect(harness.terminal('term-1').attention).toMatchObject({
      kind: 'input-required',
      message: 'curl -sI https://example.com',
    });
    expect(harness.windows.attentionRaised).toHaveBeenCalledOnce();
  });

  it('shows the Notification of a Claude that sends no PermissionRequest', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);

    await harness.attention.hook(harness.toTerminal('term-1'), permissionNotification);

    expect(harness.terminal('term-1').attention).toMatchObject({
      kind: 'input-required',
      message: 'Claude needs your permission',
    });
  });

  it.each(['PostToolUse', 'PostToolUseFailure'])(
    'no longer needs input once %s ends the tool call it asked about',
    async (event) => {
      const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
      const target = harness.toTerminal('term-1');
      await harness.attention.hook(target, permissionRequest());

      // A tool call running beside it ends, and the prompt still waits.
      await harness.attention.hook(target, toolEnd({ command: 'ls' }, event));
      expect(harness.terminal('term-1').attention).toMatchObject({ kind: 'input-required' });

      await harness.attention.hook(target, toolEnd(curl, event));
      expect(harness.terminal('term-1').attention).toBeUndefined();
      expect(harness.terminal('term-1').agentActive).toBe(true);
    }
  );

  it("no longer needs input once a subagent's tool call ends", async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const target = harness.toTerminal('term-1');
    await harness.attention.hook(target, permissionRequest(curl, 'agent-1'));

    // The lead's own call to the same tool is another one.
    await harness.attention.hook(target, toolEnd(curl));
    expect(harness.terminal('term-1').attention).toMatchObject({ kind: 'input-required' });

    await harness.attention.hook(target, toolEnd(curl, 'PostToolUse', 'agent-1'));
    expect(harness.terminal('term-1').attention).toBeUndefined();
  });

  it('no longer needs input once the question is answered, which adds the answers', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const target = harness.toTerminal('term-1');
    const questions = [{ question: 'Red or blue?', header: 'Color' }];
    const question = (toolInput: Record<string, unknown>, event: string): AgentHook => ({
      kind: event === 'PermissionRequest' ? 'input-required' : 'activity',
      source: 'claude-code',
      message: 'Red or blue?',
      hookInput: {
        hook_event_name: event,
        session_id: 's1',
        tool_name: 'AskUserQuestion',
        tool_input: toolInput,
      },
    });
    await harness.attention.hook(target, question({ questions }, 'PermissionRequest'));

    await harness.attention.hook(
      target,
      question({ questions, answers: { 'Red or blue?': 'Red' }, annotations: {} }, 'PostToolUse')
    );

    expect(harness.terminal('term-1').attention).toBeUndefined();
  });

  it('shows the Notification of a prompt too large to forward whole', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const target = harness.toTerminal('term-1');
    const compacted: AgentHook = {
      kind: 'input-required',
      source: 'claude-code',
      message: 'Claude needs approval',
      hookInput: { hook_event_name: 'PermissionRequest', session_id: 's1' },
    };
    await harness.attention.hook(target, compacted);

    expect(await harness.attention.hook(target, permissionNotification)).toBe('taken');
    await harness.attention.hook(target, {
      kind: 'activity',
      source: 'claude-code',
      hookInput: { hook_event_name: 'PostToolUse', session_id: 's1' },
    });
    expect(harness.terminal('term-1').attention).toMatchObject({ kind: 'input-required' });
  });

  it("keeps needing input while a subagent's prompt waits beside the lead's", async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const target = harness.toTerminal('term-1');
    await harness.attention.hook(target, permissionRequest());
    await harness.attention.hook(target, permissionRequest({ command: 'rm -r build' }, 'agent-1'));

    await harness.attention.hook(target, toolEnd());
    expect(harness.terminal('term-1').attention).toMatchObject({ kind: 'input-required' });

    await harness.attention.hook(
      target,
      toolEnd({ command: 'rm -r build' }, 'PostToolUse', 'agent-1')
    );
    expect(harness.terminal('term-1').attention).toBeUndefined();
  });

  it('keeps the next prompt once one was answered', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const target = harness.toTerminal('term-1');
    await harness.attention.hook(target, permissionRequest());
    await harness.attention.hook(target, toolEnd());
    await harness.attention.hook(target, permissionRequest({ command: 'curl -sI https://x.org' }));

    await harness.attention.hook(target, toolEnd());

    expect(harness.terminal('term-1').attention).toMatchObject({ kind: 'input-required' });
  });
});

describe('dock badge', () => {
  it('counts each workspace that needs attention', async () => {
    const harness = createAttentionHarness([
      createWorkspace({ id: 'ws-1', workingDirectory: '/projects/app1' }),
      createWorkspace({ id: 'ws-2', workingDirectory: '/projects/app2' }),
    ]);

    await harness.attention.hook(harness.toWorkspace('ws-1'), {});
    await harness.attention.hook(harness.toWorkspace('ws-2'), {});

    expect(badgeCount(harness)).toBe(2);
  });

  it('counts a workspace once when it is notified twice', async () => {
    const harness = createAttentionHarness([workspaceWith()]);

    await harness.attention.hook(harness.toWorkspace('ws-1'), {});
    await harness.attention.hook(harness.toWorkspace('ws-1'), {});

    expect(badgeCount(harness)).toBe(1);
  });

  it("keeps counting a workspace whose card falls back to another Terminal's done", async () => {
    const harness = createAttentionHarness([
      workspaceWith([createTerminal({ id: 'term-1' }), createTerminal({ id: 'term-2' })]),
    ]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    await harness.attention.hook(harness.toTerminal('term-2'), {
      kind: 'input-required',
      source: 'codex',
    });
    expect(badgeCount(harness)).toBe(1);

    harness.attention.dismissed('term-2');

    expect(workspace.attention).toMatchObject({ kind: 'turn-complete', terminalId: 'term-1' });
    expect(workspace.needsAttention).toBe(true);
    expect(badgeCount(harness)).toBe(1);
  });

  it('stops counting a workspace whose card falls back to a saved idle reminder', async () => {
    const idle: WorkspaceAttention = {
      kind: 'idle',
      source: 'codex',
      updatedAt: 1,
      terminalId: 'term-1',
    };
    const harness = createAttentionHarness([
      workspaceWith([
        createTerminal({ id: 'term-1', attention: idle }),
        createTerminal({ id: 'term-2' }),
      ]),
    ]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toTerminal('term-2'), {
      kind: 'input-required',
      source: 'codex',
    });

    harness.attention.dismissed('term-2');

    expect(workspace.attention).toMatchObject({ kind: 'idle', terminalId: 'term-1' });
    expect(workspace.needsAttention).toBe(false);
    expect(badgeCount(harness)).toBe(0);
  });

  it("doesn't count a workspace while it is trashed, until it is active again", async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    expect(badgeCount(harness)).toBe(1);

    workspace.status = 'trashed';
    harness.attention.workspaceStatusChanged();
    expect(workspace.needsAttention).toBe(true);
    expect(badgeCount(harness)).toBe(0);

    workspace.status = 'active';
    harness.attention.workspaceStatusChanged();
    expect(badgeCount(harness)).toBe(1);
  });

  it("doesn't count a snoozed workspace, until it wakes", async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });

    workspace.snoozedUntil = Date.now() + 60_000;
    harness.attention.workspaceStatusChanged();
    expect(badgeCount(harness)).toBe(0);

    workspace.snoozedUntil = undefined;
    harness.attention.workspaceStatusChanged();
    expect(badgeCount(harness)).toBe(1);
  });

  describe('restored workspaces', () => {
    it('counts attention saved with a workspace', () => {
      const workspace = workspaceWith();
      // Saved before needsAttention had one meaning: a done that was not counted.
      workspace.attention = { kind: 'turn-complete', source: 'codex', updatedAt: 1 };
      workspace.needsAttention = false;
      const harness = createAttentionHarness([workspace]);

      harness.attention.restored(workspace, new Map());

      expect(workspace.needsAttention).toBe(true);
      expect(badgeCount(harness)).toBe(1);
    });

    it('does not count attention saved with a trashed workspace', () => {
      const workspace = workspaceWith();
      workspace.status = 'trashed';
      workspace.attention = { kind: 'turn-complete', source: 'codex', updatedAt: 1 };
      const harness = createAttentionHarness([workspace]);

      harness.attention.restored(workspace, new Map());

      expect(badgeCount(harness)).toBe(0);
    });

    it('does not count a saved idle reminder', () => {
      const workspace = workspaceWith();
      workspace.attention = { kind: 'idle', source: 'codex', updatedAt: 1 };
      const harness = createAttentionHarness([workspace]);

      harness.attention.restored(workspace, new Map());

      expect(workspace.needsAttention).toBe(false);
      expect(badgeCount(harness)).toBe(0);
    });
  });
});

describe('prompt-submit', () => {
  it('names the workspace from the prompt a remote hook forwarded', async () => {
    const harness = createAttentionHarness([workspaceWith()]);

    const outcome = await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source: 'claude-code',
      message: 'UserPromptSubmit',
      hookInput: { prompt: 'Fix remote title generation' },
    });

    expect(outcome).toBe('taken');
    expect(harness.promptSubmitted).toHaveBeenCalledWith(
      'ws-1',
      'Fix remote title generation',
      undefined
    );
    expect(harness.promptSubmitted).toHaveBeenCalledOnce();
  });

  it('names the workspace from the message', async () => {
    const harness = createAttentionHarness([workspaceWith()]);

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source: 'claude-code',
      message: 'Fix the login bug',
    });

    expect(harness.promptSubmitted).toHaveBeenCalledWith('ws-1', 'Fix the login bug', undefined);
  });

  it('clears the workspace attention on a prompt-submit without a Terminal', async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'claude-code',
    });
    expect(badgeCount(harness)).toBe(1);
    harness.store.broadcast.mockClear();

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source: 'claude-code',
      message: 'Fix the login bug',
    });

    expect(workspace.attention).toBeUndefined();
    expect(workspace.needsAttention).toBe(false);
    expect(badgeCount(harness)).toBe(0);
    expect(harness.store.broadcast).toHaveBeenCalledWith(workspace);
    expect(harness.windows.attentionRaised).toHaveBeenCalledOnce();
  });

  it("clears only the submitting Terminal's attention", async () => {
    const harness = createAttentionHarness([
      workspaceWith([createTerminal({ id: 'term-1' }), createTerminal({ id: 'term-2' })]),
    ]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'input-required',
      source: 'codex',
    });
    await harness.attention.hook(harness.toTerminal('term-2'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    harness.store.broadcast.mockClear();

    await harness.attention.hook(harness.toTerminal('term-2'), {
      kind: 'prompt-submit',
      source: 'claude-code',
      message: 'Fix the login bug',
    });

    expect(harness.terminal('term-2').attention).toBeUndefined();
    expect(harness.terminal('term-1').attention).toMatchObject({ kind: 'input-required' });
    expect(workspace.attention).toMatchObject({ kind: 'input-required', terminalId: 'term-1' });
    expect(workspace.needsAttention).toBe(true);
    expect(harness.store.broadcast).toHaveBeenCalledWith(workspace);
    expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(2);
  });

  it('turns on the spinner for the submitting agent', async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source: 'codex',
      message: 'Fix the login bug',
    });

    expect(workspace.agentActive).toBe(true);
    expect(harness.store.broadcast).toHaveBeenCalledWith(workspace);
    // Scoped to the sending agent: another agent's done leaves it on, its own stops it.
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'claude-code',
    });
    expect(workspace.agentActive).toBe(true);
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    expect(workspace.agentActive).toBe(false);
  });

  it('records no prompt for a prompt-submit without a message', async () => {
    const harness = createAttentionHarness([workspaceWith()]);

    const outcome = await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source: 'claude-code',
    });

    expect(outcome).toBe('taken');
    expect(harness.promptSubmitted).not.toHaveBeenCalled();
  });

  it('records no prompt for a prompt-submit no workspace matched', async () => {
    const harness = createAttentionHarness([workspaceWith()]);

    const outcome = await harness.attention.hook(harness.toWorkspace('missing'), {
      kind: 'prompt-submit',
      source: 'claude-code',
      message: 'Fix the login bug',
    });

    expect(outcome).toBe('unmatched');
    expect(harness.promptSubmitted).not.toHaveBeenCalled();
  });
});

describe('agent replies', () => {
  it.each([
    ['claude-code', 'last_assistant_message'],
    ['codex', 'last-assistant-message'],
    ['gemini', 'prompt_response'],
  ])("records %s's final reply from its done hook", async (source, field) => {
    const harness = createAttentionHarness([workspaceWith()]);

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source,
      hookInput: { [field]: 'Fixed the login redirect.' },
    });

    expect(harness.agentReplied).toHaveBeenCalledExactlyOnceWith(
      'ws-1',
      'Fixed the login redirect.',
      undefined
    );
  });

  it('records the reply with its Terminal', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);

    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'prompt-submit',
      source: 'claude-code',
      message: 'Fix the login redirect',
    });
    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'turn-complete',
      source: 'claude-code',
      hookInput: { last_assistant_message: 'Fixed it.' },
    });

    expect(harness.promptSubmitted).toHaveBeenCalledWith(
      'ws-1',
      'Fix the login redirect',
      'term-1'
    );
    expect(harness.agentReplied).toHaveBeenCalledWith('ws-1', 'Fixed it.', 'term-1');
  });

  it('records no reply from a done without one', async () => {
    const harness = createAttentionHarness([workspaceWith()]);

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'claude-code',
      message: 'Claude finished',
      hookInput: { last_assistant_message: '  ' },
    });

    expect(harness.agentReplied).not.toHaveBeenCalled();
  });

  it("records a done's message when its hook carries no reply", async () => {
    const harness = createAttentionHarness([workspaceWith()]);

    const done = harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'antigravity',
      message: 'Fixed the login redirect.',
      hookInput: { hook_event_name: 'Stop' },
    });
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(harness.agentReplied).toHaveBeenCalledExactlyOnceWith(
      'ws-1',
      'Fixed the login redirect.',
      undefined
    );
  });

  it.each(['Agent finished', 'OpenCode finished', 'Compacted the conversation', 'Stop'])(
    'records no reply from a done that says only %s',
    async (message) => {
      const harness = createAttentionHarness([workspaceWith()]);

      const done = harness.attention.hook(harness.toWorkspace('ws-1'), {
        kind: 'turn-complete',
        source: 'opencode',
        message,
        hookInput: { hook_event_name: 'Stop' },
      });
      await vi.advanceTimersByTimeAsync(2000);
      await done;

      expect(harness.agentReplied).not.toHaveBeenCalled();
    }
  );

  it('records no reply from a Terminal that no longer exists', async () => {
    const harness = createAttentionHarness([workspaceWith()]);

    await harness.attention.hook(harness.toWorkspace('ws-1', { hasInvalidTerminalId: true }), {
      kind: 'turn-complete',
      source: 'claude-code',
      hookInput: { last_assistant_message: 'Fixed it.' },
    });

    expect(harness.agentReplied).not.toHaveBeenCalled();
  });

  it('records no reply from a failed turn or a command', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);

    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'error',
      source: 'claude-code',
      hookInput: { hook_event_name: 'StopFailure', last_assistant_message: 'API Error: 529' },
    });
    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'turn-complete',
      source: 'command',
      hookInput: { last_assistant_message: 'npm test passed' },
    });

    expect(harness.agentReplied).not.toHaveBeenCalled();
  });

  it('leaves a copied done to the attached installation', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);

    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'turn-complete',
      source: 'claude-code',
      copy: true,
      hookInput: { last_assistant_message: 'Fixed it.' },
    });

    expect(harness.agentReplied).not.toHaveBeenCalled();
  });
});

describe('spinner per agent', () => {
  it('keeps a Claude input-required within the turn, so its done stops the spinner', async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'input-required',
      source: 'claude-code',
      message: 'Permission needed',
    });
    expect(workspace.agentActive).toBe(true);

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'claude-code',
    });
    expect(workspace.agentActive).toBe(false);
  });

  it("keeps a Claude input-required on its Terminal's spinner without counting it again", async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const target = harness.toTerminal('term-1');
    const prompt: AgentHook = {
      kind: 'input-required',
      source: 'claude-code',
      message: 'Permission needed',
    };

    await harness.attention.hook(target, prompt);
    await harness.attention.hook(target, prompt);

    expect(harness.terminal('term-1').agentActive).toBe(true);
    expect(harness.attention.persistedSources('ws-1', 'term-1')).toEqual({ 'claude-code': 1 });
  });

  it.each([
    { kind: 'input-required' as const, source: 'codex' },
    { kind: 'error' as const, source: 'claude-code' },
  ])('neither starts nor stops the spinner on $kind from $source', async ({ kind, source }) => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');

    await harness.attention.hook(harness.toWorkspace('ws-1'), { kind, source, message: 'x' });
    expect(workspace.agentActive).toBeFalsy();

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source,
      message: 'do the thing',
    });
    await harness.attention.hook(harness.toWorkspace('ws-1'), { kind, source, message: 'x' });
    expect(workspace.agentActive).toBe(true);
  });

  it("turns on a Terminal's spinner once for repeated prompt-submits", async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const workspace = harness.workspace('ws-1');
    const submit: AgentHook = { kind: 'prompt-submit', source: 'codex', message: 'do the thing' };

    await harness.attention.hook(harness.toTerminal('term-1'), submit);
    await harness.attention.hook(harness.toTerminal('term-1'), submit);

    expect(harness.terminal('term-1').agentActive).toBe(true);
    expect(workspace.agentActive).toBe(true);
    expect(harness.attention.persistedSources('ws-1', 'term-1')).toEqual({ codex: 1 });
  });

  it('starts no spinner, and clears no attention, for a prompt-submit with a stale Terminal id', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const workspace = harness.workspace('ws-1');
    const terminal = harness.terminal('term-1');
    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });

    await harness.attention.hook(harness.toWorkspace('ws-1', { hasInvalidTerminalId: true }), {
      kind: 'prompt-submit',
      source: 'codex',
      message: 'do the thing',
    });

    // Like its done, which couldn't stop the spinner.
    expect(workspace.agentActive).toBeFalsy();
    expect(terminal.agentActive).toBeFalsy();
    expect(harness.attention.persistedSources('ws-1', 'term-1')).toBeUndefined();
    expect(terminal.attention).toMatchObject({ kind: 'turn-complete' });
    expect(workspace.attention).toMatchObject({ kind: 'turn-complete', terminalId: 'term-1' });
  });

  it('names prompt-submits without a source generic', async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      message: 'do the thing',
    });
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    expect(workspace.agentActive).toBe(true);

    await harness.attention.hook(harness.toWorkspace('ws-1'), { kind: 'turn-complete' });
    expect(workspace.agentActive).toBe(false);
  });

  it("stops only the sending agent's spinner on a turn-complete without a Terminal", async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');
    for (const source of ['claude-code', 'codex']) {
      await harness.attention.hook(harness.toWorkspace('ws-1'), {
        kind: 'prompt-submit',
        source,
        message: 'do the thing',
      });
    }

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'codex',
      message: 'Codex done',
    });
    expect(workspace.agentActive).toBe(true);

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'claude-code',
    });
    expect(workspace.agentActive).toBe(false);
  });

  it("stops every agent on the Terminal, and only that Terminal's spinner, on its turn-complete", async () => {
    const harness = createAttentionHarness([
      workspaceWith([createTerminal({ id: 'term-1' }), createTerminal({ id: 'term-2' })]),
    ]);
    const workspace = harness.workspace('ws-1');
    harness.attention.restored(
      workspace,
      sources({ 'term-1': { codex: 1, 'claude-code': 1 }, 'term-2': { codex: 1 } })
    );
    harness.attention.spinnerToggled('ws-1', true);

    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'turn-complete',
      source: 'codex',
      message: 'Codex done',
    });

    expect(harness.terminal('term-1').agentActive).toBe(false);
    expect(harness.attention.persistedSources('ws-1', 'term-1')).toBeUndefined();
    expect(harness.terminal('term-2').agentActive).toBe(true);
    expect(workspace.agentActive).toBe(true);
    expect(harness.relay.interrupted).not.toHaveBeenCalled();
    // The spinner turned on by hand stopped with term-1's done, so term-2's ends the workspace's.
    await harness.attention.hook(harness.toTerminal('term-2'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    expect(workspace.agentActive).toBe(false);
  });

  it("keeps a prompt that named no Terminal working when one Terminal's agent finishes", async () => {
    const harness = createAttentionHarness([
      workspaceWith([createTerminal({ id: 'term-1' }), createTerminal({ id: 'term-2' })]),
    ]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source: 'claude-code',
    });
    await harness.attention.hook(harness.toTerminal('term-2'), {
      kind: 'prompt-submit',
      source: 'codex',
    });

    await harness.attention.hook(harness.toTerminal('term-2'), {
      kind: 'turn-complete',
      source: 'codex',
    });

    expect(harness.terminal('term-2').agentActive).toBe(false);
    expect(workspace.agentActive).toBe(true);
  });

  it('stops no spinner on a turn-complete with a stale Terminal id', async () => {
    const harness = createAttentionHarness([workspaceWith([createTerminal({ id: 'term-1' })])]);
    const workspace = harness.workspace('ws-1');
    const terminal = harness.terminal('term-1');
    harness.attention.restored(workspace, sources({ 'term-1': { codex: 1 } }));
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source: 'codex',
      message: 'do the thing',
    });

    await harness.attention.hook(harness.toWorkspace('ws-1', { hasInvalidTerminalId: true }), {
      kind: 'turn-complete',
      source: 'codex',
      message: 'Old Codex done',
    });

    expect(terminal.agentActive).toBe(true);
    expect(harness.attention.persistedSources('ws-1', 'term-1')).toEqual({ codex: 1 });
    // The workspace-wide codex spinner survived too: stopping term-1 leaves the workspace spinning.
    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    expect(terminal.agentActive).toBe(false);
    expect(workspace.agentActive).toBe(true);
  });

  it("stops the sending agent's spinner on idle", async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source: 'opencode',
      message: 'do the thing',
    });
    expect(workspace.agentActive).toBe(true);

    await harness.attention.hook(harness.toWorkspace('ws-1'), { kind: 'idle', source: 'opencode' });

    expect(workspace.agentActive).toBe(false);
  });
});

describe('a done while another agent keeps working', () => {
  async function anotherAgentWorking(harness: AttentionHarness) {
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source: 'claude-code',
      message: 'do the thing',
    });
    expect(harness.workspace('ws-1').agentActive).toBe(true);
  }

  it('keeps the done next to the spinner', async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');
    await anotherAgentWorking(harness);

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(workspace.attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });
    expect(workspace.needsAttention).toBe(true);
    expect(badgeCount(harness)).toBe(1);
    expect(workspace.agentActive).toBe(true);
  });

  it("keeps a Terminal's done while another Terminal's prompt shows on the workspace", async () => {
    const harness = createAttentionHarness([
      workspaceWith([createTerminal({ id: 'term-1' }), createTerminal({ id: 'term-2' })]),
    ]);
    const workspace = harness.workspace('ws-1');
    // Claude waits for permission in term-2, keeping its spinner on.
    await harness.attention.hook(harness.toTerminal('term-2'), {
      kind: 'input-required',
      source: 'claude-code',
    });

    await harness.attention.hook(harness.toTerminal('term-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.terminal('term-1').attention).toMatchObject({ kind: 'turn-complete' });
    expect(workspace.attention).toMatchObject({ kind: 'input-required', terminalId: 'term-2' });
    expect(workspace.agentActive).toBe(true);
  });

  it('keeps a done when no other agent is working', async () => {
    const harness = createAttentionHarness([workspaceWith()]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'prompt-submit',
      source: 'codex',
      message: 'do the thing',
    });

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(workspace.agentActive).toBe(false);
    expect(workspace.attention).toMatchObject({ kind: 'turn-complete', source: 'codex' });
    expect(workspace.needsAttention).toBe(true);
    expect(badgeCount(harness)).toBe(1);
  });

  it("keeps another agent's input-required when a done arrives without a Terminal", async () => {
    const prompt: WorkspaceAttention = {
      kind: 'input-required',
      source: 'claude-code',
      updatedAt: 1,
      message: 'Needs permission',
    };
    const harness = createAttentionHarness([
      workspaceWith([], { attention: prompt, needsAttention: true }),
    ]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'activity',
      source: 'codex',
    });
    expect(workspace.agentActive).toBe(true);

    await harness.attention.hook(harness.toWorkspace('ws-1'), {
      kind: 'turn-complete',
      source: 'codex',
    });

    // Codex is done regardless, but the prompt keeps showing.
    expect(workspace.agentActive).toBe(false);
    expect(workspace.attention).toEqual(prompt);
    expect(workspace.needsAttention).toBe(true);
    expect(harness.windows.attentionRaised).not.toHaveBeenCalled();
  });

  it.each([
    ['error', 'Command failed'],
    ['turn-complete', undefined],
  ] as const)(
    "keeps another Terminal's %s on the workspace when a Terminal reports idle",
    async (kind, message) => {
      const harness = createAttentionHarness([
        workspaceWith([createTerminal({ id: 'term-a' }), createTerminal({ id: 'term-b' })]),
      ]);
      const workspace = harness.workspace('ws-1');
      await harness.attention.hook(harness.toTerminal('term-a'), {
        kind,
        source: 'codex',
        message,
      });
      const shown = workspace.attention;

      await harness.attention.hook(harness.toTerminal('term-b'), {
        kind: 'idle',
        source: 'claude-code',
      });

      expect(harness.terminal('term-b').attention).toBeUndefined();
      expect(harness.windows.attentionRaised).toHaveBeenCalledTimes(1);
      expect(workspace.attention).toEqual(shown);
      expect(workspace.attention).toMatchObject({ kind, terminalId: 'term-a' });
      expect(workspace.needsAttention).toBe(true);
      expect(badgeCount(harness)).toBe(1);
    }
  );

  it("keeps another Terminal's prompt on the workspace when a Terminal sends a notification", async () => {
    const harness = createAttentionHarness([
      workspaceWith([createTerminal({ id: 'term-a' }), createTerminal({ id: 'term-b' })]),
    ]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toTerminal('term-a'), {
      kind: 'input-required',
      source: 'codex',
    });
    const prompt = workspace.attention;

    await harness.attention.hook(harness.toTerminal('term-b'), {
      kind: 'generic',
      source: 'my-agent',
      title: 'Build finished',
    });

    expect(harness.terminal('term-b').attention).toMatchObject({ kind: 'generic' });
    expect(workspace.attention).toEqual(prompt);
    expect(workspace.needsAttention).toBe(true);
  });

  it('tells windows what the workspace shows along with the attention a Terminal raised', async () => {
    const harness = createAttentionHarness([
      workspaceWith([createTerminal({ id: 'term-a' }), createTerminal({ id: 'term-b' })]),
    ]);
    const workspace = harness.workspace('ws-1');
    await harness.attention.hook(harness.toTerminal('term-a'), {
      kind: 'input-required',
      source: 'codex',
    });
    expect(harness.windows.attentionRaised).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceAttention: workspace.attention })
    );
    const prompt = workspace.attention;

    await harness.attention.hook(harness.toTerminal('term-b'), {
      kind: 'turn-complete',
      source: 'claude-code',
    });

    expect(harness.windows.attentionRaised).toHaveBeenLastCalledWith({
      workspaceId: 'ws-1',
      attention: harness.terminal('term-b').attention,
      workspaceAttention: prompt,
    });
  });
});
