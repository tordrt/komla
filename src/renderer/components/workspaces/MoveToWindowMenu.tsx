import { AppWindow } from '@phosphor-icons/react';

import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';

interface WindowTarget {
  id: string;
  displayNumber: number;
}

interface MoveToWindowMenuItemsProps {
  otherWindows: WindowTarget[];
  onMoveToWindow: (windowId: string) => void;
  onMoveToNewWindow: () => void;
}

export function MoveToWindowMenuItems({
  otherWindows,
  onMoveToWindow,
  onMoveToNewWindow,
}: MoveToWindowMenuItemsProps) {
  if (otherWindows.length === 0) {
    return (
      <ContextMenuItem onClick={onMoveToNewWindow}>
        <AppWindow />
        Move to New Window
      </ContextMenuItem>
    );
  }
  if (otherWindows.length === 1) {
    return (
      <>
        <ContextMenuItem onClick={() => onMoveToWindow(otherWindows[0].id)}>
          <AppWindow />
          Move to Window {otherWindows[0].displayNumber}
        </ContextMenuItem>
        <ContextMenuItem onClick={onMoveToNewWindow}>
          <AppWindow />
          Move to New Window
        </ContextMenuItem>
      </>
    );
  }
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <AppWindow />
          Move to Window
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {otherWindows.map((targetWindow) => (
            <ContextMenuItem key={targetWindow.id} onClick={() => onMoveToWindow(targetWindow.id)}>
              Window {targetWindow.displayNumber}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onClick={onMoveToNewWindow}>
        <AppWindow />
        Move to New Window
      </ContextMenuItem>
    </>
  );
}
