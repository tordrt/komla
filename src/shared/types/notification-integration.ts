/** User-reviewable changes to an existing local notification integration. */
export interface NotificationIntegrationUpdate {
  files: { path: string; description: string }[];
}

/** An update to a notification integration on an SSH host. */
export interface RemoteNotificationIntegrationUpdate extends NotificationIntegrationUpdate {
  /** The notification configuration Komla will install. */
  preview: string;
}
