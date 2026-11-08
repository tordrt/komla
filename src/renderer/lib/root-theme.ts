import type { AgentsMenuBarTheme } from '../../shared/types';

/** Komla's theme as this window's root carries it, for a window of Komla's own to match. */
export function readRootTheme(): AgentsMenuBarTheme {
  const root = document.documentElement;
  return { className: root.className, style: root.style.cssText };
}

/** Calls `onChange` with the root's theme now and as it changes; returns a stop. */
export function watchRootTheme(onChange: (theme: AgentsMenuBarTheme) => void): () => void {
  const send = () => onChange(readRootTheme());
  send();
  const observer = new MutationObserver(send);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  return () => observer.disconnect();
}
