// Where this phone app can connect: the desktop that served it, and the SSH hosts that desktop
// vouched for over an authenticated session (ADR 0005). Hosts are remembered so the app can open
// one while the desktop is asleep; each host's fingerprint is pinned like the desktop's.

const DESKTOP_KEY = 'komla.remote.desktop';
const HOSTS_KEY = 'komla.remote.hosts';
const LAST_ENDPOINT_KEY = 'komla.remote.lastEndpoint';
const HOST_PARAM = 'host';
const WORKSPACE_PARAM = 'workspace';
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Hosts are reached over Tailscale Serve's TLS; plain `ws:` only to localhost while developing. */
const HOST_URL_PATTERN = /^(wss:\/\/|ws:\/\/(localhost|127\.0\.0\.1):\d+\/)/;

export interface HostEndpoint {
  id: string;
  name: string;
  url: string;
  fingerprint: string;
}

interface StoredHosts {
  desktopFingerprint: string;
  hosts: HostEndpoint[];
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isHostEndpoint(value: unknown): value is HostEndpoint {
  if (!value || typeof value !== 'object') return false;
  const host = value as Partial<HostEndpoint>;
  return (
    typeof host.id === 'string' &&
    ID_PATTERN.test(host.id) &&
    typeof host.name === 'string' &&
    host.name.length > 0 &&
    typeof host.url === 'string' &&
    HOST_URL_PATTERN.test(host.url) &&
    typeof host.fingerprint === 'string' &&
    FINGERPRINT_PATTERN.test(host.fingerprint)
  );
}

function read<T>(store: KeyValueStore, key: string): T | null {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(store: KeyValueStore, key: string, value: unknown): void {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Without storage the app still works while the desktop is reachable.
  }
}

/** The desktop whose device key this app holds, remembered for when it is unreachable. */
export function rememberDesktop(store: KeyValueStore, fingerprint: string): void {
  write(store, DESKTOP_KEY, { fingerprint });
}

export function rememberedDesktopFingerprint(store: KeyValueStore): string | null {
  const stored = read<{ fingerprint?: unknown }>(store, DESKTOP_KEY);
  return typeof stored?.fingerprint === 'string' && FINGERPRINT_PATTERN.test(stored.fingerprint)
    ? stored.fingerprint
    : null;
}

export function rememberHosts(
  store: KeyValueStore,
  desktopFingerprint: string,
  hosts: HostEndpoint[]
): void {
  write(store, HOSTS_KEY, { desktopFingerprint, hosts: hosts.filter(isHostEndpoint) });
}

/** Hosts the given desktop vouched for; none if another desktop's list is stored. */
export function rememberedHosts(store: KeyValueStore, desktopFingerprint: string): HostEndpoint[] {
  const stored = read<Partial<StoredHosts>>(store, HOSTS_KEY);
  if (stored?.desktopFingerprint !== desktopFingerprint || !Array.isArray(stored.hosts)) return [];
  return stored.hosts.filter(isHostEndpoint);
}

/** Remembers the endpoint the user picked, or the host this app signed in to: null is the desktop. */
export function rememberLastEndpoint(store: KeyValueStore, hostId: string | null): void {
  write(store, LAST_ENDPOINT_KEY, { hostId });
}

/** Whether an endpoint was remembered; until one is, the app prefers an SSH host to the desktop. */
export function hasLastEndpoint(store: KeyValueStore): boolean {
  const stored = read<{ hostId?: unknown }>(store, LAST_ENDPOINT_KEY);
  return typeof stored?.hostId === 'string' || stored?.hostId === null;
}

/**
 * The host the app opens at launch: the one remembered, while the desktop still vouches for it, or
 * else the first host it vouches for. Null opens the desktop, as it does once the user picks it.
 */
export function startingHostId(
  store: KeyValueStore,
  desktopFingerprint: string | null
): string | null {
  if (!desktopFingerprint) return null;
  const hosts = rememberedHosts(store, desktopFingerprint);
  const stored = read<{ hostId?: unknown }>(store, LAST_ENDPOINT_KEY);
  if (stored?.hostId === null) return null;
  const hostId = typeof stored?.hostId === 'string' ? stored.hostId : null;
  return (hosts.find((host) => host.id === hostId) ?? hosts[0])?.id ?? null;
}

/** The host this page connects to, from `?host=`, or null for the desktop. */
export function selectedHostId(href: string): string | null {
  const id = new URL(href).searchParams.get(HOST_PARAM);
  return id && ID_PATTERN.test(id) ? id : null;
}

/**
 * The page for an endpoint, the desktop for null, opening `workspaceId` if given. Keeps the app's
 * own path.
 */
export function endpointHref(href: string, hostId: string | null, workspaceId?: string): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  if (hostId) url.searchParams.set(HOST_PARAM, hostId);
  if (workspaceId) url.searchParams.set(WORKSPACE_PARAM, workspaceId);
  return url.toString();
}
