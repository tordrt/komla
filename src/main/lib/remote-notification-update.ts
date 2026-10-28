import type { RemoteNotificationIntegrationUpdate } from '../../shared/types/notification-integration';

/** An update to Komla's hooks in an agent settings file on an SSH host. */
export function remoteHookUpdate(
  path: string,
  hooks: Record<string, unknown[]>,
  otherFiles: { path: string; description: string }[] = []
): RemoteNotificationIntegrationUpdate {
  return {
    files: [
      {
        path,
        description:
          'Update Komla notification hooks to the current Komla CLI and events. Other hooks and settings are preserved.',
      },
      ...otherFiles,
    ],
    preview: JSON.stringify({ hooks }, null, 2),
  };
}

/** An update to Komla's OpenCode notification plugin on an SSH host. */
export function remotePluginUpdate(
  path: string,
  plugin: string
): RemoteNotificationIntegrationUpdate {
  return {
    files: [
      {
        path,
        description:
          'Replace this Komla notification plugin with the current Komla CLI integration. Any manual edits to this file will be replaced.',
      },
    ],
    preview: plugin,
  };
}
