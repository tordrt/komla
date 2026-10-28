import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { app, net } from 'electron';

import { WORKSPACE_LIMIT_ERROR_PREFIX } from '../../shared/types/workspace';
import { API_BASE_URL } from '../lib/api-urls';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';
import { getMachineId, getMachineName } from '../lib/machine-id';
import { migrate } from '../lib/migration';

import { ensureKomlaBasePath } from './paths';

export type LicenseFeature = 'unlimited_workspaces' | 'remote_ssh';

export type LicenseType = 'monthly' | 'yearly' | 'lifetime';

export interface LicenseActivation {
  id: string;
  machineName: string | null;
  platform: string | null;
  lastSeen: string;
  firstActivated?: string;
  isCurrent?: boolean;
}

export interface LicenseStatus {
  isLicensed: boolean;
  licenseKey: string | null;
  customerEmail: string | null;
  activatedAt: number | null;
  features: Record<LicenseFeature, boolean>;
  activationsUsed?: number;
  maxActivations?: number;
  licenseType?: LicenseType | null;
  validUntil?: string | null;
  cancelAtPeriodEnd?: boolean;
}

const LICENSE_VERSION = 1;
const LICENSE_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

interface PersistedLicense {
  _version?: number;
  licenseKey: string; // AES-256-GCM encrypted, base64 encoded
  customerEmail?: string | null; // AES-256-GCM encrypted, base64 encoded
  activatedAt: number;
  machineId: string;
  licenseType?: LicenseType | null;
  validUntil?: string | null;
  cancelAtPeriodEnd?: boolean;
}

const ENCRYPTION_SALT = 'komla-license-v1';

/** Running SSH workspaces the free plan allows; local workspaces are unlimited. */
export const FREE_WORKSPACE_LIMIT = 4;

/** Prices in minor units in one currency; lifetime is null once its early-access price has ended. */
export interface PlanPrices {
  currency: 'usd' | 'eur';
  monthly: number;
  yearly: number;
  lifetime: number | null;
}

export interface WorkspaceQuota {
  allowed: boolean;
  count: number;
  limit: number;
  isLicensed: boolean;
}

export type MonetizationTelemetryEvent = 'free_limit_hit' | 'upgrade_clicked' | 'license_activated';

export interface ActivationLimitError {
  error: 'activation_limit_reached';
  activations: LicenseActivation[];
  activationsUsed: number;
  maxActivations: number;
}

const LICENSE_SERVER_URL = `${API_BASE_URL}/api/v1/activate`;
const DEACTIVATE_SERVER_URL = `${API_BASE_URL}/api/v1/deactivate`;
const ACTIVATIONS_SERVER_URL = `${API_BASE_URL}/api/v1/activations`;
const BILLING_PORTAL_SERVER_URL = `${API_BASE_URL}/api/v1/billing-portal`;
const PRICES_SERVER_URL = `${API_BASE_URL}/api/v1/prices`;
const PRICES_TIMEOUT_MS = 10_000;
// Regions the buy page prices in USD; everyone else sees EUR (buy.html's usdRegions).
const USD_REGIONS = new Set(['US', 'CA', 'AU', 'NZ', 'GB', 'HK', 'SG']);

const logger = createLogger('LicenseService');
interface InMemoryLicense {
  licenseKey: string;
  customerEmail: string | null;
  activatedAt: number;
  machineId: string;
  licenseType: LicenseType;
  validUntil: string | null;
  cancelAtPeriodEnd: boolean;
}

class LicenseService {
  private licensePath: string;
  private license: InMemoryLicense | null = null;
  private machineId: string;
  private onRevokedCallback: (() => void) | null = null;

  constructor() {
    const komlaPath = ensureKomlaBasePath();
    this.licensePath = join(komlaPath, 'license.json');
    this.machineId = getMachineId();
    this.load();
  }

  private getEncryptionKey(): Buffer {
    return createHash('sha256')
      .update(this.machineId + ENCRYPTION_SALT)
      .digest();
  }

  private encryptLicenseValue(value: string): string {
    const encKey = this.getEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  private decryptLicenseValue(stored: string): string {
    const encKey = this.getEncryptionKey();
    const data = Buffer.from(stored, 'base64');
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
  }

  private decryptPersistedCustomerEmail(stored?: string | null): string | null {
    if (!stored) return null;
    try {
      return this.decryptLicenseValue(stored);
    } catch {
      return null;
    }
  }

  private load(): void {
    try {
      if (existsSync(this.licensePath)) {
        const data = readFileSync(this.licensePath, 'utf-8');
        const raw = JSON.parse(data);
        if (!raw?.licenseKey) return;

        const persisted = migrate(
          raw as Record<string, unknown>,
          LICENSE_VERSION,
          LICENSE_MIGRATIONS
        ) as unknown as PersistedLicense;

        this.license = {
          licenseKey: this.decryptLicenseValue(persisted.licenseKey),
          customerEmail: this.decryptPersistedCustomerEmail(persisted.customerEmail),
          activatedAt: persisted.activatedAt,
          machineId: persisted.machineId,
          licenseType: persisted.licenseType ?? 'lifetime',
          validUntil: persisted.validUntil ?? null,
          cancelAtPeriodEnd: persisted.cancelAtPeriodEnd ?? false,
        };
      }
    } catch (error) {
      logger.error('Failed to load license:', error);
      this.license = null;
    }
  }

  private save(): void {
    try {
      if (this.license) {
        const persisted: PersistedLicense = {
          _version: LICENSE_VERSION,
          licenseKey: this.encryptLicenseValue(this.license.licenseKey),
          customerEmail: this.license.customerEmail
            ? this.encryptLicenseValue(this.license.customerEmail)
            : null,
          activatedAt: this.license.activatedAt,
          machineId: this.license.machineId,
          licenseType: this.license.licenseType,
          validUntil: this.license.validUntil,
          cancelAtPeriodEnd: this.license.cancelAtPeriodEnd,
        };
        writeFileAtomicSync(this.licensePath, JSON.stringify(persisted, null, 2));
      } else {
        // Remove license file when deactivating
        if (existsSync(this.licensePath)) {
          writeFileAtomicSync(this.licensePath, JSON.stringify(null));
        }
      }
    } catch (error) {
      logger.error('Failed to save license:', error);
    }
  }

  /**
   * Local entitlement check. Subscription licenses (monthly/yearly) carry a
   * `validUntil` from the server; once we're past it, the user has no active
   * entitlement even if the cached license row is still on disk. Lifetime
   * licenses have `validUntil: null` and stay valid forever.
   */
  private isLicenseCurrentlyValid(): boolean {
    if (!this.license) return false;
    if (!this.license.validUntil) return true;
    return Date.now() < Date.parse(this.license.validUntil);
  }

  getStatus(): LicenseStatus {
    const isLicensed = this.isLicenseCurrentlyValid();

    return {
      isLicensed,
      licenseKey: this.license?.licenseKey ?? null,
      customerEmail: this.license?.customerEmail ?? null,
      activatedAt: this.license?.activatedAt ?? null,
      features: {
        unlimited_workspaces: isLicensed,
        remote_ssh: isLicensed,
      },
      licenseType: this.license?.licenseType ?? null,
      validUntil: this.license?.validUntil ?? null,
      cancelAtPeriodEnd: this.license?.cancelAtPeriodEnd ?? false,
    };
  }

  async activateLicense(key: string): Promise<LicenseStatus | ActivationLimitError> {
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      throw new Error('License key is required');
    }

    // Call license server to validate
    const response = await this.callLicenseServer(trimmedKey, { includeMachineName: true });

    if (!response.valid) {
      if (response.error === 'activation_limit_reached' && response.activations) {
        // Return the activation limit error so UI can handle it
        return {
          error: 'activation_limit_reached',
          activations: response.activations,
          activationsUsed: response.activationsUsed ?? 0,
          maxActivations: response.maxActivations ?? 3,
        };
      }
      // Cache expired monthly/yearly so the user can still reach the Stripe
      // Billing Portal to update payment / reactivate from a fresh install.
      // No machine slot is consumed — the worker rejects activation before
      // touching license_activations when the row is expired.
      if (
        response.error === 'expired' &&
        (response.licenseType === 'monthly' || response.licenseType === 'yearly')
      ) {
        this.license = {
          licenseKey: trimmedKey,
          customerEmail: response.customerEmail ?? null,
          activatedAt: Date.now(),
          machineId: this.machineId,
          licenseType: response.licenseType,
          validUntil: response.validUntil ?? null,
          cancelAtPeriodEnd: response.cancelAtPeriodEnd ?? false,
        };
        this.save();
        return this.getStatus();
      }
      throw new Error(response.error || 'Invalid license key');
    }

    this.license = {
      licenseKey: trimmedKey,
      customerEmail: response.customerEmail ?? null,
      activatedAt: Date.now(),
      machineId: this.machineId,
      licenseType: response.licenseType ?? 'lifetime',
      validUntil: response.validUntil ?? null,
      cancelAtPeriodEnd: response.cancelAtPeriodEnd ?? false,
    };
    this.save();

    return {
      ...this.getStatus(),
      activationsUsed: response.activationsUsed,
      maxActivations: response.maxActivations,
    };
  }

  async deactivateLicense(): Promise<LicenseStatus> {
    // If we have a license key, notify the server to deactivate this machine
    if (this.license?.licenseKey) {
      try {
        await this.callDeactivateServer(this.license.licenseKey, this.machineId);
      } catch (error) {
        // Log but don't block local deactivation if server call fails
        logger.error('Failed to notify server of deactivation:', error);
      }
    }

    this.license = null;
    this.save();
    return this.getStatus();
  }

  async revokeActivation(
    activationId: string,
    licenseKey: string
  ): Promise<{ success: boolean; activations: LicenseActivation[] }> {
    return this.callRevokeServer(licenseKey, activationId);
  }

  async getActivations(licenseKey: string): Promise<{
    activations: LicenseActivation[];
    activationsUsed: number;
    maxActivations: number;
  }> {
    return this.callActivationsServer(licenseKey);
  }

  /**
   * Returns a one-shot Stripe Billing Portal URL for managing the active
   * subscription. Resolves with `{ error: 'no_subscription' }` for lifetime
   * licenses or when no license is active.
   */
  async getBillingPortalUrl(): Promise<{ url: string } | { error: string }> {
    if (!this.license) return { error: 'no_license' };
    if (this.license.licenseType === 'lifetime') return { error: 'no_subscription' };
    return this.callBillingPortalServer(this.license.licenseKey);
  }

  /**
   * Prices in the buy page's currency for this region, or null when the license
   * server can't be reached or answers with something unexpected.
   */
  async getPlanPrices(): Promise<PlanPrices | null> {
    const currency = USD_REGIONS.has(app.getLocaleCountryCode().toUpperCase()) ? 'usd' : 'eur';
    const data = await this.callPricesServer();
    const prices = (data as Record<string, unknown> | null)?.[currency] as
      | Record<string, unknown>
      | undefined;
    const isAmount = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value > 0;
    if (
      !isAmount(prices?.monthly) ||
      !isAmount(prices.yearly) ||
      (prices.lifetime !== null && !isAmount(prices.lifetime))
    ) {
      return null;
    }
    return {
      currency,
      monthly: prices.monthly,
      yearly: prices.yearly,
      lifetime: prices.lifetime,
    };
  }

  getMachineId(): string {
    return this.machineId;
  }

  canStartWorkspace(currentCount: number): { allowed: boolean; reason?: string } {
    if (this.isLicenseCurrentlyValid() || currentCount < FREE_WORKSPACE_LIMIT) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `${WORKSPACE_LIMIT_ERROR_PREFIX}Free plan is limited to ${FREE_WORKSPACE_LIMIT} running SSH workspaces. Stop an SSH workspace or activate a license in Settings to run unlimited SSH workspaces. Local workspaces are unlimited.`,
    };
  }

  getWorkspaceQuota(runningCount: number): WorkspaceQuota {
    const isLicensed = this.isLicenseCurrentlyValid();
    return {
      allowed: isLicensed || runningCount < FREE_WORKSPACE_LIMIT,
      count: runningCount,
      limit: FREE_WORKSPACE_LIMIT,
      isLicensed,
    };
  }

  onRevoked(callback: () => void): void {
    this.onRevokedCallback = callback;
  }

  async startPeriodicValidation(): Promise<void> {
    // Background path — never let an offline boot bubble up.
    try {
      await this.verifyLicense();
    } catch (err) {
      logger.debug(`Background license verification failed: ${(err as Error).message}`);
    }
  }

  /**
   * Re-verify license with the server.
   * Called by the update service on its periodic 4-hour interval.
   */
  refreshValidation(): void {
    void this.verifyLicense().catch((err) => {
      logger.debug(`Periodic license verification failed: ${(err as Error).message}`);
    });
  }

  /**
   * Refresh license status from the server and update local cache.
   * Called when the user manually requests a refresh (e.g., after billing portal update).
   */
  async refreshLicenseStatus(): Promise<LicenseStatus> {
    await this.verifyLicense();
    return this.getStatus();
  }

  async verifyLicense(): Promise<void> {
    if (!this.license) return;

    // Network errors propagate so user-initiated refreshes can surface
    // "Refresh failed". Periodic/background callers wrap this themselves.
    const response = await this.callLicenseServer(this.license.licenseKey);

    if (
      !response.valid &&
      (response.error === 'revoked' ||
        response.error === 'invalid_key' ||
        response.error === 'activation_limit_reached')
    ) {
      logger.info(`License ${response.error}, clearing local license`);
      this.license = null;
      this.save();
      this.onRevokedCallback?.();
      return;
    }

    // For 'expired', keep the cached license so the user retains a path to
    // the Stripe Billing Portal (to update payment / reactivate). The
    // validUntil-based isLicensed check already drops them to free tier.
    // Sync the latest validUntil + cancelAtPeriodEnd so they don't drift.
    if (!response.valid && response.error === 'expired') {
      const nextValidUntil = response.validUntil ?? this.license.validUntil;
      const nextCancelAtPeriodEnd = response.cancelAtPeriodEnd ?? this.license.cancelAtPeriodEnd;
      const nextCustomerEmail = response.customerEmail ?? this.license.customerEmail;
      if (
        nextValidUntil !== this.license.validUntil ||
        nextCancelAtPeriodEnd !== this.license.cancelAtPeriodEnd ||
        nextCustomerEmail !== this.license.customerEmail
      ) {
        this.license = {
          ...this.license,
          validUntil: nextValidUntil,
          cancelAtPeriodEnd: nextCancelAtPeriodEnd,
          customerEmail: nextCustomerEmail,
        };
        this.save();
      }
      this.onRevokedCallback?.();
      return;
    }

    // Refresh local license metadata when the server response carries newer
    // licenseType / validUntil / cancelAtPeriodEnd — e.g. after a renewal
    // extends valid_until or the user cancels via the Stripe Portal.
    if (response.valid) {
      const nextType = response.licenseType ?? this.license.licenseType;
      const nextValidUntil = response.validUntil ?? this.license.validUntil;
      const nextCancelAtPeriodEnd = response.cancelAtPeriodEnd ?? this.license.cancelAtPeriodEnd;
      const nextCustomerEmail = response.customerEmail ?? this.license.customerEmail;
      if (
        nextType !== this.license.licenseType ||
        nextValidUntil !== this.license.validUntil ||
        nextCancelAtPeriodEnd !== this.license.cancelAtPeriodEnd ||
        nextCustomerEmail !== this.license.customerEmail
      ) {
        this.license = {
          ...this.license,
          licenseType: nextType,
          validUntil: nextValidUntil,
          cancelAtPeriodEnd: nextCancelAtPeriodEnd,
          customerEmail: nextCustomerEmail,
        };
        this.save();
      }
      return;
    }

    // Anything else — server 5xx, malformed JSON, unknown error string — is
    // a failure, not a no-op. Throwing lets the user-initiated refresh path
    // surface "Refresh failed" instead of silently toasting success.
    throw new Error(response.error ?? 'License server returned an unexpected response');
  }

  // The hostname labels the activation in the license's device list, so it is
  // sent only on user-initiated activation; background revalidation omits it
  // and the server keeps the stored name.
  private callLicenseServer(
    key: string,
    { includeMachineName = false }: { includeMachineName?: boolean } = {}
  ): Promise<{
    valid: boolean;
    error?: string;
    activationsUsed?: number;
    maxActivations?: number;
    activations?: LicenseActivation[];
    licenseType?: LicenseType;
    validUntil?: string | null;
    cancelAtPeriodEnd?: boolean;
    customerEmail?: string | null;
  }> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: LICENSE_SERVER_URL,
        });

        request.setHeader('Content-Type', 'application/json');

        let responseBody = '';

        request.on('response', (response) => {
          response.on('data', (chunk) => {
            responseBody += chunk.toString();
          });

          response.on('end', () => {
            try {
              const data = JSON.parse(responseBody);
              if (response.statusCode !== 200) {
                resolve({
                  valid: false,
                  error: data.error || `Server returned ${response.statusCode}`,
                });
                return;
              }
              // Fail closed on malformed 200s. Only accept the shape we
              // expect — `valid: true` (entitled) or `valid: false` with a
              // known error code. Anything else (`{}`, `{ valid: null }`, a
              // proxy stripping fields) used to coerce to valid:true and
              // bypass the verifyLicense throw. Metadata fields ride along
              // on both branches so `activateLicense` can handle expired
              // and activation_limit_reached responses correctly.
              if (data.valid === true || data.valid === false) {
                resolve({
                  valid: data.valid,
                  error: data.error,
                  activationsUsed: data.activationsUsed,
                  maxActivations: data.maxActivations,
                  activations: data.activations,
                  licenseType: data.licenseType,
                  validUntil: data.validUntil,
                  cancelAtPeriodEnd: data.cancelAtPeriodEnd,
                  customerEmail: data.customerEmail,
                });
              } else {
                resolve({
                  valid: false,
                  error: 'License server returned an unexpected response',
                });
              }
            } catch {
              resolve({ valid: false, error: 'Invalid server response' });
            }
          });
        });

        request.on('error', (error) => {
          reject(new Error(`Failed to connect to license server: ${error.message}`));
        });

        request.write(
          JSON.stringify({
            licenseKey: key,
            appVersion: app.getVersion(),
            platform: process.platform,
            machineId: this.machineId,
            ...(includeMachineName ? { machineName: getMachineName() } : {}),
          })
        );
        request.end();
      } catch (error) {
        reject(new Error(`Failed to validate license: ${(error as Error).message}`));
      }
    });
  }

  private callDeactivateServer(licenseKey: string, machineId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: DEACTIVATE_SERVER_URL,
        });

        request.setHeader('Content-Type', 'application/json');

        let responseBody = '';

        request.on('response', (response) => {
          response.on('data', (chunk) => {
            responseBody += chunk.toString();
          });

          response.on('end', () => {
            try {
              const data = JSON.parse(responseBody);
              if (response.statusCode === 200 && data.success) {
                resolve();
              } else {
                reject(new Error(data.error || 'Deactivation failed'));
              }
            } catch {
              reject(new Error('Invalid server response'));
            }
          });
        });

        request.on('error', (error) => {
          reject(new Error(`Failed to connect to license server: ${error.message}`));
        });

        request.write(
          JSON.stringify({
            licenseKey,
            machineId,
          })
        );
        request.end();
      } catch (error) {
        reject(new Error(`Failed to deactivate license: ${(error as Error).message}`));
      }
    });
  }

  private callRevokeServer(
    licenseKey: string,
    activationId: string
  ): Promise<{ success: boolean; activations: LicenseActivation[] }> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: DEACTIVATE_SERVER_URL,
        });

        request.setHeader('Content-Type', 'application/json');

        let responseBody = '';

        request.on('response', (response) => {
          response.on('data', (chunk) => {
            responseBody += chunk.toString();
          });

          response.on('end', () => {
            try {
              const data = JSON.parse(responseBody);
              if (response.statusCode === 200) {
                resolve({
                  success: data.success,
                  activations: data.activations || [],
                });
              } else {
                reject(new Error(data.error || 'Revocation failed'));
              }
            } catch {
              reject(new Error('Invalid server response'));
            }
          });
        });

        request.on('error', (error) => {
          reject(new Error(`Failed to connect to license server: ${error.message}`));
        });

        request.write(
          JSON.stringify({
            licenseKey,
            activationId,
          })
        );
        request.end();
      } catch (error) {
        reject(new Error(`Failed to revoke activation: ${(error as Error).message}`));
      }
    });
  }

  private callPricesServer(): Promise<unknown> {
    return new Promise((resolve) => {
      let request: ReturnType<typeof net.request> | undefined;
      let settled = false;
      const finish = (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      // A stalled connection would otherwise leave the dialog waiting forever.
      const timer = setTimeout(() => {
        request?.abort();
        finish(null);
      }, PRICES_TIMEOUT_MS);

      try {
        request = net.request({ method: 'GET', url: PRICES_SERVER_URL });

        let responseBody = '';

        request.on('response', (response) => {
          response.on('data', (chunk) => {
            responseBody += chunk.toString();
          });

          response.on('end', () => {
            try {
              finish(response.statusCode === 200 ? JSON.parse(responseBody) : null);
            } catch {
              finish(null);
            }
          });

          response.on('aborted', () => finish(null));
          response.on('error', () => finish(null));
        });

        request.on('error', (error) => {
          logger.warn('Failed to fetch prices', error);
          finish(null);
        });
        request.end();
      } catch (error) {
        logger.warn('Failed to fetch prices', error);
        finish(null);
      }
    });
  }

  private callBillingPortalServer(
    licenseKey: string
  ): Promise<{ url: string } | { error: string }> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: BILLING_PORTAL_SERVER_URL,
        });

        request.setHeader('Content-Type', 'application/json');

        let responseBody = '';

        request.on('response', (response) => {
          response.on('data', (chunk) => {
            responseBody += chunk.toString();
          });

          response.on('end', () => {
            try {
              const data = JSON.parse(responseBody);
              if (response.statusCode === 200 && typeof data.url === 'string') {
                resolve({ url: data.url });
              } else {
                resolve({ error: data.error || `Server returned ${response.statusCode}` });
              }
            } catch {
              resolve({ error: 'Invalid server response' });
            }
          });
        });

        request.on('error', (error) => {
          reject(new Error(`Failed to connect to license server: ${error.message}`));
        });

        request.write(JSON.stringify({ licenseKey }));
        request.end();
      } catch (error) {
        reject(new Error(`Failed to open billing portal: ${(error as Error).message}`));
      }
    });
  }

  private callActivationsServer(licenseKey: string): Promise<{
    activations: LicenseActivation[];
    activationsUsed: number;
    maxActivations: number;
  }> {
    return new Promise((resolve, reject) => {
      try {
        // POST with JSON body — keeps the license key out of access logs that
        // would otherwise capture URL query strings.
        const request = net.request({
          method: 'POST',
          url: ACTIVATIONS_SERVER_URL,
        });
        request.setHeader('Content-Type', 'application/json');

        let responseBody = '';

        request.on('response', (response) => {
          response.on('data', (chunk) => {
            responseBody += chunk.toString();
          });

          response.on('end', () => {
            try {
              const data = JSON.parse(responseBody);
              if (response.statusCode === 200 && data.success) {
                resolve({
                  activations: data.activations || [],
                  activationsUsed: data.activationsUsed ?? 0,
                  maxActivations: data.maxActivations ?? 3,
                });
              } else {
                reject(new Error(data.error || 'Failed to fetch activations'));
              }
            } catch {
              reject(new Error('Invalid server response'));
            }
          });
        });

        request.on('error', (error) => {
          reject(new Error(`Failed to connect to license server: ${error.message}`));
        });

        request.write(JSON.stringify({ licenseKey, machineId: this.machineId }));
        request.end();
      } catch (error) {
        reject(new Error(`Failed to fetch activations: ${(error as Error).message}`));
      }
    });
  }
}

export const licenseService = new LicenseService();
