/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../../../src/renderer/components/ui/dropdown-menu';

// A menu opens on the trigger's pointerdown. When its contents grow after loading, a row can sit
// under the pointer for a frame before the menu repositions, and releasing the button there picked
// that row: the target branch changed on a plain click of its status bar button.
function renderMenu() {
  const onItem = vi.fn();
  const onCheckbox = vi.fn();
  const onRadio = vi.fn();
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onItem}>Item</DropdownMenuItem>
        <DropdownMenuCheckboxItem onCheckedChange={onCheckbox}>Checkbox</DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup onValueChange={onRadio}>
          <DropdownMenuRadioItem value="radio">Radio</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return { onItem, onCheckbox, onRadio };
}

describe('dropdown menu items', () => {
  it('ignore a release whose press started outside them', () => {
    const { onItem, onCheckbox, onRadio } = renderMenu();

    fireEvent.pointerUp(screen.getByText('Item'));
    fireEvent.pointerUp(screen.getByText('Checkbox'));
    fireEvent.pointerUp(screen.getByText('Radio'));

    expect(onItem).not.toHaveBeenCalled();
    expect(onCheckbox).not.toHaveBeenCalled();
    expect(onRadio).not.toHaveBeenCalled();
  });

  it('still select on a click', () => {
    const { onItem } = renderMenu();

    fireEvent.click(screen.getByText('Item'));
    expect(onItem).toHaveBeenCalledTimes(1);
  });

  it('still toggle checkbox and radio items on a click', () => {
    const { onCheckbox, onRadio } = renderMenu();

    fireEvent.click(screen.getByText('Checkbox'));
    fireEvent.click(screen.getByText('Radio'));

    expect(onCheckbox).toHaveBeenCalledWith(true);
    expect(onRadio).toHaveBeenCalledWith('radio');
  });
});
