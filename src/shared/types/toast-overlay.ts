// Browser previews are native views drawn above the main window's DOM. Toasts
// that overlap one are mirrored into a transparent view drawn above it instead
// (src/renderer/toast-overlay.html), so the page underneath stays live.

/** Longer toast messages are cut to this before they are sent to the overlay. */
export const TOAST_OVERLAY_MESSAGE_MAX_LENGTH = 100_000;

export interface ToastOverlayToast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  actionLabel?: string;
  dismissOnTimeout: boolean;
  progress?: boolean;
  quiet?: boolean;
}

export interface ToastOverlayContent {
  toasts: ToastOverlayToast[];
  /** The main window's root class and inline style, which carry its theme. */
  themeClassName: string;
  themeStyle: string;
  /** The main window caps long messages at 40% of its height. */
  messageMaxHeight: number;
}

export interface ToastOverlayState extends ToastOverlayContent {
  /** Where the main window lays out its toast stack, in its CSS pixels. */
  bounds: { x: number; y: number; width: number; height: number };
}

/** Dismissing a toast or clicking its action in the overlay, applied by the main window. */
export interface ToastOverlayEvent {
  type: 'remove' | 'action';
  id: string;
}
