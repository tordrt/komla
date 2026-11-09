import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsManagementError } from '../../../src/main/services/settings-management.service';
import { approveTerminalSend } from '../../../src/main/services/terminal-send-approval';

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../../../src/main/services/settings-approval.service', () => ({
  settingsApprovalService: { decide: mocks.decide },
}));
vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: { get: mocks.get },
}));

const request = {
  workspaceId: 'workspace-1',
  callerTerminalId: 'lead',
  callerWorkspaceId: 'workspace-2',
  terminal: { id: 'review', name: 'Codex', state: 'idle' as const },
  text: 'rm -rf build',
  forced: false,
};

const workspaces: Record<string, { id: string; name: string; customName?: string }> = {
  'workspace-1': { id: 'workspace-1', name: 'fix-login', customName: 'Fix login' },
  'workspace-2': { id: 'workspace-2', name: 'review-pr' },
};

describe('approveTerminalSend', () => {
  beforeEach(() => {
    mocks.decide.mockReset().mockResolvedValue('apply');
    mocks.get.mockReset().mockImplementation((id: string) => workspaces[id]);
  });

  it('shows the user the message, and the terminal and workspace it goes to', async () => {
    const signal = new AbortController().signal;

    await expect(approveTerminalSend(request, signal)).resolves.toBe('apply');

    expect(mocks.decide).toHaveBeenCalledWith(
      {
        resource: 'terminal-send',
        workspace: workspaces['workspace-2'],
        terminalId: 'lead',
        description: expect.stringContaining('type this into Codex in Fix login and press Enter'),
        changes: [
          {
            operation: 'send',
            kind: 'terminal-message',
            title: 'Codex',
            content: 'rm -rf build',
            details: [{ label: 'Workspace', value: 'Fix login' }],
          },
        ],
      },
      signal
    );
  });

  it('names where it comes from by the sender’s own workspace, not the one it goes to', async () => {
    await approveTerminalSend(request, new AbortController().signal);

    const [prompt] = mocks.decide.mock.calls[0];
    expect(prompt.workspace).toBe(workspaces['workspace-2']);
    expect(prompt.terminalId).toBe('lead');
    expect(prompt.description).toContain('An agent or program in another terminal');
  });

  it('says a program outside any terminal sent it, and names no source', async () => {
    await approveTerminalSend(
      { ...request, callerTerminalId: undefined, callerWorkspaceId: undefined },
      new AbortController().signal
    );

    const [prompt] = mocks.decide.mock.calls[0];
    expect(prompt.description).toContain('A program outside Komla’s terminals');
    expect(prompt).not.toHaveProperty('terminalId');
    expect(prompt.workspace).toBeUndefined();
  });

  it('treats a terminal id Komla has no workspace for as outside, since nothing can name it', async () => {
    await approveTerminalSend(
      { ...request, callerWorkspaceId: undefined },
      new AbortController().signal
    );

    const [prompt] = mocks.decide.mock.calls[0];
    expect(prompt.description).toContain('A program outside Komla’s terminals');
    expect(prompt).not.toHaveProperty('terminalId');
  });

  it('warns that a forced message answers the question the agent is waiting on', async () => {
    await approveTerminalSend(
      {
        ...request,
        forced: true,
        terminal: { ...request.terminal, state: 'blocked', message: 'Run rm -rf?' },
      },
      new AbortController().signal
    );

    const [prompt] = mocks.decide.mock.calls[0];
    expect(prompt.warning).toBe('Codex is waiting for you: Run rm -rf?. This message answers it.');
    expect(prompt.description).toContain('answer Codex in Fix login, which is waiting for you');
  });

  it('names a terminal without a tab name by its id', async () => {
    await approveTerminalSend(
      { ...request, terminal: { id: 'b2', state: 'idle' } },
      new AbortController().signal
    );

    expect(mocks.decide.mock.calls[0][0].changes[0].title).toBe('Terminal b2');
  });

  it('passes the user’s refusal and an unanswered prompt on', async () => {
    mocks.decide.mockResolvedValueOnce('cancel').mockResolvedValueOnce('unanswered');
    const signal = new AbortController().signal;

    await expect(approveTerminalSend(request, signal)).resolves.toBe('cancel');
    await expect(approveTerminalSend(request, signal)).resolves.toBe('unanswered');
  });

  it('counts a missing window as no answer, and lets other failures through', async () => {
    mocks.decide
      .mockRejectedValueOnce(new SettingsManagementError('NO_APPROVAL_WINDOW', 'No window.', 503))
      .mockRejectedValueOnce(new Error('boom'));
    const signal = new AbortController().signal;

    await expect(approveTerminalSend(request, signal)).resolves.toBe('unanswered');
    await expect(approveTerminalSend(request, signal)).rejects.toThrow('boom');
  });
});
