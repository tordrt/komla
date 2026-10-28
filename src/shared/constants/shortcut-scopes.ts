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

// App-wide actions the dialog also answers to: New workspace, pressed again,
// searches projects, and Go to workspace 1–9 picks a project.
const ALSO_IN_NEW_WORKSPACE_DIALOG = /^workspace\.(new|select\.[1-9])$/;

export function isNewWorkspaceDialogShortcut(action: string): boolean {
  return action.startsWith(NEW_WORKSPACE_DIALOG_PREFIX);
}

// The main process catches these keys before any page sees them, so they act
// even while the dialog is open.
const CAUGHT_BEFORE_THE_PAGE = new Set(['pane.close']);

/** Whether both actions can be pressed in the same place, so must not share keys. */
export function shortcutsShareScope(a: string, b: string): boolean {
  if (CAUGHT_BEFORE_THE_PAGE.has(a) || CAUGHT_BEFORE_THE_PAGE.has(b)) return true;
  const aInDialog = isNewWorkspaceDialogShortcut(a);
  if (aInDialog === isNewWorkspaceDialogShortcut(b)) return true;
  return ALSO_IN_NEW_WORKSPACE_DIALOG.test(aInDialog ? b : a);
}
