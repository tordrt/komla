import { create } from 'zustand';

/** A place the prompt draft can show: the window, or a viewer that covers it. */
interface PromptDraftHost {
  id: string;
  /** The workspace the draft refers to while it shows there, for the file on screen. */
  workspaceId: string | null;
}

interface PromptDraftState {
  /** The draft, one per window across its workspaces, kept until copied over or Komla quits. */
  text: string;
  isOpen: boolean;
  /** Copied and closed since it last showed: it shows next with its text selected, to type over. */
  copied: boolean;
  /** Where the draft can show, the one on top last: the draft shows only there. */
  hosts: PromptDraftHost[];
  /** Whether the draft takes focus once it shows. */
  focusRequested: boolean;
  setText: (text: string) => void;
  /** Shows the draft and gives it focus. */
  show: () => void;
  /** Hides the draft; its text stays. */
  hide: (options?: { copied?: boolean }) => void;
  clearFocusRequest: () => void;
  clearCopied: () => void;
  addHost: (id: string, workspaceId: string | null) => void;
  updateHost: (id: string, workspaceId: string | null) => void;
  removeHost: (id: string) => void;
}

export const usePromptDraftStore = create<PromptDraftState>((set, get) => ({
  text: '',
  isOpen: false,
  copied: false,
  hosts: [],
  focusRequested: false,
  setText: (text) => set({ text }),
  show: () => set({ isOpen: true, focusRequested: true }),
  hide: ({ copied = false } = {}) => {
    if (!get().isOpen) return;
    set({ isOpen: false, focusRequested: false, copied });
  },
  clearFocusRequest: () => set({ focusRequested: false }),
  clearCopied: () => set({ copied: false }),
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

/** The workspace the draft shows over now, whose file it refers to; without one it can't show. */
export function selectPromptDraftWorkspace(state: PromptDraftState): string | null {
  return state.hosts.at(-1)?.workspaceId ?? null;
}
