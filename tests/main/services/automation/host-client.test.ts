/* eslint-disable import/order -- Vitest's hoisted mocks must precede service imports. */
import { describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

import {
  createAutomationHostClient,
  hostCommandError,
  parseHostListing,
} from '../../../../src/main/services/automation/host-client';

const automation = {
  schema: 1,
  id: 'triage',
  name: 'Triage issues',
  prompt: 'Triage new issues',
  enabled: true,
  schedule: { cron: '0 8 * * 1-5', timeZone: 'Europe/Oslo' },
  missedRunGraceMinutes: 720,
  project: {
    remoteRepoPath: '/home/me/.komla/repos/app/repo.git',
    remoteProjectRoot: '/home/me/.komla/worktrees/app',
    gitUrl: 'git@github.com:me/app.git',
  },
  launch: { agentName: 'Codex', promptCommand: 'codex {{prompt}}', openCommand: 'codex' },
  createdAt: 1,
  updatedAt: 2,
};

describe('automation host client', () => {
  it('drops automations and runs it cannot read, and puts the newest run first', () => {
    const listing = parseHostListing(
      JSON.stringify({
        automations: [automation, { ...automation, id: '../escape' }, { schema: 2 }],
        runs: {
          triage: [
            {
              id: 'a',
              automationId: 'triage',
              trigger: 'schedule',
              startedAt: 1,
              status: 'started',
            },
            { id: 'b', automationId: 'triage', trigger: 'manual', startedAt: 5, status: 'failed' },
            { id: 'c', automationId: 'triage', trigger: 'later', startedAt: 9, status: 'started' },
          ],
        },
        scheduler: { available: false, message: "cron isn't installed on this host" },
      })
    );

    expect(listing.automations.map((candidate) => candidate.id)).toEqual(['triage']);
    expect(listing.runs.triage?.map((run) => run.id)).toEqual(['b', 'a']);
    expect(listing.scheduler).toEqual({
      available: false,
      message: "cron isn't installed on this host",
    });
  });

  it('shows the host CLI’s own explanation of a failure', () => {
    const error = Object.assign(new Error('Command failed'), {
      stderr: 'warning: something\nStart one workspace for this project on this host first.\n',
    });

    expect(hostCommandError(error, 'save the automation').message).toBe(
      'Start one workspace for this project on this host first.'
    );
    expect(hostCommandError(new Error('timed out'), 'save the automation').message).toBe(
      'Could not save the automation on the SSH host: timed out'
    );
  });

  it('sends the automation on stdin and reads the scheduler status back', async () => {
    const run = vi.fn(async () => JSON.stringify({ scheduler: { available: true } }));
    const client = createAutomationHostClient({ run });

    await expect(client.save('host-1', automation as never)).resolves.toEqual({ available: true });
    expect(run).toHaveBeenCalledWith(
      'host-1',
      ['automation', 'save'],
      expect.objectContaining({ input: JSON.stringify(automation) })
    );

    await client.delete('host-1', 'triage');
    expect(run).toHaveBeenLastCalledWith(
      'host-1',
      ['automation', 'delete', 'triage'],
      expect.not.objectContaining({ input: expect.anything() })
    );
  });

  it('reads the reply after anything the host’s login profile printed', async () => {
    const run = vi.fn(async () => 'Welcome to devbox!\n{"scheduler":{"available":true}}\n');
    const client = createAutomationHostClient({ run });

    await expect(client.delete('host-1', 'triage')).resolves.toEqual({ available: true });
    expect(
      parseHostListing(
        `Last login: Thu Oct 15\n${JSON.stringify({ automations: [automation], runs: {}, scheduler: { available: true } })}\n`
      ).automations
    ).toHaveLength(1);
  });

  it('turns an automation off on the host and returns it as the host has it', async () => {
    const stored = { ...automation, prompt: 'Edited on another device', enabled: false };
    const run = vi.fn(async () =>
      JSON.stringify({ automation: stored, scheduler: { available: true } })
    );
    const client = createAutomationHostClient({ run });

    await expect(client.setEnabled('host-1', 'triage', false)).resolves.toEqual({
      automation: stored,
      scheduler: { available: true },
    });
    expect(run).toHaveBeenCalledWith(
      'host-1',
      ['automation', 'disable', 'triage'],
      expect.anything()
    );
  });

  it('gives a run time to wait for a tick and fetch, and says one that timed out may still start', async () => {
    const timedOut = Object.assign(new Error('Command failed: ssh devbox'), {
      killed: true,
      signal: 'SIGTERM',
      stderr: '',
    });
    const run = vi.fn(async () => {
      throw timedOut;
    });
    const client = createAutomationHostClient({ run });

    await expect(client.run('host-1', 'triage')).rejects.toThrow('The run may still start there');
    await expect(client.list('host-1')).rejects.toThrow('took too long');
    const [[, , runOptions], [, , listOptions]] = run.mock.calls as unknown as Array<
      [string, string[], { timeoutMs: number }]
    >;
    // The host waits up to a minute for a tick, then fetches for up to 30 s.
    expect(runOptions.timeoutMs).toBeGreaterThan(90_000);
    expect(listOptions.timeoutMs).toBeLessThan(runOptions.timeoutMs);
  });
});
