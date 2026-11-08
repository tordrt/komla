// Actions under this prefix act only while the new workspace dialog is open,
// so they may reuse keys that do something else in the rest of the app.
const NEW_WORKSPACE_DIALOG_PREFIX = 'newWorkspace.';

/** The new workspace dialog's own shortcut actions, without their `newWorkspace.` prefix. */
export const NEW_WORKSPACE_DIALOG_ACTIONS = [
  'cycleAgent',
  'cycleLaunchMode',
  'cycleEffort',
  'cycleProject',
  'cycleEnvironment',
  'agentMenu',
  'effortMenu',
  'environmentMenu',
  'branchMenu',
  'projectSearch',
] as const;

export type NewWorkspaceDialogAction = (typeof NEW_WORKSPACE_DIALOG_ACTIONS)[number];

// The app-wide action the dialog also answers to: New workspace, pressed
// again, searches projects.
const ALSO_IN_NEW_WORKSPACE_DIALOG = /^workspace\.new$/;

export function isNewWorkspaceDialogShortcut(action: string): boolean {
  return action.startsWith(NEW_WORKSPACE_DIALOG_PREFIX);
}

/** Actions that answer to their keys in any app, not only while a Komla window has focus. */
export const GLOBAL_SHORTCUT_ACTIONS = ['workspace.newFromAnywhere'] as const;

export function isGlobalShortcut(action: string): boolean {
  return (GLOBAL_SHORTCUT_ACTIONS as readonly string[]).includes(action);
}

/**
 * Whether a double tap of a modifier can be the action's keys: not in the new workspace dialog,
 * nor in other apps.
 */
export function takesDoubleTap(action: string): boolean {
  return !isNewWorkspaceDialogShortcut(action) && !isGlobalShortcut(action);
}

// The main process catches these keys before any page sees them, so they act
// even while the dialog is open.
const CAUGHT_BEFORE_THE_PAGE = new Set<string>(['pane.close', ...GLOBAL_SHORTCUT_ACTIONS]);

/** Whether both actions can be pressed in the same place, so must not share keys. */
export function shortcutsShareScope(a: string, b: string): boolean {
  if (CAUGHT_BEFORE_THE_PAGE.has(a) || CAUGHT_BEFORE_THE_PAGE.has(b)) return true;
  const aInDialog = isNewWorkspaceDialogShortcut(a);
  if (aInDialog === isNewWorkspaceDialogShortcut(b)) return true;
  return ALSO_IN_NEW_WORKSPACE_DIALOG.test(aInDialog ? b : a);
}
