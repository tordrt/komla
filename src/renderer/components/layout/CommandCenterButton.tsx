import { MagnifyingGlass } from '@phosphor-icons/react';

import { IconButton } from '@/components/ui/icon-button';
import { useShortcutsStore } from '@/stores/shortcuts.store';

import type React from 'react';

/**
 * Opens Command center: in the sidebar's top row, in the title bar, or in the tab row while the
 * sidebar is collapsed.
 */
export function CommandCenterButton({
  className,
  style,
  onClick,
}: {
  className?: string;
  style?: React.CSSProperties;
  onClick: () => void;
}) {
  const shortcut = useShortcutsStore((s) => s.getDisplayShortcut('commandCenter.open'));
  return (
    <IconButton
      label="Command center"
      shortcut={shortcut}
      className={className}
      style={style}
      onClick={onClick}
    >
      <MagnifyingGlass className="size-4" />
    </IconButton>
  );
}
