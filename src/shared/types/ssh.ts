import type { RemoteNotificationIntegrationUpdate } from './notification-integration';

/** Where adding an SSH host started; reported with `ssh_host_added`. */
export const SSH_HOST_ADDED_SOURCES = ['tips', 'new_workspace', 'settings', 'onboarding'] as const;
export type SshHostAddedSource = (typeof SSH_HOST_ADDED_SOURCES)[number];

export interface SshHost {
  id: string;
  name: string;
  hostname: string;
  user?: string;
  port?: number;
  identityFile?: string;
  basePath: string;
  forwardAgent?: boolean;
  /** The user treats the host as a sandbox, so agents may start modes there that skip prompts. */
  isolated?: boolean;
  extraSshArgs?: string[];
  portForwards?: SshPortForward[];
  setupPending?: boolean;
  capabilities?: SshHostCapabilities;
}

/** An SSH_ASKPASS prompt that main asks the renderer to show. */
export interface AskpassRequest {
  id: string;
  prompt: string;
  /** Whether the dialog may offer to remember the answer until Komla quits. */
  canRemember: boolean;
  /** Epoch milliseconds when main stops waiting and cancels the request. */
  expiresAt: number;
}

export interface SshPortForward {
  id: string;
  name: string;
  /** Defaults to local-to-remote for forwards saved before directions were configurable. */
  direction?: 'local-to-remote' | 'remote-to-local';
  localPort: number;
  remotePort: number;
  enabled: boolean;
}

/** A Host entry in the user's ~/.ssh/config, as the add-host dialog lists it. */
export interface SshConfigHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

/** What happened the last time Komla ran a command on an SSH host. */
export interface SshHostStatus {
  hostId: string;
  state: 'connected' | 'unreachable';
  /** When, in epoch milliseconds. */
  checkedAt: number;
  /** Why ssh could not connect, from its last error line. */
  message?: string;
}

export interface SshPortForwardStatus {
  hostId: string;
  state: 'stopped' | 'connecting' | 'connected' | 'error';
  error?: string;
}

/** A port Komla forwards to or from an SSH host, as the SSH hosts menu lists it. */
export interface SshForwardedPort {
  /** Unique among the listed ports; a link's is the id its toast stops it by. */
  id: string;
  hostId: string;
  /**
   * What it's for: a link opened in the default browser, a browser tab, a virtual desktop,
   * a forward saved with the host, or Komla's own tunnel for notifications and data.
   */
  kind: 'link' | 'browser-tab' | 'desktop' | 'saved' | 'komla';
  /** As for a saved forward: which side's port the other side reaches. */
  direction: NonNullable<SshPortForward['direction']>;
  localPort: number;
  remotePort: number;
  /** A link's or browser tab's workspace. */
  workspaceId?: string;
  tabId?: string;
  /** A saved forward's name. */
  name?: string;
  /** Whether its tunnel runs: the saved forwards' tunnel, or the one browser tabs and links share. */
  state?: SshPortForwardStatus['state'];
}

const KOMLA_SSH_REMOTE_PORT_BASE = 62_000;
const KOMLA_SSH_REMOTE_PORT_RANGE = 2_000;

export function komlaSshRemoteDataPort(hostId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < hostId.length; i++) {
    hash ^= hostId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return KOMLA_SSH_REMOTE_PORT_BASE + ((hash >>> 0) % KOMLA_SSH_REMOTE_PORT_RANGE);
}

export interface SshHostCapabilities {
  checkedAt: string;
  git: {
    status: 'available' | 'missing';
    version?: string;
  };
  localMirror: {
    platform: 'supported' | 'unsupported';
    localRsync: 'available' | 'missing';
    remoteRsync: 'available' | 'missing';
  };
  tmux: {
    status: 'available' | 'missing' | 'unusable';
    version?: string;
  };
  monitoring?: {
    status: 'available' | 'missing';
    missingRequirements: string[];
  };
}

export interface SshHostSetupResult extends Omit<SshHostCapabilities, 'checkedAt'> {
  ok: true;
  prepared: boolean;
  resolvedBasePath: string;
  notifyScriptPath?: string;
  gitIdentity?: {
    configured: boolean;
    userName?: string;
    userEmail?: string;
  };
  localGitIdentity?: {
    configured: boolean;
    userName?: string;
    userEmail?: string;
  };
}

export type SshAgent = 'claude' | 'codex' | 'antigravity' | 'opencode';
export type SshIntegrationType = 'notifications' | 'mcp';
export interface RemoteAgentIntegrationStatus {
  notifications: boolean;
  mcp: boolean;
  /** Set when Komla's notification setup differs from what Komla installs now. */
  update?: RemoteNotificationIntegrationUpdate;
}
export type SshIntegrationStatus = Record<SshAgent, RemoteAgentIntegrationStatus> & {
  /** Whether the host's skills folders have the Komla skill, which every agent there shares. */
  komlaSkill: boolean;
};
/** The notification configuration Komla would install for each agent whose setup needs an update. */
export type SshIntegrationUpdates = Partial<Record<SshAgent, string>>;
export type SshPreviewScheme = 'http' | 'https';

export interface SshPreviewForward {
  id: string;
  workspaceId: string;
  localUrl: string;
  localPort: number;
  remotePort: number;
}

/** The forward a link opened in the default browser goes through. */
export interface SshLinkForward extends SshPreviewForward {
  /** False when a forward the host already had serves the link. */
  started: boolean;
}

export function normalizeSshBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '~/.komla';
  return trimmed.replace(/\/~(?=\/|$)/g, '') || '~/.komla';
}

export function isValidSshBasePath(value: string): boolean {
  const normalized = normalizeSshBasePath(value);
  const withoutTrailingSlash = normalized.replace(/\/+$/, '') || '/';
  if (withoutTrailingSlash === '/' || withoutTrailingSlash === '~') return false;
  if (withoutTrailingSlash === '.') return false;
  return !normalized.split('/').includes('..');
}

export function isValidSshHostname(value: string): boolean {
  const hostname = value.trim();
  if (!hostname) return false;
  if (/\s/.test(hostname)) return false;
  if (hostname.includes('@')) return false;
  if (hostname.includes('://')) return false;
  if (hostname.includes('/')) return false;
  if (hostname.startsWith('[') || hostname.endsWith(']')) return false;

  const colonCount = (hostname.match(/:/g) ?? []).length;
  if (colonCount === 1) return false;

  return true;
}
