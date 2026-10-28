import {
  deviceIdFromPublicKey,
  encodeBase64,
  exportDevicePublicKey,
  generateDeviceKeyPair,
} from '@komla/remote-protocol';

const DATABASE_NAME = 'komla-remote-v2';
const DATABASE_VERSION = 1;
const STORE_NAME = 'trusted-devices';

export interface PendingDeviceIdentity {
  fingerprint: string;
  deviceId: string;
  devicePublicKey: string;
  privateKey: CryptoKey;
}

export interface StoredDeviceIdentity extends PendingDeviceIdentity {
  credentialId: string;
}

export interface EnrollmentDeviceIdentity {
  identity: PendingDeviceIdentity;
  previousIdentity: StoredDeviceIdentity | null;
}

interface EnrollmentIdentityDependencies {
  load: (fingerprint: string) => Promise<StoredDeviceIdentity | null>;
  create: (fingerprint: string) => Promise<PendingDeviceIdentity>;
}

export async function createPendingDeviceIdentity(
  fingerprint: string
): Promise<PendingDeviceIdentity> {
  const pair = await generateDeviceKeyPair();
  const publicKey = await exportDevicePublicKey(pair.publicKey);
  return {
    fingerprint,
    deviceId: await deviceIdFromPublicKey(publicKey),
    devicePublicKey: encodeBase64(publicKey),
    privateKey: pair.privateKey,
  };
}

export async function loadOrCreateEnrollmentDeviceIdentity(
  fingerprint: string,
  dependencies: EnrollmentIdentityDependencies = {
    load: loadDeviceIdentity,
    create: createPendingDeviceIdentity,
  }
): Promise<EnrollmentDeviceIdentity> {
  const stored = await dependencies.load(fingerprint);
  if (stored) return { identity: stored, previousIdentity: stored };
  return {
    identity: await dependencies.create(fingerprint),
    previousIdentity: null,
  };
}

export async function stageEnrollmentDeviceIdentity(
  identity: PendingDeviceIdentity,
  credentialId: string,
  onStaged: (identity: StoredDeviceIdentity) => void,
  persist: (identity: StoredDeviceIdentity) => Promise<void> = saveDeviceIdentity
): Promise<StoredDeviceIdentity> {
  const storedIdentity = { ...identity, credentialId };
  await persist(storedIdentity);
  onStaged(storedIdentity);
  return storedIdentity;
}

export async function saveDeviceIdentity(identity: StoredDeviceIdentity): Promise<void> {
  const db = await openDatabase();
  await transactionDone(db, 'readwrite', (store) => store.put(identity));
}

export async function loadDeviceIdentity(
  fingerprint: string
): Promise<StoredDeviceIdentity | null> {
  const db = await openDatabase();
  const result = await requestResult<StoredDeviceIdentity | undefined>(
    db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(fingerprint)
  );
  return result ?? null;
}

export async function removeDeviceIdentity(fingerprint: string): Promise<void> {
  const db = await openDatabase();
  await transactionDone(db, 'readwrite', (store) => store.delete(fingerprint));
}

export async function removeDeviceIdentityIfMatches(
  fingerprint: string,
  deviceId: string,
  credentialId: string
): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(fingerprint);
    request.onsuccess = () => {
      const stored = request.result as StoredDeviceIdentity | undefined;
      if (stored?.deviceId === deviceId && stored.credentialId === credentialId) {
        store.delete(fingerprint);
      }
    };
    request.onerror = () => transaction.abort();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Device key store transaction failed'));
    transaction.onabort = () =>
      reject(
        transaction.error ?? request.error ?? new Error('Device key store transaction aborted')
      );
  });
}

export async function discardRejectedEnrollmentIdentity(
  identity: StoredDeviceIdentity | null,
  previousIdentity: StoredDeviceIdentity | null,
  removeIfMatches: (
    fingerprint: string,
    deviceId: string,
    credentialId: string
  ) => Promise<void> = removeDeviceIdentityIfMatches,
  restore: (identity: StoredDeviceIdentity) => Promise<void> = saveDeviceIdentity
): Promise<void> {
  if (!identity) return;
  if (previousIdentity) {
    await restore(previousIdentity);
    return;
  }
  await removeIfMatches(identity.fingerprint, identity.deviceId, identity.credentialId);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'fingerprint' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open device key store'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Device key store request failed'));
  });
}

function transactionDone(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    operation(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Device key store transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Device key store transaction aborted'));
  });
}
