/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SshTab } from '../../../../../src/renderer/components/layout/settings/SshTab';
import { SshHostDialogHost } from '../../../../../src/renderer/components/ssh-hosts/SshHostDialogHost';
import { useSettingsDialogStore } from '../../../../../src/renderer/stores/settings-dialog.store';
import { useSshHostDialogStore } from '../../../../../src/renderer/stores/ssh-host-dialog.store';

import {
  komlaSshRemoteDataPort,
  type SshHost,
  type SshIntegrationStatus,
} from '../../../../../src/shared/types/ssh';

import type { RemoteSshWorkspace } from '../../../../../src/shared/types';

const host = {
  id: 'ssh-dev',
  name: 'Devbox',
  hostname: 'dev.example.com',
  basePath: '/home/dev/.komla',
  forwardAgent: true,
  identityFile: '~/.ssh/id_ed25519',
  extraSshArgs: ['-J', 'bastion'],
};

const mockUpdateConfig = vi.fn(async () => ({ ok: true, error: null }));
const mockSaveHost = vi.fn(async () => ({ ok: true, error: null }));
const mockBeginPendingSetup = vi.fn();
const mockCompletePendingSetup = vi.fn(async () => undefined);
const mockDeleteHost = vi.fn(async () => ({ deletedWorkspaceIds: [] }));
const mockLoadWorkspaces = vi.fn(async () => undefined);
const mockUpdateProject = vi.fn(async () => undefined);
const mockAddToast = vi.fn();
const mockOfferAgentLaunchDefaults = vi.hoisted(() => vi.fn(() => true));
const mockPresets = [
  {
    id: 'codex',
    name: 'Codex',
    openCommand: 'codex',
    continueCommand: 'codex resume --last',
    promptCommand: 'codex {{prompt}}',
    launchModes: [{ id: 'full-auto', name: 'Full auto', command: 'codex --full-auto' }],
    isBuiltin: true,
  },
];
let mockConfig: {
  defaultSshWorkspaceMode: 'remote' | 'local-mirror-actions';
} = { defaultSshWorkspaceMode: 'remote' };
let mockHosts: SshHost[] = [host];
let mockWorkspaces: Record<string, unknown>[] = [];
let mockProjects: Array<{
  id: string;
  name: string;
  color?: string;
  kind?: 'git' | 'directory';
  sshWorkspaceMode?: 'remote' | 'local-mirror-actions';
}> = [];

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = { config: mockConfig, updateConfig: mockUpdateConfig, loadConfig: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../../../src/renderer/stores/ssh-hosts.store', () => {
  const getState = () => ({
    hosts: mockHosts,
    saveHost: mockSaveHost,
    beginPendingSetup: mockBeginPendingSetup,
    completePendingSetup: mockCompletePendingSetup,
    deleteHost: mockDeleteHost,
  });
  return {
    useSshHostsStore: Object.assign(
      (selector?: (state: Record<string, unknown>) => unknown) =>
        selector ? selector(getState()) : getState(),
      { getState }
    ),
  };
});

vi.mock('../../../../../src/renderer/stores/agent-launch-defaults-dialog.store', () => ({
  offerAgentLaunchDefaults: mockOfferAgentLaunchDefaults,
}));

vi.mock('../../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ workspaces: mockWorkspaces, loadWorkspaces: mockLoadWorkspaces }),
}));

vi.mock('../../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: () => ({
    projects: mockProjects,
    updateProject: mockUpdateProject,
  }),
}));

vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ addToast: mockAddToast }),
}));

vi.mock('../../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => ({
    presets: mockPresets,
    activePresets: [{ presetId: 'codex', lastUsedAt: 1 }],
  }),
}));

vi.mock('../../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

/** SSH settings as the user sees them: the page, and the dialog it opens. */
const sshSettings = () => (
  <>
    <SshTab />
    <SshHostDialogHost />
  </>
);
const renderSsh = () => render(sshSettings());

type User = ReturnType<typeof userEvent.setup>;

/** Holds verifySshHost calls that match until each is released. */
function holdVerify(match: (options?: { prepare?: boolean }) => boolean) {
  const verify = vi.mocked(window.api.verifySshHost);
  const answer = verify.getMockImplementation()!;
  const held: Array<() => void> = [];
  verify.mockImplementation((target, options) =>
    match(options)
      ? new Promise((resolve) => held.push(() => resolve(answer(target, options))))
      : answer(target, options)
  );
  return () => act(async () => held.shift()?.());
}

/** Opens the add dialog from the page and types a host into it. */
async function startAdding(user: User, hostname: string, name?: string) {
  await user.click(screen.getByRole('button', { name: 'Add SSH host' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('Host or alias'), hostname);
  if (name) await user.type(within(dialog).getByLabelText('Name'), name);
  return dialog;
}

const sshWorkspace = (id: string) => ({
  id,
  backend: {
    kind: 'ssh',
    hostId: 'ssh-dev',
    remoteDirectory: '/home/dev/worktree',
    remoteRepoPath: '/home/dev/repo.git',
    remoteProjectRoot: '/home/dev',
    gitUrl: 'git@example.com:repo.git',
  },
});

describe('SshTab', () => {
  // Radix measures a switch inside a form.
  const OriginalResizeObserver = globalThis.ResizeObserver;

  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    useSettingsDialogStore.setState({ open: false, target: {} });
    useSshHostDialogStore.setState({ open: false, request: null, requestId: 0 });
    mockConfig = { defaultSshWorkspaceMode: 'remote' };
    mockHosts = [host];
    mockSaveHost.mockImplementation(async (savedHost) => {
      const hostToSave = savedHost as SshHost;
      mockHosts = [...mockHosts.filter((candidate) => candidate.id !== hostToSave.id), hostToSave];
      return { ok: true, error: null };
    });
    mockWorkspaces = [];
    mockProjects = [];
    (window as unknown as { api: unknown }).api = {
      platform: 'linux',
      getCachedSshIntegrationUpdates: vi.fn().mockResolvedValue({}),
      getNotificationHookDetails: vi.fn().mockResolvedValue(null),
      getCodexNotificationHookDetails: vi.fn().mockResolvedValue(null),
      getAntigravityNotificationHookDetails: vi.fn().mockResolvedValue(null),
      getOpenCodeNotificationHookDetails: vi.fn().mockResolvedValue(null),
      getSshIntegrationStatus: vi.fn().mockResolvedValue({
        claude: { notifications: false, mcp: false },
        codex: { notifications: false, mcp: false },
        antigravity: { notifications: false, mcp: false },
        opencode: { notifications: false, mcp: false },
        komlaSkill: false,
      }),
      getSshPortForwardStatus: vi.fn().mockResolvedValue({
        hostId: 'ssh-dev',
        state: 'connected',
      }),
      getSshHostStatuses: vi.fn().mockResolvedValue([]),
      onSshHostStatusesChange: vi.fn(() => () => {}),
      checkSshHost: vi.fn().mockResolvedValue(undefined),
      listSshConfigHosts: vi.fn().mockResolvedValue([]),
      getMcpStatus: vi.fn().mockResolvedValue({
        generic: { integrationPrompt: '# SSH integration prompt' },
      }),
      enableSshIntegration: vi.fn().mockResolvedValue(undefined),
      disableSshIntegration: vi.fn().mockResolvedValue(undefined),
      setSshKomlaSkill: vi.fn().mockResolvedValue(undefined),
      listRemoteSshWorkspaces: vi.fn().mockResolvedValue([]),
      syncSshHostWorkspaces: vi.fn().mockResolvedValue(undefined),
      trackSshHostAdded: vi.fn().mockResolvedValue(undefined),
      verifySshHost: vi.fn().mockImplementation(async (_host, options) => ({
        ok: true,
        prepared: Boolean(options?.prepare),
        resolvedBasePath: '/home/dev/.komla',
        git: { status: 'available', version: 'git version 2.43.0' },
        localMirror: {
          platform: window.api.platform === 'win32' ? 'unsupported' : 'supported',
          localRsync: 'available',
          remoteRsync: 'available',
        },
        tmux: { status: 'available', version: 'tmux 3.4' },
        monitoring: { status: 'available', missingRequirements: [] },
        gitIdentity: { configured: true },
      })),
    };
  });

  describe('host list', () => {
    it('shows each host with its address, workspaces and last status', async () => {
      vi.mocked(window.api.getSshHostStatuses).mockResolvedValue([
        {
          hostId: 'ssh-dev',
          state: 'unreachable',
          checkedAt: 1,
          message: 'ssh: Could not resolve hostname dev.example.com',
        },
      ]);
      mockWorkspaces = [sshWorkspace('one')];
      const user = userEvent.setup();
      renderSsh();

      expect(screen.getByText('1 host')).toBeInTheDocument();
      expect(screen.getByText('dev.example.com')).toBeInTheDocument();
      expect(screen.getByText('1 workspace')).toBeInTheDocument();
      expect(await screen.findByText('Unreachable')).toBeInTheDocument();
      expect(
        screen.getByText('ssh: Could not resolve hostname dev.example.com')
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Check connection' }));
      expect(window.api.checkSshHost).toHaveBeenCalledWith('ssh-dev');
    });

    it('leaves the default port out of a host address', () => {
      mockHosts = [{ ...host, user: 'dev', port: 22 }];
      renderSsh();

      expect(screen.getByText('dev@dev.example.com')).toBeInTheDocument();
    });

    it('notes only what the last check found missing', () => {
      mockHosts = [
        {
          ...host,
          capabilities: {
            checkedAt: '2026-10-16T00:00:00.000Z',
            git: { status: 'available', version: 'git version 2.43.0' },
            tmux: { status: 'available', version: 'tmux 3.3a' },
            monitoring: { status: 'available', missingRequirements: [] },
            localMirror: { platform: 'supported', localRsync: 'available', remoteRsync: 'missing' },
          },
        },
      ];
      renderSsh();

      expect(
        screen.getByText(
          'tmux 3.3a: 3.4 or later keeps long file links clickable · Local copies need rsync'
        )
      ).toBeInTheDocument();
      expect(screen.queryByText(/Git ready/)).not.toBeInTheDocument();
    });

    it('lists workspaces on a host and adds one started from another device', async () => {
      const user = userEvent.setup();
      const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>;
      api.listRemoteSshWorkspaces = vi.fn().mockResolvedValue([
        {
          workspaceId: 'ws-42',
          name: 'fix-login',
          repoName: 'app',
          branchName: 'fix-login',
          terminalCount: 2,
          updatedAt: 2,
          adopted: false,
          mayBeOnOtherDevices: true,
        },
        {
          workspaceId: 'ws-7',
          name: 'docs',
          terminalCount: 1,
          updatedAt: 1,
          adopted: true,
          mayBeOnOtherDevices: true,
        },
      ]);
      api.adoptRemoteSshWorkspace = vi.fn().mockResolvedValue({ id: 'ws-42' });
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Workspaces on Devbox' }));

      expect(await screen.findByText('app · fix-login · 2 agents')).toBeInTheDocument();
      // Sync is on by default, so opening the list first adds what other devices started.
      expect(api.syncSshHostWorkspaces).toHaveBeenCalledWith('ssh-dev');
      expect(screen.getByText('On this device')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Add fix-login to this device' }));

      expect(api.adoptRemoteSshWorkspace).toHaveBeenCalledWith('ssh-dev', 'ws-42');
      expect(mockLoadWorkspaces).toHaveBeenCalled();
      await waitFor(() => expect(screen.getAllByText('On this device')).toHaveLength(2));
    });

    it('turns off syncing workspaces with other devices for one host', async () => {
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Workspaces on Devbox' }));
      const sync = screen.getByRole('switch', { name: 'Sync with other devices' });
      expect(sync).toBeChecked();
      await user.click(sync);

      expect(mockUpdateConfig).toHaveBeenCalledWith({ workspaceSyncDisabledHostIds: ['ssh-dev'] });
    });

    it('presents companion diagnostics without exposing managed support scripts', async () => {
      const user = userEvent.setup();
      renderSsh();

      expect(screen.getByText('Devbox', { ignore: '[role=tab] *' })).toBeInTheDocument();
      expect(screen.getByText('0 workspaces')).toBeInTheDocument();
      expect(screen.queryByText('Remote Komla path')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Remote Companion details/ }));
      expect(screen.getByText('Remote Companion')).toBeInTheDocument();
      expect(screen.getByText(/native filesystem events/)).toBeInTheDocument();
      expect(screen.queryByText(/notify\.sh/)).not.toBeInTheDocument();
      expect(screen.queryByText(/terminal\.sh/)).not.toBeInTheDocument();
    });

    it('keeps workspace mirror choices out of SSH settings', () => {
      renderSsh();

      expect(screen.queryByRole('button', { name: 'Defaults & rules' })).not.toBeInTheDocument();
      expect(screen.queryByText('Connected machines')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add SSH host' })).toBeInTheDocument();
      expect(screen.queryByText('Do you need a local copy for testing?')).not.toBeInTheDocument();
      expect(screen.queryByText('Choose differently for a project')).not.toBeInTheDocument();
    });

    it('invites connecting a first machine when there are no hosts', () => {
      mockHosts = [];
      renderSsh();

      expect(screen.getByText('Connect your first machine')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Connect over SSH to run agents there, away from your own files and even while your laptop is closed.'
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add SSH host' })).toBeInTheDocument();
      expect(screen.queryByText('Agent integrations')).not.toBeInTheDocument();
    });
  });

  describe('agent integrations', () => {
    it('shows a single host integrations inline without redundant saved or manage controls', async () => {
      renderSsh();

      expect(await screen.findByText('Agent integrations')).toBeInTheDocument();
      expect(screen.queryByText('Saved')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Manage Devbox' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit SSH host' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete host' })).toBeInTheDocument();
    });

    it('keeps custom agent integration guidance inside Other agents', async () => {
      const user = userEvent.setup();
      renderSsh();

      await screen.findByText('Agent integrations');
      expect(
        screen.queryByRole('heading', {
          name: 'No prebuilt one-click integration for your agent yet?',
        })
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Other agents/ }));

      expect(
        screen.getByRole('heading', {
          name: 'No prebuilt one-click integration for your agent yet?',
        })
      ).toBeInTheDocument();
    });

    it('opens on an SSH host tab beside the other environments', async () => {
      renderSsh();

      const tabs = await screen.findAllByRole('tab');
      expect(tabs.map((tab) => tab.textContent)).toEqual(['Local Machine', 'Devbox']);
      expect(screen.getByRole('tab', { name: 'Devbox' })).toHaveAttribute('aria-selected', 'true');
      expect(
        await screen.findByText('Hooks and the Komla skill for agents running on this SSH host.')
      ).toBeInTheDocument();
    });

    it('switches the inline integrations panel when multiple hosts are configured', async () => {
      mockHosts = [
        host,
        {
          ...host,
          id: 'ssh-backup',
          name: 'Backup',
          hostname: 'backup.example.com',
        },
      ];
      const user = userEvent.setup();
      renderSsh();

      expect(await screen.findByRole('tab', { name: 'Devbox' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(window.api.getSshIntegrationStatus).not.toHaveBeenCalledWith('ssh-backup');
      await user.click(screen.getByRole('tab', { name: 'Backup' }));

      expect(screen.getByRole('tab', { name: 'Backup' })).toHaveAttribute('aria-selected', 'true');
      await waitFor(() =>
        expect(window.api.getSshIntegrationStatus).toHaveBeenCalledWith('ssh-backup')
      );
      expect(window.api.getMcpStatus).toHaveBeenCalledWith(undefined, 'ssh-backup');
      expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    });

    it('moves to the remaining host when the selected one is deleted', async () => {
      const backup = { ...host, id: 'ssh-backup', name: 'Backup', hostname: 'backup.example.com' };
      mockHosts = [host, backup];
      const { rerender } = renderSsh();
      expect(await screen.findByRole('tab', { name: 'Devbox' })).toHaveAttribute(
        'aria-selected',
        'true'
      );

      mockHosts = [backup];
      rerender(sshSettings());

      expect(screen.getByRole('tab', { name: 'Backup' })).toHaveAttribute('aria-selected', 'true');
      await waitFor(() =>
        expect(window.api.getSshIntegrationStatus).toHaveBeenCalledWith('ssh-backup')
      );
    });

    it('launches self-integration with the selected SSH host prefilled', async () => {
      const user = userEvent.setup();
      const dispatchEvent = vi.spyOn(window, 'dispatchEvent');
      renderSsh();

      await user.click(await screen.findByRole('button', { name: /Other agents/ }));
      await user.click(
        await screen.findByRole('button', { name: 'Launch self-integration skill' })
      );

      expect(window.api.getMcpStatus).toHaveBeenCalledWith(undefined, 'ssh-dev');
      const openEvent = dispatchEvent.mock.calls
        .map(([event]) => event as CustomEvent)
        .find((event) => event.type === 'open-new-workspace-dialog');
      expect(openEvent?.detail).toEqual({ sshHostId: 'ssh-dev' });
    });

    it('shows which agents have hooks, and counts the MCP server apart', async () => {
      vi.mocked(window.api.getSshIntegrationStatus).mockResolvedValue({
        claude: { notifications: false, mcp: true },
        codex: { notifications: true, mcp: false },
        antigravity: { notifications: false, mcp: false },
        opencode: { notifications: true, mcp: false },
        komlaSkill: true,
      });

      renderSsh();

      const hooks = within(await screen.findByRole('group', { name: 'Hooks' }));
      expect(await hooks.findAllByRole('button', { name: 'Enable' })).toHaveLength(2);
      expect(hooks.getAllByText(/Configured/)).toHaveLength(2);
      expect(screen.getByRole('group', { name: 'MCP server' })).toHaveTextContent('1 on');
    });
  });

  describe('deleting a host', () => {
    it('opens host deletion from the host row', async () => {
      mockDeleteHost.mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'ssh:delete-host': Error: Remote cleanup was refused"
        )
      );
      const user = userEvent.setup();
      renderSsh();

      expect(screen.queryByText('Remove host')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Delete host' }));

      expect(screen.getByRole('heading', { name: 'Delete SSH Host' })).toBeInTheDocument();
      await user.click(
        screen.getByRole('switch', { name: 'Delete all Komla data from this host' })
      );

      await user.click(screen.getByRole('button', { name: 'Delete Host' }));
      expect(mockDeleteHost).toHaveBeenCalledWith('ssh-dev', { deleteRemoteData: true });
      expect(await screen.findByText('Remote cleanup was refused')).toBeInTheDocument();
    });

    it('keeps remote data unless the user opts in', async () => {
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Delete host' }));
      expect(
        screen.getByRole('switch', { name: 'Delete all Komla data from this host' })
      ).not.toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Delete Host' }));
      expect(mockDeleteHost).toHaveBeenCalledWith('ssh-dev', { deleteRemoteData: false });
    });

    it('warns when it cannot check the host for workspaces from other devices', async () => {
      vi.mocked(window.api.listRemoteSshWorkspaces).mockRejectedValue(
        new Error('Connection timed out')
      );
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Delete host' }));
      const deleteData = screen.getByRole('switch', {
        name: 'Delete all Komla data from this host',
      });
      expect(deleteData).not.toBeChecked();
      await user.click(deleteData);

      expect(
        await screen.findByText(/couldn't check whether other devices have workspaces/)
      ).toBeVisible();
    });

    it('ignores a failed check from an earlier dialog', async () => {
      let failFirstCheck: ((error: Error) => void) | undefined;
      vi.mocked(window.api.listRemoteSshWorkspaces)
        .mockReturnValueOnce(
          new Promise((_resolve, reject) => {
            failFirstCheck = reject;
          })
        )
        .mockResolvedValueOnce([]);
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Delete host' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await user.click(screen.getByRole('button', { name: 'Delete host' }));
      await user.click(
        screen.getByRole('switch', { name: 'Delete all Komla data from this host' })
      );
      await act(async () => {
        failFirstCheck?.(new Error('Connection timed out'));
      });

      expect(screen.queryByText(/couldn't check whether other devices/)).not.toBeInTheDocument();
    });

    it('warns about workspaces from other devices without overriding the choice', async () => {
      let answerCheck: ((value: RemoteSshWorkspace[]) => void) | undefined;
      vi.mocked(window.api.listRemoteSshWorkspaces).mockReturnValueOnce(
        new Promise((resolve) => {
          answerCheck = resolve;
        })
      );
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Delete host' }));
      const deleteData = screen.getByRole('switch', {
        name: 'Delete all Komla data from this host',
      });
      await user.click(deleteData);
      await act(async () => {
        answerCheck?.([
          {
            workspaceId: 'mine',
            name: 'mine',
            terminalCount: 1,
            updatedAt: 2,
            adopted: true,
            mayBeOnOtherDevices: false,
          },
          {
            workspaceId: 'ws-42',
            name: 'fix-login',
            terminalCount: 2,
            updatedAt: 1,
            adopted: false,
            mayBeOnOtherDevices: true,
          },
        ]);
      });

      expect(await screen.findByText(/may be in use on another device: fix-login\./)).toBeVisible();
      expect(deleteData).toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Delete Host' }));
      expect(mockDeleteHost).toHaveBeenCalledWith('ssh-dev', { deleteRemoteData: true });
    });

    it('waits for the other-device check and ignores replies for an earlier dialog', async () => {
      let answerFirstCheck: ((value: RemoteSshWorkspace[]) => void) | undefined;
      vi.mocked(window.api.listRemoteSshWorkspaces)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            answerFirstCheck = resolve;
          })
        )
        .mockResolvedValueOnce([]);
      const user = userEvent.setup();
      renderSsh();

      const deleteData = () =>
        screen.getByRole('switch', { name: 'Delete all Komla data from this host' });
      await user.click(screen.getByRole('button', { name: 'Delete host' }));
      await user.click(deleteData());
      expect(screen.getByRole('button', { name: 'Delete Host' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await user.click(screen.getByRole('button', { name: 'Delete host' }));
      await user.click(deleteData());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Delete Host' })).toBeEnabled()
      );
      await act(async () => {
        answerFirstCheck?.([
          {
            workspaceId: 'ws-42',
            name: 'fix-login',
            terminalCount: 1,
            updatedAt: 1,
            adopted: false,
            mayBeOnOtherDevices: true,
          },
        ]);
      });

      expect(screen.queryByText(/may be in use on another device/)).not.toBeInTheDocument();
      expect(deleteData()).toBeChecked();
    });
  });

  describe('adding a host', () => {
    it('checks the machine, sets it up, then continues to agent setup', async () => {
      mockHosts = [];
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'first.example.com', 'First remote');
      expect(within(dialog).getByRole('heading', { name: 'Add SSH host' })).toBeInTheDocument();
      expect(within(dialog).getByLabelText('User')).not.toHaveAttribute('placeholder');
      expect(within(dialog).queryByLabelText('Identity file')).not.toBeInTheDocument();
      expect(within(dialog).getByText(/Agents on the machine can use your SSH keys/)).toBeVisible();
      const forwardingDetails = within(dialog).getByText('Learn more').closest('details');
      expect(forwardingDetails).not.toHaveAttribute('open');
      await user.click(within(dialog).getByText('Learn more'));
      expect(forwardingDetails).toHaveAttribute('open');
      expect(
        within(dialog).getByText(
          /Agents kept running in tmux lose the keys after Komla disconnects/
        )
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('switch', { name: 'Treat as isolated' })).toBeChecked();
      await user.click(within(dialog).getByRole('switch', { name: 'Forward SSH agent' }));
      expect(
        within(dialog).getByText(/needs its own Git credentials to create workspaces/)
      ).toBeInTheDocument();
      expect(within(dialog).getByText(/Checking changes nothing on the machine/)).toBeVisible();
      const setupDetails = within(dialog).getByText('See what setup changes').closest('details');
      await user.click(within(dialog).getByText('See what setup changes'));
      expect(setupDetails).toHaveAttribute('open');
      const setupItems = setupDetails?.querySelectorAll('li');
      expect(setupItems).toHaveLength(5);
      expect(setupItems?.[2]).toHaveTextContent(/Installs or refreshes the Remote Companion/);
      expect(setupItems?.[2]).not.toHaveTextContent(/\.sh/);

      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));

      const results = await within(dialog).findByRole('list', { name: 'Check results' });
      expect(within(results).getByText(/git version 2\.43\.0 is installed/)).toBeInTheDocument();
      expect(within(results).getByText(/tmux 3\.4 keeps remote terminals running/)).toBeVisible();
      expect(within(results).getByText(/rsync is on both computers/)).toBeInTheDocument();
      expect(within(results).queryByText(/3\.4 or later/)).not.toBeInTheDocument();
      expect(mockSaveHost).not.toHaveBeenCalled();
      expect(window.api.verifySshHost).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'First remote', hostname: 'first.example.com' })
      );

      await user.click(within(dialog).getByRole('button', { name: 'Set up machine' }));

      expect(await screen.findByText('First remote is ready')).toBeInTheDocument();
      expect(mockBeginPendingSetup).toHaveBeenCalledOnce();
      expect(mockSaveHost).toHaveBeenCalledWith(
        expect.objectContaining({
          setupPending: true,
          basePath: '/home/dev/.komla',
          isolated: true,
        })
      );
      expect(screen.getByText(/New workspaces will start on it/)).toBeInTheDocument();
      expect(mockUpdateConfig).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Done' }));

      expect(mockSaveHost).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: expect.stringMatching(/^ssh-/), setupPending: false })
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockCompletePendingSetup).toHaveBeenCalled();
    });

    it('names a host after its address and splits a pasted user and port', async () => {
      mockHosts = [];
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'deploy@build.example.com:2222');
      await user.tab();

      expect(within(dialog).getByLabelText('Host or alias')).toHaveValue('build.example.com');
      expect(within(dialog).getByLabelText('User')).toHaveValue('deploy');
      expect(within(dialog).getByLabelText('Port')).toHaveValue('2222');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));

      await within(dialog).findByRole('list', { name: 'Check results' });
      expect(window.api.verifySshHost).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'build.example.com',
          hostname: 'build.example.com',
          user: 'deploy',
          port: 2222,
        })
      );
    });

    it('fills the form from ~/.ssh/config', async () => {
      vi.mocked(window.api.listSshConfigHosts).mockResolvedValue([
        { alias: 'gpu', hostname: '10.0.0.5', user: 'devuser', port: 2222, proxyJump: 'bastion' },
        { alias: 'build', hostname: 'build.internal' },
        { alias: 'dev.example.com' },
        { alias: 'devbox', hostname: 'DEV.example.com' },
        { alias: 'dev-admin', hostname: 'dev.example.com', user: 'admin' },
      ]);
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Add SSH host' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Fill from ~/.ssh/config…' }));

      const list = await within(dialog).findByRole('list', { name: 'Hosts in ~/.ssh/config' });
      expect(within(list).getByText('devuser@10.0.0.5:2222 via bastion')).toBeInTheDocument();
      // Hosts Komla already connects to are marked and can't be picked again.
      expect(within(list).getByRole('button', { name: /^dev\.example\.com/ })).toBeDisabled();
      expect(within(list).getByRole('button', { name: /^devbox/ })).toBeDisabled();
      expect(within(list).getByRole('button', { name: /^dev-admin/ })).toBeEnabled();
      await user.type(within(dialog).getByLabelText('Filter hosts'), 'gp');
      expect(within(list).queryByText('build')).not.toBeInTheDocument();
      await user.click(within(list).getByRole('button', { name: /gpu/ }));

      expect(within(dialog).getByLabelText('Host or alias')).toHaveValue('gpu');
      expect(within(dialog).getByLabelText('Name')).toHaveValue('gpu');
      expect(within(dialog).getByLabelText('User')).toHaveValue('');
      expect(
        within(dialog).getByText(
          'Uses the settings for gpu in ~/.ssh/config: devuser@10.0.0.5:2222 via bastion.'
        )
      ).toBeInTheDocument();
    });

    it('splits a pasted user and port when the form is submitted with Enter', async () => {
      mockHosts = [];
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'deploy@build.example.com:2222{Enter}');

      await within(dialog).findByRole('list', { name: 'Check results' });
      expect(window.api.verifySshHost).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'build.example.com', user: 'deploy', port: 2222 })
      );
      expect(within(dialog).getByLabelText('Host or alias')).toHaveValue('build.example.com');
    });

    it('drops a check result for details changed while it ran', async () => {
      mockHosts = [];
      const finishCheck = holdVerify(() => true);
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'first.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));
      await user.type(within(dialog).getByLabelText('Host or alias'), '.au');
      await finishCheck();

      expect(within(dialog).queryByRole('list', { name: 'Check results' })).not.toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Check machine' })).toBeEnabled();
    });

    it('stays open with its fields locked while setting up', async () => {
      mockHosts = [];
      const finishSetup = holdVerify((options) => Boolean(options?.prepare));
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'first.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));
      await user.click(await within(dialog).findByRole('button', { name: 'Set up machine' }));

      expect(within(dialog).getByLabelText('Host or alias')).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      await user.keyboard('{Escape}');
      await user.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(screen.getByRole('dialog')).toBe(dialog);

      await finishSetup();
      expect(await screen.findByText('first.example.com is ready')).toBeInTheDocument();
    });

    it('closes the ready step with a click outside', async () => {
      mockHosts = [];
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'first.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));
      await user.click(await within(dialog).findByRole('button', { name: 'Set up machine' }));
      await screen.findByText('first.example.com is ready');
      await user.click(document.querySelector('[data-native-overlay="dialog"]:not([role])')!);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('says when ~/.ssh/config has no hosts and goes back to the form', async () => {
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'typed.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Fill from ~/.ssh/config…' }));

      expect(await within(dialog).findByText('No hosts in ~/.ssh/config')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Back' }));
      expect(within(dialog).getByLabelText('Host or alias')).toHaveValue('typed.example.com');

      await user.click(within(dialog).getByRole('button', { name: 'Fill from ~/.ssh/config…' }));
      await within(dialog).findByText('No hosts in ~/.ssh/config');
      await user.keyboard('{Escape}');
      expect(within(dialog).getByLabelText('Host or alias')).toHaveValue('typed.example.com');
    });

    it('blocks setup on missing Git while keeping rsync advisory', async () => {
      mockHosts = [];
      vi.mocked(window.api.verifySshHost).mockResolvedValue({
        ok: true,
        prepared: false,
        resolvedBasePath: '/home/dev/.komla',
        git: { status: 'missing' },
        tmux: { status: 'available', version: 'tmux 3.4' },
        monitoring: { status: 'available', missingRequirements: [] },
        localMirror: {
          platform: 'supported',
          localRsync: 'missing',
          remoteRsync: 'missing',
        },
      });
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'missing.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));

      expect(
        await within(dialog).findByText(/Git is required and is not installed/)
      ).toBeInTheDocument();
      expect(within(dialog).getByText(/sudo apt install git/)).toBeInTheDocument();
      expect(
        within(dialog).getByText(/rsync is missing on this computer and the SSH host/)
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
      expect(mockSaveHost).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Check again' }));
      expect(window.api.verifySshHost).toHaveBeenCalledTimes(2);
      expect(mockSaveHost).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', { status: 'missing' as const }, /tmux is required and is not installed/],
      [
        'unusable',
        { status: 'unusable' as const, version: 'tmux 1.8' },
        /tmux 1\.8 is installed but is not working/,
      ],
    ])('blocks setup when tmux is %s', async (_label, tmux, message) => {
      mockHosts = [];
      vi.mocked(window.api.verifySshHost).mockResolvedValue({
        ok: true,
        prepared: false,
        resolvedBasePath: '/home/dev/.komla',
        git: { status: 'available', version: 'git version 2.43.0' },
        tmux,
        monitoring: { status: 'available', missingRequirements: [] },
        localMirror: {
          platform: 'supported',
          localRsync: 'available',
          remoteRsync: 'available',
        },
        gitIdentity: { configured: true },
      });
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'no-tmux.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));

      expect(await within(dialog).findByText(message)).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
      expect(
        within(dialog).queryByRole('button', { name: 'Set up machine' })
      ).not.toBeInTheDocument();
      expect(mockSaveHost).not.toHaveBeenCalled();
    });

    it('recommends tmux 3.4 without blocking setup on an older tmux', async () => {
      mockHosts = [];
      vi.mocked(window.api.verifySshHost).mockResolvedValue({
        ok: true,
        prepared: false,
        resolvedBasePath: '/home/dev/.komla',
        git: { status: 'available', version: 'git version 2.43.0' },
        tmux: { status: 'available', version: 'tmux 3.3a' },
        monitoring: { status: 'available', missingRequirements: [] },
        localMirror: {
          platform: 'supported',
          localRsync: 'available',
          remoteRsync: 'available',
        },
        gitIdentity: { configured: true },
      });
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'old-tmux.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));

      expect(
        await within(dialog).findByText(/tmux 3\.3a works, but 3\.4 or later is recommended/)
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Set up machine' })).toBeEnabled();
    });

    it('blocks setup when required remote utilities are missing', async () => {
      mockHosts = [];
      vi.mocked(window.api.verifySshHost).mockResolvedValue({
        ok: true,
        prepared: false,
        resolvedBasePath: '/home/dev/.komla',
        git: { status: 'available', version: 'git version 2.43.0' },
        tmux: { status: 'available', version: 'tmux 3.4' },
        monitoring: {
          status: 'missing',
          missingRequirements: ['awk', 'curl or wget'],
        },
        localMirror: {
          platform: 'supported',
          localRsync: 'available',
          remoteRsync: 'available',
        },
        gitIdentity: { configured: true },
      });
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'minimal.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));

      expect(await within(dialog).findByText('awk, curl or wget')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
      expect(mockSaveHost).not.toHaveBeenCalled();
    });

    it('automatically completes a missing remote git identity from the local machine', async () => {
      mockHosts = [];
      vi.mocked(window.api.verifySshHost).mockImplementation(async (_host, options) => ({
        ok: true,
        prepared: Boolean(options?.prepare),
        resolvedBasePath: '/home/dev/.komla',
        git: { status: 'available', version: 'git version 2.43.0' },
        tmux: { status: 'available', version: 'tmux 3.4' },
        monitoring: { status: 'available', missingRequirements: [] },
        localMirror: {
          platform: 'supported',
          localRsync: 'available',
          remoteRsync: 'available',
        },
        gitIdentity: options?.prepare
          ? { configured: true, userName: 'Local Name', userEmail: 'local@example.com' }
          : { configured: false, userName: 'Remote Name' },
        localGitIdentity: {
          configured: true,
          userName: 'Local Name',
          userEmail: 'local@example.com',
        },
      }));
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'new.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));

      expect(await within(dialog).findByText(/Setup sets it to/)).toBeInTheDocument();
      expect(within(dialog).getByText('Local Name <local@example.com>')).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Set up machine' }));

      expect(window.api.verifySshHost).toHaveBeenLastCalledWith(
        expect.objectContaining({ hostname: 'new.example.com' }),
        { prepare: true }
      );
    });

    it('hides the rsync recommendation when local copies are unsupported on native Windows', async () => {
      mockHosts = [];
      (window.api as unknown as { platform: string }).platform = 'win32';
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'remote.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));

      await within(dialog).findByRole('list', { name: 'Check results' });
      expect(within(dialog).queryByText('Local copies')).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/rsync/)).not.toBeInTheDocument();
    });

    it('configures agent integrations on the ready step', async () => {
      mockHosts = [];
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'first.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));
      await user.click(await within(dialog).findByRole('button', { name: 'Set up machine' }));

      expect(await screen.findByText('first.example.com is ready')).toBeInTheDocument();
      // Hooks lead the step, one row per agent, with nothing to expand first.
      const codexRow = within(screen.getByRole('group', { name: 'Hooks' }))
        .getByText('Codex CLI')
        .closest('div.space-y-2') as HTMLElement;
      await user.click(within(codexRow).getByRole('button', { name: 'Enable' }));

      await waitFor(() => {
        expect(window.api.enableSshIntegration).toHaveBeenCalledWith(
          expect.stringMatching(/^ssh-/),
          'codex',
          'notifications'
        );
      });
    });

    it('checks agent integrations before showing the ready step', async () => {
      mockHosts = [];
      let resolveIntegrationStatus!: (status: SshIntegrationStatus) => void;
      vi.mocked(window.api.getSshIntegrationStatus).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveIntegrationStatus = resolve;
        })
      );
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'first.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));
      await user.click(await within(dialog).findByRole('button', { name: 'Set up machine' }));

      await waitFor(() => {
        expect(window.api.getSshIntegrationStatus).toHaveBeenCalledWith(
          expect.stringMatching(/^ssh-/)
        );
      });
      expect(screen.queryByText('first.example.com is ready')).not.toBeInTheDocument();

      resolveIntegrationStatus({
        claude: { notifications: true, mcp: false },
        codex: { notifications: false, mcp: false },
        antigravity: { notifications: false, mcp: false },
        opencode: { notifications: false, mcp: false },
        komlaSkill: false,
      });

      expect(await screen.findByText('first.example.com is ready')).toBeInTheDocument();
      const hooks = within(screen.getByRole('group', { name: 'Hooks' }));
      expect(hooks.getAllByText(/Configured/)).toHaveLength(1);
      expect(hooks.getAllByRole('button', { name: 'Enable' })).toHaveLength(3);
      expect(screen.queryByText('Checking...')).not.toBeInTheDocument();
      expect(window.api.getSshIntegrationStatus).toHaveBeenCalledOnce();
    });

    it('selects a newly added host for new workspaces and offers its integrations', async () => {
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'second.example.com', 'Second remote');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));
      await user.click(await within(dialog).findByRole('button', { name: 'Set up machine' }));

      await waitFor(() =>
        expect(mockUpdateConfig).toHaveBeenCalledWith({
          lastWorkspaceEnvironment: { kind: 'ssh', hostId: expect.stringMatching(/^ssh-/) },
        })
      );
      expect(mockUpdateConfig).not.toHaveBeenCalledWith({
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: host.id },
      });
      expect(mockBeginPendingSetup).not.toHaveBeenCalled();
      expect(mockSaveHost).toHaveBeenCalledWith(
        expect.not.objectContaining({ setupPending: true })
      );
      expect(await screen.findByText('Second remote is ready')).toBeInTheDocument();
    });

    it('tells the opener which host it added', async () => {
      const onAdded = vi.fn();
      const user = userEvent.setup();
      render(<SshHostDialogHost />);

      act(() => useSshHostDialogStore.getState().openAdd('new_workspace', { onAdded }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('Host or alias'), 'other.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));
      await user.click(await within(dialog).findByRole('button', { name: 'Set up machine' }));

      await waitFor(() => expect(onAdded).toHaveBeenCalledWith(expect.stringMatching(/^ssh-/)));
      expect(window.api.trackSshHostAdded).toHaveBeenCalledExactlyOnceWith('new_workspace');
    });

    it('starts from the ~/.ssh/config host the opener picked', async () => {
      const user = userEvent.setup();
      render(<SshHostDialogHost />);

      act(() =>
        useSshHostDialogStore.getState().openAdd('onboarding', {
          configHost: { alias: 'gpu', hostname: '10.0.0.5', user: 'devuser' },
        })
      );
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByLabelText('Host or alias')).toHaveValue('gpu');
      expect(within(dialog).getByLabelText('Name')).toHaveValue('gpu');
      expect(
        within(dialog).getByText('Uses the settings for gpu in ~/.ssh/config: devuser@10.0.0.5.')
      ).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));
      await user.click(await within(dialog).findByRole('button', { name: 'Set up machine' }));

      await waitFor(() =>
        expect(window.api.trackSshHostAdded).toHaveBeenCalledExactlyOnceWith('onboarding')
      );
    });

    it('keeps a dialog started from ~/.ssh/config open on a click outside', async () => {
      const user = userEvent.setup();
      render(<SshHostDialogHost />);

      act(() =>
        useSshHostDialogStore.getState().openAdd('onboarding', { configHost: { alias: 'gpu' } })
      );
      const dialog = await screen.findByRole('dialog');
      await user.click(document.querySelector('[data-native-overlay="dialog"]:not([role])')!);

      expect(screen.getByRole('dialog')).toBe(dialog);
    });

    it('keeps the starting host summary when ~/.ssh/config fails to read', async () => {
      vi.mocked(window.api.listSshConfigHosts).mockRejectedValue(new Error('Permission denied'));
      const user = userEvent.setup();
      render(<SshHostDialogHost />);

      act(() =>
        useSshHostDialogStore.getState().openAdd('onboarding', {
          configHost: { alias: 'gpu', hostname: '10.0.0.5', user: 'devuser' },
        })
      );
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Fill from ~/.ssh/config…' }));
      expect(await within(dialog).findByText(/Permission denied/)).toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: /^gpu/ })).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Back' }));

      expect(
        within(dialog).getByText('Uses the settings for gpu in ~/.ssh/config: devuser@10.0.0.5.')
      ).toBeInTheDocument();
    });

    it('links more info about SSH hosts', async () => {
      render(<SshHostDialogHost />);

      act(() => useSshHostDialogStore.getState().openAdd('settings'));
      const dialog = await screen.findByRole('dialog');

      expect(within(dialog).getByRole('link', { name: /More info/ })).toHaveAttribute(
        'href',
        expect.stringMatching(/\/remote-workspaces$/)
      );
    });

    it('reports a newly added host with where Settings was opened from', async () => {
      useSettingsDialogStore.setState({
        open: true,
        target: { tab: 'ssh', sshSetupSource: 'new_workspace' },
      });
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'second.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));
      await user.click(await within(dialog).findByRole('button', { name: 'Set up machine' }));

      await waitFor(() =>
        expect(window.api.trackSshHostAdded).toHaveBeenCalledExactlyOnceWith('new_workspace')
      );
    });

    it('reports a host added from Settings opened directly as settings', async () => {
      mockHosts = [];
      const user = userEvent.setup();
      renderSsh();

      const dialog = await startAdding(user, 'first.example.com');
      await user.click(within(dialog).getByRole('button', { name: 'Check machine' }));
      await user.click(await within(dialog).findByRole('button', { name: 'Set up machine' }));

      expect(await screen.findByText('first.example.com is ready')).toBeInTheDocument();
      expect(window.api.trackSshHostAdded).toHaveBeenCalledExactlyOnceWith('settings');
    });
  });

  describe('a first host cut short', () => {
    it('resumes at the integrations step when SSH settings reopen', async () => {
      mockHosts = [{ ...host, setupPending: true }];
      const user = userEvent.setup();
      renderSsh();

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Devbox is ready')).toBeInTheDocument();
      expect(within(dialog).getByText('Claude Code')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Review choices' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Done' }));

      await waitFor(() => {
        expect(mockSaveHost).toHaveBeenCalledWith({ ...host, setupPending: false });
      });
    });

    it('shows the launch defaults once the step closes, so they can pick the host', async () => {
      mockHosts = [{ ...host, setupPending: true }];
      const user = userEvent.setup();
      renderSsh();

      const dialog = await screen.findByRole('dialog');
      await user.click(await skillButton(dialog, 'Enable'));
      await waitFor(() => expect(window.api.setSshKomlaSkill).toHaveBeenCalledWith(host.id, true));
      expect(mockOfferAgentLaunchDefaults).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Done' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockHosts).toEqual([{ ...host, setupPending: false }]);
      expect(mockOfferAgentLaunchDefaults).toHaveBeenCalledOnce();
    });

    it('shows the launch defaults when the skill finishes turning on after the step closes', async () => {
      mockHosts = [{ ...host, setupPending: true }];
      let finishSkill = () => {};
      vi.mocked(window.api.setSshKomlaSkill).mockReturnValue(
        new Promise<void>((resolve) => {
          finishSkill = resolve;
        })
      );
      const user = userEvent.setup();
      renderSsh();

      const dialog = await screen.findByRole('dialog');
      await user.click(await skillButton(dialog, 'Enable'));
      await user.click(within(dialog).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockOfferAgentLaunchDefaults).not.toHaveBeenCalled();

      await act(async () => finishSkill());

      await waitFor(() => expect(mockOfferAgentLaunchDefaults).toHaveBeenCalledOnce());
    });

    it('leaves the launch defaults unshown when the skill comes back off', async () => {
      mockHosts = [{ ...host, setupPending: true }];
      const status = await window.api.getSshIntegrationStatus(host.id);
      vi.mocked(window.api.setSshKomlaSkill).mockImplementation(async (_hostId, enabled) => {
        status.komlaSkill = enabled;
      });
      vi.mocked(window.api.getSshIntegrationStatus).mockImplementation(async () => ({ ...status }));
      const user = userEvent.setup();
      renderSsh();

      const dialog = await screen.findByRole('dialog');
      await user.click(await skillButton(dialog, 'Enable'));
      await user.click(await skillButton(dialog, 'Remove'));
      await waitFor(() => expect(window.api.setSshKomlaSkill).toHaveBeenCalledWith(host.id, false));

      await user.click(within(dialog).getByRole('button', { name: 'Done' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockOfferAgentLaunchDefaults).not.toHaveBeenCalled();
    });

    it('stays on the integrations step while the user remains there', async () => {
      vi.useFakeTimers();
      mockHosts = [{ ...host, setupPending: true }];

      try {
        renderSsh();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });

        expect(screen.getByText('Devbox is ready')).toBeInTheDocument();

        await vi.advanceTimersByTimeAsync(10_000);

        expect(mockSaveHost).not.toHaveBeenCalled();
        expect(screen.getByText('Devbox is ready')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('finishes setup when the dialog is closed', async () => {
      mockHosts = [{ ...host, setupPending: true }];
      const user = userEvent.setup();
      renderSsh();

      await screen.findByText('Devbox is ready');
      await user.keyboard('{Escape}');

      expect(mockCompletePendingSetup).toHaveBeenCalledOnce();
    });
  });

  describe('editing a host', () => {
    it('edits loopback-only local service forwards in the advanced options', async () => {
      mockHosts = [
        {
          ...host,
          portForwards: [
            {
              id: 'postgres',
              name: 'Local PostgreSQL',
              localPort: 5432,
              remotePort: 15432,
              enabled: true,
            },
          ],
        },
      ];
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Edit SSH host' }));
      const dialog = await screen.findByRole('dialog');

      expect(within(dialog).getByRole('heading', { name: 'Edit Devbox' })).toBeInTheDocument();
      expect(within(dialog).getByText('Port forwards')).toBeInTheDocument();
      expect(within(dialog).getByDisplayValue('Local PostgreSQL')).toBeInTheDocument();
      expect(within(dialog).getByLabelText('Local port for Local PostgreSQL')).toHaveValue('5432');
      expect(within(dialog).getByLabelText('SSH host port for Local PostgreSQL')).toHaveValue(
        '15432'
      );
      expect(within(dialog).getByLabelText('Direction for Local PostgreSQL')).toHaveValue(
        'local-to-remote'
      );
      expect(
        within(dialog).getByRole('option', { name: 'SSH host → this computer' })
      ).toBeInTheDocument();
      expect(await within(dialog).findByText('Port forwards connected.')).toBeInTheDocument();
      expect(within(dialog).getAllByText('127.0.0.1:')).toHaveLength(2);
      expect(
        within(dialog).queryByRole('button', { name: 'Fill from ~/.ssh/config…' })
      ).not.toBeInTheDocument();
    });

    it('opens for the host it was asked for', async () => {
      mockHosts = [
        { ...host, id: 'other', name: 'Other' },
        {
          ...host,
          portForwards: [
            {
              id: 'postgres',
              name: 'PostgreSQL',
              localPort: 5432,
              remotePort: 15432,
              enabled: true,
            },
          ],
        },
      ];
      render(<SshHostDialogHost />);

      act(() => useSshHostDialogStore.getState().openEdit('ssh-dev'));

      expect(await screen.findByDisplayValue('PostgreSQL')).toBeInTheDocument();
      expect(screen.getByDisplayValue('dev.example.com')).toBeInTheDocument();
    });

    it('rejects SSH host ports reserved for Komla data tunnels', async () => {
      const reservedPort = komlaSshRemoteDataPort(host.id);
      mockHosts = [
        {
          ...host,
          portForwards: [
            {
              id: 'postgres',
              name: 'Local PostgreSQL',
              localPort: 5432,
              remotePort: 15432,
              enabled: true,
            },
          ],
        },
      ];
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Edit SSH host' }));
      const remotePort = await screen.findByLabelText('SSH host port for Local PostgreSQL');
      await user.clear(remotePort);
      await user.type(remotePort, String(reservedPort));
      await user.click(screen.getByRole('button', { name: 'Check changes' }));

      expect(
        screen.getByText(`SSH host port ${reservedPort} is reserved by Komla for this host.`)
      ).toBeInTheDocument();
      expect(window.api.verifySshHost).not.toHaveBeenCalled();
    });

    it('keeps agent forwarding editable while immutable connection fields are locked', async () => {
      mockWorkspaces = [sshWorkspace('ssh-workspace')];
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Edit SSH host' }));
      const dialog = await screen.findByRole('dialog');

      expect(within(dialog).getByLabelText('Host or alias')).toBeDisabled();
      expect(within(dialog).getByRole('switch', { name: 'Forward SSH agent' })).toBeEnabled();
      expect(within(dialog).getByLabelText('Identity file')).toBeDisabled();
      expect(within(dialog).getByDisplayValue('/home/dev/.komla')).toBeDisabled();
      expect(within(dialog).getByLabelText('Extra SSH args')).toBeDisabled();
      expect(
        within(dialog).getByText(/Host address, user, port, identity file/)
      ).toBeInTheDocument();
      expect(within(dialog).getByText(/Changes apply to new SSH sessions/)).toBeInTheDocument();
    });

    it('enables agent forwarding for a host that already owns a workspace', async () => {
      mockHosts = [{ ...host, forwardAgent: false }];
      mockWorkspaces = [sshWorkspace('failed-ssh-workspace')];
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Edit SSH host' }));
      await user.click(await screen.findByRole('switch', { name: 'Forward SSH agent' }));
      await user.click(screen.getByRole('button', { name: 'Check changes' }));
      await user.click(await screen.findByRole('button', { name: 'Save changes' }));

      await waitFor(() => {
        expect(mockSaveHost).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'ssh-dev', forwardAgent: true })
        );
      });
      expect(screen.queryByText(/Remove existing SSH workspaces/)).not.toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('marks a host isolated so agents may start modes that skip permission prompts', async () => {
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Edit SSH host' }));
      const isolated = await screen.findByRole('switch', { name: 'Treat as isolated' });
      expect(isolated).not.toBeChecked();
      await user.click(isolated);
      await user.click(screen.getByRole('button', { name: 'Check changes' }));
      await user.click(await screen.findByRole('button', { name: 'Save changes' }));

      await waitFor(() => {
        expect(mockSaveHost).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'ssh-dev', isolated: true })
        );
      });
    });

    it('describes key access only while forwarding is on', async () => {
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Edit SSH host' }));
      await screen.findByRole('dialog');
      expect(
        screen.getByText(/can use your SSH keys while Komla is connected/)
      ).toBeInTheDocument();

      await user.click(screen.getByRole('switch', { name: 'Forward SSH agent' }));
      expect(
        screen.queryByText(/can use your SSH keys while Komla is connected/)
      ).not.toBeInTheDocument();
      expect(screen.getByText(/needs its own Git credentials/)).toBeInTheDocument();
    });

    it('keeps the remote Komla path fixed for a saved host without workspaces', async () => {
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Edit SSH host' }));
      const dialog = await screen.findByRole('dialog');

      expect(within(dialog).getByDisplayValue('/home/dev/.komla')).toBeDisabled();
      expect(
        within(dialog).getByText(
          'Remote Komla path is fixed after this machine is connected. Remove and reconnect the machine to use a different path.'
        )
      ).toBeInTheDocument();
      expect(within(dialog).getByLabelText('Host or alias')).toBeEnabled();
    });

    it('does not report saving changes to an existing host', async () => {
      useSettingsDialogStore.setState({
        open: true,
        target: { tab: 'ssh', sshSetupSource: 'tips' },
      });
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Edit SSH host' }));
      await user.click(await screen.findByRole('switch', { name: 'Forward SSH agent' }));
      await user.click(screen.getByRole('button', { name: 'Check changes' }));
      await user.click(await screen.findByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(mockSaveHost).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'ssh-dev', forwardAgent: false })
        )
      );
      expect(window.api.trackSshHostAdded).not.toHaveBeenCalled();
      expect(mockAddToast).toHaveBeenCalledWith('SSH host saved', 'success');
    });

    it('closes when its host is deleted', async () => {
      const { rerender } = renderSsh();
      act(() => useSshHostDialogStore.getState().openEdit('ssh-dev'));
      await screen.findByRole('dialog');

      mockHosts = [];
      rerender(sshSettings());

      await waitFor(() => expect(useSshHostDialogStore.getState().open).toBe(false));
      expect(mockCompletePendingSetup).toHaveBeenCalled();
    });

    it('gives focus back to what opened it when it closes', async () => {
      const user = userEvent.setup();
      renderSsh();

      await user.click(screen.getByRole('button', { name: 'Edit SSH host' }));
      await user.click(await screen.findByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Edit SSH host' })).toHaveFocus();
    });
  });
});

// The Komla skill's Enable or Remove, under Komla CLI in the integrations step.
function skillButton(dialog: HTMLElement, name: 'Enable' | 'Remove'): Promise<HTMLElement> {
  return within(within(dialog).getByRole('group', { name: 'Komla CLI' })).findByRole('button', {
    name,
  });
}
