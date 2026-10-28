import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutomationsStore } from '../../../src/renderer/stores/automations.store';

import type { AutomationTargetSnapshot } from '../../../src/shared/types/automation';

function snapshot(name: string, workspaceId: string): AutomationTargetSnapshot[] {
  return [
    {
      target: { kind: 'local' },
      automations: [
        {
          id: 'nightly',
          name,
          prompt: 'Check dependencies',
          target: { kind: 'local' },
          schedule: { cron: '0 9 * * *', timeZone: 'UTC' },
          enabled: true,
          missedRunGraceMinutes: 720,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      runs: {
        nightly: [
          {
            id: 'run-1',
            automationId: 'nightly',
            trigger: 'schedule',
            startedAt: 1,
            status: 'started',
            workspaceId,
          },
        ],
      },
      scheduler: { available: true },
    },
  ];
}

describe('automations store', () => {
  beforeEach(() => {
    useAutomationsStore.setState(useAutomationsStore.getInitialState(), true);
  });

  it('names the automation that started each workspace', async () => {
    const listAutomations = vi.fn().mockResolvedValue(snapshot('Nightly', 'ws-1'));
    (globalThis as any).window = { api: { listAutomations } };

    await useAutomationsStore.getState().loadAutomations({ readHosts: 'in-use' });

    expect(listAutomations).toHaveBeenCalledWith({ readHosts: 'in-use' });
    expect(useAutomationsStore.getState().automationNameByWorkspace).toEqual({ 'ws-1': 'Nightly' });
  });

  it('keeps the latest load when an earlier one finishes after it', async () => {
    let finishFirst!: (snapshots: AutomationTargetSnapshot[]) => void;
    const listAutomations = vi
      .fn()
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce(snapshot('Newer', 'ws-2'));
    (globalThis as any).window = { api: { listAutomations } };

    const first = useAutomationsStore.getState().loadAutomations();
    await useAutomationsStore.getState().loadAutomations();
    finishFirst(snapshot('Older', 'ws-1'));
    await first;

    expect(useAutomationsStore.getState().automationNameByWorkspace).toEqual({ 'ws-2': 'Newer' });
  });
});
