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

import { QuickCreateMenu } from '../../../../src/renderer/components/workspaces/QuickCreateMenu';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';
import { handleCreateError } from '../../../../src/renderer/utils/workspace-error';

const mockCreateWorkspace = vi.fn();
const mockAddTerminalCommand = vi.fn().mockResolvedValue({ id: 'term-new' });
const mockShowTabInFullPane = vi.hoisted(() => vi.fn());
const mockDeleteWorkspace = vi.fn().mockResolvedValue(undefined);
const mockSelectWorkspace = vi.fn().mockResolvedValue(undefined);
const mockRecordActionUsage = vi.fn().mockResolvedValue(undefined);
const mockProjects = vi.hoisted(() => [] as any[]);
const mockOpenFolder = vi.hoisted(() => vi.fn());
let mockConfig = { remoteBranchesExpanded: false };
let mockSelectedWorkspaceId: string | null = 'ws-existing';

vi.mock('../../../../src/shared/lib/random-names', () => ({
  generateBranchSuffix: vi.fn(() => 'swift-fox'),
  branchSuffixToName: vi.fn((s: string) => s),
}));

vi.mock('../../../../src/renderer/components/ui/button', () => ({
  Button: ({ children, onClick, ...props }: React.PropsWithChildren<any>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => {
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
  // Fire onOpenChange(true) on mount so picker callbacks (loadBranchesForProject)
  // run without us simulating a real Radix open transition.
  const Sub = ({
    children,
    onOpenChange,
  }: React.PropsWithChildren<{ onOpenChange?: (open: boolean) => void }>) => {
    React.useEffect(() => {
      onOpenChange?.(true);
    }, [onOpenChange]);
    return <>{children}</>;
  };
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Item,
    DropdownMenuLabel: Passthrough,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: Sub,
    DropdownMenuSubContent: Passthrough,
    DropdownMenuSubTrigger: Passthrough,
  };
});

vi.mock('../../../../src/renderer/lib/open-folder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/renderer/lib/open-folder')>()),
  openFolder: mockOpenFolder,
}));

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
  });
  return {
    useWorkspacesStore: Object.assign(getState, { getState }),
  };
});

vi.mock('../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: () => ({
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
  const getState = () => ({
    config: mockConfig,
    updateConfig: vi.fn().mockResolvedValue(undefined),
  });
  return { useConfigStore: Object.assign(getState, { getState }) };
});

vi.mock('../../../../src/renderer/stores/layout.store', () => {
  const state = { showTabInFullPane: mockShowTabInFullPane };
  const useLayoutStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state;
  return { useLayoutStore: Object.assign(useLayoutStore, { getState: () => state }) };
});

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: () => ({
    projects: mockProjects,
  }),
}));

vi.mock('../../../../src/renderer/stores/toast.store', () => {
  const state = { addToast: vi.fn() };
  return {
    useToastStore: Object.assign(() => state, { getState: () => state }),
  };
});

vi.mock('../../../../src/renderer/utils/workspace-error', () => ({
  handleCreateError: vi.fn(),
}));

vi.mock('../../../../src/renderer/lib/action-injection', () => ({
  injectActionContext: (content: string) => content,
  ACTION_TARGET_BRANCH_TOKEN: '{{target_branch}}',
  actionNeedsInjection: () => false,
}));

describe('QuickCreateMenu action wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = { remoteBranchesExpanded: false };
    mockSelectedWorkspaceId = 'ws-existing';
    mockProjects.splice(0, mockProjects.length, {
      id: 'project-1',
      name: 'Test Project',
      color: '#f00',
      defaultBranchPrefix: 'komla/',
      managed: false,
      repositoryPath: '/repos/test',
    });
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-new', name: 'Workspace', terminals: [] });
    mockAddTerminalCommand.mockResolvedValue({ id: 'term-new' });
    global.window.api = {
      listBranches: vi.fn().mockResolvedValue([]),
      fetchFromRemote: vi.fn().mockResolvedValue(undefined),
      getMainBranch: vi.fn().mockResolvedValue('main'),
    } as any;
  });

  it('names the icon-only menu trigger', () => {
    render(<QuickCreateMenu />);

    expect(screen.getByRole('button', { name: 'Quick create' })).toBeInTheDocument();
  });

  it('opens a folder as a workspace', async () => {
    const user = userEvent.setup();
    render(<QuickCreateMenu />);

    let finishOpening = () => {};
    mockOpenFolder.mockReturnValueOnce(new Promise<void>((resolve) => (finishOpening = resolve)));
    await user.click(screen.getByRole('menuitem', { name: 'Open Folder…' }));

    expect(mockOpenFolder).toHaveBeenCalledOnce();
    // Nothing else starts until the folder has opened.
    expect(screen.getByRole('menuitem', { name: 'Open Folder…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Quick create' })).toBeDisabled();
    finishOpening();
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Open Folder…' })).toBeEnabled()
    );
  });

  it('uses the canonical action category names', async () => {
    render(<QuickCreateMenu />);

    await waitFor(() => {
      expect(document.body).toHaveTextContent('Terminal Commands');
      expect(document.body).toHaveTextContent('Saved Prompts');
    });
  });

  it('forwards action.presetId and launchModeId when launching a command action', async () => {
    const user = userEvent.setup();

    render(<QuickCreateMenu />);

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

    render(<QuickCreateMenu />);

    await user.click(screen.getByRole('menuitem', { name: /test command/i }));

    await waitFor(() => expect(mockAddTerminalCommand).toHaveBeenCalledOnce());
    expect(mockRecordActionUsage).not.toHaveBeenCalled();
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
    expect(mockSelectWorkspace).not.toHaveBeenCalled();
  });

  it('says the workspace exists when only its command fails, and retries just the command', async () => {
    const user = userEvent.setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAddTerminalCommand.mockRejectedValueOnce(
      new Error("Error invoking remote method 'terminal:add': Error: spawn zsh ENOENT")
    );
    const addToast = vi.mocked(useToastStore.getState().addToast);

    render(<QuickCreateMenu />);
    await user.click(screen.getByRole('menuitem', { name: /test command/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(handleCreateError).not.toHaveBeenCalled();
    expect(mockRecordActionUsage).not.toHaveBeenCalled();
    const [message, type, options] = addToast.mock.calls[0]!;
    expect(message).toBe(
      'Created workspace "Workspace", but "Test Command" couldn’t start: spawn zsh ENOENT'
    );
    expect(type).toBe('error');

    expect(mockShowTabInFullPane).not.toHaveBeenCalled();

    options?.action?.onClick();
    await waitFor(() => expect(mockShowTabInFullPane).toHaveBeenCalledWith('term-new'));
    expect(mockAddTerminalCommand).toHaveBeenCalledTimes(2);
    expect(mockAddTerminalCommand).toHaveBeenLastCalledWith(
      'ws-new',
      'Test Command',
      'echo hi',
      'tab',
      undefined
    );
    expect(mockCreateWorkspace).toHaveBeenCalledOnce();
  });

  it('forwards action.presetId and launchModeId when launching a prompt action', async () => {
    const user = userEvent.setup();

    render(<QuickCreateMenu />);

    await user.click(screen.getByRole('menuitem', { name: /test prompt/i }));

    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: 'preset-Y',
        launchModeId: 'mode-Y',
      })
    );
  });

  it('creates directory workspaces for directory projects', async () => {
    const user = userEvent.setup();
    mockProjects.splice(0, mockProjects.length, {
      id: 'project-dir',
      name: 'Directory Project',
      kind: 'directory',
      color: '#0f0',
      managed: false,
      repositoryPath: '/plain/folder',
    });

    render(<QuickCreateMenu />);

    await user.click(screen.getByRole('menuitem', { name: /directory project/i }));

    expect(mockCreateWorkspace).toHaveBeenCalledWith({
      mode: 'directory',
      projectId: 'project-dir',
    });
  });

  it('keeps directory projects out of branch quick-create pickers', () => {
    mockProjects.splice(
      0,
      mockProjects.length,
      {
        id: 'project-git',
        name: 'Git Project',
        color: '#f00',
        managed: false,
        repositoryPath: '/repos/test',
      },
      {
        id: 'project-dir',
        name: 'Directory Project',
        kind: 'directory',
        color: '#0f0',
        managed: false,
        repositoryPath: '/plain/folder',
      }
    );

    render(<QuickCreateMenu />);

    expect(screen.getAllByText('Directory Project')).toHaveLength(1);
  });

  it('launches directory project actions without worktree branch params', async () => {
    const user = userEvent.setup();
    mockProjects.splice(0, mockProjects.length, {
      id: 'project-dir',
      name: 'Directory Project',
      kind: 'directory',
      color: '#0f0',
      managed: false,
      repositoryPath: '/plain/folder',
    });

    render(<QuickCreateMenu />);

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

/**
 * Branch-picker coverage for the "New from Branch..." menu split.
 *
 * The branches state is shared between the two pickers ("New from Branch..."
 * and "New on Branch..."), so each branch row appears twice in the rendered
 * DOM. The "New from" picker renders first, the "New on" picker second; with
 * `remoteBranchesExpanded: true`, the order inside each picker is:
 * remote-only branches first, then local. We rely on that order to
 * disambiguate clicks via getAllByRole indices.
 */
describe('QuickCreateMenu branch picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = { remoteBranchesExpanded: true };
    mockProjects.splice(0, mockProjects.length, {
      id: 'project-1',
      name: 'Test Project',
      color: '#f00',
      defaultBranchPrefix: 'komla/',
      managed: false,
      repositoryPath: '/repos/test',
    });
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-new', name: 'Workspace', terminals: [] });
    global.window.api = {
      listBranches: vi.fn().mockResolvedValue([
        { name: 'main', isRemoteOnly: false },
        { name: 'feature-x', isRemoteOnly: true },
      ]),
      fetchFromRemote: vi.fn().mockResolvedValue(undefined),
      getMainBranch: vi.fn().mockResolvedValue('main'),
    } as any;
  });

  it('forks a workspace from a local base branch without origin/ qualification', async () => {
    const user = userEvent.setup();
    render(<QuickCreateMenu />);

    // 'main' menuitems, in DOM order: [0] newFrom picker, [1] open picker.
    const mainRows = await screen.findAllByRole('menuitem', { name: 'main' });
    await user.click(mainRows[0]);

    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'main',
        autoResolveBranchConflicts: true,
      })
    );
    expect(mockCreateWorkspace.mock.calls[0][0]).not.toHaveProperty('useExactBranchName', true);
    expect(window.api.fetchFromRemote).not.toHaveBeenCalled();
  });

  it('forks a workspace from a remote-only base branch and pre-fetches first', async () => {
    const user = userEvent.setup();
    render(<QuickCreateMenu />);

    // feature-x rows: index 0 = newFrom, index 2 = open
    const featureRows = await screen.findAllByRole('menuitem', { name: 'feature-x' });
    await user.click(featureRows[0]);

    expect(window.api.fetchFromRemote).toHaveBeenCalledWith('/repos/test');
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'origin/feature-x',
      })
    );
    // The misleading legacy flag must not be forwarded for the fromBranch path.
    expect(mockCreateWorkspace.mock.calls[0][0]).not.toHaveProperty('fetchRemote');
  });

  it('opens an existing local branch without applying origin/ qualification', async () => {
    const user = userEvent.setup();
    render(<QuickCreateMenu />);

    // `main` rows: [0] newFrom picker, [1] open picker.
    const mainRows = await screen.findAllByRole('menuitem', { name: 'main' });
    await user.click(mainRows[1]);

    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: 'main',
        useExactBranchName: true,
      })
    );
    const call = mockCreateWorkspace.mock.calls[0][0];
    expect(call.baseBranch).toBeUndefined();
    expect(window.api.fetchFromRemote).not.toHaveBeenCalled();
  });

  it('launches a chevron command on a remote-only fork with origin/ qualification', async () => {
    const user = userEvent.setup();
    render(<QuickCreateMenu />);

    // Wait for branch rows to render, then find the command items.
    await screen.findAllByRole('menuitem', { name: 'feature-x' });

    // 'Test Command' menuitems, in DOM order:
    //   [0] per-project clean sub
    //   [1] newFrom > feature-x chevron
    //   [2] newFrom > main chevron
    //   [3] open > feature-x chevron
    //   [4] open > main chevron
    const cmdItems = screen.getAllByRole('menuitem', { name: /test command/i });
    await user.click(cmdItems[1]);

    expect(window.api.fetchFromRemote).toHaveBeenCalledWith('/repos/test');
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'origin/feature-x',
        presetId: 'preset-X',
        launchModeId: 'mode-X',
      })
    );
  });

  it('leaves an existing-branch workspace intact when its command launch is canceled', async () => {
    const user = userEvent.setup();
    mockAddTerminalCommand.mockResolvedValueOnce(null);
    render(<QuickCreateMenu />);

    await screen.findAllByRole('menuitem', { name: 'main' });
    const cmdItems = screen.getAllByRole('menuitem', { name: /test command/i });
    await user.click(cmdItems[4]);

    await waitFor(() => expect(mockAddTerminalCommand).toHaveBeenCalledOnce());
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
  });

  it('launches a chevron prompt on a remote-only fork with origin/ qualification', async () => {
    const user = userEvent.setup();
    render(<QuickCreateMenu />);

    await screen.findAllByRole('menuitem', { name: 'feature-x' });

    // Same indexing scheme as Test Command above.
    const promptItems = screen.getAllByRole('menuitem', { name: /test prompt/i });
    await user.click(promptItems[1]);

    expect(window.api.fetchFromRemote).toHaveBeenCalledWith('/repos/test');
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'origin/feature-x',
        presetId: 'preset-Y',
        launchModeId: 'mode-Y',
      })
    );
  });

  it('fetches a remote-only branch before opening it with a chevron prompt', async () => {
    const user = userEvent.setup();
    render(<QuickCreateMenu />);

    await screen.findAllByRole('menuitem', { name: 'feature-x' });

    // Same indexing scheme as Test Command above: [3] = open > feature-x chevron.
    const promptItems = screen.getAllByRole('menuitem', { name: /test prompt/i });
    await user.click(promptItems[3]);

    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: 'feature-x',
        useExactBranchName: true,
        fetchRemote: true,
        presetId: 'preset-Y',
      })
    );
    expect(mockCreateWorkspace.mock.calls[0][0].baseBranch).toBeUndefined();
  });

  it('opens a local branch with a chevron prompt without fetching', async () => {
    const user = userEvent.setup();
    render(<QuickCreateMenu />);

    await screen.findAllByRole('menuitem', { name: 'main' });

    // [4] = open > main chevron.
    const promptItems = screen.getAllByRole('menuitem', { name: /test prompt/i });
    await user.click(promptItems[4]);

    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'main', useExactBranchName: true })
    );
    expect(mockCreateWorkspace.mock.calls[0][0].fetchRemote).toBeUndefined();
  });
});
