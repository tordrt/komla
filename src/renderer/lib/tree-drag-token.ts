// Custom MIME used by the sidebar file tree to stamp `@path ` on drag sources.
// Terminal drop handlers check for this type and paste the payload into the
// PTY. Shared constant so source (tree) and sink (terminal) can't drift.
export const AT_PATH_MIME = 'application/x-komla-at-path';

// Module-level flag set by the sidebar file tree during its own drag lifecycle
// and read by terminal drop handlers. Terminal drops accept AT_PATH_MIME only
// while this token is live — without the gate, any external source (a web
// page, another app) could set the same MIME and smuggle bytes into the PTY.
//
// The token is set on dragstart and cleared on dragend (or drop). drop fires
// before dragend on the source, so terminal onDrop sees the token as active.
let active = false;

export function setTreeDragActive(next: boolean): void {
  active = next;
}

export function isTreeDragActive(): boolean {
  return active;
}

export function consumeTreeDragActive(): boolean {
  const wasActive = active;
  active = false;
  return wasActive;
}
