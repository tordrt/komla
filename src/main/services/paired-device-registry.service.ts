// Persists the set of trusted browser installations paired with this Komla install.
//
// Storage: `<komla-data-dir>/paired-devices.json`. Plain JSON, no encryption.
// Every field is public material — browser installation public key, passkey
// public key, counters, origin metadata, labels, and timestamps. Stealing this file alone
// does not let an attacker impersonate a paired device (the matching
// private key never leaves the authenticator) or impersonate this Komla
// install (that requires the install identity, which lives behind
// safeStorage in `install-identity.service.ts`).
//
// Concurrency: this service is the single writer in the main process.
// Writes go through `writeFileAtomicSync` so a crash mid-write leaves the
// previous file intact rather than a half-written one.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';

import { ensureKomlaBasePath } from './paths';

import type { PairedDeviceRecord } from '../../shared/types/paired-device';

export type { PairedDeviceRecord } from '../../shared/types/paired-device';

const logger = createLogger('PairedDeviceRegistry');

const FILE_NAME = 'paired-devices.json';
const FILE_MODE = 0o600;
const FILE_VERSION = 1;
const MAX_LABEL_LENGTH = 120;

interface RegistryFileV1 {
  version: 1;
  devices: PairedDeviceRecord[];
}

/**
 * Persistent set of paired-device records. Construct with no args for the
 * production singleton path; tests can pass an explicit `registryPath` to
 * isolate from the user's data dir.
 *
 * The store is loaded lazily on the first read. Mutations save synchronously
 * so the on-disk file is always consistent with the in-memory snapshot once
 * the call returns.
 */
export class PairedDeviceRegistryService {
  // Path resolution is deferred so constructing the production singleton
  // doesn't touch `ensureKomlaBasePath()` at import time — that would
  // fail in renderer-mocked test environments where the home directory
  // mock is read-only.
  private readonly explicitPath: string | null;
  private resolvedPath: string | null = null;
  private cache: PairedDeviceRecord[] | null = null;
  private listeners: Array<(devices: PairedDeviceRecord[]) => void> = [];

  constructor(registryPath?: string) {
    this.explicitPath = registryPath ?? null;
  }

  private get registryPath(): string {
    if (!this.resolvedPath) {
      this.resolvedPath = this.explicitPath ?? join(ensureKomlaBasePath(), FILE_NAME);
    }
    return this.resolvedPath;
  }

  list(): PairedDeviceRecord[] {
    return this.snapshot();
  }

  getByCredentialId(credentialId: string): PairedDeviceRecord | null {
    return this.snapshot().find((d) => d.credentialId === credentialId) ?? null;
  }

  getByDeviceId(deviceId: string): PairedDeviceRecord | null {
    return this.snapshot().find((d) => d.deviceId === deviceId) ?? null;
  }

  /**
   * Add a freshly registered device. Throws if `credentialId` is already
   * present — the ceremony refuses a duplicate earlier, but we defend the
   * invariant here too.
   */
  add(record: PairedDeviceRecord): void {
    const devices = this.snapshot();
    if (
      devices.some((d) => d.credentialId === record.credentialId || d.deviceId === record.deviceId)
    ) {
      throw new Error(`paired device already exists: ${record.deviceId}`);
    }
    const normalized: PairedDeviceRecord = {
      ...record,
      label: normalizeLabel(record.label),
    };
    this.persist([...devices, normalized]);
  }

  /** Update the friendly label. Throws if the device is not registered. */
  rename(credentialId: string, label: string): PairedDeviceRecord {
    const devices = this.snapshot();
    const next = devices.map((d) =>
      d.credentialId === credentialId ? { ...d, label: normalizeLabel(label) } : d
    );
    if (next.length === devices.length && !next.some((d) => d.credentialId === credentialId)) {
      throw new Error(`paired device not found: ${credentialId}`);
    }
    this.persist(next);
    return next.find((d) => d.credentialId === credentialId)!;
  }

  /** Remove the record. No-op if it doesn't exist. */
  remove(credentialId: string): void {
    const devices = this.snapshot();
    const next = devices.filter((d) => d.credentialId !== credentialId);
    if (next.length === devices.length) return;
    this.persist(next);
  }

  /**
   * Persist a successful authentication: bump `signCounter` to the value the
   * authenticator just reported and stamp `lastUsedAt`. Throws if the
   * credential is not registered. The caller (auth ceremony) verifies the
   * WebAuthn assertion first, so a regression is rejected before this method
   * is reached; the counter still never goes down, because a resume or the
   * slower of two concurrent sign-ins reports a counter it read earlier.
   */
  recordAuthSuccess(credentialId: string, newCounter: number, ts: string): PairedDeviceRecord {
    if (!Number.isInteger(newCounter) || newCounter < 0) {
      throw new Error(`recordAuthSuccess: invalid counter ${newCounter}`);
    }
    const devices = this.snapshot();
    const idx = devices.findIndex((d) => d.credentialId === credentialId);
    if (idx === -1) {
      throw new Error(`paired device not found: ${credentialId}`);
    }
    const updated = {
      ...devices[idx],
      signCounter: Math.max(devices[idx].signCounter, newCounter),
      lastUsedAt: ts,
    } as PairedDeviceRecord;
    const next = [...devices];
    next[idx] = updated;
    this.persist(next);
    return updated;
  }

  /**
   * Subscribe to mutation events. The callback fires after every successful
   * `add`, `rename`, or `remove` with the new full snapshot. Returns an
   * unsubscribe function.
   */
  onChange(listener: (devices: PairedDeviceRecord[]) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  // Test seam — drops the in-memory cache so the next read re-hits disk.
  // Not part of the public API; the file is the source of truth, but we
  // never need to reload it in production.
  __resetForTests(): void {
    this.cache = null;
  }

  // ────────────────────────────────────────────────────────────────────────

  private snapshot(): PairedDeviceRecord[] {
    if (this.cache) return [...this.cache];
    this.cache = this.readFile();
    return [...this.cache];
  }

  private readFile(): PairedDeviceRecord[] {
    if (!existsSync(this.registryPath)) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.registryPath, 'utf8'));
    } catch (error) {
      logger.warn('paired-devices file is unreadable', error);
      throw new Error(
        `Paired-devices file is unreadable at ${this.registryPath}. ` +
          `Delete the file to reset the paired-device list.`
      );
    }

    const raw = parsed as { version?: unknown; devices?: unknown };
    if (raw.version !== FILE_VERSION) {
      throw new Error(
        `Paired-devices file has unsupported version ${String(raw.version)} (expected ${FILE_VERSION}).`
      );
    }
    if (!Array.isArray(raw.devices)) {
      throw new Error(`Paired-devices file is malformed: 'devices' is not an array.`);
    }

    return raw.devices.map((d, i) => coerceRecord(d, i));
  }

  private persist(devices: PairedDeviceRecord[]): void {
    const file: RegistryFileV1 = { version: FILE_VERSION, devices };
    writeFileAtomicSync(this.registryPath, JSON.stringify(file, null, 2), FILE_MODE);
    this.cache = devices;
    for (const listener of this.listeners) {
      try {
        listener([...devices]);
      } catch (err) {
        logger.warn('paired-devices change listener threw', err);
      }
    }
  }
}

function normalizeLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    throw new Error('paired device label must not be empty');
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    return trimmed.slice(0, MAX_LABEL_LENGTH);
  }
  return trimmed;
}

function coerceRecord(value: unknown, index: number): PairedDeviceRecord {
  if (!value || typeof value !== 'object') {
    throw new Error(`Paired-devices entry ${index} is not an object.`);
  }
  const r = value as Record<string, unknown>;
  if (typeof r.deviceId !== 'string' || !/^[0-9a-f]{64}$/.test(r.deviceId)) {
    throw new Error(`Paired-devices entry ${index}: deviceId is not a fingerprint.`);
  }
  if (typeof r.devicePublicKey !== 'string' || r.devicePublicKey.length === 0) {
    throw new Error(`Paired-devices entry ${index}: devicePublicKey is not a string.`);
  }
  if (typeof r.credentialId !== 'string' || r.credentialId.length === 0) {
    throw new Error(`Paired-devices entry ${index}: credentialId is not a string.`);
  }
  if (typeof r.publicKey !== 'string' || r.publicKey.length === 0) {
    throw new Error(`Paired-devices entry ${index}: publicKey is not a string.`);
  }
  if (typeof r.signCounter !== 'number' || !Number.isInteger(r.signCounter) || r.signCounter < 0) {
    throw new Error(`Paired-devices entry ${index}: signCounter is not a non-negative integer.`);
  }
  if (r.aaguid !== null && typeof r.aaguid !== 'string') {
    throw new Error(`Paired-devices entry ${index}: aaguid must be string or null.`);
  }
  if (typeof r.label !== 'string') {
    throw new Error(`Paired-devices entry ${index}: label is not a string.`);
  }
  if (typeof r.createdAt !== 'string') {
    throw new Error(`Paired-devices entry ${index}: createdAt is not a string.`);
  }
  if (r.lastUsedAt !== null && typeof r.lastUsedAt !== 'string') {
    throw new Error(`Paired-devices entry ${index}: lastUsedAt must be string or null.`);
  }
  if (
    r.transports !== null &&
    (!Array.isArray(r.transports) || !r.transports.every((t) => typeof t === 'string'))
  ) {
    throw new Error(
      `Paired-devices entry ${index}: transports must be an array of strings or null.`
    );
  }
  if (typeof r.rpId !== 'string' || r.rpId.length === 0) {
    throw new Error(`Paired-devices entry ${index}: rpId is not a string.`);
  }
  if (typeof r.origin !== 'string' || r.origin.length === 0) {
    throw new Error(`Paired-devices entry ${index}: origin is not a string.`);
  }
  return {
    deviceId: r.deviceId,
    devicePublicKey: r.devicePublicKey,
    credentialId: r.credentialId,
    publicKey: r.publicKey,
    signCounter: r.signCounter,
    aaguid: r.aaguid,
    label: r.label,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    transports: r.transports ?? null,
    rpId: r.rpId,
    origin: r.origin,
  };
}

export const pairedDeviceRegistryService = new PairedDeviceRegistryService();
