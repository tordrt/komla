import { createLogger } from '../../lib/logger';
import { askpassService } from '../../services/askpass.service';

const logger = createLogger('AskpassHandlers');

/**
 * Register IPC handlers for SSH passphrase prompting.
 *
 * The askpass:request event is sent from main to renderer when a passphrase is needed.
 * The askpass:response event is sent from renderer to main with the passphrase.
 *
 * These are handled directly by AskpassService, but we register the response
 * handler here for organization purposes.
 */
export function registerAskpassHandlers(): void {
  // Start the askpass service when the app starts
  // This ensures the socket is ready before any git operations
  askpassService.start().catch((err) => {
    logger.error('Failed to start askpass service', err);
  });

  // The askpass:response handler is registered in AskpassService.start()
  // because it needs access to the pending requests map.
  // We just need to ensure the service is started here.

  logger.info('Askpass handlers registered');
}

/**
 * Unregister askpass handlers and stop the service.
 * Call this when the app is shutting down.
 */
export function unregisterAskpassHandlers(): void {
  askpassService.stop();
  logger.info('Askpass handlers unregistered');
}
