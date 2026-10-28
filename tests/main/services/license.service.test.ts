import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { EventEmitter } from 'events';

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Top-level mocks ---

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
    getVersion: vi.fn(() => '1.0.0-test'),
    getLocaleCountryCode: vi.fn(() => 'US'),
  },
  net: {
    request: vi.fn(),
  },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomicSync: vi.fn(),
}));

vi.mock('../../../src/main/lib/machine-id', () => ({
  getMachineId: vi.fn(() => 'mock-machine-id-hash'),
  getMachineName: vi.fn(() => 'MockMachine'),
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../../src/main/services/paths', () => ({
  ensureKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
}));

vi.mock('../../../src/main/lib/api-urls', () => ({
  API_BASE_URL: 'https://test.komla.dev',
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// --- Helper: createMockNetRequest ---

interface MockNetRequestController {
  request: {
    setHeader: ReturnType<typeof vi.fn>;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };
  simulateResponse: (statusCode: number, body: unknown) => void;
  simulateRawResponse: (statusCode: number, rawBody: string) => void;
  simulateError: (error: Error) => void;
  simulateAbortedResponse: () => void;
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
    abort: vi.fn(),
  };

  function emitResponse(statusCode: number, rawBody: string) {
    const responseEmitter = new EventEmitter();
    const response = Object.assign(responseEmitter, { statusCode });
    requestEmitter.emit('response', response);
    responseEmitter.emit('data', Buffer.from(rawBody));
    responseEmitter.emit('end');
  }

  return {
    request,
    simulateResponse(statusCode: number, body: unknown) {
      emitResponse(statusCode, JSON.stringify(body));
    },
    simulateRawResponse(statusCode: number, rawBody: string) {
      emitResponse(statusCode, rawBody);
    },
    simulateError(error: Error) {
      requestEmitter.emit('error', error);
    },
    simulateAbortedResponse() {
      const responseEmitter = new EventEmitter();
      requestEmitter.emit('response', Object.assign(responseEmitter, { statusCode: 200 }));
      responseEmitter.emit('data', Buffer.from('{"usd":'));
      responseEmitter.emit('aborted');
    },
    getRequestBody() {
      return writtenBody ? JSON.parse(writtenBody) : null;
    },
    getHeaders() {
      return headers;
    },
  };
}

// --- Helper: build encrypted license file data ---

const MOCK_MACHINE_ID = 'mock-machine-id-hash';
const ENCRYPTION_SALT = 'komla-license-v1';

function getTestEncryptionKey(): Buffer {
  return createHash('sha256')
    .update(MOCK_MACHINE_ID + ENCRYPTION_SALT)
    .digest();
}

function encryptForTest(key: string): string {
  const encKey = getTestEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptForTest(stored: string): string {
  const encKey = getTestEncryptionKey();
  const data = Buffer.from(stored, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

function buildLicenseFile(key: string, activatedAt = 1700000000000, customerEmail?: string | null) {
  return JSON.stringify({
    licenseKey: encryptForTest(key),
    customerEmail: customerEmail ? encryptForTest(customerEmail) : customerEmail,
    activatedAt,
    machineId: MOCK_MACHINE_ID,
  });
}

function buildSubscriptionLicenseFile(
  key: string,
  licenseType: 'monthly' | 'yearly',
  validUntil: string | null,
  activatedAt = 1700000000000,
  customerEmail?: string | null
) {
  return JSON.stringify({
    _version: 1,
    licenseKey: encryptForTest(key),
    customerEmail: customerEmail ? encryptForTest(customerEmail) : customerEmail,
    activatedAt,
    machineId: MOCK_MACHINE_ID,
    licenseType,
    validUntil,
  });
}

// --- Helper: setup licensed state ---

function setupLicensedState(key = 'VALID-KEY-123') {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(buildLicenseFile(key));
}

// --- Helper: setup unlicensed state ---

function setupUnlicensedState() {
  mockExistsSync.mockReturnValue(false);
}

// --- Helper: get fresh import ---

async function importLicenseService() {
  const mod = await import('../../../src/main/services/license.service');
  return mod;
}

// --- Helper: set up net.request mock (async — must be called after resetModules) ---

async function setupNetRequest(): Promise<MockNetRequestController> {
  const ctrl = createMockNetRequest();
  const { net } = await import('electron');
  vi.mocked(net.request).mockReturnValue(ctrl.request as ReturnType<typeof net.request>);
  return ctrl;
}

// --- Tests ---

describe('LicenseService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // ------------------------------------------------------------------
  // Constructor / Loading
  // ------------------------------------------------------------------

  describe('Constructor / Loading', () => {
    it('should load valid encrypted license from file', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        buildLicenseFile('MY-LICENSE-KEY', 1700000000000, 'licensed@test.com')
      );

      const { licenseService } = await importLicenseService();
      const status = licenseService.getStatus();

      expect(status.isLicensed).toBe(true);
      expect(status.licenseKey).toBe('MY-LICENSE-KEY');
      expect(status.customerEmail).toBe('licensed@test.com');
      expect(status.activatedAt).toBe(1700000000000);
    });

    it('should drop a customer email that does not decrypt', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          licenseKey: encryptForTest('MY-LICENSE-KEY'),
          customerEmail: 'licensed@test.com',
          activatedAt: 1700000000000,
          machineId: MOCK_MACHINE_ID,
        })
      );

      const { licenseService } = await importLicenseService();
      const status = licenseService.getStatus();

      expect(status.isLicensed).toBe(true);
      expect(status.customerEmail).toBeNull();
    });

    it('should handle corrupted JSON gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('not valid json {{{');

      const { licenseService } = await importLicenseService();
      const status = licenseService.getStatus();

      expect(status.isLicensed).toBe(false);
      expect(status.licenseKey).toBeNull();
    });

    it('should handle file read errors gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const { licenseService } = await importLicenseService();
      const status = licenseService.getStatus();

      expect(status.isLicensed).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Saving
  // ------------------------------------------------------------------

  describe('Saving', () => {
    it('should save encrypted license and customer email', async () => {
      setupUnlicensedState();

      const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');

      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('SAVE-KEY');
      ctrl.simulateResponse(200, { valid: true, customerEmail: 'buyer@test.com' });
      await promise;

      expect(writeFileAtomicSync).toHaveBeenCalled();
      const savedData = JSON.parse(vi.mocked(writeFileAtomicSync).mock.calls[0][1]);
      expect(savedData.licenseKey).not.toBe('SAVE-KEY');
      expect(typeof savedData.licenseKey).toBe('string');
      expect(decryptForTest(savedData.licenseKey)).toBe('SAVE-KEY');
      expect(savedData.customerEmail).not.toBe('buyer@test.com');
      expect(typeof savedData.customerEmail).toBe('string');
      expect(decryptForTest(savedData.customerEmail)).toBe('buyer@test.com');
    });

    it('should write null JSON when deactivating', async () => {
      setupLicensedState('DEACTIVATE-KEY');

      const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');

      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      // Reset the write mock after constructor (migration may have called it)
      vi.mocked(writeFileAtomicSync).mockClear();

      const promise = licenseService.deactivateLicense();
      ctrl.simulateResponse(200, { success: true });
      await promise;

      expect(writeFileAtomicSync).toHaveBeenCalled();
      const savedData = JSON.parse(vi.mocked(writeFileAtomicSync).mock.calls[0][1]);
      expect(savedData).toBeNull();
    });

    it('should handle write errors gracefully without throwing', async () => {
      setupUnlicensedState();

      const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');
      vi.mocked(writeFileAtomicSync).mockImplementation(() => {
        throw new Error('ENOSPC: no space left');
      });

      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('ERROR-KEY');
      ctrl.simulateResponse(200, { valid: true });
      const result = await promise;

      expect(result).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // getStatus()
  // ------------------------------------------------------------------

  describe('getStatus()', () => {
    it('should return correct structure when licensed', async () => {
      setupLicensedState('STATUS-KEY');

      const { licenseService } = await importLicenseService();
      const status = licenseService.getStatus();

      expect(status).toEqual({
        isLicensed: true,
        licenseKey: 'STATUS-KEY',
        customerEmail: null,
        activatedAt: 1700000000000,
        features: {
          unlimited_workspaces: true,
          remote_ssh: true,
        },
        licenseType: 'lifetime',
        validUntil: null,
        cancelAtPeriodEnd: false,
      });
    });

    it('should return correct structure when unlicensed', async () => {
      setupUnlicensedState();

      const { licenseService } = await importLicenseService();
      const status = licenseService.getStatus();

      expect(status).toEqual({
        isLicensed: false,
        licenseKey: null,
        customerEmail: null,
        activatedAt: null,
        features: {
          unlimited_workspaces: false,
          remote_ssh: false,
        },
        licenseType: null,
        validUntil: null,
        cancelAtPeriodEnd: false,
      });
    });

    it('returns isLicensed=false but preserves licenseType when cached validUntil has lapsed', async () => {
      // Subscription license with validUntil already in the past — no server
      // call needed, isLicensed should drop offline.
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        buildSubscriptionLicenseFile('EXPIRED-KEY', 'yearly', '2020-01-01T00:00:00.000Z')
      );

      const { licenseService } = await importLicenseService();
      const status = licenseService.getStatus();

      expect(status.isLicensed).toBe(false);
      expect(status.features.unlimited_workspaces).toBe(false);
      // Metadata is retained so the UI can still offer the portal.
      expect(status.licenseKey).toBe('EXPIRED-KEY');
      expect(status.licenseType).toBe('yearly');
      expect(status.validUntil).toBe('2020-01-01T00:00:00.000Z');
    });

    it('returns isLicensed=true while a subscription validUntil is still in the future', async () => {
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        buildSubscriptionLicenseFile('ACTIVE-SUB-KEY', 'monthly', future)
      );

      const { licenseService } = await importLicenseService();
      const status = licenseService.getStatus();

      expect(status.isLicensed).toBe(true);
      expect(status.licenseType).toBe('monthly');
      expect(status.validUntil).toBe(future);
    });
  });

  // ------------------------------------------------------------------
  // activateLicense()
  // ------------------------------------------------------------------

  describe('activateLicense()', () => {
    it('should reject empty key', async () => {
      setupUnlicensedState();
      const { licenseService } = await importLicenseService();

      await expect(licenseService.activateLicense('')).rejects.toThrow('License key is required');
    });

    it('should reject whitespace-only key', async () => {
      setupUnlicensedState();
      const { licenseService } = await importLicenseService();

      await expect(licenseService.activateLicense('   ')).rejects.toThrow(
        'License key is required'
      );
    });

    it('should trim key before sending to server', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('  TRIMMED-KEY  ');
      ctrl.simulateResponse(200, { valid: true });
      await promise;

      const body = ctrl.getRequestBody() as { licenseKey: string };
      expect(body.licenseKey).toBe('TRIMMED-KEY');
    });

    it('should make correct POST request', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { net } = await import('electron');
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('POST-KEY');
      ctrl.simulateResponse(200, { valid: true });
      await promise;

      expect(net.request).toHaveBeenCalledWith({
        method: 'POST',
        url: 'https://test.komla.dev/api/v1/activate',
      });

      expect(ctrl.getHeaders()['Content-Type']).toBe('application/json');

      const body = ctrl.getRequestBody();
      expect(body).toEqual({
        licenseKey: 'POST-KEY',
        appVersion: '1.0.0-test',
        platform: process.platform,
        machineId: 'mock-machine-id-hash',
        machineName: 'MockMachine',
      });
    });

    it('omits the machine name from background revalidation', async () => {
      setupLicensedState('REVALIDATE-KEY');
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.verifyLicense();
      ctrl.simulateResponse(200, { valid: true });
      await promise;

      const body = ctrl.getRequestBody();
      expect(body).toMatchObject({ licenseKey: 'REVALIDATE-KEY', machineId: 'mock-machine-id-hash' });
      expect(body).not.toHaveProperty('machineName');
    });

    it('should store license locally on success and return status with activation counts', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('SUCCESS-KEY');
      ctrl.simulateResponse(200, {
        valid: true,
        activationsUsed: 2,
        maxActivations: 5,
        customerEmail: 'buyer@test.com',
      });
      const result = await promise;

      expect(result).toMatchObject({
        isLicensed: true,
        licenseKey: 'SUCCESS-KEY',
        customerEmail: 'buyer@test.com',
        activationsUsed: 2,
        maxActivations: 5,
      });
      expect((result as { activatedAt: number }).activatedAt).toBeTypeOf('number');

      const status = licenseService.getStatus();
      expect(status.isLicensed).toBe(true);
      expect(status.customerEmail).toBe('buyer@test.com');
    });

    it('should throw on server returning invalid key', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('BAD-KEY');
      ctrl.simulateResponse(200, { valid: false, error: 'Invalid license key' });

      await expect(promise).rejects.toThrow('Invalid license key');
    });

    it('caches expired monthly subscription so the user can reach the portal', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('EXPIRED-MONTHLY');
      ctrl.simulateResponse(200, {
        valid: false,
        error: 'expired',
        licenseType: 'monthly',
        validUntil: '2024-01-01T00:00:00.000Z',
        customerEmail: 'expired@test.com',
      });
      const result = await promise;

      expect(result).toMatchObject({
        isLicensed: false,
        licenseKey: 'EXPIRED-MONTHLY',
        customerEmail: 'expired@test.com',
        licenseType: 'monthly',
        validUntil: '2024-01-01T00:00:00.000Z',
      });
      expect(licenseService.getStatus().licenseKey).toBe('EXPIRED-MONTHLY');
    });

    it('does not cache expired lifetime licenses', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('EXPIRED-LIFETIME');
      ctrl.simulateResponse(200, {
        valid: false,
        error: 'expired',
        licenseType: 'lifetime',
        validUntil: null,
      });

      await expect(promise).rejects.toThrow('expired');
      expect(licenseService.getStatus().licenseKey).toBeNull();
    });

    it('should return ActivationLimitError when server returns activation_limit_reached', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const activations = [
        {
          id: 'act-1',
          machineName: 'Machine1',
          platform: 'darwin',
          lastSeen: '2024-01-01',
        },
      ];

      const promise = licenseService.activateLicense('LIMIT-KEY');
      ctrl.simulateResponse(200, {
        valid: false,
        error: 'activation_limit_reached',
        activations,
        activationsUsed: 3,
        maxActivations: 3,
      });
      const result = await promise;

      expect(result).toEqual({
        error: 'activation_limit_reached',
        activations,
        activationsUsed: 3,
        maxActivations: 3,
      });
    });

    it('should throw on server connection error', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('CONN-KEY');
      ctrl.simulateError(new Error('ECONNREFUSED'));

      await expect(promise).rejects.toThrow('Failed to connect to license server');
    });

    it('should throw on non-200 status code', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('ERR-KEY');
      ctrl.simulateResponse(500, { error: 'Internal server error' });

      await expect(promise).rejects.toThrow('Internal server error');
    });

    it('should handle unparseable server JSON', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.activateLicense('PARSE-KEY');
      ctrl.simulateRawResponse(200, 'not json at all{{{');

      // Non-200 with invalid JSON resolves with { valid: false, error: 'Invalid server response' }
      // But status 200 with invalid JSON also resolves { valid: false, error: 'Invalid server response' }
      // which then throws 'Invalid server response'
      await expect(promise).rejects.toThrow('Invalid server response');
    });
  });

  // ------------------------------------------------------------------
  // deactivateLicense()
  // ------------------------------------------------------------------

  describe('deactivateLicense()', () => {
    it('should clear local license and return unlicensed status', async () => {
      setupLicensedState('DEACT-KEY');
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      expect(licenseService.getStatus().isLicensed).toBe(true);

      const promise = licenseService.deactivateLicense();
      ctrl.simulateResponse(200, { success: true });
      const status = await promise;

      expect(status.isLicensed).toBe(false);
      expect(status.licenseKey).toBeNull();
    });

    it('should send correct deactivation request to server', async () => {
      setupLicensedState('DEACT-REQ-KEY');
      const ctrl = await setupNetRequest();
      const { net } = await import('electron');
      const { licenseService } = await importLicenseService();

      const promise = licenseService.deactivateLicense();
      ctrl.simulateResponse(200, { success: true });
      await promise;

      expect(net.request).toHaveBeenCalledWith({
        method: 'POST',
        url: 'https://test.komla.dev/api/v1/deactivate',
      });

      const body = ctrl.getRequestBody();
      expect(body).toEqual({
        licenseKey: 'DEACT-REQ-KEY',
        machineId: 'mock-machine-id-hash',
      });
    });

    it('should deactivate locally even when server call fails', async () => {
      setupLicensedState('FAIL-DEACT-KEY');
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.deactivateLicense();
      ctrl.simulateError(new Error('Network error'));
      const status = await promise;

      expect(status.isLicensed).toBe(false);
    });

    it('should skip server call when no license exists', async () => {
      setupUnlicensedState();
      const { net } = await import('electron');
      const { licenseService } = await importLicenseService();

      const status = await licenseService.deactivateLicense();

      expect(status.isLicensed).toBe(false);
      expect(net.request).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // revokeActivation()
  // ------------------------------------------------------------------

  describe('revokeActivation()', () => {
    it('should send correct revocation request to deactivate endpoint', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { net } = await import('electron');
      const { licenseService } = await importLicenseService();

      const promise = licenseService.revokeActivation('act-123', 'REVOKE-KEY');
      ctrl.simulateResponse(200, { success: true, activations: [] });
      await promise;

      expect(net.request).toHaveBeenCalledWith({
        method: 'POST',
        url: 'https://test.komla.dev/api/v1/deactivate',
      });

      const body = ctrl.getRequestBody();
      expect(body).toEqual({
        licenseKey: 'REVOKE-KEY',
        activationId: 'act-123',
      });
    });

    it('should return success and remaining activations on 200', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const remainingActivations = [
        {
          id: 'act-2',
          machineName: 'Other',
          platform: 'linux',
          lastSeen: '2024-06-01',
        },
      ];

      const promise = licenseService.revokeActivation('act-1', 'KEY');
      ctrl.simulateResponse(200, {
        success: true,
        activations: remainingActivations,
      });
      const result = await promise;

      expect(result).toEqual({
        success: true,
        activations: remainingActivations,
      });
    });

    it('should throw on server error', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.revokeActivation('act-1', 'KEY');
      ctrl.simulateResponse(500, { error: 'Server error' });

      await expect(promise).rejects.toThrow('Server error');
    });
  });

  // ------------------------------------------------------------------
  // getActivations()
  // ------------------------------------------------------------------

  describe('getActivations()', () => {
    it('should POST license key + machineId in JSON body so they stay out of URL logs', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { net } = await import('electron');
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getActivations('GET-KEY');
      ctrl.simulateResponse(200, {
        success: true,
        activations: [],
        activationsUsed: 1,
        maxActivations: 3,
      });
      await promise;

      expect(net.request).toHaveBeenCalledWith({
        method: 'POST',
        url: 'https://test.komla.dev/api/v1/activations',
      });

      expect(ctrl.getHeaders()['Content-Type']).toBe('application/json');
      expect(ctrl.getRequestBody()).toEqual({
        licenseKey: 'GET-KEY',
        machineId: 'mock-machine-id-hash',
      });
    });

    it('should return activations list on success', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const activations = [
        {
          id: 'a1',
          machineName: 'M1',
          platform: 'darwin',
          lastSeen: '2024-01-01',
        },
        {
          id: 'a2',
          machineName: 'M2',
          platform: 'win32',
          lastSeen: '2024-02-01',
        },
      ];

      const promise = licenseService.getActivations('LIST-KEY');
      ctrl.simulateResponse(200, {
        success: true,
        activations,
        activationsUsed: 2,
        maxActivations: 5,
      });
      const result = await promise;

      expect(result).toEqual({
        activations,
        activationsUsed: 2,
        maxActivations: 5,
      });
    });

    it('should default activationsUsed=0 and maxActivations=3 when server omits them', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getActivations('DEFAULTS-KEY');
      ctrl.simulateResponse(200, {
        success: true,
        activations: [],
      });
      const result = await promise;

      expect(result.activationsUsed).toBe(0);
      expect(result.maxActivations).toBe(3);
    });

    it('should throw on non-200 response', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getActivations('FAIL-KEY');
      ctrl.simulateResponse(403, { error: 'Forbidden' });

      await expect(promise).rejects.toThrow('Forbidden');
    });
  });

  // ------------------------------------------------------------------
  // canStartWorkspace()
  // ------------------------------------------------------------------

  describe('canStartWorkspace()', () => {
    it('should always allow when licensed regardless of count', async () => {
      setupLicensedState();
      const { licenseService } = await importLicenseService();

      expect(licenseService.canStartWorkspace(100)).toEqual({ allowed: true });
    });

    it('should allow when unlicensed and under limit', async () => {
      setupUnlicensedState();
      const { licenseService } = await importLicenseService();

      expect(licenseService.canStartWorkspace(2)).toEqual({ allowed: true });
    });

    it('should deny when unlicensed at limit (4)', async () => {
      setupUnlicensedState();
      const { licenseService } = await importLicenseService();

      const result = licenseService.canStartWorkspace(4);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('4 running SSH workspaces');
      expect(result.reason).toContain('license');
    });

    it('should deny when unlicensed over limit', async () => {
      setupUnlicensedState();
      const { licenseService } = await importLicenseService();

      const result = licenseService.canStartWorkspace(10);
      expect(result.allowed).toBe(false);
    });

    it('should allow the last free slot', async () => {
      setupUnlicensedState();
      const { licenseService } = await importLicenseService();

      expect(licenseService.canStartWorkspace(3)).toEqual({ allowed: true });
    });

    it('should apply the free limit once a cached subscription has lapsed', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        buildSubscriptionLicenseFile('EXPIRED-KEY', 'monthly', '2020-01-01T00:00:00.000Z')
      );
      const { licenseService } = await importLicenseService();

      expect(licenseService.canStartWorkspace(3).allowed).toBe(true);
      expect(licenseService.canStartWorkspace(4).allowed).toBe(false);
      expect(licenseService.getWorkspaceQuota(4)).toMatchObject({
        allowed: false,
        isLicensed: false,
      });
    });
  });

  // ------------------------------------------------------------------
  // getWorkspaceQuota()
  // ------------------------------------------------------------------

  describe('getWorkspaceQuota()', () => {
    it('should return allowed=true and isLicensed=true for licensed user', async () => {
      setupLicensedState();
      const { licenseService } = await importLicenseService();

      const quota = licenseService.getWorkspaceQuota(10);
      expect(quota).toEqual({
        allowed: true,
        count: 10,
        limit: 4,
        isLicensed: true,
      });
    });

    it('should return allowed=true and isLicensed=false when unlicensed under limit', async () => {
      setupUnlicensedState();
      const { licenseService } = await importLicenseService();

      const quota = licenseService.getWorkspaceQuota(2);
      expect(quota).toEqual({
        allowed: true,
        count: 2,
        limit: 4,
        isLicensed: false,
      });
    });

    it('should return allowed=false and isLicensed=false when unlicensed at limit', async () => {
      setupUnlicensedState();
      const { licenseService } = await importLicenseService();

      const quota = licenseService.getWorkspaceQuota(4);
      expect(quota).toEqual({
        allowed: false,
        count: 4,
        limit: 4,
        isLicensed: false,
      });
    });
  });

  // ------------------------------------------------------------------
  // getMachineId()
  // ------------------------------------------------------------------

  describe('getMachineId()', () => {
    it('should return the mock machine ID', async () => {
      setupUnlicensedState();
      const { licenseService } = await importLicenseService();

      expect(licenseService.getMachineId()).toBe('mock-machine-id-hash');
    });
  });

  // ------------------------------------------------------------------
  // onRevoked() callback
  // ------------------------------------------------------------------

  describe('onRevoked()', () => {
    it('should call revoked callback when periodic validation detects revoked license', async () => {
      setupLicensedState('REVOKE-ME');
      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const onRevoked = vi.fn();
      licenseService.onRevoked(onRevoked);

      // startPeriodicValidation calls verifyLicense immediately
      const promise = licenseService.startPeriodicValidation();
      ctrl.simulateResponse(200, { valid: false, error: 'revoked' });
      await promise;

      expect(onRevoked).toHaveBeenCalledTimes(1);
      expect(licenseService.getStatus().isLicensed).toBe(false);
      vi.useRealTimers();
    });

    it('should call revoked callback when periodic validation detects invalid_key', async () => {
      setupLicensedState('INVALID-KEY');
      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const onRevoked = vi.fn();
      licenseService.onRevoked(onRevoked);

      const promise = licenseService.startPeriodicValidation();
      ctrl.simulateResponse(200, { valid: false, error: 'invalid_key' });
      await promise;

      expect(onRevoked).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('should clear local license when periodic validation is no longer an active machine', async () => {
      setupLicensedState('STALE-ACTIVATION-KEY');
      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const onRevoked = vi.fn();
      licenseService.onRevoked(onRevoked);

      const promise = licenseService.startPeriodicValidation();
      ctrl.simulateResponse(200, {
        valid: false,
        error: 'activation_limit_reached',
        activations: [],
        activationsUsed: 3,
        maxActivations: 3,
      });
      await promise;

      expect(onRevoked).toHaveBeenCalledTimes(1);
      expect(licenseService.getStatus().isLicensed).toBe(false);
      expect(licenseService.getStatus().licenseKey).toBeNull();
      vi.useRealTimers();
    });

    it('should not call revoked callback when license is still valid', async () => {
      setupLicensedState('VALID-KEY');
      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const onRevoked = vi.fn();
      licenseService.onRevoked(onRevoked);

      const promise = licenseService.startPeriodicValidation();
      ctrl.simulateResponse(200, { valid: true });
      await promise;

      expect(onRevoked).not.toHaveBeenCalled();
      expect(licenseService.getStatus().isLicensed).toBe(true);
      vi.useRealTimers();
    });

    it('should not call revoked callback on network error', async () => {
      setupLicensedState('NET-ERR-KEY');
      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const onRevoked = vi.fn();
      licenseService.onRevoked(onRevoked);

      const promise = licenseService.startPeriodicValidation();
      ctrl.simulateError(new Error('ECONNREFUSED'));
      await promise;

      expect(onRevoked).not.toHaveBeenCalled();
      // License should still be active on network failure
      expect(licenseService.getStatus().isLicensed).toBe(true);
      vi.useRealTimers();
    });

    it('syncs cancelAtPeriodEnd from the server response on a valid renewal check', async () => {
      // After the user cancels via the Stripe Portal, the next periodic
      // validation tick should bring back cancelAtPeriodEnd=true so the UI
      // can flip from "Renews on" to "Ends on" without restarting the app.
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(buildSubscriptionLicenseFile('SYNC-KEY', 'monthly', future));

      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.startPeriodicValidation();
      ctrl.simulateResponse(200, {
        valid: true,
        licenseType: 'monthly',
        validUntil: future,
        cancelAtPeriodEnd: true,
      });
      await promise;

      expect(licenseService.getStatus().cancelAtPeriodEnd).toBe(true);
      vi.useRealTimers();
    });

    it('keeps the cached subscription license on expired so the user can still reach the portal', async () => {
      // Subscription license already expired (validUntil in the past).
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        buildSubscriptionLicenseFile('EXPIRED-SUB-KEY', 'monthly', '2020-01-01T00:00:00.000Z')
      );

      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const onRevoked = vi.fn();
      licenseService.onRevoked(onRevoked);

      const promise = licenseService.startPeriodicValidation();
      ctrl.simulateResponse(200, {
        valid: false,
        error: 'expired',
        validUntil: '2020-01-01T00:00:00.000Z',
        licenseType: 'monthly',
      });
      await promise;

      // Free-tier enforcement still kicks in via the callback.
      expect(onRevoked).toHaveBeenCalledTimes(1);

      const status = licenseService.getStatus();
      expect(status.isLicensed).toBe(false);
      // Cached metadata is preserved so the UI can still surface the portal.
      expect(status.licenseKey).toBe('EXPIRED-SUB-KEY');
      expect(status.licenseType).toBe('monthly');
      vi.useRealTimers();
    });
  });

  // ------------------------------------------------------------------
  // refreshLicenseStatus() — user-initiated refresh path
  // ------------------------------------------------------------------

  describe('refreshLicenseStatus()', () => {
    it('rejects on server 5xx so the renderer can toast Refresh failed', async () => {
      // Without this throw, the user-initiated refresh silently looked
      // successful on application errors (5xx, malformed JSON) — same UX
      // bug class as the network-error case, just one layer up.
      setupLicensedState('REFRESH-500-KEY');
      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.refreshLicenseStatus();
      ctrl.simulateResponse(500, { error: 'Internal server error' });

      await expect(promise).rejects.toThrow('Internal server error');
      vi.useRealTimers();
    });

    it('rejects on malformed JSON so the renderer can toast Refresh failed', async () => {
      setupLicensedState('REFRESH-BAD-JSON-KEY');
      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.refreshLicenseStatus();
      ctrl.simulateRawResponse(200, 'not json{{{');

      await expect(promise).rejects.toThrow('Invalid server response');
      vi.useRealTimers();
    });

    it('rejects on 200s that omit `valid` so a stripped/proxied response fails closed', async () => {
      // A 200 with `{}` or `{ valid: null }` used to coerce to valid:true
      // (data.valid !== false) and silently update the cache. Now any
      // shape other than valid:true|false is treated as failure.
      setupLicensedState('REFRESH-EMPTY-KEY');
      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.refreshLicenseStatus();
      ctrl.simulateResponse(200, {});

      await expect(promise).rejects.toThrow('License server returned an unexpected response');
      vi.useRealTimers();
    });

    it('resolves with the latest status on a valid 200 response', async () => {
      setupLicensedState('REFRESH-OK-KEY');
      vi.useFakeTimers();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const promise = licenseService.refreshLicenseStatus();
      ctrl.simulateResponse(200, {
        valid: true,
        licenseType: 'monthly',
        validUntil: future,
        cancelAtPeriodEnd: false,
      });
      const status = await promise;

      expect(status.isLicensed).toBe(true);
      expect(status.licenseKey).toBe('REFRESH-OK-KEY');
      vi.useRealTimers();
    });
  });

  // ------------------------------------------------------------------
  // Exports
  // ------------------------------------------------------------------

  describe('getPlanPrices()', () => {
    const PRICES = {
      usd: { monthly: 1900, yearly: 7900, lifetime: 9900 },
      eur: { monthly: 1700, yearly: 6500, lifetime: 8500 },
    };

    it('returns USD prices in a USD region', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { net } = await import('electron');
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getPlanPrices();
      ctrl.simulateResponse(200, PRICES);

      expect(await promise).toEqual({ currency: 'usd', ...PRICES.usd });
      expect(net.request).toHaveBeenCalledWith({
        method: 'GET',
        url: 'https://test.komla.dev/api/v1/prices',
      });
    });

    it('returns EUR prices elsewhere', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { app } = await import('electron');
      vi.mocked(app.getLocaleCountryCode).mockReturnValueOnce('NO');
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getPlanPrices();
      ctrl.simulateResponse(200, PRICES);

      expect(await promise).toEqual({ currency: 'eur', ...PRICES.eur });
    });

    it('passes on a lifetime price that has ended', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getPlanPrices();
      ctrl.simulateResponse(200, { ...PRICES, usd: { ...PRICES.usd, lifetime: null } });

      expect(await promise).toEqual({
        currency: 'usd',
        monthly: 1900,
        yearly: 7900,
        lifetime: null,
      });
    });

    it('returns null when the response has no lifetime field', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getPlanPrices();
      ctrl.simulateResponse(200, { usd: { monthly: 1900, yearly: 7900 } });

      expect(await promise).toBeNull();
    });

    it('returns null for prices from the old text format', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getPlanPrices();
      ctrl.simulateResponse(200, { usd: { monthly: '$19', yearly: '$79', lifetime: '$99' } });

      expect(await promise).toBeNull();
    });

    it('gives up on a request that never finishes', async () => {
      vi.useFakeTimers();
      try {
        setupUnlicensedState();
        const ctrl = await setupNetRequest();
        const { licenseService } = await importLicenseService();

        const promise = licenseService.getPlanPrices();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(await promise).toBeNull();
        expect(ctrl.request.abort).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns null when the response is cut off', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getPlanPrices();
      ctrl.simulateAbortedResponse();

      expect(await promise).toBeNull();
    });

    it('returns null on a server error', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getPlanPrices();
      ctrl.simulateResponse(503, { error: 'unavailable' });

      expect(await promise).toBeNull();
    });

    it('returns null when the request fails', async () => {
      setupUnlicensedState();
      const ctrl = await setupNetRequest();
      const { licenseService } = await importLicenseService();

      const promise = licenseService.getPlanPrices();
      ctrl.simulateError(new Error('offline'));

      expect(await promise).toBeNull();
    });
  });

  describe('Exports', () => {
    it('should export FREE_WORKSPACE_LIMIT as 4', async () => {
      setupUnlicensedState();
      const { FREE_WORKSPACE_LIMIT } = await importLicenseService();

      expect(FREE_WORKSPACE_LIMIT).toBe(4);
    });
  });
});
