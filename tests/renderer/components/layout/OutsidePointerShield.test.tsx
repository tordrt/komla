/**
 * @vitest-environment jsdom
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { OutsidePointerShield } from '../../../../src/renderer/components/layout/OutsidePointerShield';

const shield = () => document.querySelector('[data-outside-pointer-shield]');

describe('OutsidePointerShield', () => {
  afterEach(() => {
    document.body.style.pointerEvents = '';
  });

  it('covers the app only while a layer blocks pointer events outside it', async () => {
    render(<OutsidePointerShield />);
    expect(shield()).toBeNull();

    await act(async () => {
      document.body.style.pointerEvents = 'none';
    });
    expect(shield()).not.toBeNull();

    await act(async () => {
      document.body.style.pointerEvents = '';
    });
    expect(shield()).toBeNull();
  });

  // Radix is what sets the body style, so a version that stops doing it must fail here.
  it('covers the app while a modal Radix menu is open', async () => {
    function Menu({ open }: { open: boolean }) {
      return (
        <>
          <OutsidePointerShield />
          <DropdownMenu.Root open={open}>
            <DropdownMenu.Trigger>Menu</DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content>
                <DropdownMenu.Item>Item</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </>
      );
    }
    const { rerender } = render(<Menu open={false} />);
    expect(shield()).toBeNull();

    await act(async () => rerender(<Menu open />));
    expect(screen.getByRole('menuitem', { name: 'Item' })).toBeInTheDocument();
    expect(shield()).not.toBeNull();

    await act(async () => rerender(<Menu open={false} />));
    expect(shield()).toBeNull();
  });
});
