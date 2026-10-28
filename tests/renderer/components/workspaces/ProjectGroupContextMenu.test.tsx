/**
 * @vitest-environment jsdom
 *
 * Regression guard for the quick-launch wiring: when a user launches a
 * workspace from a command or prompt action, the action's presetId and
 * launchModeId must be forwarded to createWorkspace so the service starts
 * the correct preset.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectGroupContextMenu } from '../../../../src/renderer/components/workspaces/ProjectGroupContextMenu';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';
import { handleCreateError } from '../../../../src/renderer/utils/workspace-error';

const mockCreateWorkspace = vi.fn();
const mockAddTerminalCommand = vi.fn().mockResolvedValue({ id: 'term-new' });
const mockShowTabInFullPane = vi.hoisted(() => vi.fn());
const mockDeleteWorkspace = vi.fn().mockResolvedValue(undefined);
const mockSelectWorkspace = vi.fn().mockResolvedValue(undefined);
const mockRecordActionUsage = vi.fn().mockResolvedValue(undefined);
let mockSelectedWorkspaceId: string | null = 'ws-existing';
const branchCleanupProps = vi.fn();

vi.mock('../../../../src/renderer/components/projects/BranchCleanupDialog', () => ({
  BranchCleanupDialog: (props: unknown) => {
    branchCleanupProps(props);
    return null;
  },
}));

vi.mock('../../../../src/shared/lib/random-names', () => ({
  generateBranchSuffix: vi.fn(() => 'swift-fox'),
  branchSuffixToName: vi.fn((s: string) => s),
}));

vi.mock('../../../../src/renderer/components/ui/context-menu', () => {
  const Passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  const Item = ({
    children,
    onClick,
    onSelect,
    ...props
  }: React.PropsWithChildren<
    React.ButtonHTMLAttributes<HTMLButtonElement> & { onSelect?: () => void }
  >) => (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        onClick?.(e);
        onSelect?.();
      }}
      {...props}
    >
      {children}
    </button>
  );
  return {
    ContextMenu: Passthrough,
    ContextMenuTrigger: Passthrough,
    ContextMenuContent: Passthrough,
    ContextMenuItem: Item,
    ContextMenuLabel: Passthrough,
    ContextMenuSeparator: () => <hr />,
    ContextMenuSub: Passthrough,
    ContextMenuSubContent: Passthrough,
    ContextMenuSubTrigger: Passthrough,
  };
});

vi.mock('../../../../src/renderer/components/workspaces/ActionInputDialog', () => ({
  ActionInputDialog: () => null,
}));

vi.mock('../../../../src/renderer/stores/workspaces.store', () => {
  const getState = () => ({
    createWorkspace: mockCreateWorkspace,
    addTerminalCommand: mockAddTerminalCommand,
    deleteWorkspace: mockDeleteWorkspace,
    selectWorkspace: mockSelectWorkspace,
    selectedWorkspaceId: mockSelectedWorkspaceId,
    hideProjectGroup: vi.fn(),
    workspaces: [],
    moveWorkspacesToWindow: vi.fn(),
  });
  return {
    useWorkspacesStore: Object.assign(
      (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState }
    ),
  };
});

vi.mock('../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      actions: [
        {
          id: 'action-cmd',
          title: 'Test Command',
          content: 'echo hi',
          type: 'command',
          presetId: 'preset-X',
          launchModeId: 'mode-X',
        },
        {
          id: 'action-prompt',
          title: 'Test Prompt',
          content: 'help me',
          type: 'prompt',
          presetId: 'preset-Y',
          launchModeId: 'mode-Y',
        },
      ],
      loadActions: vi.fn().mockResolvedValue(undefined),
      recordActionUsage: mockRecordActionUsage,
    }),
}));

vi.mock('../../../../src/renderer/stores/config.store', () => {
  const state = {
    config: { remoteBranchesExpanded: false },
    updateConfig: vi.fn().mockResolvedValue(undefined),
  };
  return {
    useConfigStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

vi.mock('../../../../src/renderer/stores/layout.store', () => {
  const state = { showTabInFullPane: mockShowTabInFullPane };
  const useLayoutStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state;
  return { useLayoutStore: Object.assign(useLayoutStore, { getState: () => state }) };
});

vi.mock('../../../../src/renderer/stores/toast.store', () => {
  const state = { addToast: vi.fn() };
  return {
    useToastStore: Object.assign(() => state, { getState: () => state }),
  };
});

vi.mock('../../../../src/renderer/stores/window.store', () => ({
  useWindowStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ windowId: 'w1', availableWindows: [] }),
}));

vi.mock('../../../../src/renderer/utils/workspace-error', () => ({
  handleCreateError: vi.fn(),
}));

vi.mock('../../../../src/renderer/lib/action-injection', () => ({
  injectActionContext: (content: string) => content,
  ACTION_TARGET_BRANCH_TOKEN: '{{target_branch}}',
  actionNeedsInjection: () => false,
}));

const project = {
  id: 'project-1',
  name: 'Test Project',
  color: '#f00',
  defaultBranchPrefix: 'komla/',
  managed: false,
  repositoryPath: '/repos/test',
} as any;

const directoryProject = {
  ...project,
  id: 'project-dir',
  name: 'Directory Project',
  kind: 'directory',
  repositoryPath: '/repos/directory',
} as any;

describe('ProjectGroupContextMenu action wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectedWorkspaceId = 'ws-existing';
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-new', name: 'Workspace', terminals: [] });
    mockAddTerminalCommand.mockResolvedValue({ id: 'term-new' });
    global.window.api = {
      listBranches: vi.fn().mockResolvedValue([]),
      fetchFromRemote: vi.fn().mockResolvedValue(undefined),
      getMainBranch: vi.fn().mockResolvedValue('main'),
      createWindow: vi.fn().mockResolvedValue('w2'),
    } as any;
  });

  it('uses the canonical action category names', () => {
    render(
      <ProjectGroupContextMenu project={project}>
        <div>trigger</div>
      </ProjectGroupContextMenu>
    );

    expect(document.body).toHaveTextContent('Terminal Commands');
    expect(document.body).toHaveTextContent('Saved Prompts');
  });

  it('names the instant random-branch item apart from the New Workspace dialog', () => {
    render(
      <ProjectGroupContextMenu project={project}>
        <div>trigger</div>
      </ProjectGroupContextMenu>
    );

    expect(screen.getByRole('menuitem', { name: 'Quick New Workspace' })).toBeInTheDocument();
  });

  it("opens the project's branch cleanup", async () => {
    const user = userEvent.setup();
    render(
      <ProjectGroupContextMenu project={project}>
        <div>trigger</div>
      </ProjectGroupContextMenu>
    );

    await user.click(screen.getByRole('menuitem', { name: 'Clean Up Branches...' }));

    expect(branchCleanupProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: project.id, open: true })
    );
  });

  it('forwards action.presetId and launchModeId when launching a command action', async () => {
    const user = userEvent.setup();

    render(
      <ProjectGroupContextMenu project={project}>
        <div>trigger</div>
      </ProjectGroupContextMenu>
    );

    await user.click(screen.getByRole('menuitem', { name: /test command/i }));

    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: 'preset-X',
        launchModeId: 'mode-X',
      })
    );
    await waitFor(() => expect(mockShowTabInFullPane).toHaveBeenCalledWith('term-new'));
    expect(mockAddTerminalCommand).toHaveBeenCalledOnce();
  });

  it('says the workspace exists when only its command fails, and retries just the command', async () => {
    const user = userEvent.setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAddTerminalCommand.mockRejectedValueOnce(new Error('spawn zsh ENOENT'));
    const addToast = vi.mocked(useToastStore.getState().addToast);

    render(
      <ProjectGroupContextMenu project={project}>
        <div>trigger</div>
      </ProjectGroupContextMenu>
    );
    await user.click(screen.getByRole('menuitem', { name: /test command/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(handleCreateError).not.toHaveBeenCalled();
    const [message, type, options] = addToast.mock.calls[0]!;
    expect(message).toBe(
      'Created workspace "Workspace", but "Test Command" couldn’t start: spawn zsh ENOENT'
    );
    expect(type).toBe('error');

    expect(mockShowTabInFullPane).not.toHaveBeenCalled();

    options?.action?.onClick();
    await waitFor(() => expect(mockShowTabInFullPane).toHaveBeenCalledWith('term-new'));
    expect(mockAddTerminalCommand).toHaveBeenCalledTimes(2);
    expect(mockCreateWorkspace).toHaveBeenCalledOnce();
  });

  it('leaves the created workspace intact when the command launch is canceled', async () => {
    const user = userEvent.setup();
    mockCreateWorkspace.mockImplementationOnce(async () => {
      mockSelectedWorkspaceId = 'ws-new';
      return { id: 'ws-new', name: 'Workspace', terminals: [] };
    });
    mockAddTerminalCommand.mockResolvedValueOnce(null);
    mockDeleteWorkspace.mockImplementationOnce(async () => {
      mockSelectedWorkspaceId = null;
    });

    render(
      <ProjectGroupContextMenu project={project}>
        <div>trigger</div>
      </ProjectGroupContextMenu>
    );

    await user.click(screen.getByRole('menuitem', { name: /test command/i }));

    await waitFor(() => expect(mockAddTerminalCommand).toHaveBeenCalledOnce());
    expect(mockRecordActionUsage).not.toHaveBeenCalled();
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
    expect(mockSelectWorkspace).not.toHaveBeenCalled();
  });

  it('forwards action.presetId and launchModeId when launching a prompt action', async () => {
    const user = userEvent.setup();

    render(
      <ProjectGroupContextMenu project={project}>
        <div>trigger</div>
      </ProjectGroupContextMenu>
    );

    await user.click(screen.getByRole('menuitem', { name: /test prompt/i }));

    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: 'preset-Y',
        launchModeId: 'mode-Y',
      })
    );
  });

  it('uses directory mode and hides branch actions for directory projects', async () => {
    const user = userEvent.setup();

    render(
      <ProjectGroupContextMenu project={directoryProject}>
        <div>trigger</div>
      </ProjectGroupContextMenu>
    );

    expect(screen.queryByText(/new on branch/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/workspace setup/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/clean up branches/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /new workspace/i }));

    expect(mockCreateWorkspace).toHaveBeenCalledWith({
      mode: 'directory',
      projectId: 'project-dir',
    });
  });

  it('launches directory project actions without worktree branch params', async () => {
    const user = userEvent.setup();

    render(
      <ProjectGroupContextMenu project={directoryProject}>
        <div>trigger</div>
      </ProjectGroupContextMenu>
    );

    await user.click(screen.getByRole('menuitem', { name: /test command/i }));

    expect(mockCreateWorkspace).toHaveBeenCalledWith({
      mode: 'directory',
      projectId: 'project-dir',
      presetId: 'preset-X',
      launchModeId: 'mode-X',
      defaultActionId: 'action-cmd',
    });
  });
});
