import { EventEmitter } from 'events';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockApp } from '../../mocks/electron';

interface MockNetRequestController {
  request: {
    setHeader: ReturnType<typeof vi.fn>;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  simulateResponse: (statusCode: number) => void;
  simulateError: (error: Error) => void;
  getRequestBody: () => unknown;
  getHeaders: () => Record<string, string>;
}

function createMockNetRequest(): MockNetRequestController {
  const requestEmitter = new EventEmitter();
  const headers: Record<string, string> = {};
  let writtenBody = '';

  const request = {
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      requestEmitter.on(event, cb);
    },
    write: vi.fn((data: string) => {
      writtenBody += data;
    }),
    end: vi.fn(),
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
    getHeaders() {
      return headers;
    },
  };
}

const getConfig = vi.fn(() => ({ errorReportingEnabled: true }));
const getStatus = vi.fn(() => ({ isLicensed: true }));
const getActive = vi.fn(() => ({ name: 'Claude Code', isBuiltin: false }));

const appMock = mockApp({
  isPackaged: true,
  getVersion: vi.fn(() => '9.9.9'),
});

const netRequest = vi.fn();

vi.mock('electron', () => ({
  app: appMock,
  net: { request: netRequest },
}));

vi.mock('../../../src/main/lib/api-urls', () => ({
  API_BASE_URL: 'https://komla.dev',
}));

vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: getConfig,
  },
}));

vi.mock('../../../src/main/services/license.service', () => ({
  licenseService: {
    getStatus,
  },
}));

vi.mock('../../../src/main/services/agent-preset.service', () => ({
  BUILTIN_PRESETS: [{ name: 'Claude Code' }],
  agentPresetService: {
    getActive,
  },
}));

describe('ErrorReportingService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    appMock.isPackaged = true;
    getConfig.mockReturnValue({ errorReportingEnabled: true });
    getStatus.mockReturnValue({ isLicensed: true });
    getActive.mockReturnValue({ name: 'Claude Code', isBuiltin: false });
    vi.unstubAllEnvs();
  });

  it('skips reporting when DO_NOT_TRACK is set', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');

    const { errorReportingService } =
      await import('../../../src/main/services/error-reporting.service');
    await errorReportingService.report(new Error('boom'), 'uncaughtException');

    expect(netRequest).not.toHaveBeenCalled();
  });

  it('reports a custom agent preset as Custom', async () => {
    getActive.mockReturnValue({ name: 'acme-internal-bot', isBuiltin: false });
    const netCtrl = createMockNetRequest();
    netRequest.mockReturnValue(netCtrl.request);

    const { errorReportingService } =
      await import('../../../src/main/services/error-reporting.service');
    await errorReportingService.report(new Error('boom'), 'uncaughtException');

    expect(netCtrl.getRequestBody()).toMatchObject({
      systemInfo: { agentPresetName: 'Custom' },
    });
  });

  it('skips transient network errors', async () => {
    const { errorReportingService } =
      await import('../../../src/main/services/error-reporting.service');

    await errorReportingService.report(new Error('net::ERR_CONNECTION_RESET'), 'uncaughtException');
    await errorReportingService.report(
      new Error('net::ERR_INTERNET_DISCONNECTED'),
      'uncaughtException'
    );
    await errorReportingService.report(
      new Error('net::ERR_CONNECTION_TIMED_OUT'),
      'unhandledRejection'
    );

    expect(netRequest).not.toHaveBeenCalled();
  });

  it('skips reporting when user opts out', async () => {
    getConfig.mockReturnValue({ errorReportingEnabled: false });

    const { errorReportingService } =
      await import('../../../src/main/services/error-reporting.service');
    await errorReportingService.report(new Error('boom'), 'uncaughtException');

    expect(netRequest).not.toHaveBeenCalled();
  });

  it('skips reporting in development mode', async () => {
    appMock.isPackaged = false;

    const { errorReportingService } =
      await import('../../../src/main/services/error-reporting.service');
    await errorReportingService.report(new Error('boom'), 'uncaughtException');

    expect(netRequest).not.toHaveBeenCalled();
  });

  it('sends scrubbed payload with allowlisted context keys only', async () => {
    const netCtrl = createMockNetRequest();
    netRequest.mockReturnValue(netCtrl.request);

    const { errorReportingService } =
      await import('../../../src/main/services/error-reporting.service');
    const error = new Error(
      'failed at /Users/alice/project and /home/bob/work and C:\\Users\\chris\\repo'
    );
    error.stack = Array.from({ length: 12 }, (_, i) => `line${i + 1} /Users/alice/path`).join('\n');

    await errorReportingService.report(error, 'uncaughtException', {
      type: 'renderer',
      origin: 'workspace:open',
      service: 'workspace-service',
      componentStack: '<Stack />',
      processType: 'Utility',
      reason: 'crashed',
      exitCode: 134,
      token: 'secret-token',
      path: '/Users/private',
    });

    const payload = netCtrl.getRequestBody() as {
      message: string;
      stack: string;
      context: Record<string, unknown>;
      systemInfo: { appVersion: string; isLicensed: boolean; agentPresetName: string };
    };

    expect(netRequest).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://komla.dev/api/v1/errors',
    });
    expect(netCtrl.getHeaders()).toEqual({ 'Content-Type': 'application/json' });
    expect(payload.message).toContain('/Users/[REDACTED]');
    expect(payload.message).toContain('/home/[REDACTED]');
    expect(payload.message).toContain('C:\\Users\\[REDACTED]');
    expect(payload.stack.split('\n')).toHaveLength(10);
    expect(payload.context).toEqual({
      type: 'renderer',
      origin: 'workspace:open',
      componentStack: '<Stack />',
      processType: 'Utility',
      reason: 'crashed',
      exitCode: 134,
    });
    expect(payload.systemInfo).toMatchObject({
      appVersion: '9.9.9',
      isLicensed: true,
      agentPresetName: 'Claude Code',
    });

    netCtrl.simulateResponse(200);
  });

  it('deduplicates identical errors and rate limits to ten per minute', async () => {
    const netCtrl = createMockNetRequest();
    netRequest.mockReturnValue(netCtrl.request);

    const { errorReportingService } =
      await import('../../../src/main/services/error-reporting.service');

    const duplicate = new Error('duplicate');
    await errorReportingService.report(duplicate, 'uncaughtException');
    await errorReportingService.report(duplicate, 'uncaughtException');

    for (let i = 0; i < 12; i += 1) {
      await errorReportingService.report(new Error(`unique-${i}`), 'uncaughtException');
    }

    expect(netRequest).toHaveBeenCalledTimes(9);
  });

  it('never throws when request setup fails', async () => {
    netRequest.mockImplementation(() => {
      throw new Error('net down');
    });

    const { errorReportingService } =
      await import('../../../src/main/services/error-reporting.service');

    await expect(
      errorReportingService.report(new Error('boom'), 'uncaughtException')
    ).resolves.toBeUndefined();
  });

  describe('scrubErrorText', () => {
    it('redacts the short macOS hostname but leaves localhost alone', async () => {
      vi.resetModules();
      vi.doMock('os', async (importOriginal) => ({
        ...(await importOriginal<typeof import('os')>()),
        hostname: () => 'Johns-MacBook-Pro.local',
      }));
      const { scrubErrorText } = await import('../../../src/main/services/error-reporting.service');

      expect(scrubErrorText('ssh Johns-MacBook-Pro failed on localhost:3000')).toBe(
        'ssh [HOST] failed on localhost:3000'
      );
      vi.doUnmock('os');
    });

    it('redacts personal data beyond home-directory usernames', async () => {
      const os = await import('os');
      const { scrubErrorText } = await import('../../../src/main/services/error-reporting.service');

      const scrubbed = scrubErrorText(
        [
          `open ${os.homedir()}/secret/file.ts`,
          'C:/Users/dana/repo and D:\\Users\\erin\\repo',
          'push to https://bob:hunter2@github.com/acme/app.git',
          'contact alice.smith+dev@example.co.uk',
          'auth ghp_abcdefghijklmnopqrstuvwxyz0123 and sk-proj-abcdefghijklmnopqrstuv',
          `host ${os.hostname()} down`,
          'installed electron@31.0.0',
        ].join('\n')
      );

      expect(scrubbed).not.toContain(os.homedir());
      expect(scrubbed).toContain('~/secret/file.ts');
      expect(scrubbed).toContain('C:/Users/[REDACTED]/repo');
      expect(scrubbed).toContain('D:\\Users\\[REDACTED]\\repo');
      expect(scrubbed).toContain('https://[REDACTED]@github.com/acme/app.git');
      expect(scrubbed).toContain('contact [EMAIL]');
      expect(scrubbed).toContain('auth [TOKEN] and [TOKEN]');
      if (os.hostname().length >= 3) expect(scrubbed).toContain('host [HOST] down');
      expect(scrubbed).toContain('electron@31.0.0');
    });
  });
});
