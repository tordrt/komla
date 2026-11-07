import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminal, createWorkspace } from '../../factories';
import { createAttentionHarness } from '../../helpers/terminal-attention';

import { FOLDER_TRUST_BADGE } from '../../../src/main/services/terminal-attention/terminal-attention';

vi.mock('electron', async () => (await import('../../mocks/electron')).mockElectron());

/** Workspace ws-1 with Terminals t1 and t2. */
function harness() {
  return createAttentionHarness([
    createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 't1' }), createTerminal({ id: 't2' })],
    }),
  ]);
}

describe('TerminalAttention folder trust', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a folder trust prompt as input the workspace needs', () => {
    const h = harness();
    h.attention.folderTrustAsked('t1', 'claude-code');

    const attention = {
      kind: 'input-required',
      source: 'claude-code',
      badge: FOLDER_TRUST_BADGE,
      message: 'Claude Code asks you to trust this project',
      terminalId: 't1',
    };
    expect(h.terminal('t1').attention).toMatchObject(attention);
    expect(h.workspace('ws-1')).toMatchObject({ needsAttention: true, attention });
    expect(h.windows.attentionRaised).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId: 'ws-1', attention: expect.objectContaining(attention) })
    );
    expect(h.windows.badge).toHaveBeenLastCalledWith(1);
    // The agent hasn't started, so nothing works yet.
    expect(h.terminal('t1').agentActive).toBeFalsy();
  });

  it('takes the prompt back once it is answered', () => {
    const h = harness();
    h.attention.folderTrustAsked('t1', 'codex');
    h.attention.folderTrustAnswered('t1', 'codex');

    expect(h.terminal('t1').attention).toBeUndefined();
    expect(h.workspace('ws-1').needsAttention).toBe(false);
  });

  it("leaves a request the agent raised itself, which isn't the trust prompt's to take back", async () => {
    const h = harness();
    h.attention.folderTrustAsked('t1', 'claude-code');
    await h.settle(h.toTerminal('t1'), {
      source: 'claude-code',
      kind: 'input-required',
      message: 'Claude needs your permission to use Bash',
    });
    h.attention.folderTrustAnswered('t1', 'claude-code');

    expect(h.terminal('t1').attention).toMatchObject({
      kind: 'input-required',
      message: 'Claude needs your permission to use Bash',
    });
  });

  it("reports each agent hook and program status with the Terminal's workspace", async () => {
    const h = harness();
    await h.settle(h.toTerminal('t1'), { source: 'codex', kind: 'activity' });
    h.attention.programStatusChanged('t2', { app: 'claude-code', state: 'idle' });

    expect(h.agentReported).toHaveBeenCalledWith(h.workspace('ws-1'), 'codex', 't1');
    expect(h.agentReported).toHaveBeenCalledWith(h.workspace('ws-1'), 'claude-code', 't2');
  });

  it('reports no program that names no app, as Codex and Claude Code do as they quit', () => {
    const h = harness();
    h.attention.programStatusChanged('t1', { state: 'clear' });
    expect(h.agentReported).not.toHaveBeenCalled();
  });
});
