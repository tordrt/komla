import { posix as pathPosix } from 'path';

import { shellQuotePosix } from '../../../shared/lib/shell-quote';
import { sshHostService } from '../ssh-host.service';
import { joinRemote, sshWorkspaceService } from '../ssh-workspace.service';

import {
  isSshWorkspaceManifestId,
  MAX_SSH_WORKSPACE_MANIFEST_BYTES,
  SSH_WORKSPACE_MANIFEST_DIRECTORY,
  SSH_WORKSPACE_TOMBSTONE_DIRECTORY,
  SSH_WORKSPACE_TOMBSTONE_RETENTION_DAYS,
  type SshWorkspaceOnHost,
} from './workspace-manifest';

import type { SshWorkspaceSyncHost } from './ssh-workspace-sync';
import type { SshWorkspaceBackend } from '../../../shared/types/workspace';

function manifestPath(backend: SshWorkspaceBackend, workspaceId: string): string {
  if (!isSshWorkspaceManifestId(workspaceId)) {
    throw new Error(`Invalid SSH workspace manifest id ${workspaceId}`);
  }
  const remoteBasePath = pathPosix.dirname(pathPosix.dirname(backend.remoteProjectRoot));
  return joinRemote(remoteBasePath, SSH_WORKSPACE_MANIFEST_DIRECTORY, `${workspaceId}.json`);
}

function tombstonePath(backend: SshWorkspaceBackend, workspaceId: string): string {
  return joinRemote(
    pathPosix.dirname(manifestPath(backend, workspaceId)),
    SSH_WORKSPACE_TOMBSTONE_DIRECTORY,
    workspaceId
  );
}

/** The Workspace manifests and Tombstones on SSH hosts, read and written over SSH. */
export const sshWorkspaceSyncHost = {
  /**
   * Reports whether a workspace's worktree is still on its host, with its
   * current manifest, or whether a Komla installation deleted it.
   */
  async inspect(backend: SshWorkspaceBackend, workspaceId: string): Promise<SshWorkspaceOnHost> {
    const manifest = shellQuotePosix(manifestPath(backend, workspaceId));
    const output = await sshWorkspaceService.run(
      sshWorkspaceService.getHost(backend.hostId),
      [
        // A deleted workspace's directory can belong to a new one on the same branch.
        `if [ -e ${shellQuotePosix(tombstonePath(backend, workspaceId))} ]; then`,
        '  printf deleted',
        `elif [ -d ${shellQuotePosix(backend.remoteDirectory)} ]; then`,
        "  printf 'present\\n'",
        `  if [ -f ${manifest} ] && [ "$(wc -c < ${manifest} | tr -d ' ')" -le ${MAX_SSH_WORKSPACE_MANIFEST_BYTES} ]; then`,
        `    base64 < ${manifest} | tr -d '\\n'`,
        '  fi',
        'else',
        '  printf missing',
        'fi',
      ].join('\n')
    );
    const [state = '', encoded = ''] = output.split('\n').map((line) => line.trim());
    if (state === 'deleted') return { state: 'deleted' };
    if (state === 'missing') return { state: 'missing' };
    if (state !== 'present') {
      throw new Error('Unexpected reply while checking an SSH workspace on its host');
    }
    return encoded
      ? { state: 'present', manifest: Buffer.from(encoded, 'base64').toString('utf8') }
      : { state: 'present' };
  },

  /**
   * Writes a workspace's manifest unless a Komla installation deleted the
   * workspace, which would resurrect it. Returns false when it was deleted.
   */
  async write(
    backend: SshWorkspaceBackend,
    workspaceId: string,
    content: string
  ): Promise<boolean> {
    return sshWorkspaceService.writeRemoteText(
      sshWorkspaceService.getHost(backend.hostId),
      manifestPath(backend, workspaceId),
      content,
      false,
      tombstonePath(backend, workspaceId)
    );
  },

  /** Removes a workspace's manifest if its files are gone, so no installation adds it again. */
  async removeOrphaned(backend: SshWorkspaceBackend, workspaceId: string): Promise<void> {
    await sshWorkspaceService.run(
      sshWorkspaceService.getHost(backend.hostId),
      `[ -d ${shellQuotePosix(backend.remoteDirectory)} ] || rm -f ${shellQuotePosix(
        manifestPath(backend, workspaceId)
      )}`
    );
  },

  /** Replaces a deleted workspace's manifest with a Tombstone and prunes old Tombstones. */
  async delete(backend: SshWorkspaceBackend, workspaceId: string): Promise<void> {
    const tombstone = tombstonePath(backend, workspaceId);
    const tombstones = shellQuotePosix(pathPosix.dirname(tombstone));
    await sshWorkspaceService.run(
      sshWorkspaceService.getHost(backend.hostId),
      [
        `mkdir -p ${tombstones} && : > ${shellQuotePosix(tombstone)} && rm -f ${shellQuotePosix(
          manifestPath(backend, workspaceId)
        )} || exit 1`,
        `find ${tombstones} -type f -mtime +${SSH_WORKSPACE_TOMBSTONE_RETENTION_DAYS} -exec rm -f {} + 2>/dev/null || true`,
      ].join('\n')
    );
  },

  /**
   * Returns the raw text of every workspace manifest on the host, skipping
   * oversized files. `background` leaves the connection slot kept for commands
   * someone waits on free, e.g. for a sync.
   */
  async read(
    hostId: string,
    { background = false }: { background?: boolean } = {}
  ): Promise<string[]> {
    const host = sshWorkspaceService.getHost(hostId);
    const directory = joinRemote(
      await sshWorkspaceService.resolveWorkspaceBasePath(hostId),
      SSH_WORKSPACE_MANIFEST_DIRECTORY
    );
    const output = await sshWorkspaceService.run(
      host,
      [
        `directory=${shellQuotePosix(directory)}`,
        '[ -d "$directory" ] || exit 0',
        'for manifest in "$directory"/*.json; do',
        '  [ -f "$manifest" ] || continue',
        '  id=${manifest##*/}',
        // One written while another installation deleted the workspace.
        `  [ -e "$directory/${SSH_WORKSPACE_TOMBSTONE_DIRECTORY}/\${id%.json}" ] && continue`,
        '  size=$(wc -c < "$manifest" | tr -d " ")',
        `  [ "$size" -le ${MAX_SSH_WORKSPACE_MANIFEST_BYTES} ] || continue`,
        '  base64 < "$manifest" | tr -d "\\n"',
        '  printf "\\n"',
        'done',
      ].join('\n'),
      { purpose: { kind: background ? 'background' : 'interactive' } }
    );
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => Buffer.from(line, 'base64').toString('utf8'));
  },

  /** The Terminals among `terminalIds` whose sessions run on the host. */
  findTerminalSessions(backend: SshWorkspaceBackend, terminalIds: string[]): Promise<Set<string>> {
    return sshWorkspaceService.findTerminalSessions(backend, terminalIds);
  },

  hasHost(hostId: string): boolean {
    return sshWorkspaceService.hasHost(hostId);
  },

  readyHosts(): string[] {
    return sshHostService
      .list()
      .filter((host) => !host.setupPending)
      .map((host) => host.id);
  },

  basePath(hostId: string): Promise<string> {
    return sshWorkspaceService.resolveWorkspaceBasePath(hostId);
  },
} satisfies SshWorkspaceSyncHost;
