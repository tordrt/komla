import { create } from 'zustand';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  action?: ToastAction;
  dismissOnTimeout?: boolean;
  /** The work it reports is still running, so it shows a spinner instead of its icon. */
  progress?: boolean;
  /**
   * A small neutral note with no icon or close button, for routine news such as an undoable
   * launch. Success toasts default to it.
   */
  quiet?: boolean;
}

interface ToastState {
  toasts: Toast[];
  addToast: (
    message: string,
    type: 'success' | 'error' | 'info',
    options?: {
      action?: ToastAction;
      dismissOnTimeout?: boolean;
      progress?: boolean;
      quiet?: boolean;
    }
  ) => string;
  removeToast: (id: string) => void;
}

/** Older toasts beyond this are dropped so a burst can't fill the screen. */
const MAX_VISIBLE_TOASTS = 4;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (message, type, options) => {
    const id = Math.random().toString(36).slice(2);
    // Plain errors stay until dismissed. ToastItem owns the timer so it can
    // pause on hover/focus and play its exit animation before removal.
    const dismissOnTimeout =
      options?.dismissOnTimeout ?? !(type === 'error' && options?.action === undefined);
    // A success is routine, so it stays small. One that waits to be dismissed keeps the
    // close button the quiet style drops.
    const quiet = options?.quiet ?? (type === 'success' && dismissOnTimeout);
    set((state) => ({
      toasts: [
        ...state.toasts,
        {
          id,
          message,
          type,
          action: options?.action,
          dismissOnTimeout,
          progress: options?.progress,
          quiet,
        },
      ].slice(-MAX_VISIBLE_TOASTS),
    }));
    return id;
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
}));
