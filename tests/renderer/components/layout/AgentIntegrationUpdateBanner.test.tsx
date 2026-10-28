/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentIntegrationUpdateBanner,
  INTEGRATION_UPDATE_CHECK_DELAY_MS,
} from '../../../../src/renderer/components/layout/AgentIntegrationUpdateBanner';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useSettingsDialogStore } from '../../../../src/renderer/stores/settings-dialog.store';
import { useSshHostsStore } from '../../../../src/renderer/stores/ssh-hosts.store';

import type { SshHost, SshIntegrationUpdates } from '../../../../src/renderer/types';

const update = {
  files: [{ path: '/home/dev/.claude/settings.json', description: 'Update hooks' }],
};

interface LocalState {
  claude?: string;
  codex?: string;
  opencode?: string;
}

let sshListener: ((updates: Record<string, SshIntegrationUpdates>) => void) | undefined;

/** Each agent named in `pending` reports an update that would install the given content. */
function mockApi(pending: LocalState, cachedSsh: Record<string, SshIntegrationUpdates> = {}) {
  window.api = {
    getNotificationHookDetails: vi.fn().mockResolvedValue({
      configJson: pending.claude ?? 'claude hooks',
      update: pending.claude ? update : undefined,
    }),
    getCodexNotificationHookDetails: vi.fn().mockResolvedValue({
      configJson: pending.codex ?? 'codex hooks',
      update: pending.codex ? update : undefined,
    }),
    getAntigravityNotificationHookDetails: vi.fn().mockResolvedValue({ configJson: 'agy hooks' }),
    getOpenCodeNotificationHookDetails: vi.fn().mockResolvedValue({
      pluginContent: pending.opencode ?? 'plugin',
      update: pending.opencode ? update : undefined,
    }),
    getCachedSshIntegrationUpdates: vi.fn().mockResolvedValue(cachedSsh),
    onSshIntegrationUpdatesChange: vi.fn((listener) => {
      sshListener = listener;
      return vi.fn();
    }),
  } as unknown as typeof window.api;
}

async function renderChecked() {
  const view = render(<AgentIntegrationUpdateBanner />, { wrapper: TooltipProvider });
  await act(() => vi.advanceTimersByTimeAsync(INTEGRATION_UPDATE_CHECK_DELAY_MS));
  return view;
}

const title = (names: string) => `Komla's hooks for ${names} have an update.`;

describe('AgentIntegrationUpdateBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sshListener = undefined;
    useSettingsDialogStore.setState({ open: false, target: {} });
    useSshHostsStore.setState({ hosts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the agents with an update after startup and opens Settings to review it', async () => {
    mockApi({ claude: 'new claude hooks', opencode: 'new plugin' });
    render(<AgentIntegrationUpdateBanner />, { wrapper: TooltipProvider });
    await act(() => vi.advanceTimersByTimeAsync(INTEGRATION_UPDATE_CHECK_DELAY_MS - 1));
    expect(window.api.getNotificationHookDetails).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText(title('Claude Code and OpenCode'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));
    expect(useSettingsDialogStore.getState()).toMatchObject({
      open: true,
      target: { tab: 'integrations' },
    });
  });

  it('stays hidden when every integration is current', async () => {
    mockApi({});
    await renderChecked();
    expect(screen.queryByRole('button', { name: 'Review update' })).toBeNull();
  });

  it('remembers a dismissal until Komla would install something different', async () => {
    mockApi({ claude: 'new claude hooks' });
    const first = await renderChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification update notice' }));
    expect(screen.queryByText(title('Claude Code'))).toBeNull();
    first.unmount();

    const second = await renderChecked();
    expect(screen.queryByText(title('Claude Code'))).toBeNull();
    second.unmount();

    mockApi({ claude: 'newer claude hooks' });
    await renderChecked();
    expect(screen.getByText(title('Claude Code'))).toBeInTheDocument();
  });

  it('shows only the updates that are new since a dismissal', async () => {
    mockApi({ claude: 'new claude hooks' });
    const first = await renderChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification update notice' }));
    first.unmount();

    mockApi({ claude: 'new claude hooks', codex: 'new codex hooks' });
    await renderChecked();
    expect(screen.getByText(title('Codex'))).toBeInTheDocument();
  });

  it('keeps earlier dismissals for SSH hosts not checked yet', async () => {
    mockApi({ claude: 'new claude hooks' }, { 'host-1': { codex: 'remote hooks' } });
    const first = await renderChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification update notice' }));
    first.unmount();

    // The next launch, before host-1 is checked, finds a new OpenCode plugin.
    mockApi({ claude: 'new claude hooks', opencode: 'new plugin' });
    await renderChecked();
    expect(screen.getByText(title('OpenCode'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification update notice' }));

    act(() => sshListener?.({ 'host-1': { codex: 'remote hooks' } }));
    expect(screen.queryByRole('button', { name: 'Review update' })).toBeNull();
  });

  it('keeps SSH results pushed while the local check is still running', async () => {
    mockApi({}, { 'host-1': { claude: 'remote hooks' } });
    let finishLocal = () => {};
    vi.mocked(window.api.getNotificationHookDetails).mockReturnValue(
      new Promise((resolve) => {
        finishLocal = () => resolve({ configJson: 'claude hooks' } as never);
      })
    );
    await renderChecked();

    // The host's update was applied meanwhile.
    act(() => sshListener?.({}));
    await act(async () => {
      finishLocal();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole('button', { name: 'Review update' })).toBeNull();
  });

  it('adds SSH hosts as their checks report updates', async () => {
    useSshHostsStore.setState({ hosts: [{ id: 'host-1', name: 'devbox' } as SshHost] });
    mockApi({}, { 'host-2': { claude: 'remote hooks' } });
    await renderChecked();
    expect(screen.getByText(title('Claude Code on an SSH host'))).toBeInTheDocument();

    act(() => sshListener?.({ 'host-1': { codex: 'a', opencode: 'b' } }));
    expect(screen.getByText(title('Codex on devbox and OpenCode on devbox'))).toBeInTheDocument();
  });

  it('checks again when Settings closes', async () => {
    mockApi({ claude: 'new claude hooks' });
    await renderChecked();
    expect(screen.getByText(title('Claude Code'))).toBeInTheDocument();

    act(() => useSettingsDialogStore.getState().openSettings({ tab: 'integrations' }));
    mockApi({});
    await act(async () => {
      useSettingsDialogStore.getState().closeSettings();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText(title('Claude Code'))).toBeNull();
  });
});
