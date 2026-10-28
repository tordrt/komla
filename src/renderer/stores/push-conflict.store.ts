import { create } from 'zustand';

export type PushConflictResolution = 'pull-and-push' | 'rebase-and-push' | 'cancel';

export interface PushConflictOptions {
  allowRebase?: boolean;
}

interface PushConflict {
  message: string;
  options: PushConflictOptions;
  settle: (resolution: PushConflictResolution) => void;
}

interface PushConflictState {
  conflict: PushConflict | null;
  requestResolution: (
    message: string,
    options?: PushConflictOptions
  ) => Promise<PushConflictResolution>;
  resolve: (resolution: PushConflictResolution) => void;
}

export const usePushConflictStore = create<PushConflictState>((set, get) => ({
  conflict: null,

  requestResolution: (message: string, options: PushConflictOptions = {}) => {
    const { conflict } = get();
    if (conflict) {
      conflict.settle('cancel');
    }
    return new Promise<PushConflictResolution>((settle) => {
      set({
        conflict: { message, options, settle },
      });
    });
  },

  resolve: (resolution: PushConflictResolution) => {
    const { conflict } = get();
    if (conflict) {
      conflict.settle(resolution);
      set({ conflict: null });
    }
  },
}));
