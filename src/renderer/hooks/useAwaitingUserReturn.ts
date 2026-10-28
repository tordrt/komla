import { useSyncExternalStore } from 'react';

// Input that shows the user is back at the computer.
const RETURN_EVENTS = ['keydown', 'pointerdown', 'pointermove'] as const;

let awaiting = false;
const listeners = new Set<() => void>();
const onReturns: Array<() => void> = [];

function notify(): void {
  for (const listener of listeners) listener();
}

function handleReturn(event: Event): void {
  // The pointer reaches a window in the background too, passing over it on the way elsewhere.
  if (!document.hasFocus()) return;
  // Content scrolling beneath a resting pointer can raise moves that went nowhere.
  if (event instanceof MouseEvent && event.type === 'pointermove') {
    if (event.movementX === 0 && event.movementY === 0) return;
  }
  awaiting = false;
  for (const type of RETURN_EVENTS) window.removeEventListener(type, handleReturn, true);
  for (const onReturn of onReturns.splice(0)) onReturn();
  notify();
}

/**
 * An alert arrived while the user was away; what's on screen stays unseen until they're back,
 * when `onReturn` runs.
 */
export function awaitUserReturn(onReturn?: () => void): void {
  if (onReturn) onReturns.push(onReturn);
  if (awaiting) return;
  awaiting = true;
  for (const event of RETURN_EVENTS) {
    window.addEventListener(event, handleReturn, { capture: true, passive: true });
  }
  notify();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Whether an alert is waiting for the user to come back to the computer. */
export function useAwaitingUserReturn(): boolean {
  return useSyncExternalStore(subscribe, () => awaiting);
}
