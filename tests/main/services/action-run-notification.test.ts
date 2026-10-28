import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backgroundActionNotification } from '../../../src/main/services/workspace-setup/action-run-notification';
import { createWorkspace, resetIdCounter } from '../../factories';
import { createAttentionHarness } from '../../helpers/terminal-attention';

import type { SetupActivityRun } from '../../../src/shared/types';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function run(overrides: Partial<SetupActivityRun>): SetupActivityRun {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    setupRunId: 'action-run-1',
    stepId: 'watch-ci',
    stepName: 'Watch CI',
    actionId: 'watch-ci',
    retryable: true,
    state: 'succeeded',
    startedAt: 0,
    completedAt: 65_000,
    exitCode: 0,
    output: '',
    ...overrides,
  };
}

beforeEach(() => {
  resetIdCounter();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('background Action notifications', () => {
  it('shows a finished run as done on its workspace', async () => {
    const harness = createAttentionHarness([createWorkspace({ id: 'ws-1', terminals: [] })]);

    await harness.settle(harness.toWorkspace('ws-1'), backgroundActionNotification(run({})));

    expect(harness.workspace('ws-1').attention).toEqual(
      expect.objectContaining({
        kind: 'turn-complete',
        source: 'command',
        title: 'Watch CI',
        body: 'Finished in 1m 5s',
      })
    );
    expect(harness.workspace('ws-1').needsAttention).toBe(true);
  });

  it('shows a failed run as an error with how it failed', async () => {
    const harness = createAttentionHarness([createWorkspace({ id: 'ws-1', terminals: [] })]);

    await harness.settle(
      harness.toWorkspace('ws-1'),
      backgroundActionNotification(run({ state: 'failed', exitCode: 1, completedAt: 4_000 }))
    );

    expect(harness.workspace('ws-1').attention).toEqual(
      expect.objectContaining({
        kind: 'error',
        title: 'Watch CI',
        body: 'Failed with exit code 1 after 4s',
      })
    );
  });

  it('names the error of a run that never started', () => {
    expect(
      backgroundActionNotification(
        run({
          state: 'unsupported',
          exitCode: undefined,
          error: 'SSH Local copy requires rsync',
          completedAt: 0,
        })
      ).body
    ).toBe('Failed with SSH Local copy requires rsync after 0s');
  });
});
