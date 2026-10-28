import { useLayoutEffect, useRef, useState } from 'react';

import { menuContentClass, menuItemClass } from '@/components/ui/menu-styles';
import { cn } from '@/lib/utils';

import type { SlashMenuState } from './markdown-slash-commands';

const GAP = 4;
/** The menu's `w-52`. */
const MENU_WIDTH = 208;

/**
 * The block menu shown while typing `/` at the start of a line, placed in the
 * editor's `container` (not portaled, so it stays inside the file viewer's
 * dialog). Keys are handled in the editor.
 */
export function MarkdownSlashMenu({
  menu,
  container,
}: {
  menu: SlashMenuState;
  container: HTMLElement | null;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const { anchor, commands, selected, run } = menu;

  // Below the `/`, or above it when the menu would run past the bottom of the editor.
  useLayoutEffect(() => {
    const height = menuRef.current?.offsetHeight ?? 0;
    if (!anchor || !container) return;
    const bounds = container.getBoundingClientRect();
    const below = anchor.bottom - bounds.top + GAP;
    const top =
      below + height > bounds.height
        ? Math.max(GAP, anchor.top - bounds.top - GAP - height)
        : below;
    const left = Math.max(
      GAP,
      Math.min(anchor.left - bounds.left, bounds.width - MENU_WIDTH - GAP)
    );
    setPosition({ left, top });
  }, [anchor, commands.length, container]);

  useLayoutEffect(() => {
    menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="Insert block"
      className={cn(menuContentClass, 'absolute max-h-72 w-52 min-w-0')}
      style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
      // Keep focus, and the typed `/`, in the editor.
      onMouseDown={(event) => event.preventDefault()}
    >
      {commands.map((command, index) => (
        <div
          key={command.title}
          role="option"
          aria-selected={index === selected}
          // The editor keeps focus and moves the selection with the arrow keys.
          tabIndex={-1}
          className={cn(menuItemClass, index === selected && 'bg-foreground/8')}
          onClick={() => run(command)}
        >
          <command.icon />
          {command.title}
        </div>
      ))}
    </div>
  );
}
