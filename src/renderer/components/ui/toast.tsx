import { Check, Copy, Info, WarningCircle, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { nativeViewRects, rectsIntersect } from '@/lib/native-view-layout';
import { Toast, useToastStore } from '@/stores/toast.store';

import { TOAST_OVERLAY_MESSAGE_MAX_LENGTH } from '../../../shared/types';

import type { ToastOverlayState } from '../../../shared/types';
import type { CSSProperties } from 'react';

type ToastPlacement = 'right' | 'left' | 'over-native-view';

interface ToastItemProps {
  toast: Toast;
  /** The overlay layer shows this toast, so this copy only holds its place and doesn't count down. */
  mirrored?: boolean;
  /** Rendered in the overlay layer, whose page is only as big as the toast stack. */
  overlay?: { messageMaxHeight: number; onRemove: (id: string) => void };
}

// The overlay layer can't blur the browser preview behind it (on macOS each
// view is a separate layer), so its toasts tint the surface menus use instead,
// and they take the stack's width, which the main window has already capped.
function overlaySurface(isError: boolean): CSSProperties {
  const tint = isError ? '--destructive' : '--primary';
  return {
    maxWidth: 'none',
    backgroundColor: `color-mix(in oklch, oklch(var(${tint})) 10%, oklch(var(--popover)))`,
  };
}

export function ToastItem({ toast, mirrored = false, overlay }: ToastItemProps) {
  const removeFromStore = useToastStore((s) => s.removeToast);
  const removeToast = overlay?.onRemove ?? removeFromStore;
  const [exiting, setExiting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused || mirrored;
  const duration = toast.action ? 7000 : toast.type === 'error' ? 8000 : 3000;
  const toastRef = useRef<HTMLDivElement>(null);
  const exitingRef = useRef(false);
  const remainingRef = useRef(duration);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setExiting(true);
    setTimeout(() => removeToast(toast.id), 200);
  }, [removeToast, toast.id]);

  // Count down only while the toast is neither hovered nor focused, resuming
  // with whatever time was left when it was paused.
  useEffect(() => {
    if (toast.dismissOnTimeout === false || paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(dismiss, remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [dismiss, paused, toast.dismissOnTimeout]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const element = toastRef.current;
    if (!element) return;

    const preventLayerDismiss = (event: Event) => {
      event.preventDefault();
    };

    element.addEventListener('dismissableLayer.pointerDownOutside', preventLayerDismiss, true);
    element.addEventListener('dismissableLayer.focusOutside', preventLayerDismiss, true);
    return () => {
      element.removeEventListener('dismissableLayer.pointerDownOutside', preventLayerDismiss, true);
      element.removeEventListener('dismissableLayer.focusOutside', preventLayerDismiss, true);
    };
  }, []);

  const isError = toast.type === 'error';

  // Copying is usually the last thing done with an error, so the toast closes
  // once the check mark has had a moment to show. One with an action stays
  // open, since its button may still be needed.
  const copyMessage = () => {
    window.api.copyToClipboard(toast.message);
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = toast.action
      ? setTimeout(() => setCopied(false), 1500)
      : setTimeout(dismiss, 600);
  };

  return (
    <div
      ref={toastRef}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      className={`toast-enter ${exiting ? 'toast-exit' : ''} no-drag ${mirrored ? '' : 'pointer-events-auto'} relative flex max-w-[min(70vw,560px)] items-center overflow-hidden border text-foreground shadow-soft-lg backdrop-blur-xl ${
        toast.quiet
          ? // A pill keeps its own width at the stack's outer edge, beside wider toasts. Its
            // radius rounds one line fully without clipping a message that wraps.
            `gap-3 self-end rounded-2xl py-1 pl-3.5 text-xs [.toast-stack-left_&]:self-start ${toast.action ? 'pr-1' : 'pr-3.5'}`
          : 'gap-2.5 rounded-lg py-2.5 pr-3.5 pl-4 text-[13px] font-medium'
      } ${isError ? 'toast-surface-error border-destructive/20 bg-destructive/10' : 'toast-surface border-primary/20 bg-primary/10'} `}
      style={overlay && overlaySurface(isError)}
    >
      {!toast.quiet && (
        <>
          {/* Left accent bar */}
          <div
            className={`absolute top-0 bottom-0 left-0 w-[3px] rounded-l-lg ${isError ? 'bg-error/60' : 'bg-primary/60'}`}
          />
          <div className={`shrink-0 ${isError ? 'text-error' : 'text-primary'}`}>
            {toast.progress ? (
              <Spinner />
            ) : toast.type === 'info' ? (
              <Info className="size-4" weight="fill" />
            ) : isError ? (
              <WarningCircle className="size-4" weight="fill" />
            ) : (
              <Check className="size-4" weight="bold" />
            )}
          </div>
        </>
      )}

      <span
        className="max-h-[40vh] min-w-0 flex-1 cursor-text overflow-y-auto leading-snug break-words whitespace-pre-wrap select-text"
        style={overlay && { maxHeight: overlay.messageMaxHeight }}
      >
        {toast.message}
      </span>

      {toast.action && (
        <button
          onClick={() => {
            toast.action?.onClick();
            dismiss();
          }}
          className={`shrink-0 text-xs font-semibold transition-colors ${
            toast.quiet ? 'rounded-full px-2.5 py-1' : 'rounded-md px-2 py-0.5'
          } ${
            isError
              ? 'bg-error/15 text-error hover:bg-error/25'
              : 'bg-primary/15 text-primary hover:bg-primary/25'
          } `}
        >
          {toast.action.label}
        </button>
      )}

      {isError && (
        <button
          onClick={copyMessage}
          className="shrink-0 rounded-md p-0.5 opacity-60 transition-opacity hover:opacity-100"
          title={copied ? 'Copied' : 'Copy error message'}
          aria-label={copied ? 'Copied error message' : 'Copy error message'}
        >
          {copied ? <Check className="size-3.5" weight="bold" /> : <Copy className="size-3.5" />}
        </button>
      )}

      {!toast.quiet && (
        <button
          onClick={dismiss}
          className="shrink-0 rounded-md p-0.5 opacity-60 transition-opacity hover:opacity-100"
          aria-label="Dismiss notification"
        >
          <X className="size-3.5" />
        </button>
      )}

      {toast.dismissOnTimeout !== false && (
        <div className="absolute right-0 bottom-0 left-0 h-[2px] overflow-hidden">
          <div
            className={`h-full origin-left ${isError ? 'bg-destructive/30' : 'bg-primary/30'}`}
            style={{
              animation: `toast-progress ${duration}ms linear forwards`,
              animationPlayState: paused ? 'paused' : 'running',
            }}
          />
        </div>
      )}
    </div>
  );
}

// A browser preview draws above the DOM and would hide toasts. So the stack
// takes whichever bottom corner is clear of previews, and only when neither is
// does it move into the overlay layer drawn above them.
function chooseToastPlacement(stack: DOMRect, viewportWidth: number): ToastPlacement {
  const views = nativeViewRects();
  const isClear = (box: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>) =>
    !views.some((view) => rectsIntersect(box, view));
  const mirrored = {
    left: viewportWidth - stack.right,
    right: viewportWidth - stack.left,
    top: stack.top,
    bottom: stack.bottom,
  };
  const isAtLeft = stack.left + stack.right < viewportWidth;
  const [right, left] = isAtLeft ? [mirrored, stack] : [stack, mirrored];
  if (isClear(right)) return 'right';
  if (isClear(left)) return 'left';
  return 'over-native-view';
}

// What the overlay layer needs to draw the stack exactly where, and as, the
// main window lays it out.
function toastOverlayState(stack: DOMRect, toasts: Toast[]): ToastOverlayState {
  const root = document.documentElement;
  return {
    bounds: { x: stack.x, y: stack.y, width: stack.width, height: stack.height },
    toasts: toasts.map(({ id, message, type, action, dismissOnTimeout, progress, quiet }) => ({
      id,
      // The overlay would refuse the whole stack over one long message.
      message: message.slice(0, TOAST_OVERLAY_MESSAGE_MAX_LENGTH),
      type,
      actionLabel: action?.label,
      dismissOnTimeout: dismissOnTimeout !== false,
      progress,
      quiet,
    })),
    themeClassName: root.className,
    themeStyle: root.style.cssText,
    messageMaxHeight: window.innerHeight * 0.4,
  };
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const hasToasts = toasts.length > 0;
  const stackRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ToastPlacement>('right');

  // Re-placed every frame while shown, since panes can move or open under it.
  useLayoutEffect(() => {
    if (!hasToasts) {
      setPlacement('right');
      return;
    }
    let animationFrame = 0;
    let shownInOverlay = '';
    const place = () => {
      const stack = stackRef.current;
      if (stack) {
        const rect = stack.getBoundingClientRect();
        const next = chooseToastPlacement(rect, document.documentElement.clientWidth);
        setPlacement(next);
        const overlayState =
          next === 'over-native-view'
            ? toastOverlayState(rect, useToastStore.getState().toasts)
            : null;
        const overlayKey = overlayState ? JSON.stringify(overlayState) : '';
        if (overlayKey !== shownInOverlay) {
          if (overlayState) window.api.showToastOverlay(overlayState);
          else window.api.hideToastOverlay();
          shownInOverlay = overlayKey;
        }
      }
      animationFrame = requestAnimationFrame(place);
    };
    place();
    return () => {
      cancelAnimationFrame(animationFrame);
      if (shownInOverlay) window.api.hideToastOverlay();
    };
  }, [hasToasts]);

  // Dismissals and actions from toasts drawn in the overlay layer.
  useEffect(() => {
    return window.api.onToastOverlayEvent(({ type, id }) => {
      const { toasts: current, removeToast } = useToastStore.getState();
      if (type === 'action') current.find((toast) => toast.id === id)?.action?.onClick();
      else removeToast(id);
    });
  }, []);

  // The live region stays mounted so screen readers announce new toasts, even
  // ones the overlay layer draws; the stack itself only exists while there is
  // something to show.
  const mirrored = placement === 'over-native-view';
  return (
    <div role="status" aria-live="polite">
      {hasToasts && (
        <div
          ref={stackRef}
          className={`pointer-events-none fixed bottom-[calc(1rem_+_var(--status-bar-height,0px))] z-[100] flex flex-col gap-2 ${
            placement === 'left' ? 'toast-stack-left left-4' : 'right-4'
          } ${
            // While the overlay layer draws the toasts, any part of this copy
            // outside the preview would show as a second toast.
            mirrored ? 'opacity-0' : ''
          }`}
        >
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} mirrored={mirrored} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Root of the overlay layer's page (toast-overlay.html). It mirrors the main
 * window's toasts that overlap a browser preview: they count down and animate
 * out here, and the main window applies removals and actions.
 */
export function ToastOverlay() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [messageMaxHeight, setMessageMaxHeight] = useState(0);
  const removedIdsRef = useRef(new Set<string>());

  useEffect(() => {
    return window.api.onToastOverlayContent((content) => {
      document.documentElement.className = content.themeClassName;
      document.documentElement.style.cssText = content.themeStyle;
      setMessageMaxHeight(content.messageMaxHeight);
      // A toast removed here can arrive once more before the main window hears of it.
      const removedIds = removedIdsRef.current;
      const incomingIds = new Set(content.toasts.map((toast) => toast.id));
      for (const id of removedIds) {
        if (!incomingIds.has(id)) removedIds.delete(id);
      }
      setToasts(
        content.toasts
          .filter((toast) => !removedIds.has(toast.id))
          .map(({ actionLabel, ...toast }) => ({
            ...toast,
            action:
              actionLabel === undefined
                ? undefined
                : {
                    label: actionLabel,
                    onClick: () =>
                      window.api.sendToastOverlayEvent({ type: 'action', id: toast.id }),
                  },
          }))
      );
    });
  }, []);

  useEffect(() => {
    const releaseFocus = () => window.api.releaseToastOverlayFocus();
    window.addEventListener('pointerup', releaseFocus);
    return () => window.removeEventListener('pointerup', releaseFocus);
  }, []);

  const remove = useCallback((id: string) => {
    removedIdsRef.current.add(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
    window.api.sendToastOverlayEvent({ type: 'remove', id });
  }, []);

  // Bottom-aligned like the main window's stack, so toasts stay put while the
  // view's bounds catch up with a removal.
  return (
    <div className="flex h-screen flex-col justify-end gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} overlay={{ messageMaxHeight, onRemove: remove }} />
      ))}
    </div>
  );
}
