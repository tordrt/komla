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

    await user.click(await screen.findByRole('button', { name: /Claude Code/ }));
    await user.click(
      within(screen.getByRole('group', { name: 'Claude Code' })).getAllByRole('button', {
        name: 'Enable',
      })[0]
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

  it('keeps the agent list while it rechecks after a change', async () => {
    const user = userEvent.setup();
    const api = setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);
    await user.click(await screen.findByRole('button', { name: /Claude Code/ }));
    api.getSshIntegrationStatus.mockReturnValue(new Promise(() => {}));

    await user.click(
      within(screen.getByRole('group', { name: 'Claude Code' })).getAllByRole('button', {
        name: 'Enable',
      })[0]
    );

    await waitFor(() => expect(api.getSshIntegrationStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Checking...')).not.toBeInTheDocument();
    expect(screen.getAllByText('Not configured')).toHaveLength(4);
  });

  it('opens on the status the caller already read', () => {
    const api = setupMockApi();
    render(
      <RemoteAgentIntegrationsPanel
        target={{ kind: 'ssh', host }}
        initialStatus={{ ...emptyStatus, claude: { notifications: true, mcp: false } }}
      />
    );

    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(api.getSshIntegrationStatus).not.toHaveBeenCalled();
  });

  it('adds the Komla skill on the host for every agent from one row', async () => {
    const user = userEvent.setup();
    const api = setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);
    await screen.findAllByText('Not configured');
    expect(screen.getAllByText('Komla skill')).toHaveLength(1);

    // The skill's row comes before the agents.
    await user.click(screen.getAllByRole('button', { name: 'Enable' })[0]);

    await waitFor(() => expect(api.setSshKomlaSkill).toHaveBeenCalledWith(host.id, true));
    expect(api.enableSshIntegration).not.toHaveBeenCalled();
    expect(mockAddToast).toHaveBeenCalledWith('Komla skill added on Devbox', 'success');
    // Agents there can now start other agents.
    expect(mockOfferAgentLaunchDefaults).toHaveBeenCalledOnce();
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

  it('says when an SSH host MCP server is reachable', async () => {
    const user = userEvent.setup();
    setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    await user.click(await screen.findByRole('button', { name: /Claude Code/ }));

    expect(
      screen.getByText('Available while a Komla SSH terminal for this host is open.')
    ).toBeInTheDocument();
  });

  it('explains Codex hook approval on the host', async () => {
    const user = userEvent.setup();
    setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    await user.click(await screen.findByRole('button', { name: /Codex CLI/ }));

    expect(
      screen.getByText(/Codex won.t run the Komla hooks until you approve them/)
    ).toBeInTheDocument();
    expect(screen.getByText(/workspace titles won.t follow the chat/)).toBeInTheDocument();
  });

  it('offers Antigravity CLI and other agents on the host', async () => {
    setupMockApi();
    render(<RemoteAgentIntegrationsPanel target={{ kind: 'ssh', host }} />);

    expect(await screen.findByRole('button', { name: /Antigravity CLI/ })).toBeInTheDocument();
    expect(screen.queryByText(/Gemini CLI/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Other Agent CLIs/ })).toBeInTheDocument();
  });
});
