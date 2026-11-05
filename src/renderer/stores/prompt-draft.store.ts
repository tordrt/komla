import { create } from 'zustand';

/** A place the prompt draft can show: the window, or a viewer that covers it. */
interface PromptDraftHost {
  id: string;
  /** The workspace whose draft shows there. */
  workspaceId: string | null;
}

interface PromptDraftState {
  /** Each workspace's draft, kept until cleared or Komla quits. */
  textByWorkspace: Record<string, string>;
  openByWorkspace: Record<string, boolean>;
  /** Where the draft can show, the one on top last: the draft shows only there. */
  hosts: PromptDraftHost[];
  /** The workspace whose draft takes focus once it shows. */
  focusRequest: { workspaceId: string } | null;
  setText: (workspaceId: string, text: string) => void;
  /** Shows the workspace's draft and gives it focus. */
  open: (workspaceId: string) => void;
  /** Hides the workspace's draft; its text stays. */
  close: (workspaceId: string) => void;
  clearFocusRequest: () => void;
  addHost: (id: string, workspaceId: string | null) => void;
  updateHost: (id: string, workspaceId: string | null) => void;
  removeHost: (id: string) => void;
}

export const usePromptDraftStore = create<PromptDraftState>((set, get) => ({
  textByWorkspace: {},
  openByWorkspace: {},
  hosts: [],
  focusRequest: null,
  setText: (workspaceId, text) =>
    set((state) => ({ textByWorkspace: { ...state.textByWorkspace, [workspaceId]: text } })),
  open: (workspaceId) =>
    set((state) => ({
      openByWorkspace: { ...state.openByWorkspace, [workspaceId]: true },
      focusRequest: { workspaceId },
    })),
  close: (workspaceId) => {
    if (!get().openByWorkspace[workspaceId]) return;
    set((state) => ({
      openByWorkspace: { ...state.openByWorkspace, [workspaceId]: false },
      focusRequest: state.focusRequest?.workspaceId === workspaceId ? null : state.focusRequest,
    }));
  },
  clearFocusRequest: () => set({ focusRequest: null }),
  addHost: (id, workspaceId) =>
    set((state) => ({
      hosts: [...state.hosts.filter((host) => host.id !== id), { id, workspaceId }],
    })),
  updateHost: (id, workspaceId) => {
    if (get().hosts.find((host) => host.id === id)?.workspaceId === workspaceId) return;
    set((state) => ({
      hosts: state.hosts.map((host) => (host.id === id ? { id, workspaceId } : host)),
    }));
  },
  removeHost: (id) => set((state) => ({ hosts: state.hosts.filter((host) => host.id !== id) })),
}));

/** The workspace whose draft the shortcut acts on: the one the draft would show for now. */
export function selectPromptDraftWorkspace(state: PromptDraftState): string | null {
  return state.hosts.at(-1)?.workspaceId ?? null;
}
