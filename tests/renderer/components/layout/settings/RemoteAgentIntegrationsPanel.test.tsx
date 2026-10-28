/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteAgentIntegrationsPanel } from '../../../../../src/renderer/components/layout/settings/RemoteAgentIntegrationsPanel';
import type { SshHost, SshIntegrationStatus } from '../../../../../src/renderer/types';

const mockAddToast = vi.fn();
const mockOfferAgentLaunchDefaults = vi.hoisted(() => vi.fn(() => false));

vi.mock('../../../../../src/renderer/stores/agent-launch-defaults-dialog.store', () => ({
  offerAgentLaunchDefaults: mockOfferAgentLaunchDefaults,
}));

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector?: (state: unknown) => unknown) => {
    const state = { config: { notificationPort: 52863 }, updateConfig: vi.fn() };
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
  openNewWorkspaceDialog: vi.fn(),
}));

vi.mock('../../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const host: SshHost = {
  id: 'ssh-dev',
  name: 'Devbox',
  hostname: 'dev.example.com',
  basePath: '~/.komla',
};

const emptyStatus: SshIntegrationStatus = {
  claude: { notifications: false, mcp: false },
  codex: { notifications: false, mcp: false },
  antigravity: { notifications: false, mcp: false },
  opencode: { notifications: false, mcp: false },
  komlaSkill: false,
};

function setupMockApi() {
  const api = {
    getSshIntegrationStatus: vi.fn().mockResolvedValue(emptyStatus),
    getMcpStatus: vi.fn().mockResolvedValue({ generic: { integrationPrompt: 'prompt' } }),
    enableSshIntegration: vi.fn().mockResolvedValue(undefined),
    disableSshIntegration: vi.fn().mockResolvedValue(undefined),
    setSshKomlaSkill: vi.fn().mockResolvedValue(undefined),
  };
  (window as unknown as { api: unknown }).api = api;
  return api;
}

describe('RemoteAgentIntegrationsPanel', () => {
  beforeEach(() => {
    mockAddToast.mockClear();
    mockOfferAgentLaunchDefaults.mockClear();
  });

  it('keeps an SSH failure on screen with a way to copy it', async () => {
    const user = userEvent.setup();
    const api = setupMockApi();
    api.enableSshIntegration.mockRejectedValue(new Error('permission denied on ~/.claude'));
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    await user.click(
      await within(await row('Hooks', 'Claude Code')).findByRole('button', { name: 'Enable' })
    );

    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        'Failed to enable hooks: permission denied on ~/.claude',
        'error',
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Copy' }),
          dismissOnTimeout: false,
        })
      )
    );
  });

  it('puts hooks first, then the Komla skill, then the MCP server, collapsed', async () => {
    setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);
    await within(await row('Hooks', 'Claude Code')).findByRole('button', { name: 'Enable' });

    const tiers = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'))
      .filter((label) => ['Hooks', 'Komla CLI', 'MCP server'].includes(label ?? ''));
    expect(tiers).toEqual(['Hooks', 'Komla CLI', 'MCP server']);
    const hooks = screen.getByRole('group', { name: 'Hooks' });
    expect(within(hooks).getByText('Recommended')).toBeInTheDocument();
    // One Enable per agent, with nothing to expand first.
    expect(within(hooks).getAllByRole('button', { name: 'Enable' })).toHaveLength(4);
    const mcp = screen.getByRole('group', { name: 'MCP server' });
    expect(within(mcp).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(mcp).toHaveTextContent('Off');
  });

  it('shows each agent’s logo in its own colors, and a muted mark for other agents', async () => {
    setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    for (const agent of ['Claude Code', 'Codex CLI', 'Antigravity CLI', 'OpenCode']) {
      const logo = (await row('Hooks', agent)).querySelector('[data-agent-preset-icon]');
      expect(logo).not.toHaveAttribute('data-agent-preset-icon', 'fallback');
      expect(logo).not.toHaveClass('text-muted-foreground');
    }
    const otherMark = screen
      .getByRole('group', { name: 'Other agents' })
      .querySelector('[data-agent-preset-icon]');
    expect(otherMark).toHaveAttribute('data-agent-preset-icon', 'fallback');
    expect(otherMark).toHaveClass('text-muted-foreground');
  });

  it('keeps the agent list while it rechecks after a change', async () => {
    const user = userEvent.setup();
    const api = setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);
    const claude = await row('Hooks', 'Claude Code');
    const enable = await within(claude).findByRole('button', { name: 'Enable' });
    api.getSshIntegrationStatus.mockReturnValue(new Promise(() => {}));

    await user.click(enable);

    await waitFor(() => expect(api.getSshIntegrationStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Checking...')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Hooks' })).getAllByRole('button', {
        name: 'Enable',
      })
    ).toHaveLength(4);
  });

  it('opens on the status the caller already read', () => {
    const api = setupMockApi();
    render(
      <RemoteAgentIntegrationsPanel
        target={{ kind: 'ssh', host }}
        initialStatus={{ ...emptyStatus, claude: { notifications: true, mcp: false } }}
      />
    );

    expect(
      within(screen.getByRole('group', { name: 'Hooks' })).getByText(/Configured/)
    ).toBeInTheDocument();
    expect(api.getSshIntegrationStatus).not.toHaveBeenCalled();
  });

  it('points to komla --help under the Komla skill', () => {
    setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    expect(screen.getByRole('group', { name: 'Komla CLI' })).toHaveTextContent(
      'Agents can also look up any command with komla --help or komla <command> --help.'
    );
  });

  it('adds the Komla skill on the host for every agent from one row', async () => {
    const user = userEvent.setup();
    const api = setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);
    expect(screen.getAllByText('Komla skill')).toHaveLength(1);

    await user.click(
      await within(screen.getByRole('group', { name: 'Komla CLI' })).findByRole('button', {
        name: 'Enable',
      })
    );

    await waitFor(() => expect(api.setSshKomlaSkill).toHaveBeenCalledWith(host.id, true));
    expect(api.enableSshIntegration).not.toHaveBeenCalled();
    expect(mockAddToast).toHaveBeenCalledWith('Komla skill added on Devbox', 'success');
    // Agents there can now start other agents.
    expect(mockOfferAgentLaunchDefaults).toHaveBeenCalledOnce();
  });

  it('reports the skill and MCP to a caller that offers the launch defaults later', async () => {
    const user = userEvent.setup();
    const api = setupMockApi();
    const onLaunchIntegrationChange = vi.fn();
    const status = { ...emptyStatus, claude: { notifications: false, mcp: true } };
    api.getSshIntegrationStatus.mockImplementation(async () => ({ ...status }));
    api.setSshKomlaSkill.mockImplementation(async (_hostId: string, enabled: boolean) => {
      status.komlaSkill = enabled;
    });
    render(
      <RemoteAgentIntegrationsPanel
        target={{ kind: 'ssh', host }}
        onLaunchIntegrationChange={onLaunchIntegrationChange}
      />
    );

    await user.click(
      await within(screen.getByRole('group', { name: 'Komla CLI' })).findByRole('button', {
        name: 'Enable',
      })
    );
    await waitFor(() => expect(onLaunchIntegrationChange).toHaveBeenLastCalledWith(true));

    // Removing the skill leaves Claude Code's MCP server, so agents there still start others.
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.setSshKomlaSkill).toHaveBeenCalledWith(host.id, false));
    await screen.findAllByRole('button', { name: 'Enable' });
    expect(onLaunchIntegrationChange).toHaveBeenCalledOnce();

    await user.click(
      within(screen.getByRole('group', { name: 'MCP server' })).getAllByRole('button')[0]
    );
    status.claude = { notifications: false, mcp: false };
    await user.click(
      within(await row('MCP server', 'Claude Code')).getByRole('button', { name: 'Remove' })
    );
    await waitFor(() => expect(onLaunchIntegrationChange).toHaveBeenLastCalledWith(false));
    expect(mockOfferAgentLaunchDefaults).not.toHaveBeenCalled();
  });

  it('removes the Komla skill on the host', async () => {
    const user = userEvent.setup();
    const api = setupMockApi();
    api.getSshIntegrationStatus.mockResolvedValue({ ...emptyStatus, komlaSkill: true });
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(api.setSshKomlaSkill).toHaveBeenCalledWith(host.id, false));
    expect(mockAddToast).toHaveBeenCalledWith('Komla skill removed on Devbox', 'success');
    expect(mockOfferAgentLaunchDefaults).not.toHaveBeenCalled();
  });

  it('enables an agent’s MCP server on the host, saying when it is reachable', async () => {
    const user = userEvent.setup();
    const api = setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    const mcp = screen.getByRole('group', { name: 'MCP server' });
    expect(mcp).toHaveTextContent('Available while a Komla SSH terminal for this host is open.');
    await user.click(within(mcp).getByRole('button'));
    await user.click(
      await within(await row('MCP server', 'Codex CLI')).findByRole('button', { name: 'Enable' })
    );

    await waitFor(() =>
      expect(api.enableSshIntegration).toHaveBeenCalledWith(host.id, 'codex', 'mcp')
    );
  });

  it('says every tier is unavailable when the host can’t be checked', async () => {
    const user = userEvent.setup();
    const api = setupMockApi();
    api.getSshIntegrationStatus.mockRejectedValue(new Error('connection refused'));
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    const mcp = screen.getByRole('group', { name: 'MCP server' });
    await waitFor(() => expect(mcp).toHaveTextContent('Unavailable'));
    await user.click(within(mcp).getByRole('button'));
    const codex = await row('MCP server', 'Codex CLI');
    expect(within(codex).getByText('Unavailable')).toBeInTheDocument();
    expect(within(codex).queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
  });

  it('explains Codex hook approval on the host', async () => {
    setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    const codex = await row('Hooks', 'Codex CLI');
    expect(codex).toHaveTextContent(/Codex won.t run the Komla hooks until you approve them/);
    expect(codex).toHaveTextContent(/workspace titles won.t follow the chat/);
  });

  it('offers Antigravity CLI and other agents on the host', async () => {
    setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    expect(await row('Hooks', 'Antigravity CLI')).toBeInTheDocument();
    expect(screen.queryByText(/Gemini CLI/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Other agents/ })).toBeInTheDocument();
  });
});

// An agent's row in a tier.
async function row(tier: 'Hooks' | 'MCP server', agent: string): Promise<HTMLElement> {
  const label = await within(screen.getByRole('group', { name: tier })).findByText(agent, {
    selector: 'span',
  });
  return label.closest('div.space-y-2') as HTMLElement;
}
