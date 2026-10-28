/**
 * Monaco editor internal errors that surface as uncaught exceptions but have
 * no user-visible impact. These are async race conditions in Monaco's teardown
 * path — debounced events fire after the editor instance is already disposed.
 */
const SUPPRESSED_ERROR_MESSAGES = [
  // Monaco disposes the text model before pending diff/validation callbacks complete
  'TextModel got disposed',
  // Diff editor teardown races with an in-flight async diff computation
  'no diff result available',
  // Debounced menu/toolbar update fires after the editor's context key service is torn down
  'AbstractContextKeyService has been disposed',
];

export function shouldSuppressRendererError(error: Error): boolean {
  if (SUPPRESSED_ERROR_MESSAGES.some((message) => error.message.includes(message))) {
    return true;
  }

  return error.name === 'Canceled' && error.message === 'Canceled';
}
