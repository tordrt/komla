import { ArrowsClockwise, CaretDown, CaretRight, Cloud } from '@phosphor-icons/react';
import React from 'react';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

import type { BranchInfo } from '@/types';

/**
 * Parts the Branches menu and the target branch menu share: a filter box the arrow keys reach,
 * and the Remote section's header.
 */

const ENABLED_ITEM = '[role^="menuitem"]:not([data-disabled])';

/** The menu's enabled items just above and just below its filter box. */
function itemsAroundFilter(menu: Element, input: HTMLInputElement) {
  const items = Array.from(menu.querySelectorAll<HTMLElement>(ENABLED_ITEM));
  const firstAfter = items.findIndex(
    (item) => input.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING
  );
  const split = firstAfter === -1 ? items.length : firstAfter;
  return { above: items[split - 1], below: items[split] };
}

/**
 * The menu moves between its items with the arrow keys and skips the filter box, which isn't
 * one. For the menu's `onKeyDownCapture`: an arrow key in the box moves to the item above or
 * below it, and one on either of those items moves back into the box. It runs before the item
 * sees the key, as the item would otherwise move the focus on after.
 */
export function handleMenuKeyDownAroundFilter(
  event: React.KeyboardEvent<HTMLElement>,
  input: HTMLInputElement | null
): void {
  if (!input || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
  const { above, below } = itemsAroundFilter(event.currentTarget, input);
  const up = event.key === 'ArrowUp';
  let next: HTMLElement | undefined;
  if (event.target === input) next = up ? above : below;
  else if (event.target === (up ? below : above)) next = input;
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
}

/** A branch row's key: two remotes can hold a branch of the same name, so a remote row goes by its full ref. */
export function branchRowKey(branch: BranchInfo): string {
  return branch.isRemoteOnly ? `remote:${branch.remoteRef ?? branch.name}` : `local:${branch.name}`;
}

/**
 * Whether the Remote section lists its branches: when expanded, or to show the matches of a
 * filter, which is any text typed, as the list filters on it as typed.
 */
export function showsRemoteBranches(expanded: boolean, filter: string): boolean {
  return expanded || filter !== '';
}

interface BranchFilterInputProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Enter in the box, as to create the branch typed. */
  onEnter?: () => void;
  className?: string;
}

/** A menu's box for filtering its branches or naming a new one. */
export const BranchFilterInput = React.forwardRef<HTMLInputElement, BranchFilterInputProps>(
  function BranchFilterInput({ value, onValueChange, onEnter, className }, ref) {
    return (
      <input
        ref={ref}
        type="text"
        placeholder="Filter or create branch..."
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Kept from the menu, whose typeahead would otherwise take the focus while typing.
          // The arrow keys are the menu's, in handleMenuKeyDownAroundFilter.
          e.stopPropagation();
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        className={className}
      />
    );
  }
);

interface RemoteBranchesHeaderProps {
  remoteCount: number;
  expanded: boolean;
  /** The menu's filter, whose matches the section shows however it's set. */
  filter: string;
  onExpandedChange: (expanded: boolean) => void;
  isFetching: boolean;
  onFetch: () => void;
}

/** The Remote section's header: a toggle to show its branches, and Fetch. Both stay in the menu. */
export function RemoteBranchesHeader({
  remoteCount,
  expanded,
  filter,
  onExpandedChange,
  isFetching,
  onFetch,
}: RemoteBranchesHeaderProps) {
  const shown = showsRemoteBranches(expanded, filter);
  // Shown even collapsed, so collapsing would change nothing.
  const filtering = showsRemoteBranches(false, filter);
  const headerItemClass = 'gap-1.5 py-1.5 text-xs font-medium text-muted-foreground';
  return (
    <div className="flex items-center gap-1">
      <DropdownMenuItem
        aria-expanded={shown}
        disabled={filtering}
        className={cn('flex-1', headerItemClass)}
        onClick={(e) => {
          // Keeps the menu open.
          e.preventDefault();
          onExpandedChange(!expanded);
        }}
      >
        {shown ? <CaretDown className="size-3" /> : <CaretRight className="size-3" />}
        <Cloud className="size-3" />
        Remote ({remoteCount})
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={isFetching}
        className={cn('px-1.5', headerItemClass)}
        title={isFetching ? 'Fetching...' : 'Fetch from remote'}
        onClick={(e) => {
          e.preventDefault();
          onFetch();
        }}
      >
        <ArrowsClockwise className={cn('size-3.5', isFetching && 'animate-spin')} />
        {isFetching ? 'Fetching' : 'Fetch'}
      </DropdownMenuItem>
    </div>
  );
}
