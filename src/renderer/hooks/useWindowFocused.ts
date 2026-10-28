import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
  return () => {
    window.removeEventListener('focus', onChange);
    window.removeEventListener('blur', onChange);
  };
}

/** Whether this Komla window currently has OS focus. */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, () => document.hasFocus());
}
