import { shellQuotePosix } from '../../../shared/lib/shell-quote';
import { joinRemote, sshWorkspaceService } from '../ssh-workspace.service';

import {
  isSshProjectManifestId,
  MAX_SSH_PROJECT_MANIFEST_BYTES,
  SSH_PROJECT_MANIFEST_DIRECTORY,
} from './project-manifest';

import type { SshProjectSyncHost } from './ssh-project-sync';

async function manifestDirectory(hostId: string): Promise<string> {
  return joinRemote(
    await sshWorkspaceService.resolveWorkspaceBasePath(hostId),
    SSH_PROJECT_MANIFEST_DIRECTORY
  );
}

/** The Project manifests on SSH hosts, read and written over SSH. */
export const sshProjectSyncHost = {
  /** Returns the raw text of every Project manifest on the host by id; empty for oversized ones. */
  async read(hostId, { background }) {
    const output = await sshWorkspaceService.run(
      sshWorkspaceService.getHost(hostId),
      [
        `directory=${shellQuotePosix(await manifestDirectory(hostId))}`,
        '[ -d "$directory" ] || exit 0',
        'for manifest in "$directory"/*.json; do',
        '  [ -f "$manifest" ] || continue',
        '  id=${manifest##*/}',
        '  printf "%s " "${id%.json}"',
        '  size=$(wc -c < "$manifest" | tr -d " ")',
        // Listed without its text, so it isn't taken for missing and written over.
        `  [ "$size" -le ${MAX_SSH_PROJECT_MANIFEST_BYTES} ] || { printf "\\n"; continue; }`,
        '  base64 < "$manifest" | tr -d "\\n"',
        '  printf "\\n"',
        'done',
      ].join('\n'),
      { purpose: { kind: background ? 'background' : 'interactive' } }
    );
    const manifests = new Map<string, string>();
    for (const line of output.split('\n')) {
      const [id = '', encoded = ''] = line.trim().split(' ');
      if (!isSshProjectManifestId(id)) continue;
      manifests.set(id, Buffer.from(encoded, 'base64').toString('utf8'));
    }
    return manifests;
  },

  async write(hostId, manifestId, content) {
    if (!isSshProjectManifestId(manifestId)) {
      throw new Error(`Invalid SSH project manifest id ${manifestId}`);
    }
    await sshWorkspaceService.writeRemoteText(
      sshWorkspaceService.getHost(hostId),
      joinRemote(await manifestDirectory(hostId), `${manifestId}.json`),
      content
    );
  },

  hasHost(hostId) {
    return sshWorkspaceService.hasHost(hostId);
  },
} satisfies SshProjectSyncHost;
