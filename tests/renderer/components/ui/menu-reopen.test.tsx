/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../src/renderer/components/ui/dropdown-menu';

// A closed menu hands the focus back to its trigger a task after it unmounts. On a busy renderer
// that came after the menu had opened again, and taking the focus from it closed it: the target
// branch menu, reopened from the keyboard right after a pick, shut 20 ms later.
describe('a dropdown menu opened again as the last one closes', () => {
  it('stays open when the focus would go back to its trigger', async () => {
    render(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Pick</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const trigger = screen.getByRole('button', { name: 'Open' });

    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pick' }));
    expect(screen.queryByRole('menu')).toBeNull();
    // Before the closed menu's hand-back runs.
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('menu')).toBeTruthy();

    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('still hands the focus back to its trigger when it closes for good', async () => {
    render(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Pick</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const trigger = screen.getByRole('button', { name: 'Open' });

    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pick' }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(trigger);
  });
});
