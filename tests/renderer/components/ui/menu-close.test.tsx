/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../../../../src/renderer/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../../../src/renderer/components/ui/dropdown-menu';

// A menu that stays mounted for an exit animation takes focus back from whatever its item
// just opened, which dismissed the commit popover opened from the title bar menu. Menus
// therefore close without one.
function expectNoExitAnimation(element: HTMLElement) {
  expect(element.className).not.toMatch(/data-\[state=closed\]:/);
}

describe('menus close without an exit animation', () => {
  it('applies to dropdown menus and their submenus', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent data-testid="content">
          <DropdownMenuItem>Item</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="sub-content">
              <DropdownMenuItem>Sub item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    expectNoExitAnimation(screen.getByTestId('content'));
    expectNoExitAnimation(screen.getByTestId('sub-content'));
  });

  it('applies to context menus and their submenus', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent data-testid="content">
          <ContextMenuItem>Item</ContextMenuItem>
          <ContextMenuSub open>
            <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
            <ContextMenuSubContent data-testid="sub-content">
              <ContextMenuItem>Sub item</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    );
    fireEvent.contextMenu(screen.getByText('Target'));

    expectNoExitAnimation(screen.getByTestId('content'));
    expectNoExitAnimation(screen.getByTestId('sub-content'));
  });
});
