/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteHostAccessCard } from '../../../../../src/renderer/components/layout/settings/RemoteHostAccessCard';

import type { RemoteControlHostAccessStatus } from '../../../../../src/shared/types/remote-control';

const mockAddToast = vi.fn();

vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: { addToast: typeof mockAddToast }) => unknown) =>
    selector({ addToast: mockAddToast }),
}));

const statuses: RemoteControlHostAccessStatus[] = [
  { hostId: 'h1', hostName: 'devbox', enabled: false, state: 'off' },
  {
    hostId: 'h2',
    hostName: 'gpu-box',
    enabled: true,
    state: 'needs-attention',
    message: 'Tailscale is not installed on this host. Install it and join your tailnet.',
  },
  {
    hostId: 'h3',
    hostName: 'build',
    enabled: true,
    state: 'ready',
    url: 'wss://build.tail1.ts.net:48123/remote/ws',
  },
];

function installApi(list = statuses) {
  let changed: ((next: RemoteControlHostAccessStatus[]) => void) | null = null;
  const api = {
    remoteControlHostAccessList: vi.fn().mockResolvedValue(list),
    remoteControlHostAccessSet: vi.fn(async (hostId: string, enabled: boolean) => ({
      ...list.find((status) => status.hostId === hostId)!,
      enabled,
    })),
    onRemoteControlHostAccessChanged: vi.fn(
      (callback: (next: RemoteControlHostAccessStatus[]) => void) => {
        changed = callback;
        return vi.fn();
      }
    ),
  };
  Object.defineProperty(window, 'api', { value: api, configurable: true });
  return { api, emitChange: (next: RemoteControlHostAccessStatus[]) => changed?.(next) };
}

describe('RemoteHostAccessCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows each SSH host with what direct access needs there', async () => {
    installApi();

    render(<RemoteHostAccessCard remoteEnabled />);

    expect(await screen.findByText('gpu-box')).toBeTruthy();
    expect(screen.getByText(/Tailscale is not installed on this host/)).toBeTruthy();
    expect(screen.getByText('build.tail1.ts.net:48123')).toBeTruthy();
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText('Recommended')).toBeTruthy();
  });

  it('turns direct access on for a host and follows status changes', async () => {
    const { api, emitChange } = installApi();
    render(<RemoteHostAccessCard remoteEnabled />);

    await userEvent.click(await screen.findByRole('switch', { name: 'Direct access to devbox' }));

    expect(api.remoteControlHostAccessSet).toHaveBeenCalledWith('h1', true);
    emitChange([{ hostId: 'h1', hostName: 'devbox', enabled: true, state: 'setting-up' }]);
    await waitFor(() => expect(screen.getByText('Setting up…')).toBeTruthy());
  });

  it('only lets a host be turned off while remote access is off', async () => {
    installApi();

    render(<RemoteHostAccessCard remoteEnabled={false} />);

    expect(await screen.findByText('Turn on remote control above first.')).toBeTruthy();
    expect(
      (screen.getByRole('switch', { name: 'Direct access to devbox' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole('switch', { name: 'Direct access to build' }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('shows nothing without SSH hosts', async () => {
    const { api } = installApi([]);

    const { container } = render(<RemoteHostAccessCard remoteEnabled />);

    await waitFor(() => expect(api.remoteControlHostAccessList).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
