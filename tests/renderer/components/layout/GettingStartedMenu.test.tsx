/**
 * @vitest-environment jsdom
 */
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentPresetsStore } from '../../../../src/renderer/stores/agent-presets.store';
import { useDialogsStore } from '../../../../src/renderer/stores/dialogs.store';
import { useLayoutStore } from '../../../../src/renderer/stores/layout.store';
import { useSshHostDialogStore } from '../../../../src/renderer/stores/ssh-host-dialog.store';
import { useStatusBarCustomizeStore } from '../../../../src/renderer/stores/status-bar-customize.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';

const mockConfigState = vi.hoisted(() => ({
  config: {
    onboardingTipsDismissed: false,
  } as Record<string, unknown>,
  updateConfig: vi.fn().mockResolvedValue(true),
}));

const mockOfferKomlaSkillInstall = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/renderer/stores/agent-launch-defaults-dialog.store', () => ({
  offerKomlaSkillInstall: mockOfferKomlaSkillInstall,
}));

const popoverState = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
}));

vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: Object.assign(() => mockConfigState, { getState: () => mockConfigState }),
}));

vi.mock('../../../../src/renderer/components/ui/popover', () => ({
  Popover: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    popoverState.onOpenChange = onOpenChange;
    return (
      <div data-testid="popover" data-open={open}>
        {children}
      </div>
    );
  },
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-trigger" onClick={() => popoverState.onOpenChange?.(true)}>
      {children}
    </div>
  ),
  PopoverAnchor: () => <div data-testid="popover-anchor" />,
  PopoverContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="popover-content" className={className}>
      {children}
    </div>
  ),
}));

vi.mock('../../../../src/renderer/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
    ({ children, ...props }, ref) => (
      <button ref={ref} {...props}>
        {children}
      </button>
    )
  ),
}));

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Mock window.api
Object.assign(window as any, {
  api: {
    createWindow: vi.fn().mockResolvedValue('window-id'),
    getNotificationHookDetails: vi.fn().mockResolvedValue({ isConfigured: false }),
    getCodexNotificationHookDetails: vi.fn().mockResolvedValue({ isConfigured: false }),
    getAntigravityNotificationHookDetails: vi.fn().mockResolvedValue({ isConfigured: false }),
    getOpenCodeNotificationHookDetails: vi.fn().mockResolvedValue({ isConfigured: false }),
    getMcpStatus: vi.fn().mockResolvedValue({ isConfigured: false }),
    getKomlaSkillStatus: vi.fn(),
    enableKomlaSkill: vi.fn().mockResolvedValue(undefined),
    voiceGetModelStatus: vi.fn().mockResolvedValue('not-downloaded'),
    listSshHosts: vi.fn().mockResolvedValue([]),
    listAutomations: vi.fn().mockResolvedValue([]),
    pairedDevicesList: vi.fn().mockResolvedValue([]),
    getServerPort: vi.fn().mockResolvedValue(52863),
    getBasePath: vi.fn().mockResolvedValue('/Users/test/.komla'),
  },
});

// The agents whose Komla skill is on; the rest report it off.
function skillConfigured(isConfigured: boolean) {
  (window as any).api.getKomlaSkillStatus.mockResolvedValue({ isConfigured, paths: [] });
}

const defaultProps = {
  onOpenShortcuts: vi.fn(),
  onOpenSettingsTab: vi.fn(),
  onOpenFeedback: vi.fn(),
  onOpenNewWorkspace: vi.fn(),
};

let GettingStartedMenu: typeof import('../../../../src/renderer/components/layout/GettingStartedMenu').GettingStartedMenu;

describe('GettingStartedMenu', () => {
  beforeAll(async () => {
    ({ GettingStartedMenu } =
      await import('../../../../src/renderer/components/layout/GettingStartedMenu'));
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    skillConfigured(false);
    useSshHostDialogStore.setState({ open: false, request: null, requestId: 0 });
    mockConfigState.config = {
      onboardingTipsDismissed: false,
    };
    mockConfigState.updateConfig = vi.fn().mockResolvedValue(true);
    popoverState.onOpenChange = undefined;
  });

  // The title bar owns whether Tips is open.
  function ControlledMenu(props: object) {
    const [open, setOpen] = React.useState(false);
    return <GettingStartedMenu {...defaultProps} open={open} onOpenChange={setOpen} {...props} />;
  }

  async function renderComponent(props = {}) {
    return render(<ControlledMenu {...props} />);
  }

  it('shows the available tips without the workspace title refresh tip', async () => {
    await renderComponent();
    expect(screen.getByText('Komla CLI demo')).toBeTruthy();
    expect(screen.queryByText('MCP demo')).toBeNull();
    expect(screen.getByText('Run project setup skill')).toBeTruthy();
    expect(screen.getByText('Set up agent integrations')).toBeTruthy();
    expect(screen.getByText('Get notified when your agents finish or need you')).toBeTruthy();
    expect(screen.getByText('Install the Komla skill')).toBeTruthy();
    expect(screen.getByText('Teach your agents how to use the Komla CLI')).toBeTruthy();
    expect(screen.queryByText('Enable notifications')).toBeNull();
    expect(screen.queryByText('Enable MCP server')).toBeNull();
    expect(screen.getByText('Set up voice dictation')).toBeTruthy();
    expect(screen.getByText('Multi-window support')).toBeTruthy();
    expect(screen.getByText('Learn keyboard shortcuts')).toBeTruthy();
    expect(screen.getByText('Share feedback')).toBeTruthy();
    expect(screen.queryByText('Keep workspace titles fresh')).toBeNull();
    expect(
      screen.queryByText(
        'Prompt-submit hooks let Komla generate or refresh titles from prompts you send'
      )
    ).toBeNull();
    expect(screen.getByText('Done with a workspace?')).toBeTruthy();
  });

  it('shows self-integration tip when onboarding created it', async () => {
    mockConfigState.config = {
      onboardingTipsDismissed: false,
      selfIntegrationTipCreated: true,
    };
    await renderComponent();
    expect(screen.getByText('Integrate your agent with Komla')).toBeTruthy();
  });

  it('marks self-integration tip done after onboarding launch', async () => {
    mockConfigState.config = {
      onboardingTipsDismissed: false,
      selfIntegrationTipCreated: true,
      selfIntegrationTipCompleted: true,
    };
    await renderComponent();
    openPopover();
    await waitFor(() => {
      expect(rowFor('Integrate your agent with Komla')?.className).toContain('opacity-60');
    });
  });

  it('marks self-integration tip done when launched from the menu', async () => {
    mockConfigState.config = {
      onboardingTipsDismissed: false,
      selfIntegrationTipCreated: true,
    };
    (window as any).api.getMcpStatus = vi
      .fn()
      .mockResolvedValue({ isConfigured: false, generic: { integrationPrompt: 'integrate me' } });
    const onOpenNewWorkspace = vi.fn();
    await renderComponent({ onOpenNewWorkspace });
    fireEvent.click(rowFor('Integrate your agent with Komla')!);
    await waitFor(() =>
      expect(mockConfigState.updateConfig).toHaveBeenCalledWith({
        selfIntegrationTipCompleted: true,
        selfSetupNudgePending: false,
      })
    );
    expect(onOpenNewWorkspace).toHaveBeenCalled();
  });

  describe('with agents that set themselves up', () => {
    const preset = (id: string, name: string, openCommand: string) => ({
      id,
      name,
      openCommand,
      continueCommand: '',
      promptCommand: '',
      launchModes: [],
      isBuiltin: false,
    });
    const presets = [
      preset('preset-claude', 'Claude Code', 'claude'),
      preset('preset-cursor', 'Cursor CLI', 'cursor-agent'),
      preset('preset-pi', 'Pi', 'pi'),
    ];
    const workspace = (backend?: { kind: 'ssh' }) => ({
      id: 'ws-1',
      name: 'login-fix',
      workingDirectory: '/repo/login-fix',
      isWorktree: true,
      projectId: 'project-1',
      terminals: [],
      windowId: null,
      categoryId: null,
      createdAt: 0,
      lastActivityAt: 0,
      order: 0,
      status: 'running',
      ...(backend && { backend }),
    });

    beforeEach(() => {
      mockConfigState.config = { onboardingTipsDismissed: false, selfIntegrationTipCreated: true };
      Object.assign((window as any).api, {
        getMcpStatus: vi.fn().mockResolvedValue({
          isConfigured: false,
          generic: { integrationPrompt: 'integrate me' },
        }),
        getPresets: vi.fn().mockResolvedValue(presets),
        getActivePreset: vi.fn().mockResolvedValue(presets[0]),
        getActivePresets: vi
          .fn()
          .mockResolvedValue(presets.map((p, i) => ({ presetId: p.id, lastUsedAt: 10 - i }))),
        addAgentTab: vi.fn(async (_ws: string, _prompt: string, _mode: unknown, id: string) => ({
          id: `terminal-${id}`,
        })),
        getWorkspaces: vi.fn(async () => useWorkspacesStore.getState().workspaces),
      });
      useWorkspacesStore.setState({
        workspaces: [workspace() as never],
        selectedWorkspaceId: 'ws-1',
      });
      useAgentPresetsStore.setState({
        presets,
        activePresets: presets.map((p, i) => ({ presetId: p.id, lastUsedAt: 10 - i })),
      });
      useLayoutStore.setState({ tabsByWorkspace: {} });
      useToastStore.setState({ toasts: [] });
    });

    afterEach(() => {
      for (const name of ['getPresets', 'getActivePreset', 'getActivePresets', 'addAgentTab']) {
        delete (window as any).api[name];
      }
      useWorkspacesStore.setState({ workspaces: [], selectedWorkspaceId: null });
      useAgentPresetsStore.setState({ presets: [], activePresets: [], activePreset: null });
    });

    it('opens a setup tab there for each agent left ticked', async () => {
      const onOpenNewWorkspace = vi.fn();
      await renderComponent({ onOpenNewWorkspace });
      openPopover();
      fireEvent.click(rowFor('Integrate Cursor CLI and Pi with Komla')!);
      const agents = await screen.findByRole('list', { name: 'Agents to set up' });
      expect(
        within(agents)
          .getAllByRole('checkbox')
          .map((box) => box.closest('label')?.textContent)
      ).toEqual(['Cursor CLI', 'Pi']);

      fireEvent.click(screen.getByRole('checkbox', { name: 'Pi' }));
      fireEvent.click(screen.getByRole('button', { name: 'Set up Cursor CLI' }));

      await waitFor(() =>
        expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toEqual([
          'terminal-preset-cursor',
        ])
      );
      expect((window as any).api.addAgentTab).toHaveBeenCalledOnce();
      // Setup leaves the workspace's own agent, and the one New Workspace picks, as they were.
      expect((window as any).api.addAgentTab).toHaveBeenCalledWith(
        'ws-1',
        'integrate me',
        undefined,
        'preset-cursor',
        { keepWorkspaceAgent: true }
      );
      expect(mockConfigState.updateConfig).toHaveBeenCalledWith({ selfSetupNudgePending: false });
      expect(mockConfigState.updateConfig).toHaveBeenCalledWith({
        selfIntegrationTipCompleted: true,
      });
      expect(onOpenNewWorkspace).not.toHaveBeenCalled();
    });

    it('says so when a setup tab could not open', async () => {
      (window as any).api.addAgentTab.mockRejectedValue(new Error('pty failed'));
      await renderComponent();
      openPopover();
      fireEvent.click(rowFor('Integrate Cursor CLI and Pi with Komla')!);

      fireEvent.click(await screen.findByRole('button', { name: 'Set up Cursor CLI and Pi' }));

      await waitFor(() =>
        expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
          'Couldn’t start agent setup: pty failed',
        ])
      );
      expect(mockConfigState.updateConfig).not.toHaveBeenCalledWith({
        selfIntegrationTipCompleted: true,
      });
    });

    it('names those agents, and says why', async () => {
      await renderComponent();

      expect(screen.getByText('Integrate Cursor CLI and Pi with Komla')).toBeTruthy();
      expect(
        screen.getByText(
          'They have no one-click setup, so they wire up notifications & the Komla skill themselves'
        )
      ).toBeTruthy();
      expect(screen.queryByText('Integrate your agent with Komla')).toBeNull();
    });

    it.each([
      ['no workspace is open', null],
      ['an SSH workspace is open', 'ssh'],
    ])('opens New Workspace with the ticked agents when %s', async (_case, backend) => {
      useWorkspacesStore.setState(
        backend
          ? { workspaces: [workspace({ kind: 'ssh' }) as never] }
          : { workspaces: [], selectedWorkspaceId: null }
      );
      const opened = vi.fn();
      window.addEventListener('open-new-workspace-dialog', opened);
      try {
        await renderComponent();
        openPopover();
        fireEvent.click(rowFor('Integrate Cursor CLI and Pi with Komla')!);
        expect(screen.getByText(/^Opens New Workspace with the setup prompt/)).toBeTruthy();

        fireEvent.click(screen.getByRole('checkbox', { name: 'Cursor CLI' }));
        fireEvent.click(screen.getByRole('button', { name: 'Set up Pi' }));

        await waitFor(() => expect(opened).toHaveBeenCalledOnce());
        const prefill = (opened.mock.calls[0][0] as CustomEvent).detail;
        expect(prefill).toEqual({ presetIds: ['preset-pi'], onLaunch: expect.any(Function) });
        expect(useDialogsStore.getState().newWorkspaceDialogPrompt).toBe('integrate me');
        expect((window as any).api.addAgentTab).not.toHaveBeenCalled();
        // Setup is done once New Workspace starts the agent, but launching it needs no nudge.
        expect(mockConfigState.updateConfig).toHaveBeenCalledWith({ selfSetupNudgePending: false });
        expect(mockConfigState.updateConfig).not.toHaveBeenCalledWith({
          selfIntegrationTipCompleted: true,
        });
        prefill.onLaunch(['preset-pi']);
        expect(mockConfigState.updateConfig).toHaveBeenCalledWith({
          selfIntegrationTipCompleted: true,
        });
      } finally {
        window.removeEventListener('open-new-workspace-dialog', opened);
      }
    });

    it('names the agents New Workspace did not start, and leaves the tip to do', async () => {
      useWorkspacesStore.setState({ workspaces: [], selectedWorkspaceId: null });
      const opened = vi.fn();
      window.addEventListener('open-new-workspace-dialog', opened);
      try {
        await renderComponent();
        openPopover();
        fireEvent.click(rowFor('Integrate Cursor CLI and Pi with Komla')!);
        fireEvent.click(await screen.findByRole('button', { name: 'Set up Cursor CLI and Pi' }));
        await waitFor(() => expect(opened).toHaveBeenCalledOnce());

        // A folder project, say, starts one agent per launch.
        (opened.mock.calls[0][0] as CustomEvent).detail.onLaunch(['preset-cursor']);

        expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
          'Pi wasn’t started. Set it up from Tips.',
        ]);
        expect(mockConfigState.updateConfig).not.toHaveBeenCalledWith({
          selfIntegrationTipCompleted: true,
        });
      } finally {
        window.removeEventListener('open-new-workspace-dialog', opened);
      }
    });
  });

  describe('the customize tip', () => {
    const workspace = (backend?: { kind: 'ssh' }) => ({
      id: 'ws-1',
      name: 'login-fix',
      workingDirectory: '/repo/login-fix',
      isWorktree: true,
      projectId: 'project-1',
      terminals: [],
      windowId: null,
      categoryId: null,
      createdAt: 0,
      lastActivityAt: 0,
      order: 0,
      status: 'running',
      ...(backend && { backend }),
    });

    beforeEach(() => {
      Object.assign((window as any).api, {
        addAgentTab: vi.fn(async () => ({ id: 'terminal-customize' })),
        getWorkspaces: vi.fn(async () => useWorkspacesStore.getState().workspaces),
      });
      useWorkspacesStore.setState({
        workspaces: [workspace() as never],
        selectedWorkspaceId: 'ws-1',
      });
      useLayoutStore.setState({ tabsByWorkspace: {} });
      useDialogsStore.setState({ newWorkspaceDialogPrompt: '' });
      useToastStore.setState({ toasts: [] });
    });

    afterEach(() => {
      delete (window as any).api.addAgentTab;
      delete (window as any).api.getWorkspaces;
      useWorkspacesStore.setState({ workspaces: [], selectedWorkspaceId: null });
    });

    it("opens the workspace's agent in a new tab with the customize skill", async () => {
      const onOpenNewWorkspace = vi.fn();
      await renderComponent({ onOpenNewWorkspace });
      fireEvent.click(rowFor('Customize Komla with your agent')!);

      await waitFor(() =>
        expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toEqual(['terminal-customize'])
      );
      const [workspaceId, prompt, ...rest] = (window as any).api.addAgentTab.mock.calls[0];
      expect(workspaceId).toBe('ws-1');
      expect(prompt).toContain('komla skill customize');
      expect(rest.filter((arg: unknown) => arg !== undefined)).toEqual([]);
      expect(onOpenNewWorkspace).not.toHaveBeenCalled();
    });

    it('opens in an SSH workspace too, where the Komla CLI reaches Komla', async () => {
      useWorkspacesStore.setState({ workspaces: [workspace({ kind: 'ssh' }) as never] });
      await renderComponent();
      fireEvent.click(rowFor('Customize Komla with your agent')!);

      await waitFor(() =>
        expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toEqual(['terminal-customize'])
      );
    });

    it('starts from New Workspace when no workspace is open', async () => {
      useWorkspacesStore.setState({ workspaces: [], selectedWorkspaceId: null });
      const onOpenNewWorkspace = vi.fn();
      await renderComponent({ onOpenNewWorkspace });
      fireEvent.click(rowFor('Customize Komla with your agent')!);

      await waitFor(() => expect(onOpenNewWorkspace).toHaveBeenCalledOnce());
      expect(useDialogsStore.getState().newWorkspaceDialogPrompt).toContain(
        'komla skill customize'
      );
      expect((window as any).api.addAgentTab).not.toHaveBeenCalled();
    });

    it('says so when the tab could not open', async () => {
      (window as any).api.addAgentTab.mockRejectedValue(new Error('pty failed'));
      await renderComponent();
      fireEvent.click(rowFor('Customize Komla with your agent')!);

      await waitFor(() =>
        expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
          'Couldn’t open the agent: pty failed',
        ])
      );
    });
  });

  it('calls onOpenShortcuts when shortcuts tip is clicked', async () => {
    const onOpenShortcuts = vi.fn();
    await renderComponent({ onOpenShortcuts });
    fireEvent.click(rowFor('Learn keyboard shortcuts')!);
    expect(onOpenShortcuts).toHaveBeenCalled();
  });

  it('calls onOpenFeedback when feedback tip is clicked', async () => {
    const onOpenFeedback = vi.fn();
    await renderComponent({ onOpenFeedback });
    fireEvent.click(rowFor('Share feedback')!);
    expect(onOpenFeedback).toHaveBeenCalled();
  });

  it('calls onOpenNewWorkspace when demo tip is clicked', async () => {
    const onOpenNewWorkspace = vi.fn();
    await renderComponent({ onOpenNewWorkspace });
    fireEvent.click(rowFor('Komla CLI demo')!);
    await waitFor(() => expect(onOpenNewWorkspace).toHaveBeenCalled());
  });

  it('calls onOpenNewWorkspace when project-setup tip is clicked', async () => {
    const onOpenNewWorkspace = vi.fn();
    await renderComponent({ onOpenNewWorkspace });
    fireEvent.click(rowFor('Run project setup skill')!);
    await waitFor(() => expect(onOpenNewWorkspace).toHaveBeenCalled());
  });

  it('calls onOpenSettingsTab with integrations when agent integrations tip is clicked', async () => {
    const onOpenSettingsTab = vi.fn();
    await renderComponent({ onOpenSettingsTab });
    fireEvent.click(rowFor('Set up agent integrations')!);
    expect(onOpenSettingsTab).toHaveBeenCalledWith('integrations', { sshSetupSource: 'tips' });
  });

  describe('Komla skill tip', () => {
    it('asks before installing the skill', async () => {
      const onOpenSettingsTab = vi.fn();
      await renderComponent({ onOpenSettingsTab });
      openPopover();
      await waitFor(() => expect((window as any).api.getKomlaSkillStatus).toHaveBeenCalled());
      expect(within(rowFor('Install the Komla skill')!).getByText('Install')).toBeTruthy();

      fireEvent.click(rowFor('Install the Komla skill')!);

      expect(mockOfferKomlaSkillInstall).toHaveBeenCalledOnce();
      expect((window as any).api.enableKomlaSkill).not.toHaveBeenCalled();
      expect(screen.getByTestId('popover').getAttribute('data-open')).toBe('false');
      expect(onOpenSettingsTab).not.toHaveBeenCalled();
    });

    it('opens Integrations once the skill is installed', async () => {
      skillConfigured(true);
      const onOpenSettingsTab = vi.fn();
      await renderComponent({ onOpenSettingsTab });
      openPopover();
      await waitFor(() => {
        expect(rowFor('Install the Komla skill')?.className).toContain('opacity-60');
      });

      fireEvent.click(rowFor('Install the Komla skill')!);

      expect(onOpenSettingsTab).toHaveBeenCalledWith('integrations', { sshSetupSource: 'tips' });
      expect(mockOfferKomlaSkillInstall).not.toHaveBeenCalled();
    });
  });

  it('leaves the SSH setup guide link out of the SSH host tip', async () => {
    await renderComponent();
    expect(screen.queryByRole('link', { name: /Setup guide/ })).toBeNull();
  });

  it('opens the add SSH host dialog attributed to Tips when the SSH host tip is clicked', async () => {
    await renderComponent();
    fireEvent.click(rowFor('Set up an SSH host')!);
    expect(useSshHostDialogStore.getState().request).toMatchObject({ kind: 'add', source: 'tips' });
    expect(defaultProps.onOpenSettingsTab).not.toHaveBeenCalledWith('ssh', expect.anything());
  });

  it('calls onOpenSettingsTab with voice when voice dictation tip is clicked', async () => {
    const onOpenSettingsTab = vi.fn();
    await renderComponent({ onOpenSettingsTab });
    fireEvent.click(rowFor('Set up voice dictation')!);
    expect(onOpenSettingsTab).toHaveBeenCalledWith('voice', { sshSetupSource: 'tips' });
  });

  it('calls onOpenSettingsTab with automations when the automations tip is clicked', async () => {
    const onOpenSettingsTab = vi.fn();
    await renderComponent({ onOpenSettingsTab });
    fireEvent.click(rowFor('Schedule an automation')!);
    expect(onOpenSettingsTab).toHaveBeenCalledWith('automations', { sshSetupSource: 'tips' });
  });

  it('opens the status bar customize panel, turning the bar on if it is off', async () => {
    useStatusBarCustomizeStore.setState({ open: false, anchor: null });
    mockConfigState.config = { showStatusBar: false };
    await renderComponent();

    fireEvent.click(rowFor('Customize the status bar')!);

    expect(mockConfigState.updateConfig).toHaveBeenCalledWith({ showStatusBar: true });
    expect(useStatusBarCustomizeStore.getState()).toMatchObject({ open: true, anchor: null });
  });

  it('opens Settings → Remote when the remote control tip is clicked', async () => {
    const onOpenSettingsTab = vi.fn();
    await renderComponent({ onOpenSettingsTab });
    fireEvent.click(rowFor('Use Komla from your phone')!);
    expect(onOpenSettingsTab).toHaveBeenCalledWith('remote', { sshSetupSource: 'tips' });
  });

  it('offers SSH, not a sandbox, in the setup section', async () => {
    await renderComponent();
    const row = rowFor('Set up an SSH host')!;
    expect(row.closest('section')?.textContent).toContain('Set up Komla');
    expect(row.textContent).toContain('a VM or a container');
    expect(screen.queryByRole('button', { name: 'Local VM' })).toBeNull();
  });

  it('opens a new window when multi-window tip is clicked', async () => {
    await renderComponent();
    fireEvent.click(screen.getByText('Try'));
    expect((window as any).api.createWindow).toHaveBeenCalled();
  });

  it('marks Tips as new until the first open and persists discovery', async () => {
    const view = await renderComponent();
    expect(screen.getByRole('button', { name: 'Tips' })).toHaveAccessibleDescription(
      'New: setup steps and demos'
    );
    openPopover();
    expect(screen.getByRole('button', { name: 'Tips' })).toHaveAccessibleDescription('');
    expect(mockConfigState.updateConfig).toHaveBeenCalledWith({ onboardingTipsViewed: true });
    view.unmount();
    mockConfigState.config.onboardingTipsViewed = true;
    await renderComponent();
    expect(screen.getByRole('button', { name: 'Tips' })).toHaveAccessibleDescription('');
  });

  it('has a single entry point that is always called Tips', async () => {
    await renderComponent();

    expect(screen.getAllByRole('button', { name: /tips/i })).toHaveLength(1);
    expect(screen.queryByText('Demo and setup tips')).toBeNull();
    expect(screen.queryByText('Tips & shortcuts')).toBeNull();
    expect(screen.queryByText('Setup, demos, and shortcuts')).toBeNull();
    expect(screen.getByTestId('popover-content')).toHaveTextContent(/^Tips/);
  });

  it('finishes the intro after setup wherever Tips opens', async () => {
    mockConfigState.config.tipsIntroPending = true;
    const props = { ...defaultProps, anchorRef: { current: null } };
    const { rerender } = render(<GettingStartedMenu {...props} open={false} />);
    expect(mockConfigState.updateConfig).not.toHaveBeenCalledWith({ tipsIntroPending: false });

    // Opened from the settings menu, away from the status bar's pointer.
    rerender(<GettingStartedMenu {...props} open />);
    expect(mockConfigState.updateConfig).toHaveBeenCalledWith({ tipsIntroPending: false });
  });

  it('opens beside an anchor instead of its own button', async () => {
    const onOpenChange = vi.fn();
    const props = { ...defaultProps, anchorRef: { current: null }, onOpenChange };
    const { rerender } = render(<GettingStartedMenu {...props} open={false} />);

    expect(screen.queryByRole('button', { name: 'Tips' })).toBeNull();
    expect(screen.getByTestId('popover-anchor')).toBeTruthy();
    expect(mockConfigState.updateConfig).not.toHaveBeenCalled();

    // Opened by the title bar's More menu, which never goes through the popover.
    rerender(<GettingStartedMenu {...props} open />);
    expect(screen.getByTestId('popover').getAttribute('data-open')).toBe('true');
    expect(mockConfigState.updateConfig).toHaveBeenCalledWith({ onboardingTipsViewed: true });

    fireEvent.click(screen.getByText('Learn keyboard shortcuts'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses the shared popover surface', async () => {
    await renderComponent();

    expect(screen.getByTestId('popover-content')).not.toHaveClass('bg-secondary');
    expect(screen.getByTestId('popover-content').className).not.toMatch(/ring-/);
  });

  it('shows only the bulb, without a label', async () => {
    await renderComponent();

    expect(screen.getByRole('button', { name: 'Tips' })).toHaveTextContent(/^$/);
  });

  it('offers to hide its button from the status bar', async () => {
    await renderComponent({ onHideButton: vi.fn() });
    openPopover();

    expect(screen.getByRole('button', { name: 'Hide from status bar' })).toBeInTheDocument();
    expect(screen.getByText('Tips stays in the settings menu')).toBeInTheDocument();
  });

  it('lists setup in one group by importance, and keeps optional features collapsed', async () => {
    mockConfigState.config = { selfIntegrationTipCreated: true };
    await renderComponent();
    const titles = (heading: string) =>
      [...screen.getByText(heading).parentElement!.querySelectorAll('.font-medium')].map(
        (title) => title.textContent
      );

    expect(titles('Set up Komla')).toEqual([
      'Set up agent integrations',
      'Integrate your agent with Komla',
      'Run project setup skill',
      'Set up an SSH host',
      'Install the Komla skill',
      'Komla CLI demo',
      'Customize the status bar',
      'Schedule an automation',
    ]);
    expect(screen.queryByText('Configure with your agent')).toBeNull();
    expect(screen.queryByText('Try a demo')).toBeNull();
    expect(screen.getByText('More to explore').closest('details')?.open).toBe(false);
    expect(titles('More to explore')[0]).toBe('Customize Komla with your agent');
    expect(screen.getByText('Learn keyboard shortcuts').closest('details')).not.toBeNull();
  });

  it('keeps the setup order without the self-integration tip', async () => {
    await renderComponent();
    const titles = [
      ...screen.getByText('Set up Komla').parentElement!.querySelectorAll('.font-medium'),
    ].map((title) => title.textContent);

    expect(titles).toEqual([
      'Set up agent integrations',
      'Run project setup skill',
      'Set up an SSH host',
      'Install the Komla skill',
      'Komla CLI demo',
      'Customize the status bar',
      'Schedule an automation',
    ]);
  });

  it('does not open automatically on first view', async () => {
    await renderComponent();
    expect(screen.getByTestId('popover').getAttribute('data-open')).toBe('false');
    expect(mockConfigState.updateConfig).not.toHaveBeenCalled();
  });

  function rowFor(label: string): HTMLElement | null {
    return screen.getByText(label).closest('[class*="rounded-md"]') as HTMLElement | null;
  }

  function openPopover() {
    fireEvent.click(screen.getByTestId('popover-trigger'));
  }

  it("marks agent integrations done with an agent's notifications, without the skill", async () => {
    (window as any).api.getCodexNotificationHookDetails.mockResolvedValueOnce({
      isConfigured: true,
    });
    await renderComponent();
    openPopover();
    await waitFor(() => {
      expect(rowFor('Set up agent integrations')?.className).toContain('opacity-60');
    });
    expect(rowFor('Install the Komla skill')?.className).not.toContain('opacity-60');
  });

  it('marks only the skill tip done when only the Komla skill is installed', async () => {
    skillConfigured(true);
    await renderComponent();
    openPopover();
    await waitFor(() => {
      expect(rowFor('Install the Komla skill')?.className).toContain('opacity-60');
    });
    expect(rowFor('Set up agent integrations')?.className).not.toContain('opacity-60');
  });

  it('marks dictation as done when voice model status is ready', async () => {
    (window as any).api.voiceGetModelStatus.mockResolvedValueOnce('ready');
    await renderComponent();
    openPopover();
    await waitFor(() => {
      expect(rowFor('Set up voice dictation')?.className).toContain('opacity-60');
    });
  });

  it('marks SSH setup as done when an SSH host exists', async () => {
    (window as any).api.listSshHosts.mockResolvedValueOnce([{ id: 'host-1' }]);
    await renderComponent();
    openPopover();
    await waitFor(() => {
      expect(rowFor('Set up an SSH host')?.className).toContain('opacity-60');
    });
  });

  it('marks automations done when any target has an automation', async () => {
    (window as any).api.listAutomations.mockResolvedValueOnce([
      { target: { kind: 'local' }, automations: [] },
      { target: { kind: 'ssh', hostId: 'host-1' }, automations: [{ id: 'automation-1' }] },
    ]);
    await renderComponent();
    openPopover();
    await waitFor(() => {
      expect(rowFor('Schedule an automation')?.className).toContain('opacity-60');
    });
  });

  it('leaves automations to do when no target has one', async () => {
    (window as any).api.listAutomations.mockResolvedValueOnce([
      { target: { kind: 'local' }, automations: [] },
    ]);
    (window as any).api.voiceGetModelStatus.mockResolvedValueOnce('ready');
    await renderComponent();
    openPopover();
    await waitFor(() => {
      expect(rowFor('Set up voice dictation')?.className).toContain('opacity-60');
    });
    expect(rowFor('Schedule an automation')?.className).not.toContain('opacity-60');
  });

  it('marks remote control done once a device is paired', async () => {
    (window as any).api.pairedDevicesList.mockResolvedValueOnce([{ credentialId: 'c1' }]);
    await renderComponent();
    openPopover();
    await waitFor(() => {
      expect(rowFor('Use Komla from your phone')?.className).toContain('opacity-60');
    });
  });

  it('still marks dictation done when an unrelated IPC rejects', async () => {
    (window as any).api.getKomlaSkillStatus.mockRejectedValueOnce(new Error('boom'));
    (window as any).api.voiceGetModelStatus.mockResolvedValueOnce('ready');
    await renderComponent();
    openPopover();
    await waitFor(() => {
      expect(rowFor('Set up voice dictation')?.className).toContain('opacity-60');
    });
  });
});
