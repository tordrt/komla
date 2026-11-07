/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BranchComparisonToggle } from '../../../../../src/renderer/components/workspaces/file-viewer/BranchComparisonToggle';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';

import type { AppConfig } from '../../../../../src/renderer/types';

const updateConfig = vi.fn();
const onToggle = vi.fn();

function renderToggle(config: Partial<AppConfig>, showingAllChanges = false) {
  useConfigStore.setState({ config: config as AppConfig, updateConfig });
  return render(
    <TooltipProvider>
      <BranchComparisonToggle
        showingAllChanges={showingAllChanges}
        targetBranchName="main"
        onToggle={onToggle}
        pressedClassName="pressed"
      />
    </TooltipProvider>
  );
}

const DEFAULT_ITEM = 'Show changes since target branch by default';

describe('BranchComparisonToggle', () => {
  beforeEach(() => {
    updateConfig.mockReset();
    onToggle.mockReset();
  });

  it('toggles the comparison on click', async () => {
    const user = userEvent.setup();
    renderToggle({});

    await user.click(screen.getByRole('button', { name: 'Show all changes since main' }));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('offers going back to uncommitted changes while showing all changes', () => {
    renderToggle({}, true);

    expect(screen.getByRole('button', { name: 'Show uncommitted changes' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('turns on showing changes since the target branch by default from its context menu', async () => {
    const user = userEvent.setup();
    renderToggle({});

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Show all changes since main' }));
    const item = screen.getByRole('menuitemcheckbox', { name: DEFAULT_ITEM });
    expect(item).toHaveAttribute('aria-checked', 'false');

    await user.click(item);

    expect(updateConfig).toHaveBeenCalledWith({ defaultCompareTargetBranch: true });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('turns off showing changes since the target branch by default from its context menu', async () => {
    const user = userEvent.setup();
    renderToggle({ defaultCompareTargetBranch: true });

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Show all changes since main' }));
    const item = screen.getByRole('menuitemcheckbox', { name: DEFAULT_ITEM });
    expect(item).toHaveAttribute('aria-checked', 'true');

    await user.click(item);

    expect(updateConfig).toHaveBeenCalledWith({ defaultCompareTargetBranch: false });
  });
});
