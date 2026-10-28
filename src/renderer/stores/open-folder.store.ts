import { create } from 'zustand';

/** How a folder in a Git repository picked with Open Folder opens. */
export type GitRepoFolderChoice = 'project' | 'folder';

interface OpenFolderState {
  open: boolean;
  /** The folder and its repository asked about; kept after closing so the text doesn't blank out. */
  folder: string;
  repoRoot: string;
  resolve: ((choice: GitRepoFolderChoice | null) => void) | null;
  /** Resolves with the choice, or null when the question is dismissed. */
  askHowToOpenGitRepo: (folder: string, repoRoot: string) => Promise<GitRepoFolderChoice | null>;
  answer: (choice: GitRepoFolderChoice | null) => void;
}

export const useOpenFolderStore = create<OpenFolderState>((set, get) => ({
  open: false,
  folder: '',
  repoRoot: '',
  resolve: null,

  askHowToOpenGitRepo: (folder, repoRoot) => {
    // A newer question supersedes one still waiting for an answer.
    get().resolve?.(null);
    return new Promise((resolve) => set({ open: true, folder, repoRoot, resolve }));
  },

  answer: (choice) => {
    const { resolve } = get();
    set({ open: false, resolve: null });
    resolve?.(choice);
  },
}));
