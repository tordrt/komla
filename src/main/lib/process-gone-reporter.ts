import { errorReportingService } from '../services/error-reporting.service';

import type { Logger } from './logger';

interface ChildProcessGoneDetails {
  type: string;
  reason: string;
  exitCode: number;
  // Windows only: GetLastError() of a launch-failed child.
  systemErrorCode?: number;
  name?: string;
}

export function reportChildProcessGone(details: ChildProcessGoneDetails, logger: Logger): void {
  if (details.reason === 'clean-exit') return;
  logger.error('Child process gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    ...(details.systemErrorCode !== undefined && { systemErrorCode: details.systemErrorCode }),
    name: details.name,
  });
  const systemError =
    details.systemErrorCode !== undefined ? `, systemErrorCode ${details.systemErrorCode}` : '';
  const error = new Error(
    `Child process gone: ${details.type} ${details.reason} (exitCode ${details.exitCode}${systemError})`
  );
  void errorReportingService.report(error, 'processGone', {
    processType: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
  });
}
