import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../../src/shared/constants/ipc-channels';

import type { Automation } from '../../../src/shared/types/automation';

type LaunchLocal = (
  automation: Automation,
  request: { trigger: 'schedule' | 'manual'; startedAt: number }
) => Promise<{ workspaceId: string }>;

const { dependencies, create, broadcastWhenReady } = vi.hoisted(() => ({
  dependencies: {} as { launchLocal?: unknown },
  create: vi.fn(),
  broadcastWhenReady: vi.fn(),
}));

vi.mock('../../../src/main/services/automation/automation-service', () => ({
  AutomationService: class {
    constructor(given: { launchLocal: unknown }) {
      dependencies.launchLocal = given.launchLocal;
    }
  },
}));
vi.mock('../../../src/main/services/automation/host-client', () => ({
  createAutomationHostClient: () => ({}),
}));
vi.mock('../../../src/main/services/automation/local-store', () => ({
  LocalAutomationStore: class {},
}));
vi.mock('../../../src/main/services/agent-preset.service', () => ({ agentPresetService: {} }));
vi.mock('../../../src/main/services/config.service', () => ({ configService: {} }));
vi.mock('../../../src/main/services/git.service', () => ({ gitService: {} }));
vi.mock('../../../src/main/services/paths', () => ({ getKomlaBasePath: () => '/komla' }));
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: { get: () => ({ id: 'p1', kind: 'git' }) },
}));
vi.mock('../../../src/main/services/remote-companion.service', () => ({
  remoteCompanionService: {},
}));
vi.mock('../../../src/main/services/ssh-host.service', () => ({ sshHostService: {} }));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({ sshWorkspaceService: {} }));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: { getMainWindowId: () => 'main-window', broadcastWhenReady },
}));
vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: { create },
}));

describe('an automation run on this computer', () => {
  const automation = {
    name: 'Nightly deps',
    projectId: 'p1',
    prompt: 'Update the dependencies.',
    schedule: { timeZone: 'Europe/Oslo' },
  } as Automation;
  const workspace = { id: 'ws-run', projectId: 'p1' };
  let launchLocal: LaunchLocal;

  beforeEach(async () => {
    broadcastWhenReady.mockClear();
    create.mockReset().mockResolvedValue(workspace);
    await import('../../../src/main/services/automation.service');
    launchLocal = dependencies.launchLocal as LaunchLocal;
  });

  // Windows bring a workspace someone asked for into sight, and leave a scheduled one be.
  it.each([
    { trigger: 'schedule' as const, scheduled: true },
    { trigger: 'manual' as const, scheduled: false },
  ])('tells windows whether its schedule started it: $trigger', async ({ trigger, scheduled }) => {
    await launchLocal(automation, { trigger, startedAt: Date.UTC(2026, 9, 15, 7) });

    expect(broadcastWhenReady).toHaveBeenCalledWith(IPC.WORKSPACE_CREATED, workspace, {
      scheduled,
    });
  });
});
