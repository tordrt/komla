/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileTreeToggleButton } from '../../../../src/renderer/components/terminal/FileTreeToggleButton';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';

import type { AppConfig } from '../../../../src/renderer/types';

const updateConfig = vi.fn();
const toggleInlineFileTree = vi.fn();

function renderButton(config: Partial<AppConfig>) {
  useConfigStore.setState({ config: config as AppConfig, updateConfig });
  return render(
    <TooltipProvider>
      <FileTreeToggleButton workspaceId="ws-1" />
    </TooltipProvider>
  );
}

describe('FileTreeToggleButton', () => {
  beforeEach(() => {
    updateConfig.mockReset();
    toggleInlineFileTree.mockReset();
    useFileViewerStore.setState({ toggleInlineFileTree });
  });

  it('toggles the file tree of the workspace on click', async () => {
    const user = userEvent.setup();
    renderButton({});

    await user.click(screen.getByRole('button', { name: 'Toggle file panel' }));

    expect(toggleInlineFileTree).toHaveBeenCalledWith('ws-1');
  });

  it('turns on showing the file tree in new workspaces from its context menu', async () => {
    const user = userEvent.setup();
    renderButton({});

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Toggle file panel' }));
    const item = screen.getByRole('menuitemcheckbox', {
      name: 'Show by default in new workspaces',
    });
    expect(item).toHaveAttribute('aria-checked', 'false');

    await user.click(item);

    expect(updateConfig).toHaveBeenCalledWith({ defaultFileTreeOpen: true });
  });

  it('turns off showing the file tree in new workspaces from its context menu', async () => {
    const user = userEvent.setup();
    renderButton({ defaultFileTreeOpen: true });

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Toggle file panel' }));
    const item = screen.getByRole('menuitemcheckbox', {
      name: 'Show by default in new workspaces',
    });
    expect(item).toHaveAttribute('aria-checked', 'true');

    await user.click(item);

    expect(updateConfig).toHaveBeenCalledWith({ defaultFileTreeOpen: false });
  });
});
