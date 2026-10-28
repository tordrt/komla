/** The status bar item that shows the branch's pull request; it notifies only while shown. */
export const PULL_REQUEST_STATUS_ITEM = 'pull-request';

/** Checks still running after this stop being watched. */
export const CI_WATCH_LIMIT_MS = 3 * 60 * 60_000;

/** Whether the end of a pull request's checks notifies its workspace: while its item shows. */
export function notifiesCiFinished(config: {
  showStatusBar?: boolean;
  statusBarHiddenItems?: readonly string[];
  pullRequestCiNotifications?: boolean;
}): boolean {
  return (
    config.showStatusBar !== false &&
    config.statusBarHiddenItems?.includes(PULL_REQUEST_STATUS_ITEM) !== true &&
    config.pullRequestCiNotifications !== false
  );
}
