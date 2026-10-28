/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentIntegrationsPanel } from '../../../../../src/renderer/components/layout/settings/AgentIntegrations';
import type { NotificationIntegrationUpdate } from '../../../../../src/shared/types/notification-integration';
import type { McpStatus, SshIntegrationStatus } from '../../../../../src/renderer/types';
import { useSshHostsStore } from '../../../../../src/renderer/stores/ssh-hosts.store';
import { useWorkspacesStore } from '../../../../../src/renderer/stores/workspaces.store';

// Capture addToast across all mocked-store consumers.
const mockAddToast = vi.fn();

// Hoisted because dialogs.store is imported (via OtherAgentCallout) before this
// module's body runs.
const mockOpenNewWorkspaceDialog = vi.hoisted(() => vi.fn());
const mockConfigState = vi.hoisted(() => ({ config: null as any }));
const mockUpdateConfig = vi.hoisted(() => vi.fn());
const mockOfferAgentLaunchDefaults = vi.hoisted(() => vi.fn(() => false));

vi.mock('../../../../../src/renderer/stores/agent-launch-defaults-dialog.store', () => ({
  offerAgentLaunchDefaults: mockOfferAgentLaunchDefaults,
}));

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector?: (state: unknown) => unknown) => {
    const state = { config: mockConfigState.config, updateConfig: mockUpdateConfig };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector?: (state: unknown) => unknown) => {
    const state = { addToast: mockAddToast };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../../../src/renderer/stores/dialogs.store', () => ({
  openNewWorkspaceDialog: mockOpenNewWorkspaceDialog,
}));

vi.mock('../../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// Default fixtures — tests can override per-call.
const baseNotification = {
  update: undefined as NotificationIntegrationUpdate | undefined,
  command: 'curl ...',
  configJson: '{"hooks":{}}',
  settingsPath: '~/.claude/settings.json',
  port: 52863,
  isConfigured: false,
};

const baseMcpStatus: McpStatus = {
  isConfigured: false,
  mcpServerUrl: 'http://localhost:52863/mcp',
  cliCommand: 'claude mcp add komla ...',
  configJson: '{"mcp":{}}',
  codex: {
    isConfigured: false,
    cliCommand: 'codex mcp add komla ...',
    removeCliCommand: 'codex mcp remove komla',
    configToml: '[mcp]',
    settingsPath: '~/.codex/config.toml',
  },
  antigravity: {
    isConfigured: false,
    cliCommand: 'agy mcp add komla ...',
    removeCliCommand: 'agy mcp remove komla',
    settingsPath: '~/.gemini/config/mcp_config.json',
  },
  opencode: {
    isConfigured: false,
    cliCommand: 'opencode mcp add komla ...',
    configJson: '{"mcp":{}}',
    settingsPath: '~/.opencode/config.json',
  },
  generic: {
    cliCommand: 'komla mcp',
    configJson: '{"mcp":{}}',
    notifyCommand: 'komla notify --source my-agent --event Stop',
    integrationPrompt: 'prompt',
  },
};

const baseCodexNotification = {
  ...baseNotification,
  settingsPath: '~/.codex/config.toml',
  hasConflict: false,
  canAutoConfigure: true,
  conflictMessage: null as string | null,
};

const baseOpencodeNotification = {
  update: undefined as NotificationIntegrationUpdate | undefined,
  pluginContent: '// plugin',
  pluginPath: '~/.opencode/plugins/komla.ts',
  port: 52863,
  isConfigured: false,
};

interface MockOpts {
  notificationInfo?: typeof baseNotification | null;
  antigravityNotificationInfo?: typeof baseNotification | null;
  codexNotificationInfo?: typeof baseCodexNotification | null;
  opencodeNotificationInfo?: typeof baseOpencodeNotification | null;
  mcpStatus?: McpStatus;
  showMessageBoxResponse?: number;
  enableCodexNotificationsForceResult?: {
    success: boolean;
    backupPath?: string;
    error?: string;
  };
  /** Whether the skills folders have the Komla skill. */
  skill?: boolean;
  remoteIntegrationStatus?: SshIntegrationStatus;
  cachedSshIntegrationUpdates?: Record<string, Record<string, string>>;
}

const emptyRemoteIntegrationStatus: SshIntegrationStatus = {
  claude: { notifications: false, mcp: false },
  codex: { notifications: false, mcp: false },
  antigravity: { notifications: false, mcp: false },
  opencode: { notifications: false, mcp: false },
  komlaSkill: false,
};

function setupMockApi(opts: MockOpts = {}) {
  const api = {
    getNotificationHookDetails: vi
      .fn()
      .mockResolvedValue(opts.notificationInfo ?? baseNotification),
    getAntigravityNotificationHookDetails: vi
      .fn()
      .mockResolvedValue(opts.antigravityNotificationInfo ?? baseNotification),
    getCodexNotificationHookDetails: vi
      .fn()
      .mockResolvedValue(opts.codexNotificationInfo ?? baseCodexNotification),
    getOpenCodeNotificationHookDetails: vi
      .fn()
      .mockResolvedValue(opts.opencodeNotificationInfo ?? baseOpencodeNotification),
    getMcpStatus: vi.fn().mockResolvedValue(opts.mcpStatus ?? baseMcpStatus),
    getKomlaSkillStatus: vi.fn().mockResolvedValue({
      isConfigured: opts.skill ?? false,
      paths: [
        '/home/user/.claude/skills/komla/SKILL.md',
        '/home/user/.agents/skills/komla/SKILL.md',
      ],
    }),
    enableKomlaSkill: vi.fn().mockResolvedValue(undefined),
    disableKomlaSkill: vi.fn().mockResolvedValue(undefined),
    getBasePath: vi.fn().mockResolvedValue('~/.komla'),
    getServerPort: vi.fn().mockResolvedValue(52863),
    getSshIntegrationStatus: vi
      .fn()
      .mockResolvedValue(opts.remoteIntegrationStatus ?? emptyRemoteIntegrationStatus),
    getCachedSshIntegrationUpdates: vi
      .fn()
      .mockResolvedValue(opts.cachedSshIntegrationUpdates ?? {}),

    enableNotifications: vi.fn().mockResolvedValue(undefined),
    disableNotifications: vi.fn().mockResolvedValue(undefined),
    enableAntigravityNotifications: vi.fn().mockResolvedValue(undefined),
    disableAntigravityNotifications: vi.fn().mockResolvedValue(undefined),
    enableCodexNotifications: vi.fn().mockResolvedValue(undefined),
    disableCodexNotifications: vi.fn().mockResolvedValue(undefined),
    enableCodexNotificationsForce: vi
      .fn()
      .mockResolvedValue(opts.enableCodexNotificationsForceResult ?? { success: true }),
    enableOpenCodeNotifications: vi.fn().mockResolvedValue(undefined),
    disableOpenCodeNotifications: vi.fn().mockResolvedValue(undefined),
    runMcpCli: vi.fn().mockResolvedValue({ success: true }),
    runMcpRemoveCli: vi.fn().mockResolvedValue({ success: true }),
    runCodexMcpCli: vi.fn().mockResolvedValue({ success: true }),
    runCodexMcpRemoveCli: vi.fn().mockResolvedValue({ success: true }),
    runAntigravityMcpCli: vi.fn().mockResolvedValue({ success: true }),
    runAntigravityMcpRemoveCli: vi.fn().mockResolvedValue({ success: true }),
    enableSshIntegration: vi.fn().mockResolvedValue(undefined),
    disableSshIntegration: vi.fn().mockResolvedValue(undefined),

    showMessageBox: vi.fn().mockResolvedValue(opts.showMessageBoxResponse ?? 1),
    copyToClipboard: vi.fn(),
  };
  (global as any).window.api = api;
  return api;
}

// Helper: wait for the panel's mount-time loaders to settle (mcpChecking goes false).
async function waitForLoad(): Promise<void> {
  await waitFor(() => expect(screen.queryAllByText(/Checking\.\.\./).length).toBe(0));
}

// Helper: an agent's row in a tier, so callers can scope queries to it.
function agentRow(tier: 'Hooks' | 'MCP server', agent: string): HTMLElement {
  return within(screen.getByRole('group', { name: tier }))
    .getByText(agent, { selector: 'span' })
    .closest('div.space-y-2') as HTMLElement;
}

// Helper: expand a collapsed tier or row by clicking its header button.
async function expand(group: 'MCP server' | 'Other agents'): Promise<HTMLElement> {
  const container = screen.getByRole('group', { name: group });
  await userEvent.click(within(container).getAllByRole('button')[0]);
  return container;
}

describe('AgentIntegrationsPanel', () => {
  beforeEach(() => {
    useWorkspacesStore.setState({ workspaces: [] });
    mockAddToast.mockClear();
    mockOpenNewWorkspaceDialog.mockClear();
    mockOfferAgentLaunchDefaults.mockClear();
    mockUpdateConfig.mockClear();
    mockConfigState.config = null;
    useSshHostsStore.setState({ hosts: [] });
  });

  it.each([
    ['claude', 'notificationInfo', 'enableNotifications', baseNotification],
    ['codex', 'codexNotificationInfo', 'enableCodexNotifications', baseCodexNotification],
    [
      'antigravity',
      'antigravityNotificationInfo',
      'enableAntigravityNotifications',
      baseNotification,
    ],
    [
      'opencode',
      'opencodeNotificationInfo',
      'enableOpenCodeNotifications',
      baseOpencodeNotification,
    ],
  ] as const)(
    'requires review and explicit application for %s updates',
    async (agent, field, enable, base) => {
      const user = userEvent.setup();
      const update = {
        files: [
          {
            path: '/home/user/agent-config',
            description: 'Update Komla hooks; preserve other settings.',
          },
        ],
      };
      const api = setupMockApi({ [field]: { ...base, isConfigured: true, update } });
      render(<AgentIntegrationsPanel agentFilter={agent} />);
      await user.click(await screen.findByRole('button', { name: 'Review update' }));
      expect(screen.getByText('/home/user/agent-config')).toBeInTheDocument();
      expect(screen.getByText(update.files[0].description)).toBeInTheDocument();
      expect(api[enable]).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(api[enable]).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Review update' }));
      await user.click(screen.getByRole('button', { name: 'Apply update' }));
      await waitFor(() => expect(api[enable]).toHaveBeenCalledOnce());
    }
  );

  it('keeps Local Machine first and adds tabs for SSH hosts', async () => {
    const api = setupMockApi();
    mockConfigState.config = { notificationPort: 52863 };
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'server-1',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ],
    });

    render(<AgentIntegrationsPanel />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Local Machine', 'Build Server']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('tab', { name: 'Build Server' }));
    await waitFor(() => expect(api.getSshIntegrationStatus).toHaveBeenCalledWith('server-1'));
    expect(
      screen.getByText('Hooks and the Komla skill for agents running on this SSH host.')
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Local Machine' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Build Server' }));
    expect(api.getSshIntegrationStatus).toHaveBeenCalledTimes(1);

    // Role queries skip the hidden Local Machine panel.
    const otherAgents = await expand('Other agents');
    expect(
      within(otherAgents).getByRole('heading', {
        name: 'No prebuilt one-click integration for your agent yet?',
      })
    ).toBeInTheDocument();

    await userEvent.click(
      await within(agentRow('Hooks', 'Claude Code')).findByRole('button', { name: 'Enable' })
    );
    await waitFor(() =>
      expect(api.enableSshIntegration).toHaveBeenCalledWith('server-1', 'claude', 'notifications')
    );
  });

  it('opens on the place where the last workspace was created', async () => {
    setupMockApi();
    mockConfigState.config = { notificationPort: 52863 };
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'server-1',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ],
    });
    useWorkspacesStore.setState({
      workspaces: [
        { createdAt: 1, backend: { kind: 'local' } },
        {
          createdAt: 2,
          backend: {
            kind: 'ssh',
            hostId: 'server-1',
            remoteDirectory: '/r',
            remoteRepoPath: '/r',
            remoteProjectRoot: '/r',
            gitUrl: 'git@example.com:repo.git',
          },
        },
      ],
    } as never);

    render(<AgentIntegrationsPanel />);

    expect(screen.getByRole('tab', { name: /Build Server/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tab', { name: /Local Machine/ })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });

  it('marks the Local Machine tab when a local integration has an update while another tab is open', async () => {
    const update = {
      files: [{ path: '/home/user/.claude/settings.json', description: 'Update hooks.' }],
    };
    setupMockApi({ notificationInfo: { ...baseNotification, isConfigured: true, update } });
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'server-1',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ],
    });
    useWorkspacesStore.setState({
      workspaces: [
        {
          createdAt: 1,
          backend: {
            kind: 'ssh',
            hostId: 'server-1',
            remoteDirectory: '/r',
            remoteRepoPath: '/r',
            remoteProjectRoot: '/r',
            gitUrl: 'git@example.com:repo.git',
          },
        },
      ],
    } as never);

    render(<AgentIntegrationsPanel />);

    const localTab = screen.getByRole('tab', { name: /Local Machine/ });
    expect(localTab).toHaveAttribute('aria-selected', 'false');
    expect(
      await within(localTab).findByRole('img', { name: 'Update available' })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('tab', { name: /Build Server/ })).queryByRole('img', {
        name: 'Update available',
      })
    ).not.toBeInTheDocument();
  });

  it('marks SSH tabs that need an update without opening them', async () => {
    const api = setupMockApi({
      cachedSshIntegrationUpdates: { 'server-1': { codex: 'hooks' } },
    });
    mockConfigState.config = { notificationPort: 52863 };
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'server-1',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ],
    });

    render(<AgentIntegrationsPanel />);

    expect(
      await within(screen.getByRole('tab', { name: /Build Server/ })).findByRole('img', {
        name: 'Update available',
      })
    ).toBeInTheDocument();
    expect(api.getSshIntegrationStatus).not.toHaveBeenCalled();
  });

  it('only marks remote tabs for the agent a preset-specific menu shows', async () => {
    setupMockApi({ cachedSshIntegrationUpdates: { 'server-1': { codex: 'hooks' } } });
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'server-1',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ],
    });

    render(<AgentIntegrationsPanel agentFilter="claude" />);
    await waitForLoad();

    expect(
      within(screen.getByRole('tab', { name: /Build Server/ })).queryByRole('img', {
        name: 'Update available',
      })
    ).not.toBeInTheDocument();
  });

  it('reviews and applies a notification update on an SSH host', async () => {
    const user = userEvent.setup();
    const update = {
      files: [{ path: '/home/dev/.claude/settings.json', description: 'Update Komla hooks.' }],
      preview: '{ "hooks": {} }',
    };
    const api = setupMockApi({
      remoteIntegrationStatus: {
        ...emptyRemoteIntegrationStatus,
        claude: { notifications: true, mcp: false, update },
      },
    });
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'server-1',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ],
    });

    render(<AgentIntegrationsPanel />);
    await user.click(screen.getByRole('tab', { name: /Build Server/ }));
    await user.click(await screen.findByRole('button', { name: 'Review update' }));
    expect(screen.getByText('/home/dev/.claude/settings.json')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply update' }));

    await waitFor(() =>
      expect(api.enableSshIntegration).toHaveBeenCalledWith('server-1', 'claude', 'notifications')
    );
  });

  it('keeps environment tabs available for a preset-specific integration menu', async () => {
    const api = setupMockApi();
    mockConfigState.config = { notificationPort: 52863 };
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'server-1',
          name: 'Build Server',
          hostname: 'build.example.com',
          basePath: '~/.komla',
        },
      ],
    });

    render(<AgentIntegrationsPanel agentFilter="claude" />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Local Machine',
      'Build Server',
    ]);

    await userEvent.click(screen.getByRole('tab', { name: 'Build Server' }));
    await waitFor(() => expect(api.getSshIntegrationStatus).toHaveBeenCalledWith('server-1'));
    const hooks = screen.getByRole('group', { name: 'Hooks' });
    expect(within(hooks).getByText('Claude Code')).toBeInTheDocument();
    expect(within(hooks).queryByText('Codex CLI')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Other agents' })).not.toBeInTheDocument();
  });

  describe('tiers', () => {
    it('puts hooks first, then the Komla CLI, then the MCP server', async () => {
      setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const tiers = screen
        .getAllByRole('group')
        .filter((group) =>
          ['Hooks', 'Komla CLI', 'MCP server'].includes(group.getAttribute('aria-label') ?? '')
        );
      expect(tiers.map((tier) => tier.getAttribute('aria-label'))).toEqual([
        'Hooks',
        'Komla CLI',
        'MCP server',
      ]);
      expect(within(tiers[0]).getByText('Recommended')).toBeInTheDocument();
      // Each tier is named by a heading; the MCP tier's heading holds its toggle.
      for (const name of ['Hooks', 'Komla CLI', 'MCP server']) {
        expect(screen.getByRole('heading', { name })).toBeInTheDocument();
      }
      expect(
        within(screen.getByRole('heading', { name: 'MCP server' })).getByRole('button', {
          name: 'MCP server',
        })
      ).toHaveAttribute('aria-expanded', 'false');
    });

    it('offers every agent’s hooks without expanding anything', async () => {
      setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      for (const agent of ['Claude Code', 'Codex CLI', 'Antigravity CLI', 'OpenCode']) {
        expect(
          within(agentRow('Hooks', agent)).getByRole('button', { name: /^Enable$/ })
        ).toBeVisible();
      }
    });

    it('keeps the MCP server collapsed, saying how many agents have it', async () => {
      setupMockApi({ mcpStatus: { ...baseMcpStatus, isConfigured: true } });
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const mcp = screen.getByRole('group', { name: 'MCP server' });
      expect(within(mcp).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
      expect(mcp).toHaveTextContent('1 on');
      expect(within(mcp).queryByText('Claude Code')).not.toBeInTheDocument();

      await expand('MCP server');
      expect(
        within(agentRow('MCP server', 'Claude Code')).getByRole('button', { name: /^Remove$/ })
      ).toBeInTheDocument();
      expect(
        within(agentRow('MCP server', 'Codex CLI')).getByRole('button', { name: /^Enable$/ })
      ).toBeInTheDocument();
    });

    it('counts hooks apart from the MCP server', async () => {
      setupMockApi({ notificationInfo: { ...baseNotification, isConfigured: true } });
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const row = agentRow('Hooks', 'Claude Code');
      expect(within(row).getByText(/Configured/)).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: /^Remove$/ })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'MCP server' })).toHaveTextContent('Off');
    });
  });

  describe('when a check fails', () => {
    it.each([
      ['getNotificationHookDetails', 'Claude Code'],
      ['getAntigravityNotificationHookDetails', 'Antigravity CLI'],
      ['getOpenCodeNotificationHookDetails', 'OpenCode'],
    ] as const)('says so on the Hooks row when %s fails', async (method, agent) => {
      const api = setupMockApi();
      api[method].mockRejectedValue(new Error('login shell failed'));
      render(<AgentIntegrationsPanel />);

      const row = agentRow('Hooks', agent);
      expect(await within(row).findByText('login shell failed')).toBeInTheDocument();
      expect(row.querySelector('[role="status"], .animate-spin')).toBeNull();
    });

    it('says the MCP server is unavailable, and still offers other agents’ setup', async () => {
      const api = setupMockApi();
      api.getMcpStatus.mockRejectedValue(new Error('no MCP'));
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      expect(screen.getByRole('group', { name: 'MCP server' })).toHaveTextContent('Unavailable');
      const mcp = await expand('MCP server');
      // The reason, once for the tier, in place of rows that would offer Enable.
      expect(within(mcp).getAllByText('no MCP')).toHaveLength(1);
      expect(within(mcp).queryByText('Claude Code')).not.toBeInTheDocument();
      expect(within(mcp).queryByRole('button', { name: /^Enable$/ })).not.toBeInTheDocument();
      const other = await expand('Other agents');
      expect(
        within(other).getByRole('button', { name: 'Launch self-integration skill' })
      ).toBeDisabled();
      expect(within(other).getByText('no MCP')).toBeInTheDocument();
    });

    it('says it couldn’t check Codex’s hooks, not that an update failed', async () => {
      const api = setupMockApi();
      api.getCodexNotificationHookDetails.mockRejectedValue({});
      render(<AgentIntegrationsPanel />);

      const row = agentRow('Hooks', 'Codex CLI');
      expect(await within(row).findByText('Couldn’t check its hooks')).toBeInTheDocument();
      expect(within(row).queryByText('Update failed')).not.toBeInTheDocument();
    });

    it('keeps why a change failed when the recheck after it fails too', async () => {
      const api = setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();
      const tier = screen.getByRole('group', { name: 'Komla CLI' });
      const enable = await within(tier).findByRole('button', { name: /^Enable$/ });

      api.enableKomlaSkill.mockRejectedValue(new Error('EACCES: ~/.claude/skills'));
      api.getKomlaSkillStatus.mockRejectedValue(new Error('skills folder unreadable'));
      await userEvent.click(enable);

      expect(await within(tier).findByText('EACCES: ~/.claude/skills')).toBeInTheDocument();
      expect(within(tier).queryByText('skills folder unreadable')).not.toBeInTheDocument();
    });

    it('says so on the Komla skill row when its check fails', async () => {
      const api = setupMockApi();
      api.getKomlaSkillStatus.mockRejectedValue(new Error('skills folder unreadable'));
      render(<AgentIntegrationsPanel />);

      const tier = screen.getByRole('group', { name: 'Komla CLI' });
      expect(await within(tier).findByText('skills folder unreadable')).toBeInTheDocument();
      expect(tier.querySelector('.animate-spin')).toBeNull();
    });

    it('says so in the MCP tier when the check after a change fails', async () => {
      const api = setupMockApi();
      render(<AgentIntegrationsPanel agentFilter="codex" />);
      await waitForLoad();
      await expand('MCP server');

      api.getMcpStatus.mockRejectedValue(new Error('no MCP'));
      await userEvent.click(
        within(agentRow('MCP server', 'Codex CLI')).getByRole('button', { name: /^Enable$/ })
      );

      // Claude Code isn't shown here, so the reason can't go on its row.
      expect(
        await within(screen.getByRole('group', { name: 'MCP server' })).findByText('no MCP')
      ).toBeInTheDocument();
    });
  });

  it('shows OpenCode’s MCP command until it’s configured, with no toggle that does nothing', async () => {
    setupMockApi();
    render(<AgentIntegrationsPanel />);
    await waitForLoad();
    await expand('MCP server');

    const row = agentRow('MCP server', 'OpenCode');
    expect(within(row).getByText('opencode mcp add komla ...')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Show command' })).not.toBeInTheDocument();
  });

  it('lets you show OpenCode’s MCP command once it’s configured', async () => {
    setupMockApi({
      mcpStatus: { ...baseMcpStatus, opencode: { ...baseMcpStatus.opencode, isConfigured: true } },
    });
    render(<AgentIntegrationsPanel />);
    await waitForLoad();
    await expand('MCP server');

    const row = agentRow('MCP server', 'OpenCode');
    expect(within(row).queryByText('opencode mcp add komla ...')).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Show command' }));
    expect(within(row).getByText('opencode mcp add komla ...')).toBeInTheDocument();
  });

  describe('Komla skill', () => {
    const skillRow = async () =>
      (await screen.findByText('Komla skill')).closest('div.space-y-2') as HTMLElement;

    it('points to komla --help under the skill', async () => {
      setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      expect(await skillRow()).toHaveTextContent(
        'Agents can also look up any command with komla --help or komla <command> --help.'
      );
    });

    it('adds the skill for every agent from one row', async () => {
      const api = setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();
      expect(screen.getAllByText('Komla skill')).toHaveLength(1);

      await userEvent.click(within(await skillRow()).getByRole('button', { name: /^Enable$/ }));

      await waitFor(() => expect(api.enableKomlaSkill).toHaveBeenCalledOnce());
      expect(mockAddToast).toHaveBeenCalledWith('Komla skill added', 'success');
      // Agents can now start other agents.
      expect(mockOfferAgentLaunchDefaults).toHaveBeenCalledOnce();
    });

    it("shows it on one agent's page too, and removes it", async () => {
      const api = setupMockApi({ skill: true });
      render(<AgentIntegrationsPanel agentFilter="codex" />);
      await waitForLoad();

      await userEvent.click(within(await skillRow()).getByRole('button', { name: /^Remove$/ }));

      await waitFor(() => expect(api.disableKomlaSkill).toHaveBeenCalledOnce());
      expect(mockAddToast).toHaveBeenCalledWith('Komla skill removed', 'success');
      expect(mockOfferAgentLaunchDefaults).not.toHaveBeenCalled();
    });

    it('lists the folders it goes in', async () => {
      setupMockApi({ skill: true });
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      await userEvent.click(
        within(await skillRow()).getByRole('button', { name: 'Show what this changes' })
      );

      expect(screen.getByText('/home/user/.claude/skills/komla/SKILL.md')).toBeVisible();
      expect(screen.getByText('/home/user/.agents/skills/komla/SKILL.md')).toBeVisible();
    });

    it('clicking Enable on notifications calls enableNotifications and toasts success', async () => {
      const api = setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      await userEvent.click(
        within(agentRow('Hooks', 'Claude Code')).getByRole('button', { name: /^Enable$/ })
      );

      await waitFor(() => expect(api.enableNotifications).toHaveBeenCalledTimes(1));
      expect(mockAddToast).toHaveBeenCalledWith('Claude Code hooks added', 'success');
    });
  });

  describe('Antigravity', () => {
    it('offers its hooks and MCP server when nothing is configured', async () => {
      setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      expect(
        within(agentRow('Hooks', 'Antigravity CLI')).getByRole('button', { name: /^Enable$/ })
      ).toBeInTheDocument();
      await expand('MCP server');
      expect(
        within(agentRow('MCP server', 'Antigravity CLI')).getByRole('button', { name: /^Enable$/ })
      ).toBeInTheDocument();
    });

    it('shows Configured when its hooks are set up', async () => {
      setupMockApi({
        antigravityNotificationInfo: { ...baseNotification, isConfigured: true },
      });
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const row = agentRow('Hooks', 'Antigravity CLI');
      expect(within(row).getByText(/Configured/)).toBeInTheDocument();
      expect(within(row).getAllByRole('button', { name: /^Remove$/ })).toHaveLength(1);
    });
  });

  describe('Codex', () => {
    it('always shows hook approval info for Codex (heads-up regardless of configured state)', async () => {
      setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const section = agentRow('Hooks', 'Codex CLI');
      expect(
        within(section).getByText(/won.t run the Komla hooks until you approve them/i)
      ).toBeInTheDocument();
      expect(
        within(section).getByText(/select and approve each Komla hook individually/i)
      ).toBeInTheDocument();
      // Codex reports its own status here, so the /review hook gap doesn't touch the spinner.
      expect(section).toHaveTextContent(/workspace titles won.t follow the chat/i);
      expect(section).not.toHaveTextContent(/review.*completion hook/i);
    });

    it('warns about /review on Windows, where the spinner depends on Codex hooks', async () => {
      setupMockApi();
      window.api.platform = 'win32';
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const section = agentRow('Hooks', 'Codex CLI');
      expect(section).toHaveTextContent(/notifications won.t fire at all/i);
      expect(section).toHaveTextContent(/review.*completion hook/i);
    });

    it('still shows hook approval info when Codex notifications are configured', async () => {
      setupMockApi({
        codexNotificationInfo: { ...baseCodexNotification, isConfigured: true },
      });
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const section = agentRow('Hooks', 'Codex CLI');
      expect(
        within(section).getByText(/won.t run the Komla hooks until you approve them/i)
      ).toBeInTheDocument();
    });

    it('renders Force Enable button when hasConflict and !canAutoConfigure', async () => {
      setupMockApi({
        codexNotificationInfo: {
          ...baseCodexNotification,
          hasConflict: true,
          canAutoConfigure: false,
          conflictMessage: 'Existing notify config detected',
        },
      });
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const section = agentRow('Hooks', 'Codex CLI');
      expect(within(section).getByRole('button', { name: /Force Enable/ })).toBeInTheDocument();
      expect(within(section).getByText('Existing notify config detected')).toBeInTheDocument();
    });

    it('Force Enable + confirm calls enableCodexNotificationsForce and toasts', async () => {
      const api = setupMockApi({
        codexNotificationInfo: {
          ...baseCodexNotification,
          hasConflict: true,
          canAutoConfigure: false,
          conflictMessage: 'conflict',
        },
        showMessageBoxResponse: 1,
      });
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const section = agentRow('Hooks', 'Codex CLI');
      await userEvent.click(within(section).getByRole('button', { name: /Force Enable/ }));

      await waitFor(() => expect(api.enableCodexNotificationsForce).toHaveBeenCalledTimes(1));
      expect(api.showMessageBox).toHaveBeenCalledTimes(1);
      expect(mockAddToast).toHaveBeenCalledWith('Codex hooks enabled!', 'success');
    });

    it('Force Enable + cancel does not call enableCodexNotificationsForce', async () => {
      const api = setupMockApi({
        codexNotificationInfo: {
          ...baseCodexNotification,
          hasConflict: true,
          canAutoConfigure: false,
          conflictMessage: 'conflict',
        },
        showMessageBoxResponse: 0,
      });
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const section = agentRow('Hooks', 'Codex CLI');
      await userEvent.click(within(section).getByRole('button', { name: /Force Enable/ }));

      await waitFor(() => expect(api.showMessageBox).toHaveBeenCalledTimes(1));
      expect(api.enableCodexNotificationsForce).not.toHaveBeenCalled();
      expect(mockAddToast).not.toHaveBeenCalled();
    });
  });

  describe('OpenCode', () => {
    it('offers its hooks, and a command for its MCP server', async () => {
      setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      expect(
        within(agentRow('Hooks', 'OpenCode')).getByRole('button', { name: /^Enable$/ })
      ).toBeInTheDocument();
      await expand('MCP server');
      const mcp = agentRow('MCP server', 'OpenCode');
      expect(within(mcp).queryByRole('button', { name: /^Enable$/ })).not.toBeInTheDocument();
      expect(within(mcp).getByRole('button', { name: /Copy command/ })).toBeInTheDocument();
    });

    it('shows Configured when the notification plugin is set up', async () => {
      setupMockApi({
        opencodeNotificationInfo: { ...baseOpencodeNotification, isConfigured: true },
      });
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      expect(within(agentRow('Hooks', 'OpenCode')).getByText(/Configured/)).toBeInTheDocument();
    });
  });

  describe('Other agents', () => {
    it('shows how other agents set up their hooks, and their MCP command in the MCP tier', async () => {
      const user = userEvent.setup();
      setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const other = await expand('Other agents');
      expect(
        within(other).getByRole('button', { name: 'Launch self-integration skill' })
      ).toBeInTheDocument();
      await user.click(
        within(other).getByRole('button', { name: 'Or wire up its hooks yourself' })
      );
      expect(other).toHaveTextContent('--event Stop');
      expect(other).not.toHaveTextContent('notify.js');
      expect(other).not.toHaveTextContent('/api/v1/notify');
      expect(other).not.toHaveTextContent('komla mcp');

      await expand('MCP server');
      const mcp = agentRow('MCP server', 'Other agents');
      expect(within(mcp).getByText('komla mcp')).toBeInTheDocument();
      // Its MCP server is a command to copy rather than Enable/Remove.
      expect(within(mcp).getByRole('button', { name: /Copy command/ })).toBeInTheDocument();
    });

    it('drops the self-setup nudge once the self-integration skill launches', async () => {
      setupMockApi();
      render(<AgentIntegrationsPanel />);
      await waitForLoad();

      const other = await expand('Other agents');
      await userEvent.click(
        within(other).getByRole('button', { name: 'Launch self-integration skill' })
      );

      expect(mockUpdateConfig).toHaveBeenCalledWith({ selfSetupNudgePending: false });
      expect(mockOpenNewWorkspaceDialog).toHaveBeenCalledWith({ prompt: 'prompt' });
    });

    it('launches the self-integration skill with the agent a link came for', async () => {
      setupMockApi();
      render(<AgentIntegrationsPanel openSection="generic" selfSetupPresetId="amp" />);
      await waitForLoad();

      await userEvent.click(screen.getByRole('button', { name: 'Launch self-integration skill' }));

      expect(mockOpenNewWorkspaceDialog).toHaveBeenCalledWith({
        prompt: 'prompt',
        prefill: { presetIds: ['amp'] },
      });
    });
  });

  it('opens other agents’ setup for a link that asks for it', async () => {
    setupMockApi();
    render(<AgentIntegrationsPanel openSection="generic" />);
    await waitForLoad();

    const other = screen.getByRole('group', { name: 'Other agents' });
    expect(within(other).getByRole('button', { name: /Other agents/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('shows an agent’s hooks for a link about it without expanding anything else', async () => {
    setupMockApi();
    render(<AgentIntegrationsPanel openSection="codex" />);
    await waitForLoad();

    expect(
      within(agentRow('Hooks', 'Codex CLI')).getByRole('button', { name: /^Enable$/ })
    ).toBeVisible();
    expect(
      within(screen.getByRole('group', { name: 'Other agents' })).getByRole('button', {
        name: /Other agents/,
      })
    ).toHaveAttribute('aria-expanded', 'false');
  });
});
