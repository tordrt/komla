import { EventEmitter } from 'events';

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

// --- Top-level mocks ---

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0-test'),
    getLocale: vi.fn(() => 'en-US'),
    isPackaged: true,
  },
  net: {
    request: vi.fn(),
  },
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../../src/main/lib/api-urls', () => ({
  API_BASE_URL: 'https://test.komla.dev',
}));

vi.mock('../../../src/main/lib/build-info', () => ({
  getBuildDistribution: () => 'official',
}));

const mockConfig: Record<string, unknown> = {
  telemetryPingSent: false,
  lastHeartbeatDate: null,
  telemetryDistinctId: 'app_test-id',
  anonymousTelemetryEnabled: true,
  usageTelemetryEnabled: true,
  reportedTelemetryMilestones: [],
};

vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: vi.fn(() => ({ ...mockConfig })),
    getTelemetryDistinctId: vi.fn(() => mockConfig.telemetryDistinctId),
    update: vi.fn((updates: Record<string, unknown>) => {
      Object.assign(mockConfig, updates);
    }),
  },
}));

vi.mock('../../../src/main/services/agent-preset.service', () => ({
  // Stored presets always have isBuiltin false, even the stock ones.
  BUILTIN_PRESETS: [{ name: 'test-agent' }],
  agentPresetService: {
    getActive: vi.fn((): { name: string; isBuiltin?: boolean } | undefined => ({
      name: 'test-agent',
      isBuiltin: false,
    })),
  },
}));

vi.mock('../../../src/main/services/license.service', () => ({
  licenseService: {
    getStatus: vi.fn(() => ({ isLicensed: true, licenseType: 'lifetime' })),
  },
}));

vi.mock('../../../src/main/services/metrics-collector.service', () => ({
  metricsCollectorService: {
    confirmFlush: vi.fn(),
    discard: vi.fn(),
    flush: vi.fn(() => ({
      schemaVersion: 2,
      version: '1.0.0-test',
      platform: 'darwin',
      arch: 'arm64',
      distinctId: 'app_test-id',
      agent: 'test-agent',
      isLicensed: false,
      licenseCohort: 'paid_lifetime',
      licenseType: 'lifetime',
      runningWorkspacesAvg: 0,
      stoppedWorkspaces: 0,
      archivedWorkspaces: 0,
      totalWorkspaces: 0,
      workspacesCreated: 0,
      agentTabsCreated: 0,
      actionsUsed: 0,
      promptActionsUsed: 0,
      terminalActionsUsed: 0,
      projectsConfigured: 0,
      projectsWithWorkspaceSetup: 0,
    })),
  },
}));

// --- Helper: createMockNetRequest ---

interface MockNetRequestController {
  request: {
    setHeader: ReturnType<typeof vi.fn>;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };
  simulateResponse: (statusCode: number) => void;
  simulateError: (error: Error) => void;
  getRequestBody: () => unknown;
}

function createMockNetRequest(): MockNetRequestController {
  const requestEmitter = new EventEmitter();
  let writtenBody = '';

  const request = {
    setHeader: vi.fn(),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      requestEmitter.on(event, cb);
    },
    write: vi.fn((data: string) => {
      writtenBody += data;
    }),
    end: vi.fn(),
    abort: vi.fn(),
  };

  return {
    request,
    simulateResponse(statusCode: number) {
      const responseEmitter = new EventEmitter();
      const response = Object.assign(responseEmitter, { statusCode });
      requestEmitter.emit('response', response);
      responseEmitter.emit('data', Buffer.from('{}'));
      responseEmitter.emit('end');
    },
    simulateError(error: Error) {
      requestEmitter.emit('error', error);
    },
    getRequestBody() {
      return writtenBody ? JSON.parse(writtenBody) : null;
    },
  };
}

describe('TelemetryService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConfig.telemetryPingSent = false;
    mockConfig.lastHeartbeatDate = null;
    mockConfig.telemetryDistinctId = 'app_test-id';
    mockConfig.anonymousTelemetryEnabled = true;
    mockConfig.usageTelemetryEnabled = true;
    mockConfig.reportedTelemetryMilestones = [];
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('KOMLA_TELEMETRY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('turned off', () => {
    it('sends no install ping or heartbeat when anonymous telemetry is off', async () => {
      const { net } = await import('electron');
      mockConfig.anonymousTelemetryEnabled = false;
      mockConfig.usageTelemetryEnabled = false;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      await telemetryService.sendInstallPing();
      await telemetryService.sendDailyHeartbeat();

      expect(net.request).not.toHaveBeenCalled();
    });

    it.each([
      ['DO_NOT_TRACK', '1'],
      ['KOMLA_TELEMETRY', 'off'],
      ['KOMLA_TELEMETRY', '0'],
    ])('sends nothing when %s=%s, even when opted in', async (name, value) => {
      const { net } = await import('electron');
      vi.stubEnv(name, value);
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      await telemetryService.sendInstallPing();
      await telemetryService.sendDailyHeartbeat();
      telemetryService.sendMonetizationEvent('upgrade_clicked');
      telemetryService.sendSshHostAdded('tips');
      telemetryService.sendAgentSelected('Claude Code');
      telemetryService.sendIntegrationMilestone('mcp:tool-used', { tool: 'x' });

      expect(net.request).not.toHaveBeenCalled();
    });
  });

  describe('dev mode', () => {
    it('skips install ping when app is not packaged', async () => {
      const { app, net } = await import('electron');
      (app as any).isPackaged = false;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      await telemetryService.sendInstallPing();

      expect(net.request).not.toHaveBeenCalled();
      (app as any).isPackaged = true;
    });

    it('skips heartbeat when app is not packaged', async () => {
      const { app, net } = await import('electron');
      (app as any).isPackaged = false;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      await telemetryService.sendDailyHeartbeat();

      expect(net.request).not.toHaveBeenCalled();
      (app as any).isPackaged = true;
    });

    it('still sends monetization telemetry when app is not packaged', async () => {
      const { app, net } = await import('electron');
      (app as any).isPackaged = false;
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      telemetryService.sendMonetizationEvent('upgrade_clicked', {
        source: 'free_limit_wall',
      });
      controller.simulateResponse(200);

      expect(net.request).toHaveBeenCalledWith({
        method: 'POST',
        url: 'https://test.komla.dev/api/v1/telemetry/monetization',
      });
      expect(controller.getRequestBody()).toMatchObject({
        event: 'upgrade_clicked',
        source: 'free_limit_wall',
        distinctId: 'app_test-id',
      });
      expect(controller.request.setHeader).toHaveBeenCalledWith(
        'User-Agent',
        expect.stringContaining('Komla/1.0.0-test')
      );
      expect(controller.request.setHeader).toHaveBeenCalledWith('Accept-Language', 'en-US');
      (app as any).isPackaged = true;
    });
  });

  describe('sendInstallPing', () => {
    it('skips when already sent', async () => {
      const { net } = await import('electron');
      mockConfig.telemetryPingSent = true;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      await telemetryService.sendInstallPing();

      expect(net.request).not.toHaveBeenCalled();
    });

    it('sends ping with correct payload', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendInstallPing();
      controller.simulateResponse(200);
      await promise;

      const body = controller.getRequestBody();
      expect(body).toMatchObject({
        appVersion: '1.0.0-test',
        platform: process.platform,
        arch: process.arch,
        distribution: 'official',
        distinctId: 'app_test-id',
      });
      expect(controller.request.setHeader).toHaveBeenCalledWith(
        'User-Agent',
        expect.stringContaining('Komla/1.0.0-test')
      );
      expect(controller.request.setHeader).toHaveBeenCalledWith('Accept-Language', 'en-US');
    });

    it('omits the distinct id when usage telemetry is not opted in', async () => {
      const { net } = await import('electron');
      mockConfig.usageTelemetryEnabled = false;
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendInstallPing();
      controller.simulateResponse(200);
      await promise;

      const body = controller.getRequestBody();
      expect(body).toMatchObject({ appVersion: '1.0.0-test', platform: process.platform });
      expect(body).not.toHaveProperty('distinctId');
    });

    it('updates config on success', async () => {
      const { net } = await import('electron');
      const { configService } = await import('../../../src/main/services/config.service');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendInstallPing();
      controller.simulateResponse(200);
      await promise;

      expect(configService.update).toHaveBeenCalledWith({ telemetryPingSent: true });
    });

    it('does not throw on failure', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendInstallPing();
      controller.simulateResponse(500);
      // Should not throw
      await expect(promise).resolves.toBeUndefined();
    });

    it('handles network error silently', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendInstallPing();
      controller.simulateError(new Error('network down'));
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe('sendAgentSelected', () => {
    it('skips when app is not packaged', async () => {
      const { app, net } = await import('electron');
      (app as any).isPackaged = false;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      telemetryService.sendAgentSelected('Cursor CLI');

      expect(net.request).not.toHaveBeenCalled();
      (app as any).isPackaged = true;
    });

    it('skips when usage telemetry is disabled', async () => {
      const { net } = await import('electron');
      mockConfig.usageTelemetryEnabled = false;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      telemetryService.sendAgentSelected('Cursor CLI');

      expect(net.request).not.toHaveBeenCalled();
    });

    it('sends ping with the chosen agent and correct payload', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      telemetryService.sendAgentSelected('Cursor CLI');
      controller.simulateResponse(200);

      expect(net.request).toHaveBeenCalledWith({
        method: 'POST',
        url: 'https://test.komla.dev/api/v1/telemetry/agent-selected',
      });
      expect(controller.getRequestBody()).toMatchObject({
        appVersion: '1.0.0-test',
        platform: process.platform,
        arch: process.arch,
        agent: 'Cursor CLI',
        distinctId: 'app_test-id',
      });
    });

    it('does not throw on failure', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      expect(() => {
        telemetryService.sendAgentSelected('Cursor CLI');
        controller.simulateResponse(500);
      }).not.toThrow();
    });
  });

  describe('sendSshHostAdded', () => {
    it('skips when app is not packaged', async () => {
      const { app, net } = await import('electron');
      (app as any).isPackaged = false;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      telemetryService.sendSshHostAdded('tips');

      expect(net.request).not.toHaveBeenCalled();
      (app as any).isPackaged = true;
    });

    it('skips when usage telemetry is not opted in', async () => {
      const { net } = await import('electron');
      mockConfig.usageTelemetryEnabled = false;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      telemetryService.sendSshHostAdded('tips');

      expect(net.request).not.toHaveBeenCalled();
    });

    it('sends where the host was added from', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      telemetryService.sendSshHostAdded('new_workspace');
      controller.simulateResponse(200);

      expect(net.request).toHaveBeenCalledWith({
        method: 'POST',
        url: 'https://test.komla.dev/api/v1/telemetry/ssh-host-added',
      });
      expect(controller.getRequestBody()).toEqual({
        appVersion: '1.0.0-test',
        platform: process.platform,
        arch: process.arch,
        distribution: 'official',
        source: 'new_workspace',
        distinctId: 'app_test-id',
      });
    });

    it('does not throw on failure', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      expect(() => {
        telemetryService.sendSshHostAdded('settings');
        controller.simulateResponse(500);
      }).not.toThrow();
    });
  });

  describe('sendIntegrationMilestone', () => {
    it('skips when app is not packaged', async () => {
      const { app, net } = await import('electron');
      (app as any).isPackaged = false;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      telemetryService.sendIntegrationMilestone('notification:idle', {
        notificationKind: 'idle',
      });

      expect(net.request).not.toHaveBeenCalled();
      (app as any).isPackaged = true;
    });

    it('skips when usage telemetry is disabled', async () => {
      const { net } = await import('electron');
      mockConfig.usageTelemetryEnabled = false;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      telemetryService.sendIntegrationMilestone('notification:idle', {
        notificationKind: 'idle',
      });

      expect(net.request).not.toHaveBeenCalled();
    });

    it('skips a milestone that was already reported', async () => {
      const { net } = await import('electron');
      mockConfig.reportedTelemetryMilestones = ['notification:idle'];
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      telemetryService.sendIntegrationMilestone('notification:idle', {
        notificationKind: 'idle',
      });

      expect(net.request).not.toHaveBeenCalled();
    });

    it('sends a milestone with the active agent and props', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      telemetryService.sendIntegrationMilestone('mcp:tool-used', {
        tool: 'spawn_agent_in_new_workspace',
      });
      controller.simulateResponse(200);

      expect(net.request).toHaveBeenCalledWith({
        method: 'POST',
        url: 'https://test.komla.dev/api/v1/telemetry/milestone',
      });
      expect(controller.getRequestBody()).toMatchObject({
        appVersion: '1.0.0-test',
        platform: process.platform,
        arch: process.arch,
        milestone: 'mcp:tool-used',
        agent: 'test-agent',
        tool: 'spawn_agent_in_new_workspace',
        distinctId: 'app_test-id',
      });
    });

    it('attributes the agent from the notification source instead of the active preset', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      telemetryService.sendIntegrationMilestone('notification:turn-complete:codex', {
        notificationKind: 'turn-complete',
        source: 'codex',
      });
      controller.simulateResponse(200);

      const body = controller.getRequestBody();
      expect(body).toMatchObject({
        milestone: 'notification:turn-complete:codex',
        agent: 'codex',
        notificationKind: 'turn-complete',
      });
      // `source` is consumed for attribution, not forwarded as its own prop.
      expect(body).not.toHaveProperty('source');
    });

    it('persists the milestone to config on success', async () => {
      const { net } = await import('electron');
      const { configService } = await import('../../../src/main/services/config.service');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      telemetryService.sendIntegrationMilestone('notification:turn-complete', {
        notificationKind: 'turn-complete',
      });
      controller.simulateResponse(200);
      // Let the response promise's .then() settle.
      await new Promise((r) => setImmediate(r));

      expect(configService.update).toHaveBeenCalledWith({
        reportedTelemetryMilestones: ['notification:turn-complete'],
      });
    });

    it('does not double-send a milestone whose ping is in flight', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      telemetryService.sendIntegrationMilestone('notification:idle', {
        notificationKind: 'idle',
      });
      // Second call before the first response arrives.
      telemetryService.sendIntegrationMilestone('notification:idle', {
        notificationKind: 'idle',
      });

      expect(net.request).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendDailyHeartbeat', () => {
    it('sends heartbeat when never sent before', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      controller.simulateResponse(200);
      await promise;

      expect(net.request).toHaveBeenCalled();
    });

    it('says whether this is the first heartbeat of the week and month', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2027-01-01T12:00:00Z'));
      mockConfig.lastHeartbeatDate = '2026-12-31';
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValueOnce(controller.request as any);
      mockConfig.usageTelemetryEnabled = false;

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      controller.simulateResponse(200);
      await promise;
      vi.useRealTimers();

      const body = controller.getRequestBody();
      expect(body).toMatchObject({ firstThisWeek: false, firstThisMonth: true });
      expect(body).not.toHaveProperty('lastHeartbeatDate');
    });

    it('skips when already sent today', async () => {
      const { net } = await import('electron');
      mockConfig.lastHeartbeatDate = new Date().toISOString().split('T')[0]; // Today

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      await telemetryService.sendDailyHeartbeat();

      expect(net.request).not.toHaveBeenCalled();
    });

    it('sends when last heartbeat was yesterday', async () => {
      const { net } = await import('electron');
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      mockConfig.lastHeartbeatDate = yesterday;

      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      controller.simulateResponse(200);
      await promise;

      expect(net.request).toHaveBeenCalled();
    });

    it('updates lastHeartbeatDate to today on success', async () => {
      const { net } = await import('electron');
      const { configService } = await import('../../../src/main/services/config.service');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      controller.simulateResponse(200);
      await promise;

      const today = new Date().toISOString().split('T')[0];
      expect(configService.update).toHaveBeenCalledWith({ lastHeartbeatDate: today });
    });

    it('includes agent name in heartbeat payload', async () => {
      const { net } = await import('electron');
      const heartbeatController = createMockNetRequest();
      const usageController = createMockNetRequest();
      vi.mocked(net.request)
        .mockReturnValueOnce(heartbeatController.request as any)
        .mockReturnValueOnce(usageController.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      heartbeatController.simulateResponse(200);
      await promise;

      const body = heartbeatController.getRequestBody();
      expect(body).toMatchObject({
        agent: 'test-agent',
        isLicensed: true,
        distinctId: 'app_test-id',
        licenseCohort: 'paid_lifetime',
        licenseType: 'lifetime',
      });
    });

    it('reports a custom agent preset as Custom, never by its name', async () => {
      const { net } = await import('electron');
      const { agentPresetService } =
        await import('../../../src/main/services/agent-preset.service');
      vi.mocked(agentPresetService.getActive).mockReturnValueOnce({ name: 'acme-internal-bot' });
      mockConfig.usageTelemetryEnabled = false;
      const heartbeatController = createMockNetRequest();
      vi.mocked(net.request).mockReturnValueOnce(heartbeatController.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      heartbeatController.simulateResponse(200);
      await promise;

      expect(heartbeatController.getRequestBody()).toMatchObject({ agent: 'Custom' });
    });

    it('sends an anonymous counting heartbeat when usage telemetry is not opted in', async () => {
      const { net } = await import('electron');
      mockConfig.usageTelemetryEnabled = false;
      const heartbeatController = createMockNetRequest();
      vi.mocked(net.request).mockReturnValueOnce(heartbeatController.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      heartbeatController.simulateResponse(200);
      await promise;

      const body = heartbeatController.getRequestBody();
      expect(body).toMatchObject({
        agent: 'test-agent',
        isLicensed: true,
        licenseCohort: 'paid_lifetime',
      });
      expect(body).not.toHaveProperty('distinctId');
    });

    it('uploads Umami-shaped usage summary payloads', async () => {
      const { net } = await import('electron');
      const heartbeatController = createMockNetRequest();
      const usageController = createMockNetRequest();
      vi.mocked(net.request)
        .mockReturnValueOnce(heartbeatController.request as any)
        .mockReturnValueOnce(usageController.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      heartbeatController.simulateResponse(200);
      await promise;

      expect(usageController.getRequestBody()).toMatchObject({
        schemaVersion: 2,
        version: '1.0.0-test',
        distinctId: 'app_test-id',
        licenseCohort: 'paid_lifetime',
        runningWorkspacesAvg: 0,
      });
    });

    it('skips usage summary upload when usage telemetry is disabled', async () => {
      const { net } = await import('electron');
      const { metricsCollectorService } =
        await import('../../../src/main/services/metrics-collector.service');
      mockConfig.usageTelemetryEnabled = false;

      const heartbeatController = createMockNetRequest();
      vi.mocked(net.request).mockReturnValueOnce(heartbeatController.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      heartbeatController.simulateResponse(200);
      await promise;

      expect(net.request).toHaveBeenCalledTimes(1);
      expect(metricsCollectorService.flush).not.toHaveBeenCalled();
      expect(metricsCollectorService.discard).toHaveBeenCalledTimes(1);
      expect(metricsCollectorService.confirmFlush).not.toHaveBeenCalled();
    });

    it('falls back to "unknown" when no active preset', async () => {
      const { net } = await import('electron');
      const { agentPresetService } =
        await import('../../../src/main/services/agent-preset.service');
      vi.mocked(agentPresetService.getActive).mockReturnValue(null as any);

      const heartbeatController = createMockNetRequest();
      const usageController = createMockNetRequest();
      vi.mocked(net.request)
        .mockReturnValueOnce(heartbeatController.request as any)
        .mockReturnValueOnce(usageController.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      heartbeatController.simulateResponse(200);
      await promise;

      const body = heartbeatController.getRequestBody();
      expect(body).toMatchObject({ agent: 'unknown' });
    });

    it('handles failure silently', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      controller.simulateError(new Error('timeout'));
      await expect(promise).resolves.toBeUndefined();
    });

    it('re-checks heartbeat on hourly interval for long-running instances', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-06T12:00:00.000Z'));
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      // Send initial heartbeat for today
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      controller.simulateResponse(200);
      await promise;

      // Already sent today, so advancing 1 hour should not trigger another request
      vi.mocked(net.request).mockClear();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(net.request).not.toHaveBeenCalled();

      // Simulate day rollover by changing the stored date to yesterday
      mockConfig.lastHeartbeatDate = '2020-01-01';
      const controller2 = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller2.request as any);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(net.request).toHaveBeenCalled();

      vi.useRealTimers();
    });
    it('sends one heartbeat when a second check starts while the first is in flight', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);
      mockConfig.usageTelemetryEnabled = false;

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const first = telemetryService.sendDailyHeartbeat();
      const second = telemetryService.sendDailyHeartbeat();
      controller.simulateResponse(200);
      await Promise.all([first, second]);

      expect(net.request).toHaveBeenCalledTimes(1);
    });

    it('gives up on a heartbeat that gets no response, so the next check can retry', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-06T12:00:00.000Z'));
      const { net } = await import('electron');
      const { configService } = await import('../../../src/main/services/config.service');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      const promise = telemetryService.sendDailyHeartbeat();
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await promise;

      expect(controller.request.abort).toHaveBeenCalled();
      expect(configService.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ lastHeartbeatDate: expect.any(String) })
      );
      vi.useRealTimers();
    });
  });

  describe('sendMonetizationEvent', () => {
    it('sends safe monetization payload with app metadata and distinct id', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      telemetryService.sendMonetizationEvent('free_limit_hit', {
        source: 'create_workspace',
        limit: 4,
        runningCount: 4,
      });
      controller.simulateResponse(200);

      expect(net.request).toHaveBeenCalledWith({
        method: 'POST',
        url: 'https://test.komla.dev/api/v1/telemetry/monetization',
      });
      expect(controller.getRequestBody()).toMatchObject({
        event: 'free_limit_hit',
        appVersion: '1.0.0-test',
        platform: process.platform,
        arch: process.arch,
        isLicensed: true,
        distinctId: 'app_test-id',
        licenseCohort: 'paid_lifetime',
        licenseType: 'lifetime',
        source: 'create_workspace',
        limit: 4,
        runningCount: 4,
      });
    });

    it('skips monetization events when usage telemetry is not opted in', async () => {
      const { net } = await import('electron');
      mockConfig.usageTelemetryEnabled = false;
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');

      telemetryService.sendMonetizationEvent('free_limit_hit', { source: 'create_workspace' });

      expect(net.request).not.toHaveBeenCalled();
    });

    it('exposes the telemetry distinct id', async () => {
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      expect(telemetryService.getDistinctId()).toBe('app_test-id');
    });

    it('withholds the distinct id when not opted in or turned off by the environment', async () => {
      const { telemetryService } = await import('../../../src/main/services/telemetry.service');
      vi.stubEnv('DO_NOT_TRACK', '1');
      expect(telemetryService.getDistinctId()).toBeNull();
      vi.stubEnv('DO_NOT_TRACK', '');
      mockConfig.usageTelemetryEnabled = false;
      expect(telemetryService.getDistinctId()).toBeNull();
    });
  });
});
