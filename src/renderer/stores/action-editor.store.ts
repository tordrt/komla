import { create } from 'zustand';

/** What the shared Action editor opens on: an existing Action, or a new one. */
export interface ActionEditorRequest {
  /** The Action to edit; null creates a new one. */
  actionId: string | null;
  /** Projects a new Action starts scoped to. Empty means every project. */
  projectIds?: string[];
  /** Settings has no workspace to imply a scope from, so it opens Advanced up front. */
  advancedOpen?: boolean;
  /** Where focus goes on close when what opened the editor is gone, such as a menu item. */
  returnFocus?: () => void;
}

interface ActionEditorState {
  request: ActionEditorRequest | null;
  /** Bumped on every open so a reopened editor starts from a fresh draft. */
  openCount: number;
  /** The Action waiting for delete confirmation. */
  pendingDeleteId: string | null;
  openActionEditor: (request: ActionEditorRequest) => void;
  closeActionEditor: () => void;
  requestActionDelete: (id: string) => void;
  cancelActionDelete: () => void;
}

// One editor for the tab bar, terminal menus and Settings; ActionEditorHost renders it.
export const useActionEditorStore = create<ActionEditorState>((set) => ({
  request: null,
  openCount: 0,
  pendingDeleteId: null,
  openActionEditor: (request) => set((state) => ({ request, openCount: state.openCount + 1 })),
  closeActionEditor: () => set({ request: null }),
  requestActionDelete: (id) => set({ pendingDeleteId: id }),
  cancelActionDelete: () => set({ pendingDeleteId: null }),
}));

export function openActionEditor(request: ActionEditorRequest): void {
  useActionEditorStore.getState().openActionEditor(request);
}

/** Opens the editor on a new Action, scoped to the workspace's project when there is one. */
export function openNewActionEditor(
  projectId: string | null | undefined,
  returnFocus?: () => void
): void {
  openActionEditor({ actionId: null, projectIds: projectId ? [projectId] : [], returnFocus });
}
