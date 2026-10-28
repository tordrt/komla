/**
 * Global shortcut action dispatcher.
 *
 * This module provides a way to register and execute shortcut actions from anywhere
 * in the app. It's used to handle keyboard shortcuts when xterm captures key events,
 * allowing TerminalView to execute actions directly instead of relying on event bubbling.
 *
 * Components register handlers on mount, TerminalView calls executeShortcutAction() directly.
 */

type ActionHandler = (event?: KeyboardEvent) => void;

const actionHandlers = new Map<string, ActionHandler>();

/**
 * Register a shortcut action handler.
 *
 * @param id - The action ID (e.g., 'workspace.next', 'pane.close')
 * @param handler - Function to execute when the action is triggered
 * @returns Cleanup function to unregister the handler
 *
 * @example
 * useEffect(() => {
 *   return registerShortcutAction('workspace.next', () => selectNextWorkspace())
 * }, [selectNextWorkspace])
 */
export function registerShortcutAction(id: string, handler: ActionHandler): () => void {
  actionHandlers.set(id, handler);
  return () => {
    actionHandlers.delete(id);
  };
}

/**
 * Execute a registered shortcut action.
 *
 * @param id - The action ID to execute
 * @returns true if the action was found and executed, false otherwise
 *
 * @example
 * // In TerminalView's custom key handler:
 * const matchedAction = findMatchingAction(event)
 * if (matchedAction) {
 *   executeShortcutAction(matchedAction)
 *   return false // Prevent xterm from handling
 * }
 */
export function executeShortcutAction(id: string, event?: KeyboardEvent): boolean {
  const handler = actionHandlers.get(id);
  if (handler) {
    handler(event);
    return true;
  }
  return false;
}

/**
 * Check if an action handler is registered.
 *
 * @param id - The action ID to check
 * @returns true if a handler is registered for this action
 */
export function hasShortcutAction(id: string): boolean {
  return actionHandlers.has(id);
}
