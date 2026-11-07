/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React, { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  BranchFilterInput,
  handleMenuKeyDownAroundFilter,
} from '../../../../src/renderer/components/layout/BranchMenuParts';

function Menu({
  onEnter,
  onItemKeyDown,
}: {
  onEnter?: () => void;
  onItemKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  return (
    <div role="menu" onKeyDownCapture={(e) => handleMenuKeyDownAroundFilter(e, inputRef.current)}>
      <button role="menuitem">Sync</button>
      <BranchFilterInput ref={inputRef} value={value} onValueChange={setValue} onEnter={onEnter} />
      <button role="menuitem" data-disabled="">
        Loading
      </button>
      <button role="menuitem" onKeyDown={onItemKeyDown}>
        main
      </button>
      <button role="menuitem">develop</button>
    </div>
  );
}

describe('BranchFilterInput', () => {
  it('moves down into the branch list and up to the item above it', () => {
    render(<Menu />);
    const input = screen.getByPlaceholderText('Filter or create branch...');

    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'main' })).toHaveFocus();

    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Sync' })).toHaveFocus();
  });

  it('returns to the filter from the items on either side of it', () => {
    render(<Menu />);
    const input = screen.getByPlaceholderText('Filter or create branch...');

    const main = screen.getByRole('menuitem', { name: 'main' });
    main.focus();
    fireEvent.keyDown(main, { key: 'ArrowUp' });
    expect(input).toHaveFocus();

    const sync = screen.getByRole('menuitem', { name: 'Sync' });
    sync.focus();
    fireEvent.keyDown(sync, { key: 'ArrowDown' });
    expect(input).toHaveFocus();

    const develop = screen.getByRole('menuitem', { name: 'develop' });
    develop.focus();
    fireEvent.keyDown(develop, { key: 'ArrowUp' });
    expect(develop).toHaveFocus();
  });

  it("keeps the key it moves into the filter from the item, whose own move would follow", () => {
    const onItemKeyDown = vi.fn();
    render(<Menu onItemKeyDown={onItemKeyDown} />);
    const main = screen.getByRole('menuitem', { name: 'main' });

    main.focus();
    fireEvent.keyDown(main, { key: 'ArrowUp' });
    expect(onItemKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(main, { key: 'ArrowDown' });
    expect(onItemKeyDown).toHaveBeenCalledOnce();
  });

  it("keeps typed keys from reaching the menu, so its typeahead doesn't take focus", () => {
    const onMenuKeyDown = vi.fn();
    render(
      <div onKeyDown={onMenuKeyDown}>
        <BranchFilterInput value="" onValueChange={vi.fn()} />
      </div>
    );

    fireEvent.keyDown(screen.getByPlaceholderText('Filter or create branch...'), { key: 'r' });

    expect(onMenuKeyDown).not.toHaveBeenCalled();
  });

  it('creates on Enter', () => {
    const onEnter = vi.fn();
    render(<Menu onEnter={onEnter} />);

    fireEvent.keyDown(screen.getByPlaceholderText('Filter or create branch...'), { key: 'Enter' });

    expect(onEnter).toHaveBeenCalledOnce();
  });
});
