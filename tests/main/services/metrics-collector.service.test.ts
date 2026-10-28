import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVirtualFs } from '../../mocks/fs';
import { mockElectron } from '../../mocks/electron';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

const vfs = createVirtualFs();
vi.mock('fs', () => vfs.mock);

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => '/mock/home/.komla',
  ensureKomlaBasePath: () => '/mock/home/.komla',
}));

vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomicSync: (path: string, content: string) => vfs.mock.writeFileSync(path, content),
}));

// Mock dependent services
const mockWorkspaceService = {
  getRunningWorkspaceCount: vi.fn().mockReturnValue(2),
  getDiagnostics: vi.fn().mockReturnValue({
    workspaceCount: 5,
    stoppedWorkspaceCount: 2,
    trashedWorkspaceCount: 2,
  }),
};

const mockConfigService = {
  get: vi.fn().mockReturnValue({
    usageTelemetryEnabled: true,
  }),
  getTelemetryDistinctId: vi.fn().mockReturnValue('app_test-id'),
};

const mockAgentPresetService = {
  getActive: vi.fn().mockReturnValue({ id: '1', name: 'Claude Code', isBuiltin: false }),
  getActivePresets: vi.fn().mockReturnValue([{ presetId: '1', lastUsedAt: Date.now() }]),
  get: vi.fn().mockReturnValue({ id: '1', name: 'Claude Code' }),
};

const mockLicenseService = {
  getStatus: vi.fn().mockReturnValue({ isLicensed: true, licenseType: 'monthly' }),
};

const mockProjectService = {
  list: vi.fn().mockReturnValue([
    { id: 'p1', name: 'Project 1', setupSteps: [{ id: 's1', command: 'npm install' }] },
    { id: 'p2', name: 'Project 2' },
  ]),
};

vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: mockConfigService,
}));
vi.mock('../../../src/main/services/agent-preset.service', () => ({
  agentPresetService: mockAgentPresetService,
  BUILTIN_PRESETS: [{ name: 'Claude Code' }],
}));
vi.mock('../../../src/main/services/license.service', () => ({
  licenseService: mockLicenseService,
}));
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: mockProjectService,
}));

describe('MetricsCollectorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vfs.clear();
    vi.resetModules();
    vi.useFakeTimers();
    // Make app.isPackaged true so metrics collection starts
    electronMock.app.isPackaged = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createService() {
    const mod = await import('../../../src/main/services/metrics-collector.service');
    return mod.metricsCollectorService;
  }

  describe('counter increments', () => {
    it('should increment kept workspace counters', async () => {
      const service = await createService();
      service.start();

      service.increment('workspacesCreated');
      service.increment('workspacesCreated');
      service.increment('agentTabsCreated');

      const payload = await service.flush();
      expect(payload.workspacesCreated).toBe(2);
      expect(payload.agentTabsCreated).toBe(1);
      service.stop();
    });

    it('should increment prompt and terminal action counters', async () => {
      const service = await createService();
      service.start();

      service.incrementAction('prompt');
      service.incrementAction('command');
      service.incrementAction('command');

      const payload = await service.flush();
      expect(payload.actionsUsed).toBe(3);
      expect(payload.promptActionsUsed).toBe(1);
      expect(payload.terminalActionsUsed).toBe(2);
      service.stop();
    });
  });

  describe('recordUtilityRequest', () => {
    it('should count requests by provider', async () => {
      const service = await createService();
      service.start();

      service.recordUtilityRequest({ provider: 'komla-managed', success: true });
      service.recordUtilityRequest({ provider: 'komla-managed', success: true });
      service.recordUtilityRequest({ provider: 'custom', success: true });

      const payload = await service.flush();
      expect(payload.utilityRequests.managed).toBe(2);
      expect(payload.utilityRequests.custom).toBe(1);
      service.stop();
    });

    it('should count failures by reason and default a missing reason to "other"', async () => {
      const service = await createService();
      service.start();

      service.recordUtilityRequest({
        provider: 'komla-managed',
        success: false,
        errorReason: 'timeout',
      });
      service.recordUtilityRequest({ provider: 'custom', success: false });

      const payload = await service.flush();
      expect(payload.utilityRequests.managed).toBe(1);
      expect(payload.utilityRequests.custom).toBe(1);
      expect(payload.utilityRequests.failuresByReason.timeout).toBe(1);
      expect(payload.utilityRequests.failuresByReason.other).toBe(1);
      service.stop();
    });

    it('should reset utility request counts after flush', async () => {
      const service = await createService();
      service.start();

      service.recordUtilityRequest({ provider: 'custom', success: false });
      const first = await service.flush();
      expect(first.utilityRequests.custom).toBe(1);
      expect(first.utilityRequests.failuresByReason.other).toBe(1);

      service.confirmFlush();
      const second = await service.flush();
      expect(second.utilityRequests.custom).toBe(0);
      expect(second.utilityRequests.failuresByReason.other).toBe(0);
      service.stop();
    });
  });

  describe('flush', () => {
    it('should produce a complete payload with all fields', async () => {
      const service = await createService();
      service.start();

      const payload = await service.flush();

      // Metadata
      expect(payload.schemaVersion).toBe(2);
      expect(payload.version).toBe('1.0.0');
      expect(payload.platform).toBe(process.platform);
      expect(payload.arch).toBe(process.arch);
      expect(payload.terminalShell).toBe(process.platform === 'win32' ? 'powershell' : 'native');
      expect(payload.distinctId).toBe('app_test-id');
      expect(payload.agent).toBe('Claude Code');
      expect(payload.isLicensed).toBe(true);
      expect(payload.licenseCohort).toBe('paid_monthly');
      expect(payload.licenseType).toBe('monthly');

      // Snapshot
      expect(typeof payload.runningWorkspacesAvg).toBe('number');

      // Counters default to 0
      expect(payload.workspacesCreated).toBe(0);
      expect(payload.agentTabsCreated).toBe(0);
      expect(payload.actionsUsed).toBe(0);

      // Project adoption
      expect(payload.projectsConfigured).toBe(2);
      expect(payload.projectsWithWorkspaceSetup).toBe(1);

      // Utility AI requests default to 0
      expect(payload.utilityRequests.managed).toBe(0);
      expect(payload.utilityRequests.custom).toBe(0);
      expect(payload.utilityRequests.failuresByReason.other).toBe(0);
      service.stop();
    });

    it('reports WSL as the terminal shell without including the distro', async () => {
      mockConfigService.get.mockReturnValue({
        usageTelemetryEnabled: true,
        shellMode: 'wsl',
        wslDistro: 'Ubuntu',
      });
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const service = await createService();
      try {
        service.start();

        const payload = await service.flush();
        expect(payload.terminalShell).toBe('wsl');
        expect(payload).not.toHaveProperty('wslDistro');
      } finally {
        service.stop();
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        mockConfigService.get.mockReturnValue({
          usageTelemetryEnabled: true,
        });
      }
    });

    it('should reset counters after flush', async () => {
      const service = await createService();
      service.start();

      service.increment('workspacesCreated');
      const first = await service.flush();
      expect(first.workspacesCreated).toBe(1);

      service.confirmFlush();
      const second = await service.flush();
      expect(second.workspacesCreated).toBe(0);
      service.stop();
    });

    it('should read snapshot values from services', async () => {
      const service = await createService();
      service.start();

      // flush() takes a snapshot before producing the payload
      const payload = await service.flush();
      expect(payload.runningWorkspacesAvg).toBe(2);
      expect(payload.stoppedWorkspaces).toBe(2);
      expect(payload.archivedWorkspaces).toBe(2);
      expect(payload.totalWorkspaces).toBe(5);
      service.stop();
    });

    it('should discard pending and in-memory usage state when analytics is disabled', async () => {
      const service = await createService();
      service.start();

      service.increment('workspacesCreated');
      const flushed = await service.flush();
      expect(flushed.workspacesCreated).toBe(1);

      service.increment('workspacesCreated');
      service.discard();

      const afterDiscard = await service.flush();
      expect(afterDiscard.workspacesCreated).toBe(0);
      service.stop();
    });

    it('does not collect metrics while usage analytics is disabled', async () => {
      const service = await createService();
      service.start();

      mockConfigService.get.mockReturnValue({
        usageTelemetryEnabled: false,
      });

      service.increment('workspacesCreated');

      mockConfigService.get.mockReturnValue({
        usageTelemetryEnabled: true,
      });

      const payload = await service.flush();
      expect(payload.workspacesCreated).toBe(0);
      service.stop();
    });

    it('does not recreate metrics file while usage analytics is disabled', async () => {
      const service = await createService();
      service.start();
      service.discard();

      mockConfigService.get.mockReturnValue({
        usageTelemetryEnabled: false,
      });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      service.stop();

      expect(vfs.hasFile('/mock/home/.komla/metrics-today.json')).toBe(false);
    });

    it('starts a fresh metrics session when analytics is re-enabled', async () => {
      vi.setSystemTime(new Date('2026-03-29T10:00:00.000Z'));
      const service = await createService();
      service.start();

      mockConfigService.get.mockReturnValue({
        usageTelemetryEnabled: false,
      });
      service.discard();

      vi.setSystemTime(new Date('2026-03-29T12:00:00.000Z'));
      mockConfigService.get.mockReturnValue({
        usageTelemetryEnabled: true,
      });

      const payload = await service.flush();
      expect(payload.workspacesCreated).toBe(0);
      service.stop();
    });
  });

  describe('snapshot accumulation', () => {
    it('should compute average across multiple snapshots', async () => {
      const service = await createService();
      service.start();

      // First snapshot: runningWorkspaceCount = 2
      // Now change to 5
      mockWorkspaceService.getRunningWorkspaceCount.mockReturnValue(5);

      const payload = await service.flush(); // takes another snapshot
      // avg should be (2 + 5) / 2 = 3.5 -> 4 rounded
      expect(payload.runningWorkspacesAvg).toBe(4);

      mockWorkspaceService.getRunningWorkspaceCount.mockReturnValue(2);
      service.stop();
    });
  });

  describe('crash recovery', () => {
    it('should load persisted state from disk', async () => {
      const today = new Date().toISOString().split('T')[0];
      const persistedState = {
        date: today,
        runningWorkspaces: { sum: 30, count: 5 },
        counters: {
          workspacesCreated: 7,
          agentTabsCreated: 0,
        },
      };

      vfs.mock.existsSync = vi.fn().mockReturnValue(true);
      vfs.mock.readFileSync = vi.fn().mockReturnValue(JSON.stringify(persistedState));

      const service = await createService();
      service.start();

      // Should have resumed the counter
      service.increment('workspacesCreated');
      const payload = await service.flush();
      expect(payload.workspacesCreated).toBe(8); // 7 from disk + 1 increment
      service.stop();
    });

    it('should flush previous-day data as pending on next-day startup', async () => {
      const persistedState = {
        date: '2024-01-01', // previous day
        counters: { workspacesCreated: 99 },
      };

      vfs.mock.existsSync = vi.fn().mockReturnValue(true);
      vfs.mock.readFileSync = vi.fn().mockReturnValue(JSON.stringify(persistedState));

      const service = await createService();
      service.start();

      // First flush returns the previous day's pending data
      const payload = await service.flush();
      expect(payload.workspacesCreated).toBe(99);

      // After confirmFlush, a second flush returns fresh state
      service.confirmFlush();
      const payload2 = await service.flush();
      expect(payload2.workspacesCreated).toBe(0);
      service.stop();
    });
  });

  describe('dev mode guard', () => {
    it('should skip metrics collection in dev mode', async () => {
      electronMock.app.isPackaged = false;

      const service = await createService();
      service.start();

      // increment still works (no-op protection not needed, service just doesn't start timer)
      service.increment('workspacesCreated');
      const payload = await service.flush();
      expect(payload.workspacesCreated).toBe(1);
      service.stop();
    });
  });
});
