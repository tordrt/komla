import type { NewWorkspaceDialogAction } from '../../shared/constants/shortcut-scopes';

export interface ShortcutEntry {
  action: string;
  label: string;
  group: string;
  /** If set, renders a condensed "1 ... 9" range row instead of a single key badge */
  rangeActions?: { first: string; last: string };
}

/** Shortcuts that act only in the new workspace dialog. */
export const NEW_WORKSPACE_SHORTCUTS_GROUP = 'New workspace dialog';

const NEW_WORKSPACE_DIALOG_LABELS: Record<NewWorkspaceDialogAction, string> = {
  cycleAgent: 'Next agent',
  cycleLaunchMode: 'Next launch mode',
  cycleEffort: 'Next effort level',
  cycleProject: 'Next project',
  cycleEnvironment: 'Next environment',
  agentMenu: 'Open agent menu',
  effortMenu: 'Open effort menu',
  environmentMenu: 'Open environment menu',
  branchMenu: 'Open branch menu',
  projectSearch: 'Search projects',
};

export const shortcutEntries: ShortcutEntry[] = [
  { action: 'commandCenter.open', label: 'Command center', group: 'Workspace' },
  { action: 'workspace.overview', label: 'Overview', group: 'Workspace' },
  { action: 'workspace.new', label: 'New workspace', group: 'Workspace' },
  { action: 'workspace.openFolder', label: 'Open folder', group: 'Workspace' },
  { action: 'workspace.stop', label: 'Stop workspace', group: 'Workspace' },
  { action: 'workspace.trash', label: 'Move workspace to Trash', group: 'Workspace' },
  { action: 'workspace.delete', label: 'Delete workspace permanently', group: 'Workspace' },
  { action: 'workspace.next', label: 'Next workspace', group: 'Workspace' },
  { action: 'workspace.previous', label: 'Previous workspace', group: 'Workspace' },
  { action: 'workspace.nextAttention', label: 'Next workspace needing input', group: 'Workspace' },
  {
    action: 'workspace.select.1',
    label: 'Go to workspace 1–9',
    group: 'Workspace',
    rangeActions: { first: 'workspace.select.1', last: 'workspace.select.9' },
  },
  { action: 'sidebar.toggle', label: 'Toggle sidebar', group: 'Workspace' },
  { action: 'diff.toggle', label: 'Toggle diff viewer', group: 'Workspace' },
  { action: 'history.toggle', label: 'Toggle commit history', group: 'Workspace' },
  { action: 'tab.newAgent', label: 'New agent tab', group: 'Terminal' },
  { action: 'terminal.new', label: 'New terminal tab', group: 'Terminal' },
  { action: 'terminal.scrollToBottom', label: 'Scroll to bottom', group: 'Terminal' },
  { action: 'terminal.search', label: 'Find in terminal', group: 'Terminal' },
  { action: 'tab.next', label: 'Next tab', group: 'Terminal' },
  { action: 'tab.previous', label: 'Previous tab', group: 'Terminal' },
  { action: 'pane.close', label: 'Close pane', group: 'Terminal' },
  { action: 'pane.splitRight', label: 'Split right', group: 'Terminal' },
  { action: 'pane.splitDown', label: 'Split down', group: 'Terminal' },
  { action: 'pane.focusNext', label: 'Focus next pane', group: 'Terminal' },
  { action: 'pane.focusPrev', label: 'Focus previous pane', group: 'Terminal' },
  { action: 'file.open', label: 'Search files', group: 'File' },
  { action: 'file.tree', label: 'File tree viewer', group: 'File' },
  { action: 'inline.file.tree', label: 'Toggle file tree panel', group: 'File' },
  { action: 'note.new', label: 'New note', group: 'File' },
  { action: 'voice.record', label: 'Toggle voice input', group: 'Voice' },
  ...Object.entries(NEW_WORKSPACE_DIALOG_LABELS).map(([action, label]) => ({
    action: `newWorkspace.${action}`,
    label,
    group: NEW_WORKSPACE_SHORTCUTS_GROUP,
  })),
];

export const groupOrder = ['Workspace', NEW_WORKSPACE_SHORTCUTS_GROUP, 'Terminal', 'File', 'Voice'];
