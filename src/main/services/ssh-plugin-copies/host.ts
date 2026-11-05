import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { configService } from '../config.service';
import { joinRemote, sshWorkspaceService } from '../ssh-workspace.service';

import type { SshPluginCopiesDependencies } from './ssh-plugin-copies';

/** Long enough to copy a plugin of the largest size Komla runs over a slow connection. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** This installation's folder among the host's copies, so each removes only its own. */
function installationFolder(): string {
  const id = configService.getWorkspaceSyncDeviceId();
  return /^[A-Za-z0-9-]{1,64}$/.test(id)
    ? id
    : createHash('sha256').update(id).digest('hex').slice(0, 32);
}

/** Plugins' copies on SSH hosts, in the host's Komla folder, over Komla's own SSH connections. */
export const sshPluginCopyHost = {
  root: async (hostId) =>
    joinRemote(
      await sshWorkspaceService.resolveWorkspaceBasePath(hostId),
      'plugins',
      installationFolder()
    ),
  run: (hostId, script) =>
    sshWorkspaceService.run(sshWorkspaceService.getHost(hostId), script, {
      purpose: { kind: 'background' },
    }),
  upload: async (hostId, script, archive) => {
    const folder = await mkdtemp(join(tmpdir(), 'komla-plugin-'));
    try {
      const path = join(folder, 'plugin.tar');
      await writeFile(path, archive, { mode: 0o600 });
      return await sshWorkspaceService.runWithFileInput(
        sshWorkspaceService.getHost(hostId),
        script,
        path,
        { purpose: { kind: 'background' }, timeout: UPLOAD_TIMEOUT_MS }
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
} satisfies Pick<SshPluginCopiesDependencies, 'root' | 'run' | 'upload'>;
