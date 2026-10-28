/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/components/layout/UnifiedMenu', () => ({
  UnifiedMenu: () => <div data-testid="git-menu" />,
}));
vi.mock('../../../../src/renderer/components/layout/TargetBranchSelector', () => ({
  TargetBranchSelector: () => <div data-testid="target-branch" />,
}));
vi.mock('../../../../src/renderer/components/workspaces/SetupActivityPanel', () => ({
  SetupActivityIndicator: ({ workspace }: { workspace: { id: string } }) => (
    <div data-testid="setup-activity" data-workspace-id={workspace.id} />
  ),
}));
vi.mock('../../../../src/renderer/components/layout/EditorToolbarButton', () => ({
  useEditorOptions: () => ({
    allOptions: [{ id: 'vscode', name: 'VS Code' }],
    defaultOption: { id: 'vscode', name: 'VS Code' },
    workspacePath: '/repo',
    handleOpen: vi.fn(),
  }),
  EditorToolbarButton: () => <div data-testid="open-in-editor" />,
}));

import { TabRowBranchControls } from '../../../../src/renderer/components/layout/TabRowBranchControls';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';

import type { AppConfig, Workspace } from '../../../../src/renderer/types';

function setConfig(config: Partial<AppConfig>): void {
  useConfigStore.setState({ config: config as AppConfig });
}

describe('TabRowBranchControls', () => {
  beforeEach(() => {
    setConfig({});
    useWorkspacesStore.setState({ workspaces: [], selectedWorkspaceId: null });
  });

  it('stays out of the tab row while the status bar shows the branch controls', () => {
    render(<TabRowBranchControls />);

    expect(screen.queryByTestId('git-menu')).toBeNull();
  });

  it('keeps the git menu, target branch and editor reachable with the status bar off', () => {
    setConfig({ showStatusBar: false });
    render(<TabRowBranchControls />);

    expect(screen.getByTestId('git-menu')).toBeTruthy();
    expect(screen.getByTestId('target-branch')).toBeTruthy();
    expect(screen.getByTestId('open-in-editor')).toBeTruthy();
  });

  it('brings Open in editor back with the status bar off, whose menu hid it', () => {
    setConfig({ showStatusBar: false, showEditorInToolbar: false });
    render(<TabRowBranchControls />);

    expect(screen.getByTestId('open-in-editor')).toBeTruthy();
  });

  it('leaves setup progress to the quick command button beside it', () => {
    setConfig({ showStatusBar: false });
    useWorkspacesStore.setState({
      workspaces: [{ id: 'ws-1' } as Workspace],
      selectedWorkspaceId: 'ws-1',
    });
    render(<TabRowBranchControls />);

    expect(screen.getByTestId('git-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('setup-activity')).not.toBeInTheDocument();
  });
});
