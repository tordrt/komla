import type { SshHostCapabilities } from '../../shared/types/ssh';

/**
 * Whether a Local copy can't run for an SSH host from this computer: Windows has no Local copy,
 * and it needs rsync on both ends. A host whose capabilities were never checked isn't ruled out.
 */
export function localCopyUnsupported(capability?: SshHostCapabilities['localCopy']): boolean {
  return (
    process.platform === 'win32' ||
    capability?.platform === 'unsupported' ||
    capability?.localRsync === 'missing' ||
    capability?.remoteRsync === 'missing'
  );
}
