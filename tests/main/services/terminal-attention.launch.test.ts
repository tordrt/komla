import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LAUNCH_REPORT_WAIT_MS,
  SSH_LAUNCH_REPORT_WAIT_MS,
} from '../../../src/main/services/terminal-attention/terminal-attention';
import { createSshWorkspace, createTerminal, createWorkspace } from '../../factories';
import { createAttentionHarness } from '../../helpers/terminal-attention';

import type { AgentHook } from '../../../src/main/services/terminal-attention/terminal-attention';

vi.mock('electron', async () => (await import('../../mocks/electron')).mockElectron());

const prompted = (source: string): AgentHook => ({
  kind: 'prompt-submit',
  source,
});
const done = (source: string): AgentHook => ({ kind: 'turn-complete', source });

function localWorkspace() {
  return createWorkspace({
    id: 'ws-1',
    terminals: [createTerminal({ id: 't1' })],
  });
}

function sshWorkspace() {
  return createSshWorkspace({
    id: 'ws-42',
    terminals: [createTerminal({ id: 't1' })],
  });
}

describe('Terminal Attention State: an agent launched with a prompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('works from the launch, before the agent reports', () => {
    const { attention, workspace, terminal } = createAttentionHarness([localWorkspace()]);

    attention.agentLaunched('t1');

    expect(terminal('t1').agentActive).toBe(true);
    expect(terminal('t1').commandActive).toBeFalsy();
    expect(workspace('ws-1').agentActive).toBe(true);
  });

  it('stops working when the agent never reports', async () => {
    const { attention, workspace, terminal, store } = createAttentionHarness([localWorkspace()]);

    attention.agentLaunched('t1');
    await vi.advanceTimersByTimeAsync(LAUNCH_REPORT_WAIT_MS - 1);
    expect(terminal('t1').agentActive).toBe(true);

    store.broadcast.mockClear();
    await vi.advanceTimersByTimeAsync(1);
    expect(terminal('t1').agentActive).toBe(false);
    expect(workspace('ws-1').agentActive).toBe(false);
    expect(store.broadcast).toHaveBeenCalledWith(workspace('ws-1'));
  });

  it('waits longer for an agent on an SSH host', async () => {
    const { attention, terminal } = createAttentionHarness([sshWorkspace()]);

    attention.agentLaunched('t1');
    await vi.advanceTimersByTimeAsync(LAUNCH_REPORT_WAIT_MS);
    expect(terminal('t1').agentActive).toBe(true);

    await vi.advanceTimersByTimeAsync(SSH_LAUNCH_REPORT_WAIT_MS - LAUNCH_REPORT_WAIT_MS);
    expect(terminal('t1').agentActive).toBe(false);
  });

  it('hands over to the agent once it reports, keeping when it started', async () => {
    const { attention, terminal, toTerminal } = createAttentionHarness([localWorkspace()]);

    attention.agentLaunched('t1');
    const launchedAt = terminal('t1').agentActiveSince;
    await vi.advanceTimersByTimeAsync(3_000);
    await attention.hook(toTerminal('t1'), prompted('claude-code'));
    await vi.advanceTimersByTimeAsync(LAUNCH_REPORT_WAIT_MS);

    expect(terminal('t1').agentActive).toBe(true);
    expect(terminal('t1').agentActiveSince).toBe(launchedAt);

    await attention.hook(toTerminal('t1'), done('claude-code'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(terminal('t1').agentActive).toBe(false);
  });

  it('stops working as the agent asks the user to trust the folder', () => {
    const { attention, terminal } = createAttentionHarness([localWorkspace()]);

    attention.agentLaunched('t1');
    attention.folderTrustAsked('t1', 'claude-code');

    expect(terminal('t1').agentActive).toBe(false);
  });

  it('stops working as the agent exits', () => {
    const { attention, terminal } = createAttentionHarness([localWorkspace()]);

    attention.agentLaunched('t1');
    attention.ended('t1');

    expect(terminal('t1').agentActive).toBe(false);
  });

  it('tells no other installation of an interrupt that stopped only the launch', () => {
    const { attention, terminal, relay } = createAttentionHarness([sshWorkspace()]);

    attention.agentLaunched('t1');
    attention.aborted('t1', true);

    expect(terminal('t1').agentActive).toBe(false);
    expect(relay.interrupted).not.toHaveBeenCalled();
  });

  it('is not saved, as it could not stop after a restart', () => {
    const { attention } = createAttentionHarness([localWorkspace()]);

    attention.agentLaunched('t1');

    expect(attention.persistedSources('ws-1', 't1')).toBeUndefined();
  });

  describe('while its workspace is still being created', () => {
    const provisioning = () =>
      createWorkspace({ id: 'ws-1', terminals: [], provisioning: true });

    it('works before the workspace has a Terminal, however long the setup takes', async () => {
      const { attention, workspace } = createAttentionHarness([provisioning()]);

      attention.agentLaunching('ws-1');
      await vi.advanceTimersByTimeAsync(SSH_LAUNCH_REPORT_WAIT_MS * 2);

      expect(workspace('ws-1').agentActive).toBe(true);
      expect(workspace('ws-1').agentLaunching).toBe(true);
    });

    it("moves to the agent's Terminal as it launches, keeping when the workspace started", async () => {
      const { attention, workspace, terminal, add } = createAttentionHarness([provisioning()]);

      attention.agentLaunching('ws-1');
      const createdAt = workspace('ws-1').agentActiveSince;
      await vi.advanceTimersByTimeAsync(5_000);
      add({ ...workspace('ws-1'), terminals: [createTerminal({ id: 't1' })] });
      attention.agentLaunched('t1');
      attention.launchSettled('ws-1');

      expect(terminal('t1').agentActive).toBe(true);
      expect(workspace('ws-1').agentLaunching).toBeFalsy();
      expect(workspace('ws-1').agentActiveSince).toBe(createdAt);

      await vi.advanceTimersByTimeAsync(LAUNCH_REPORT_WAIT_MS);
      expect(terminal('t1').agentActive).toBe(false);
      expect(workspace('ws-1').agentActive).toBe(false);
    });

    it('stops working when the setup ends without the agent', () => {
      const { attention, workspace, store } = createAttentionHarness([provisioning()]);

      attention.agentLaunching('ws-1');
      store.broadcast.mockClear();
      attention.launchSettled('ws-1');

      expect(workspace('ws-1').agentActive).toBe(false);
      expect(workspace('ws-1').agentLaunching).toBeFalsy();
      expect(store.broadcast).toHaveBeenCalledWith(workspace('ws-1'));
    });

    it('is no longer on its way once the user turns the spinner off', () => {
      const { attention, workspace } = createAttentionHarness([provisioning()]);

      attention.agentLaunching('ws-1');
      attention.spinnerToggled('ws-1', false);

      expect(workspace('ws-1').agentActive).toBe(false);
      expect(workspace('ws-1').agentLaunching).toBeFalsy();
    });

    it('settles a launch while another spinner keeps the workspace working', () => {
      const { attention, workspace, store } = createAttentionHarness([provisioning()]);

      attention.spinnerToggled('ws-1', true);
      attention.agentLaunching('ws-1');
      store.broadcast.mockClear();
      attention.launchSettled('ws-1');

      expect(workspace('ws-1').agentActive).toBe(true);
      expect(workspace('ws-1').agentLaunching).toBeFalsy();
      expect(store.broadcast).toHaveBeenCalledWith(workspace('ws-1'));
    });
  });

  it('a later launch in the Terminal waits afresh', async () => {
    const { attention, terminal } = createAttentionHarness([localWorkspace()]);

    attention.agentLaunched('t1');
    await vi.advanceTimersByTimeAsync(LAUNCH_REPORT_WAIT_MS - 1_000);
    attention.ended('t1');
    attention.agentLaunched('t1');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(terminal('t1').agentActive).toBe(true);
  });
});
