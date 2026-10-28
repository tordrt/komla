/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../src/renderer/components/ui/dropdown-menu';
import { IconButton } from '../../../../src/renderer/components/ui/icon-button';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';

describe('IconButton', () => {
  it('names the button with its label and forwards clicks', () => {
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <IconButton label="Close preview" onClick={onClick}>
          <svg />
        </IconButton>
      </TooltipProvider>
    );

    const button = screen.getByRole('button', { name: 'Close preview' });
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows the label and shortcut in a tooltip on focus', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <IconButton label="Toggle sidebar" shortcut="Ctrl+B">
          <svg />
        </IconButton>
      </TooltipProvider>
    );

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Toggle sidebar' })).toHaveFocus();

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Toggle sidebar');
    expect(tooltip.textContent).toContain('Ctrl+B');
  });

  it('passes tooltip props through to the tooltip content', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <IconButton label="Reload" tooltipProps={{ className: 'custom-tooltip' }}>
          <svg />
        </IconButton>
      </TooltipProvider>
    );

    await userEvent.tab();

    await screen.findByRole('tooltip');
    expect(document.querySelector('.custom-tooltip')).toBeTruthy();
  });

  it('renders without a tooltip when turned off', () => {
    render(
      <IconButton label="More" tooltip={false}>
        <svg />
      </IconButton>
    );

    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
  });

  it('works as an asChild menu trigger', async () => {
    render(
      <TooltipProvider>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="Workspace actions">
              <svg />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Rename</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    );

    const trigger = screen.getByRole('button', { name: 'Workspace actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeTruthy();
  });

  it('does not show the tooltip when focus is moved there by script after a click', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <IconButton label="More">
          <svg />
        </IconButton>
      </TooltipProvider>
    );
    const button = screen.getByRole('button', { name: 'More' });

    // e.g. a menu item clicked with the mouse hands focus back to its trigger.
    fireEvent.pointerDown(document.body);
    fireEvent.focus(button);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('tooltip')).toBeNull();

    // Keyboard focus still shows it.
    fireEvent.keyDown(document.body, { key: 'Tab' });
    fireEvent.blur(button);
    fireEvent.focus(button);
    expect(await screen.findByRole('tooltip')).toBeTruthy();
  });
});
