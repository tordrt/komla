import { EventEmitter } from 'events';

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Top-level mocks ---

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '2.0.0-test'),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  net: {
    request: vi.fn(),
  },
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('os', () => ({
  release: vi.fn(() => '24.0.0'),
}));

vi.mock('../../../src/main/lib/api-urls', () => ({
  API_BASE_URL: 'https://test.komla.dev',
}));

vi.mock('../../../src/main/services/license.service', () => ({
  licenseService: {
    getStatus: vi.fn(() => ({
      isLicensed: true,
      licenseKey: 'TEST-LICENSE-KEY' as string | null,
      customerEmail: null as string | null,
    })),
  },
}));

vi.mock('../../../src/main/services/agent-preset.service', () => ({
  agentPresetService: {
    getActive: vi.fn(() => ({ name: 'test-agent' })),
  },
}));

// --- Helper: createMockNetRequest ---

interface MockNetRequestController {
  request: {
    setHeader: ReturnType<typeof vi.fn>;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  simulateResponse: (statusCode: number, body?: string) => void;
  simulateError: (error: Error) => void;
  getRequestBody: () => Record<string, unknown>;
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
  };

  return {
    request,
    simulateResponse(statusCode: number, body = '{}') {
      const responseEmitter = new EventEmitter();
      const response = Object.assign(responseEmitter, { statusCode });
      requestEmitter.emit('response', response);
      responseEmitter.emit('data', Buffer.from(body));
      responseEmitter.emit('end');
    },
    simulateError(error: Error) {
      requestEmitter.emit('error', error);
    },
    getRequestBody() {
      return writtenBody ? JSON.parse(writtenBody) : {};
    },
  };
}

describe('FeedbackService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('selectScreenshots', () => {
    it('returns empty array when dialog is canceled', async () => {
      const { dialog } = await import('electron');
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const result = await feedbackService.selectScreenshots();
      expect(result).toEqual([]);
    });

    it('returns selected file paths', async () => {
      const { dialog } = await import('electron');
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: ['/path/to/screenshot1.png', '/path/to/screenshot2.png'],
      });

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const result = await feedbackService.selectScreenshots();
      expect(result).toEqual(['/path/to/screenshot1.png', '/path/to/screenshot2.png']);
    });

    it('limits to 3 files', async () => {
      const { dialog } = await import('electron');
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: ['/a.png', '/b.png', '/c.png', '/d.png', '/e.png'],
      });

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const result = await feedbackService.selectScreenshots();
      expect(result).toHaveLength(3);
    });
  });

  describe('sendFeedback', () => {
    it('sends feedback with correct body structure', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'bug',
        description: 'Something broke',
        email: 'test@test.com',
      });
      controller.simulateResponse(200);
      const result = await promise;

      expect(result.success).toBe(true);
      const body = controller.getRequestBody();
      expect(body.type).toBe('bug');
      expect(body.description).toBe('Something broke');
      expect(body.email).toBe('test@test.com');
    });

    it('does not add cached customer email when payload email is omitted', async () => {
      const { net } = await import('electron');
      const { licenseService } = await import('../../../src/main/services/license.service');
      vi.mocked(licenseService.getStatus).mockReturnValue({
        isLicensed: true,
        licenseKey: 'TEST-LICENSE-KEY',
        customerEmail: 'licensed@test.com',
      } as any);

      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'general',
        description: 'Feedback from a licensed user',
      });
      controller.simulateResponse(200);
      await promise;

      expect(controller.getRequestBody().email).toBeUndefined();
    });

    it('sends the payload email when one is provided', async () => {
      const { net } = await import('electron');
      const { licenseService } = await import('../../../src/main/services/license.service');
      vi.mocked(licenseService.getStatus).mockReturnValue({
        isLicensed: true,
        licenseKey: 'TEST-LICENSE-KEY',
        customerEmail: 'licensed@test.com',
      } as any);

      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'bug',
        description: 'Use a different reply-to email',
        email: 'reply-to@test.com',
      });
      controller.simulateResponse(200);
      await promise;

      expect(controller.getRequestBody().email).toBe('reply-to@test.com');
    });

    it('includes system info in payload', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'feature',
        description: 'Please add dark mode',
      });
      controller.simulateResponse(200);
      await promise;

      const body = controller.getRequestBody();
      const systemInfo = body.systemInfo as Record<string, unknown>;
      expect(systemInfo.appVersion).toBe('2.0.0-test');
      expect(systemInfo.platform).toBe(process.platform);
      expect(systemInfo.arch).toBe(process.arch);
      expect(systemInfo.isLicensed).toBe(true);
      expect(systemInfo.agentPresetName).toBe('test-agent');
    });

    it('includes license status', async () => {
      const { net } = await import('electron');
      const { licenseService } = await import('../../../src/main/services/license.service');
      vi.mocked(licenseService.getStatus).mockReturnValue({
        isLicensed: false,
        licenseKey: null,
      } as any);

      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'general',
        description: 'Just wanted to say hello from test',
      });
      controller.simulateResponse(200);
      await promise;

      const body = controller.getRequestBody();
      expect((body.systemInfo as Record<string, unknown>).isLicensed).toBe(false);
    });

    it('reports unlicensed when license key is missing despite isLicensed flag', async () => {
      const { net } = await import('electron');
      const { licenseService } = await import('../../../src/main/services/license.service');
      vi.mocked(licenseService.getStatus).mockReturnValue({
        isLicensed: true,
        licenseKey: null,
      } as any);

      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'bug',
        description: 'Stale license state test',
      });
      controller.simulateResponse(200);
      await promise;

      const body = controller.getRequestBody();
      expect((body.systemInfo as Record<string, unknown>).isLicensed).toBe(false);
    });

    it('encodes screenshots as base64', async () => {
      const { net } = await import('electron');
      const { statSync, readFileSync } = await import('fs');
      vi.mocked(statSync as any).mockReturnValue({ size: 1000 });
      vi.mocked(readFileSync as any).mockReturnValue(Buffer.from('fake-image-data'));

      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'bug',
        description: 'There is a visual bug with the button',
        screenshotPaths: ['/path/to/screenshot.png'],
      });
      controller.simulateResponse(200);
      await promise;

      const body = controller.getRequestBody();
      const screenshots = body.screenshots as Array<Record<string, string>>;
      expect(screenshots).toHaveLength(1);
      expect(screenshots[0].filename).toBe('screenshot.png');
      expect(screenshots[0].data).toBe(Buffer.from('fake-image-data').toString('base64'));
      expect(screenshots[0].contentType).toBe('image/png');
    });

    it('skips files larger than 8MB', async () => {
      const { net } = await import('electron');
      const { statSync, readFileSync } = await import('fs');
      vi.mocked(statSync as any).mockReturnValue({ size: 9 * 1024 * 1024 }); // 9MB

      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'bug',
        description: 'Big screenshot but should be skipped',
        screenshotPaths: ['/path/to/huge.png'],
      });
      controller.simulateResponse(200);
      await promise;

      expect(readFileSync).not.toHaveBeenCalled();
      const body = controller.getRequestBody();
      expect(body.screenshots).toBeUndefined();
    });

    it('handles file read errors gracefully', async () => {
      const { net } = await import('electron');
      const { statSync } = await import('fs');
      vi.mocked(statSync as any).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'bug',
        description: 'Screenshot file was deleted before send',
        screenshotPaths: ['/path/to/deleted.png'],
      });
      controller.simulateResponse(200);
      const result = await promise;

      expect(result.success).toBe(true);
    });

    it('detects MIME type from file extension', async () => {
      const { net } = await import('electron');
      const { statSync, readFileSync } = await import('fs');
      vi.mocked(statSync as any).mockReturnValue({ size: 1000 });
      vi.mocked(readFileSync as any).mockReturnValue(Buffer.from('data'));

      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'bug',
        description: 'Testing MIME type detection for feedback',
        screenshotPaths: ['/test.jpg', '/test.gif', '/test.webp'],
      });
      controller.simulateResponse(200);
      await promise;

      const body = controller.getRequestBody();
      const screenshots = body.screenshots as Array<Record<string, string>>;
      expect(screenshots[0].contentType).toBe('image/jpeg');
      expect(screenshots[1].contentType).toBe('image/gif');
      expect(screenshots[2].contentType).toBe('image/webp');
    });

    it('returns error on server failure', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'bug',
        description: 'This will fail on the server',
      });
      controller.simulateResponse(500, '{"error":"Server error"}');
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns error on network failure', async () => {
      const { net } = await import('electron');
      const controller = createMockNetRequest();
      vi.mocked(net.request).mockReturnValue(controller.request as any);

      const { feedbackService } = await import('../../../src/main/services/feedback.service');
      const promise = feedbackService.sendFeedback({
        type: 'bug',
        description: 'Network error test',
      });
      controller.simulateError(new Error('connection refused'));
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('connect');
    });
  });
});
