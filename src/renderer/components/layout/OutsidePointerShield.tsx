import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { attributes: true, attributeFilter: ['style'] });
  return () => observer.disconnect();
}

const outsidePointerEventsBlocked = () => document.body.style.pointerEvents === 'none';

/**
 * Radix modal menus and dialogs block the app behind them by setting pointer-events: none on the
 * body, which restyles every element on each open and close. The main window's body keeps its
 * pointer events instead (globals.css), and this transparent layer catches those clicks: above
 * the app, and under the open layer's portal, which comes later in the document.
 */
export function OutsidePointerShield() {
  const blocked = useSyncExternalStore(subscribe, outsidePointerEventsBlocked);
  if (!blocked) return null;
  return (
    <div
      data-outside-pointer-shield=""
      aria-hidden="true"
      className="fixed inset-0 z-50"
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}
