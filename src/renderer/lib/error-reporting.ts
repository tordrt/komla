type ErrorReportType = Parameters<typeof window.api.reportError>[0]['type'];

export function reportError(
  error: Error,
  type: ErrorReportType,
  context?: Record<string, unknown>
): void {
  // Explicitly handle async rejection to avoid unhandledrejection loops.
  void window.api
    .reportError({
      message: error.message,
      stack: error.stack,
      type,
      context,
    })
    .catch(() => {
      // Silent fail - don't crash on error reporting errors
    });
}
