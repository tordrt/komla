// Web Push to trusted remote devices: "an agent needs you" on a phone whose page is closed.
//
// The desktop sends straight to each browser's push service (Apple, Google, Mozilla) with its own
// VAPID key, encrypting every payload to that subscription's keys (RFC 8291), so the push service
// relays ciphertext and Komla runs no gateway. Pushes go only to devices still in the paired
// device registry, and only while remote control is on.
//
// Storage, both in the Komla data dir:
// - `remote-push-key.json`: the VAPID key pair, encrypted with safeStorage. Loaded only when a
//   phone asks for it or a push is due, so launching Komla never reads the keychain for it.
// - `remote-push-subscriptions.json`: one subscription per trusted device, keyed by passkey
//   credential id. Endpoints are capability URLs, but pushing to one also needs the VAPID key.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { safeStorage } from 'electron';

import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';
import { canUseSecureStorage } from '../lib/secure-storage';
import { isUserAway } from '../lib/user-presence';
import {
  assertWebPushSubscription,
  buildWebPushRequest,
  generateVapidKeys,
  sendWebPush,
  type VapidKeys,
  type WebPushOutcome,
  type WebPushRequest,
  type WebPushResult,
} from '../lib/web-push';

import { configService } from './config.service';
import { pairedDeviceRegistryService } from './paired-device-registry.service';
import { ensureKomlaBasePath } from './paths';

import type { WorkspaceAttentionEvent, WorkspaceAttentionKind } from '../../shared/types/workspace';
import type { RemotePushNotifyWhen, RemotePushSubscription } from '@komla/remote-protocol';

const logger = createLogger('RemoteControlPush');

const KEY_FILE_NAME = 'remote-push-key.json';
const SUBSCRIPTIONS_FILE_NAME = 'remote-push-subscriptions.json';
const FILE_MODE = 0o600;
const FILE_VERSION = 1;
// RFC 8292: the contact a push service may use about this sender.
const VAPID_SUBJECT = 'https://komla.dev';
// An alert older than this is stale; the push service drops it instead of delivering late.
const PUSH_TTL_SECONDS = 6 * 60 * 60;
// One workspace can't buzz the phone more than once in this window for the same kind.
const MIN_REPEAT_MS = 5_000;
const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 180;

const NOTIFIED_KINDS: ReadonlyMap<WorkspaceAttentionKind, string> = new Map([
  ['input-required', 'Needs input'],
  ['turn-complete', 'Done'],
  ['error', 'Error'],
]);

export interface StoredPushSubscription extends RemotePushSubscription {
  credentialId: string;
  notifyWhen: RemotePushNotifyWhen;
  createdAt: string;
}

/** What one connected phone is looking at right now. */
export interface PushViewer {
  visible: boolean;
  /** Attached terminal id → its workspace id. */
  attachedTerminals: ReadonlyMap<string, string>;
}

export interface RemotePushConfigState {
  available: boolean;
  vapidPublicKey?: string;
  subscribed: boolean;
  notifyWhen: RemotePushNotifyWhen;
}

export interface PushPayload {
  v: 1;
  title: string;
  body: string;
  /** Replaces an earlier notification for the same workspace on the phone. */
  tag: string;
  workspaceId?: string;
  terminalId?: string;
  kind?: WorkspaceAttentionKind;
}

interface KeyFileV1 {
  version: 1;
  // base64(safeStorage.encryptString(JSON.stringify(VapidKeys)))
  encryptedKeys: string;
}

interface SubscriptionsFileV1 {
  version: 1;
  subscriptions: StoredPushSubscription[];
}

export interface RemoteControlPushDeps {
  keyPath?: string;
  subscriptionsPath?: string;
  secureStorage?: {
    available(): boolean;
    encrypt(text: string): Buffer;
    decrypt(data: Buffer): string;
  };
  devices?: {
    list(): Array<{ credentialId: string }>;
    onChange(listener: (devices: Array<{ credentialId: string }>) => void): () => void;
  };
  isUserAway?: () => boolean;
  isEnabled?: () => boolean;
  send?: (request: WebPushRequest) => Promise<WebPushResult>;
  now?: () => number;
}

export class RemoteControlPushService {
  private readonly deps: Required<Omit<RemoteControlPushDeps, 'keyPath' | 'subscriptionsPath'>>;
  private readonly explicitKeyPath: string | null;
  private readonly explicitSubscriptionsPath: string | null;
  private keys: VapidKeys | null = null;
  private subscriptions: StoredPushSubscription[] | null = null;
  private readonly viewers = new Map<string, () => PushViewer>();
  private readonly lastSent = new Map<string, number>();
  private unsubscribeDevices: (() => void) | null = null;

  constructor(deps: RemoteControlPushDeps = {}) {
    this.explicitKeyPath = deps.keyPath ?? null;
    this.explicitSubscriptionsPath = deps.subscriptionsPath ?? null;
    this.deps = {
      secureStorage: deps.secureStorage ?? {
        available: canUseSecureStorage,
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (data) => safeStorage.decryptString(data),
      },
      devices: deps.devices ?? pairedDeviceRegistryService,
      isUserAway: deps.isUserAway ?? isUserAway,
      isEnabled: deps.isEnabled ?? (() => Boolean(configService.get().directRemoteEnabled)),
      send: deps.send ?? ((request) => sendWebPush(request)),
      now: deps.now ?? Date.now,
    };
  }

  /** Drops a device's subscription as soon as the device is removed. */
  start(): void {
    if (this.unsubscribeDevices) return;
    this.unsubscribeDevices = this.deps.devices.onChange(() => this.pruneRemovedDevices());
  }

  stop(): void {
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = null;
  }

  config(credentialId: string): RemotePushConfigState {
    // Keys first: replacing an unreadable key also clears the subscriptions made for it.
    const keys = this.loadKeys();
    const subscription = this.subscriptionFor(credentialId);
    return {
      available: keys !== null,
      ...(keys ? { vapidPublicKey: keys.publicKey } : {}),
      subscribed: subscription !== undefined,
      notifyWhen: subscription?.notifyWhen ?? 'away',
    };
  }

  subscribe(
    credentialId: string,
    subscription: RemotePushSubscription,
    notifyWhen: RemotePushNotifyWhen
  ): void {
    if (!this.deps.devices.list().some((device) => device.credentialId === credentialId)) {
      throw new Error('This device is no longer trusted.');
    }
    if (!this.loadKeys())
      throw new Error('Notifications need access to the OS keychain on this computer.');
    assertWebPushSubscription(subscription);
    const record: StoredPushSubscription = {
      credentialId,
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      notifyWhen,
      createdAt: new Date(this.deps.now()).toISOString(),
    };
    this.saveSubscriptions([
      ...this.loadSubscriptions().filter((existing) => existing.credentialId !== credentialId),
      record,
    ]);
  }

  unsubscribe(credentialId: string): void {
    const subscriptions = this.loadSubscriptions();
    const remaining = subscriptions.filter((existing) => existing.credentialId !== credentialId);
    if (remaining.length !== subscriptions.length) this.saveSubscriptions(remaining);
  }

  /** A connected phone reports what it shows, so it isn't pushed what it is looking at. */
  registerViewer(credentialId: string, viewer: () => PushViewer): () => void {
    this.viewers.set(credentialId, viewer);
    return () => {
      if (this.viewers.get(credentialId) === viewer) this.viewers.delete(credentialId);
    };
  }

  async sendTest(credentialId: string): Promise<WebPushOutcome | 'not-subscribed'> {
    const subscription = this.subscriptionFor(credentialId);
    if (!subscription) return 'not-subscribed';
    return this.deliver(subscription, {
      v: 1,
      title: 'Komla',
      body: 'Notifications are on for this device.',
      tag: 'komla-test',
    });
  }

  async attentionRaised(event: WorkspaceAttentionEvent, workspaceName?: string): Promise<void> {
    const label = NOTIFIED_KINDS.get(event.attention.kind);
    if (!label || !this.deps.isEnabled()) return;
    const subscriptions = this.loadSubscriptions();
    if (subscriptions.length === 0) return;

    const detail = (event.attention.title?.trim() || event.attention.message?.trim()) ?? '';
    const payload: PushPayload = {
      v: 1,
      title: clip(workspaceName?.trim() || 'Komla', MAX_TITLE_CHARS),
      body: clip(detail ? `${label} · ${detail}` : label, MAX_BODY_CHARS),
      tag: `workspace-${event.workspaceId}`,
      workspaceId: event.workspaceId,
      ...(event.attention.terminalId ? { terminalId: event.attention.terminalId } : {}),
      kind: event.attention.kind,
    };
    const away = this.deps.isUserAway();
    await Promise.all(
      subscriptions.map(async (subscription) => {
        if (subscription.notifyWhen === 'away' && !away) return;
        if (this.isViewing(subscription.credentialId, event)) return;
        const key = `${subscription.credentialId}:${event.workspaceId}:${event.attention.kind}`;
        const now = this.deps.now();
        if (now - (this.lastSent.get(key) ?? -Infinity) < MIN_REPEAT_MS) return;
        this.lastSent.set(key, now);
        await this.deliver(subscription, payload);
      })
    );
  }

  private isViewing(credentialId: string, event: WorkspaceAttentionEvent): boolean {
    const viewer = this.viewers.get(credentialId)?.();
    if (!viewer?.visible) return false;
    const terminalId = event.attention.terminalId;
    if (terminalId) return viewer.attachedTerminals.has(terminalId);
    return [...viewer.attachedTerminals.values()].includes(event.workspaceId);
  }

  private async deliver(
    subscription: StoredPushSubscription,
    payload: PushPayload
  ): Promise<WebPushOutcome> {
    const keys = this.loadKeys();
    if (!keys) return 'failed';
    try {
      const request = buildWebPushRequest(
        subscription,
        Buffer.from(JSON.stringify(payload)),
        keys,
        {
          subject: VAPID_SUBJECT,
          ttlSeconds: PUSH_TTL_SECONDS,
          urgency: payload.kind === 'turn-complete' ? 'normal' : 'high',
          topic: topicFor(payload.tag),
        }
      );
      const result = await this.deps.send(request);
      if (result.outcome === 'gone') {
        logger.info('push subscription expired; removing it');
        this.unsubscribe(subscription.credentialId);
      } else if (result.outcome === 'failed') {
        // The endpoint is a capability URL, so only its status is logged.
        logger.warn('push service rejected a notification', { status: result.status });
      }
      return result.outcome;
    } catch (err) {
      logger.warn('push notification failed', { error: String(err) });
      return 'failed';
    }
  }

  private subscriptionFor(credentialId: string): StoredPushSubscription | undefined {
    return this.loadSubscriptions().find((existing) => existing.credentialId === credentialId);
  }

  private pruneRemovedDevices(): void {
    const trusted = new Set(this.deps.devices.list().map((device) => device.credentialId));
    const subscriptions = this.loadSubscriptions();
    const remaining = subscriptions.filter((existing) => trusted.has(existing.credentialId));
    if (remaining.length !== subscriptions.length) this.saveSubscriptions(remaining);
  }

  private get keyPath(): string {
    return this.explicitKeyPath ?? join(ensureKomlaBasePath(), KEY_FILE_NAME);
  }

  private get subscriptionsPath(): string {
    return this.explicitSubscriptionsPath ?? join(ensureKomlaBasePath(), SUBSCRIPTIONS_FILE_NAME);
  }

  /**
   * The VAPID key pair, created on first use; null when it can't be kept encrypted at rest, or
   * while the keychain won't decrypt it.
   */
  private loadKeys(): VapidKeys | null {
    if (this.keys) return this.keys;
    if (!this.deps.secureStorage.available()) return null;
    const stored = this.readStoredKeys();
    if (stored === 'locked') return null;
    if (stored) {
      this.keys = stored;
      return stored;
    }
    // Subscriptions were made for the old public key, so push services would refuse them.
    const keys = generateVapidKeys();
    let encryptedKeys: string;
    try {
      encryptedKeys = this.deps.secureStorage.encrypt(JSON.stringify(keys)).toString('base64');
    } catch (err) {
      logger.warn('push key could not be encrypted', { error: String(err) });
      return null;
    }
    const file: KeyFileV1 = { version: FILE_VERSION, encryptedKeys };
    writeFileAtomicSync(this.keyPath, JSON.stringify(file), FILE_MODE);
    this.saveSubscriptions([]);
    this.keys = keys;
    return keys;
  }

  /**
   * The stored key pair; null when there is none or its file is unreadable, so it is replaced;
   * 'locked' when the keychain refused to decrypt it, as when its prompt was dismissed. A locked
   * key is kept, and every phone's subscription with it, to be read again next time.
   */
  private readStoredKeys(): VapidKeys | null | 'locked' {
    if (!existsSync(this.keyPath)) return null;
    let encryptedKeys: string;
    try {
      const file = JSON.parse(readFileSync(this.keyPath, 'utf8')) as Partial<KeyFileV1>;
      if (file.version !== FILE_VERSION || typeof file.encryptedKeys !== 'string') {
        throw new Error('unsupported push key file');
      }
      encryptedKeys = file.encryptedKeys;
    } catch (err) {
      logger.warn('push key file is unreadable; replacing it and its subscriptions', {
        error: String(err),
      });
      return null;
    }
    let plaintext: string;
    try {
      plaintext = this.deps.secureStorage.decrypt(Buffer.from(encryptedKeys, 'base64'));
    } catch (err) {
      logger.warn('push key could not be decrypted; keeping it', { error: String(err) });
      return 'locked';
    }
    try {
      const keys = JSON.parse(plaintext) as Partial<VapidKeys>;
      if (typeof keys.publicKey === 'string' && typeof keys.privateKey === 'string') {
        return { publicKey: keys.publicKey, privateKey: keys.privateKey };
      }
    } catch {
      // Falls through to replacing it.
    }
    logger.warn('push key is unreadable; replacing it and its subscriptions');
    return null;
  }

  private loadSubscriptions(): StoredPushSubscription[] {
    if (this.subscriptions) return this.subscriptions;
    let subscriptions: StoredPushSubscription[] = [];
    try {
      if (existsSync(this.subscriptionsPath)) {
        const file = JSON.parse(
          readFileSync(this.subscriptionsPath, 'utf8')
        ) as Partial<SubscriptionsFileV1>;
        if (file.version === FILE_VERSION && Array.isArray(file.subscriptions)) {
          subscriptions = file.subscriptions.filter(isStoredSubscription);
        }
      }
    } catch (err) {
      logger.warn('push subscriptions are unreadable; starting empty', { error: String(err) });
    }
    const trusted = new Set(this.deps.devices.list().map((device) => device.credentialId));
    this.subscriptions = subscriptions.filter((existing) => trusted.has(existing.credentialId));
    return this.subscriptions;
  }

  private saveSubscriptions(subscriptions: StoredPushSubscription[]): void {
    this.subscriptions = subscriptions;
    const file: SubscriptionsFileV1 = { version: FILE_VERSION, subscriptions };
    writeFileAtomicSync(this.subscriptionsPath, JSON.stringify(file, null, 2), FILE_MODE);
  }
}

function isStoredSubscription(value: unknown): value is StoredPushSubscription {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredPushSubscription>;
  if (typeof record.credentialId !== 'string' || typeof record.createdAt !== 'string') return false;
  if (record.notifyWhen !== 'away' && record.notifyWhen !== 'always') return false;
  try {
    assertWebPushSubscription(record as StoredPushSubscription);
    return true;
  } catch {
    return false;
  }
}

function clip(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

/** Push service topics are at most 32 base64url characters. */
function topicFor(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, '_').slice(-32);
}

export const remoteControlPushService = new RemoteControlPushService();
