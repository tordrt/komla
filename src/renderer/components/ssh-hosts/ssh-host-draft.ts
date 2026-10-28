import {
  komlaSshRemoteDataPort,
  isValidSshBasePath,
  isValidSshHostname,
  normalizeSshBasePath,
  type SshHost,
  type SshHostCapabilities,
  type SshHostSetupResult,
} from '@/types';

export interface HostDraft {
  id: string | null;
  name: string;
  hostname: string;
  user: string;
  port: string;
  identityFile: string;
  basePath: string;
  forwardAgent: boolean;
  isolated: boolean;
  extraSshArgs: string;
  portForwards: PortForwardDraft[];
}

export interface PortForwardDraft {
  id: string;
  name: string;
  direction: 'local-to-remote' | 'remote-to-local';
  localPort: string;
  remotePort: string;
  enabled: boolean;
}

export const EMPTY_DRAFT: HostDraft = {
  id: null,
  name: '',
  hostname: '',
  user: '',
  port: '',
  identityFile: '',
  basePath: '~/.komla',
  forwardAgent: true,
  isolated: true,
  extraSshArgs: '',
  portForwards: [],
};

export function getLocalMirrorDisabledReason(result: SshHostSetupResult): string | null {
  if (result.localMirror.platform === 'unsupported') {
    return 'local copies are not supported on Windows.';
  }
  const missingLocal = result.localMirror.localRsync === 'missing';
  const missingRemote = result.localMirror.remoteRsync === 'missing';
  if (missingLocal && missingRemote) {
    return 'rsync is missing on this computer and the SSH host.';
  }
  if (missingLocal) return 'rsync is missing on this computer.';
  if (missingRemote) return 'rsync is missing on the SSH host.';
  return null;
}

/** tmux before 3.4 drops terminal hyperlinks, so wrapped file links from agents don't open. */
export function tmuxUpgradeRecommended(version: string | undefined): boolean {
  const match = version?.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  return major < 3 || (major === 3 && Number(match[2]) < 4);
}

/** Whether a check found everything setup needs. rsync and the Git identity are optional. */
export function setupRequirementsMet(result: SshHostSetupResult): boolean {
  return (
    result.git.status === 'available' &&
    result.tmux.status === 'available' &&
    result.monitoring?.status === 'available'
  );
}

export function capabilitySnapshot(result: SshHostSetupResult): SshHostCapabilities {
  return {
    checkedAt: new Date().toISOString(),
    git: result.git,
    localMirror: result.localMirror,
    tmux: result.tmux,
    monitoring: result.monitoring,
  };
}

function createHostId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `ssh-${crypto.randomUUID()}`;
  }
  return `ssh-${Date.now()}`;
}

export function createPortForwardId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `forward-${crypto.randomUUID()}`;
  }
  return `forward-${Date.now()}`;
}

export function formatExtraSshArgs(args: string[] | undefined): string {
  return args?.join('\n') ?? '';
}

export function parseExtraSshArgs(value: string): string[] | undefined {
  const args = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return args.length > 0 ? args : undefined;
}

/**
 * Splits what people paste into a host field, such as `deploy@server:2222` or
 * `ssh://deploy@server`, into its parts. Null when there is nothing to split off.
 */
export function parseSshHostInput(
  value: string
): { hostname: string; user?: string; port?: string } | null {
  let rest = value.trim();
  const isUrl = /^ssh:\/\//i.test(rest);
  if (isUrl) rest = rest.slice('ssh://'.length).replace(/\/+$/, '');
  if (!rest) return null;

  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }

  let port: string | undefined;
  const bracketed = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    rest = bracketed[1];
    port = bracketed[2];
  } else if ((rest.match(/:/g) ?? []).length === 1) {
    const [hostname, maybePort] = rest.split(':');
    if (!/^\d+$/.test(maybePort)) return null;
    rest = hostname;
    port = maybePort;
  }

  if (!rest || (!isUrl && !user && !port && !bracketed)) return null;
  return { hostname: rest, ...(user ? { user } : {}), ...(port ? { port } : {}) };
}

/** Moves a user and port typed into the host field into their own fields. */
export function applySshHostInput(draft: HostDraft): HostDraft {
  const parsed = parseSshHostInput(draft.hostname);
  if (!parsed) return draft;
  return {
    ...draft,
    hostname: parsed.hostname,
    user: parsed.user ?? draft.user,
    port: parsed.port ?? draft.port,
  };
}

export function hostToDraft(host: SshHost): HostDraft {
  return {
    id: host.id,
    name: host.name,
    hostname: host.hostname,
    user: host.user ?? '',
    port: host.port ? String(host.port) : '',
    identityFile: host.identityFile ?? '',
    basePath: host.basePath,
    forwardAgent: host.forwardAgent ?? false,
    isolated: host.isolated ?? false,
    extraSshArgs: formatExtraSshArgs(host.extraSshArgs),
    portForwards:
      host.portForwards?.map((forward) => ({
        ...forward,
        direction: forward.direction ?? 'local-to-remote',
        localPort: String(forward.localPort),
        remotePort: String(forward.remotePort),
      })) ?? [],
  };
}

export function draftToHost(draft: HostDraft, newHostId?: string): SshHost {
  return {
    id: draft.id ?? newHostId ?? createHostId(),
    // A host left unnamed goes by its address or ~/.ssh/config alias.
    name: draft.name.trim() || draft.hostname.trim(),
    hostname: draft.hostname.trim(),
    user: draft.user.trim() || undefined,
    port: draft.port.trim() ? Number(draft.port.trim()) : undefined,
    identityFile: draft.identityFile.trim() || undefined,
    basePath: normalizeSshBasePath(draft.basePath),
    forwardAgent: draft.forwardAgent,
    isolated: draft.isolated,
    extraSshArgs: parseExtraSshArgs(draft.extraSshArgs),
    portForwards:
      draft.portForwards.length > 0
        ? draft.portForwards.map((forward) => ({
            id: forward.id,
            name: forward.name.trim(),
            direction: forward.direction,
            localPort: Number(forward.localPort),
            remotePort: Number(forward.remotePort),
            enabled: forward.enabled,
          }))
        : undefined,
  };
}

/** Why a saved host can't take these details: its remote path, or a connection workspaces use. */
export function savedHostChangeError(
  draft: HostDraft,
  savedHost: SshHost | undefined,
  hasWorkspaces: boolean
): string | null {
  if (!savedHost) return null;
  if (normalizeSshBasePath(savedHost.basePath) !== normalizeSshBasePath(draft.basePath)) {
    return 'Remote Komla path is fixed after this machine is connected. Remove and reconnect the machine to use a different path.';
  }
  const connectionChanged =
    savedHost.hostname !== draft.hostname.trim() ||
    (savedHost.user ?? '') !== draft.user.trim() ||
    (savedHost.port ? String(savedHost.port) : '') !== draft.port.trim() ||
    (savedHost.identityFile ?? '') !== draft.identityFile.trim() ||
    formatExtraSshArgs(savedHost.extraSshArgs) !== draft.extraSshArgs;
  if (hasWorkspaces && connectionChanged) {
    return 'Remove existing SSH workspaces for this host before changing its connection.';
  }
  return null;
}

export function validateDraft(draft: HostDraft, hostId: string): string | null {
  if (!draft.hostname.trim()) return 'Host is required.';
  if (!isValidSshHostname(draft.hostname)) {
    return 'Host must not include a username, port, URL, or path.';
  }
  if (!draft.basePath.trim()) return 'Base path is required.';
  if (!isValidSshBasePath(draft.basePath)) {
    return 'Base path must not resolve to the filesystem root or home directory or contain parent traversal.';
  }
  if (draft.port.trim()) {
    const port = Number(draft.port.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return 'Port must be a number from 1 to 65535.';
    }
  }
  const enabledLocalPorts = new Set<number>();
  const enabledRemotePorts = new Set<number>();
  for (const forward of draft.portForwards) {
    if (!forward.name.trim()) return 'Each port forward needs a name.';
    const localPort = Number(forward.localPort);
    const remotePort = Number(forward.remotePort);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      return `Local port for ${forward.name.trim()} must be a number from 1 to 65535.`;
    }
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      return `SSH host port for ${forward.name.trim()} must be a number from 1 to 65535.`;
    }
    if (forward.direction === 'local-to-remote' && remotePort === komlaSshRemoteDataPort(hostId)) {
      return `SSH host port ${remotePort} is reserved by Komla for this host.`;
    }
    if (
      forward.enabled &&
      forward.direction === 'local-to-remote' &&
      enabledRemotePorts.has(remotePort)
    ) {
      return `SSH host port ${remotePort} is used by more than one enabled forward.`;
    }
    if (
      forward.enabled &&
      forward.direction === 'remote-to-local' &&
      enabledLocalPorts.has(localPort)
    ) {
      return `Local port ${localPort} is used by more than one enabled forward.`;
    }
    if (forward.enabled && forward.direction === 'local-to-remote') {
      enabledRemotePorts.add(remotePort);
    }
    if (forward.enabled && forward.direction === 'remote-to-local') {
      enabledLocalPorts.add(localPort);
    }
  }
  return null;
}
