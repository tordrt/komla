// Keydowns a focused surface has already handled, such as Cmd+1 inside the new
// workspace dialog. Stopping propagation instead would hide the key from
// double-tap detection, which would then read Cmd+1 as a bare Cmd tap.
const claimedEvents = new WeakSet<KeyboardEvent>();

/** Keep app-wide shortcuts from also acting on a keydown handled locally. */
export function claimShortcutEvent(event: KeyboardEvent): void {
  claimedEvents.add(event);
}

export function isShortcutEventClaimed(event: KeyboardEvent): boolean {
  return claimedEvents.has(event);
}
