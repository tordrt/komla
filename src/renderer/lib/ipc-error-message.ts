/** A main-process error's own message, without Electron's "Error invoking remote method '<channel>': Error: " prefix. */
export function ipcErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ''
  );
}
