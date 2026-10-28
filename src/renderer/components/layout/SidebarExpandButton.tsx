import { SidebarSimple } from '@phosphor-icons/react';
import { type ReactNode } from 'react';

import { IconButton } from '@/components/ui/icon-button';
import { setSidebarCollapsed, useSidebarCollapsed } from '@/lib/sidebar-collapsed';
import { cn } from '@/lib/utils';
import { useShortcutsStore } from '@/stores/shortcuts.store';

import { MAC_TRAFFIC_LIGHT_INSET_PX, useHasTrafficLights } from './title-bar-metrics';

/**
 * Brings a collapsed sidebar back, at the left of the window's top row, followed by children such
 * as the settings menu the sidebar would show. On macOS it sits right of the traffic lights; pass
 * trafficLightInset where the row doesn't already leave room for them.
 */
export function SidebarExpandButton({
  trafficLightInset = false,
  className,
  children,
}: {
  trafficLightInset?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const collapsed = useSidebarCollapsed();
  const hasTrafficLights = useHasTrafficLights();
  const shortcut = useShortcutsStore((s) => s.getDisplayShortcut('sidebar.toggle'));
  if (!collapsed) return null;
  return (
    <div
      className={cn('flex shrink-0 items-center', className)}
      style={
        trafficLightInset && hasTrafficLights
          ? { paddingLeft: MAC_TRAFFIC_LIGHT_INSET_PX }
          : undefined
      }
    >
      <IconButton
        label="Expand sidebar"
        shortcut={shortcut}
        className="no-drag text-muted-foreground hover:text-foreground"
        onClick={() => setSidebarCollapsed(false)}
      >
        <SidebarSimple className="size-4" />
      </IconButton>
      {children}
    </div>
  );
}
