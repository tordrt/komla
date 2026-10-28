export interface IpcValidationIssue {
  path: string;
  message: string;
}

export interface IpcValidationError extends Error {
  code: 'IPC_VALIDATION_ERROR';
  channel: string;
  issues: IpcValidationIssue[];
}

export function createIpcValidationError(
  channel: string,
  issues: IpcValidationIssue[]
): IpcValidationError {
  const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  const message = `IPC validation failed for ${channel}${details ? ` (${details})` : ''}`;

  const err = new Error(message) as IpcValidationError;
  err.name = 'IpcValidationError';
  err.code = 'IPC_VALIDATION_ERROR';
  err.channel = channel;
  err.issues = issues;
  return err;
}
