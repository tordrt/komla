import { GitBranch } from '@phosphor-icons/react';

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';

interface BranchComparisonToggleProps {
  /** Whether the tree shows all changes since the target branch, rather than uncommitted ones */
  showingAllChanges: boolean;
  targetBranchName?: string;
  loading?: boolean;
  onToggle: () => void;
  /** Classes for the pressed-in look, shared with the header's other toggles */
  pressedClassName: string;
}

/**
 * Switches the changes view between uncommitted changes and all changes since the target
 * branch; its context menu sets which one workspaces start on.
 */
export function BranchComparisonToggle({
  showingAllChanges,
  targetBranchName,
  loading,
  onToggle,
  pressedClassName,
}: BranchComparisonToggleProps) {
  const compareByDefault = useConfigStore((s) => s.config?.defaultCompareTargetBranch === true);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const label = showingAllChanges
    ? 'Show uncommitted changes'
    : `Show all changes since ${targetBranchName || 'target branch'}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <IconButton
          label={loading ? 'Loading changes' : label}
          size="xs"
          tooltipSide="bottom"
          onClick={onToggle}
          disabled={loading}
          aria-pressed={showingAllChanges}
          className={cn(
            showingAllChanges ? pressedClassName : 'text-muted-foreground-80 hover:text-foreground'
          )}
        >
          {loading ? <Spinner size="sm" /> : <GitBranch aria-hidden="true" className="size-3.5" />}
        </IconButton>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuCheckboxItem
          checked={compareByDefault}
          onCheckedChange={(checked) => updateConfig({ defaultCompareTargetBranch: checked })}
        >
          Show changes since target branch by default
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
