/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RemoteTab,
  secureStoragePromptNote,
} from '../../../../../src/renderer/components/layout/settings/RemoteTab';

import type { RemoteControlDirectState } from '../../../../../src/shared/types/remote-control';

const mockAddToast = vi.fn();
const mockUpdateConfig = vi.fn(async () => ({ ok: true, error: null }));

vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector?: (state: { addToast: typeof mockAddToast }) => unknown) => {
    const state = { addToast: mockAddToast };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const mockConfig = { directRemotePublicOrigin: '', directRemoteKeepAwake: true };

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: () => ({ config: mockConfig, updateConfig: mockUpdateConfig }),
}));

function pairedDevice(credentialId: string, label: string) {
  return {
    deviceId: 'd'.repeat(64),
    devicePublicKey: 'key',
    credentialId,
    publicKey: 'cose',
    signCounter: 0,
    aaguid: null,
    label,
    createdAt: '2026-10-19T10:00:00.000Z',
    lastUsedAt: null,
    transports: null,
    rpId: 'localhost',
  };
}

const fingerprint = 'a'.repeat(64);
const secret = 'A'.repeat(43);
const directServer = {
  host: '127.0.0.1',
  port: 52864,
  preferredPort: 52864,
  localOrigin: 'http://localhost:52864',
  httpOrigin: 'http://localhost:52864',
  wsUrl: `ws://localhost:52864/remote/ws?fp=${fingerprint}`,
  fingerprint,
};
const directOffer = {
  pairUrl: `http://localhost:52864/remote/pair#fp=${fingerprint}&secret=${secret}`,
  fingerprint,
  pairingSecret: secret,
};

function installApi(directState: RemoteControlDirectState) {
  let directStateChanged: ((state: RemoteControlDirectState) => void) | null = null;
  const api = {
    remoteControlDirectGetState: vi.fn().mockResolvedValue(directState),
    pairedDevicesList: vi.fn().mockResolvedValue([]),
    onRemoteControlDirectStateChanged: vi.fn(
      (callback: (state: RemoteControlDirectState) => void) => {
        directStateChanged = callback;
        return vi.fn();
      }
    ),
    onPairedDevicesChanged: vi.fn(() => vi.fn()),
    remoteControlHostAccessList: vi.fn().mockResolvedValue([]),
    remoteControlHostAccessSet: vi.fn(),
    onRemoteControlHostAccessChanged: vi.fn(() => vi.fn()),
    remoteControlDisconnectActive: vi.fn().mockResolvedValue(undefined),
    remoteControlDirectStart: vi.fn().mockResolvedValue(directServer),
    remoteControlDirectStop: vi.fn().mockResolvedValue(undefined),
    remoteControlDirectStartPairing: vi.fn().mockResolvedValue(directOffer),
    remoteControlDirectStartTailscaleServe: vi.fn().mockResolvedValue({
      server: directServer,
      command: 'tailscale serve --bg localhost:52864',
    }),
    remoteControlDirectGetTailscaleStatus: vi.fn().mockResolvedValue({
      installed: true,
      command: 'tailscale serve --bg --https=443 localhost:52864',
    }),
    remoteControlDirectCancelPairing: vi.fn().mockResolvedValue(undefined),
    pairedDevicesRename: vi.fn().mockResolvedValue(undefined),
    pairedDevicesRemove: vi.fn().mockResolvedValue(undefined),
    copyToClipboard: vi.fn(),
    openExternal: vi.fn().mockResolvedValue(undefined),
    emitDirectStateChanged: (state: RemoteControlDirectState) => directStateChanged?.(state),
  };
  (window as unknown as { api: typeof api; confirm: () => boolean }).api = api;
  window.confirm = vi.fn(() => true);
  return api;
}

describe('RemoteTab direct remote controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateConfig.mockResolvedValue({ ok: true, error: null });
  });

  it('shows a one-time enrollment QR without exposing a separate pairing code', async () => {
    installApi({ server: directServer, pairingOffer: directOffer, portChange: null });

    render(<RemoteTab />);

    expect(await screen.findByText('On, but only this computer can reach it')).toBeInTheDocument();
    // An offer started before Settings opened shows in the pair dialog.
    expect(await screen.findByRole('dialog', { name: 'Pair a device' })).toBeInTheDocument();
    expect(screen.getByText(directOffer.pairUrl)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Until Komla is published on your tailnet, the code only opens on this computer.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(await screen.findByAltText('Pair URL QR code')).toBeInTheDocument();
    expect(screen.queryByText(/Komla Relay/)).not.toBeInTheDocument();
  });

  it('starts enrollment and exposes copy/open controls', async () => {
    const api = installApi({ server: null, pairingOffer: null, portChange: null });
    const user = userEvent.setup();
    render(<RemoteTab />);

    await user.click(await screen.findByRole('button', { name: 'Pair a device' }));
    await waitFor(() => expect(api.remoteControlDirectStartPairing).toHaveBeenCalledOnce());
    expect(await screen.findByText(directOffer.pairUrl)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy pair URL' }));
    expect(api.copyToClipboard).toHaveBeenCalledWith(directOffer.pairUrl);
    await user.click(screen.getByRole('button', { name: 'Open pair URL' }));
    expect(api.openExternal).toHaveBeenCalledWith(directOffer.pairUrl);
  });

  it('waits for the device once it claims the code, and offers a new one', async () => {
    const api = installApi({ server: directServer, pairingOffer: directOffer, portChange: null });
    const user = userEvent.setup();
    render(<RemoteTab />);

    expect(await screen.findByText(directOffer.pairUrl)).toBeInTheDocument();
    api.emitDirectStateChanged({ server: directServer, pairingOffer: null, portChange: null });

    expect(
      await screen.findByText('Finish on the device by saving the passkey')
    ).toBeInTheDocument();
    expect(screen.queryByText(directOffer.pairUrl)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show a new code' }));
    await waitFor(() => expect(api.remoteControlDirectStartPairing).toHaveBeenCalledOnce());
  });

  it('cancels the code when the pair dialog closes', async () => {
    const api = installApi({ server: directServer, pairingOffer: directOffer, portChange: null });
    const user = userEvent.setup();
    render(<RemoteTab />);

    expect(await screen.findByText(directOffer.pairUrl)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!);

    await waitFor(() => expect(api.remoteControlDirectCancelPairing).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('offers direct access to SSH hosts once a device is paired', async () => {
    const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
    let devicesChanged: ((devices: ReturnType<typeof pairedDevice>[]) => void) | null = null;
    api.onPairedDevicesChanged.mockImplementation((callback) => {
      devicesChanged = callback;
      return vi.fn();
    });
    api.remoteControlHostAccessList.mockResolvedValue([
      { hostId: 'h1', hostName: 'devbox', enabled: false, state: 'off' },
      { hostId: 'h2', hostName: 'gpu-box', enabled: false, state: 'off' },
      {
        hostId: 'h3',
        hostName: 'build',
        enabled: true,
        state: 'ready',
        url: 'wss://build.tail1.ts.net:48123/remote/ws',
      },
    ]);
    const user = userEvent.setup();
    render(<RemoteTab />);

    await user.click(await screen.findByRole('button', { name: 'Pair a device' }));
    devicesChanged!([
      { ...pairedDevice('credential-1', 'iPad'), createdAt: new Date().toISOString() },
    ]);

    expect(await screen.findByText('iPad is paired')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Reach your SSH hosts directly');
    expect(dialog).not.toHaveTextContent('build');
    await user.click(screen.getByRole('checkbox', { name: 'gpu-box' }));
    await user.click(screen.getByRole('button', { name: 'Turn on' }));

    await waitFor(() => expect(api.remoteControlHostAccessSet).toHaveBeenCalledWith('h1', true));
    expect(api.remoteControlHostAccessSet).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('disconnects the active direct device', async () => {
    const api = installApi({
      server: directServer,
      pairingOffer: null,
      portChange: null,
      connectedDevice: {
        credentialId: 'credential-1',
        label: 'My phone',
        connectedAt: Date.now(),
      },
    });
    const user = userEvent.setup();
    render(<RemoteTab />);

    expect(await screen.findByText('My phone is connected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.remoteControlDisconnectActive).toHaveBeenCalledOnce());
  });

  it('starts enrollment with a Tailscale origin', async () => {
    const api = installApi({ server: null, pairingOffer: null, portChange: null });
    const user = userEvent.setup();
    render(<RemoteTab />);

    await user.type(
      await screen.findByLabelText('Tailscale HTTPS origin'),
      'https://mac.tailnet.ts.net'
    );
    await user.click(screen.getByRole('button', { name: 'Pair a device' }));

    await waitFor(() =>
      expect(api.remoteControlDirectStartPairing).toHaveBeenCalledWith({
        publicOrigin: 'https://mac.tailnet.ts.net',
      })
    );
  });

  it('adds HTTPS when saving a scheme-less Tailscale origin', async () => {
    installApi({ server: null, pairingOffer: null, portChange: null });
    const user = userEvent.setup();
    render(<RemoteTab />);

    const input = await screen.findByLabelText('Tailscale HTTPS origin');
    await user.type(input, 'mac.tailnet.ts.net');
    await user.tab();

    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
      })
    );
    expect(input).toHaveValue('https://mac.tailnet.ts.net');
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('starts Tailscale Serve from the detected private origin', async () => {
    const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: true,
      command: 'tailscale serve --bg --https=443 localhost:52864',
      hostname: 'mac.tailnet.ts.net',
      suggestedOrigin: 'https://mac.tailnet.ts.net',
    });
    const user = userEvent.setup();
    render(<RemoteTab />);

    // The detected origin fills itself in, so the network options stay folded away.
    await user.click(await screen.findByRole('button', { name: 'Publish with Tailscale Serve' }));
    expect(screen.queryByLabelText('Tailscale HTTPS origin')).not.toBeInTheDocument();

    await waitFor(() =>
      expect(api.remoteControlDirectStartTailscaleServe).toHaveBeenCalledWith({
        publicOrigin: 'https://mac.tailnet.ts.net',
      })
    );
  });

  it('warns when another Tailscale Serve route has the HTTPS port', async () => {
    const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: true,
      command: 'tailscale serve --bg --https=443 localhost:52864',
      hostname: 'mac.tailnet.ts.net',
      suggestedOrigin: 'https://mac.tailnet.ts.net:52864',
      httpsPortTaken: true,
    });

    render(<RemoteTab />);

    expect(
      await screen.findByText(/Another Tailscale Serve route uses this HTTPS port/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Turn remote control off to pick another/)).toBeInTheDocument();
    // Publishing checks the port again, so freeing it elsewhere needs no refresh here.
    expect(screen.getByRole('button', { name: 'Publish with Tailscale Serve' })).toBeEnabled();
  });

  it('warns about a taken port while the address can still be changed', async () => {
    const api = installApi({ server: null, pairingOffer: null, portChange: null });
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: true,
      command: 'tailscale serve --bg --https=443 localhost:52864',
      suggestedOrigin: 'https://mac.tailnet.ts.net',
      httpsPortTaken: true,
    });

    render(<RemoteTab />);

    expect(
      await screen.findByText(/Another Tailscale Serve route uses this HTTPS port/)
    ).toBeInTheDocument();
  });

  it('locks the address while remote control is on', async () => {
    const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: true,
      command: 'tailscale serve --bg --https=443 localhost:52864',
    });

    render(<RemoteTab />);

    expect(await screen.findByLabelText('Tailscale HTTPS origin')).toBeDisabled();
    expect(screen.getByText(/Turn remote control off to change these/)).toBeInTheDocument();
  });

  it('rechecks Tailscale after a refused publish', async () => {
    const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
    api.remoteControlDirectStartTailscaleServe.mockRejectedValueOnce(new Error('port taken'));
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: true,
      command: 'tailscale serve --bg --https=443 localhost:52864',
      suggestedOrigin: 'https://mac.tailnet.ts.net',
    });
    const user = userEvent.setup();
    render(<RemoteTab />);

    await user.click(await screen.findByRole('button', { name: 'Publish with Tailscale Serve' }));

    await waitFor(() => expect(api.remoteControlDirectGetTailscaleStatus).toHaveBeenCalledTimes(2));
  });

  it('rechecks Tailscale even when turning remote control off fails', async () => {
    const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
    const user = userEvent.setup();
    render(<RemoteTab />);

    const toggle = await screen.findByRole('switch', { name: /remote control/i });
    await waitFor(() => expect(api.remoteControlDirectGetTailscaleStatus).toHaveBeenCalledOnce());
    api.remoteControlDirectStop.mockRejectedValueOnce(new Error('off failed'));
    await user.click(toggle);

    await waitFor(() => expect(api.remoteControlDirectStop).toHaveBeenCalledOnce());
    await waitFor(() => expect(api.remoteControlDirectGetTailscaleStatus).toHaveBeenCalledTimes(2));
  });

  it('says when the Tailscale origin could not be saved', async () => {
    mockUpdateConfig.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    installApi({ server: null, pairingOffer: null, portChange: null });
    const user = userEvent.setup();
    render(<RemoteTab />);

    await user.type(await screen.findByLabelText('Tailscale HTTPS origin'), 'mac.tailnet.ts.net');
    await user.tab();

    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        'Could not save Tailscale origin: disk full',
        'error'
      )
    );
  });

  describe('when Tailscale is not signed in', () => {
    const signedOut = {
      installed: true,
      command: 'tailscale serve --bg --https=443 localhost:52864',
      needsSignIn: true,
    };

    it('says so and offers an account instead of asking for an address', async () => {
      const api = installApi({ server: null, pairingOffer: null, portChange: null });
      api.remoteControlDirectGetTailscaleStatus.mockResolvedValue(signedOut);
      const user = userEvent.setup();
      render(<RemoteTab />);

      expect(await screen.findByText(/Tailscale isn't connected on this computer/)).toBeVisible();
      expect(screen.queryByLabelText('Tailscale HTTPS origin')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Network options' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Create a Tailscale account/ }));

      expect(api.openExternal).toHaveBeenCalledWith('https://login.tailscale.com/start');
    });

    it('replaces Publish while remote control is on', async () => {
      const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
      api.remoteControlDirectGetTailscaleStatus.mockResolvedValue(signedOut);
      render(<RemoteTab />);

      expect(await screen.findByText(/Tailscale isn't connected on this computer/)).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Publish with Tailscale Serve' })
      ).not.toBeInTheDocument();
    });

    it('does not claim to be published while Tailscale is down', async () => {
      const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
      api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
        ...signedOut,
        serveConfigured: true,
      });
      render(<RemoteTab />);

      expect(await screen.findByText(/only this computer can reach it/)).toBeVisible();
    });

    it('tells Linux users to run the command, since there is no app to open', async () => {
      const api = installApi({ server: null, pairingOffer: null, portChange: null });
      (api as unknown as { platform: string }).platform = 'linux';
      api.remoteControlDirectGetTailscaleStatus.mockResolvedValue(signedOut);
      render(<RemoteTab />);

      expect(await screen.findByText('sudo tailscale up')).toBeVisible();
    });

    it('tells Mac and Windows users to open the app', async () => {
      const api = installApi({ server: null, pairingOffer: null, portChange: null });
      (api as unknown as { platform: string }).platform = 'darwin';
      api.remoteControlDirectGetTailscaleStatus.mockResolvedValue(signedOut);
      render(<RemoteTab />);

      expect(await screen.findByText(/Open the Tailscale app and sign in/)).toBeVisible();
    });

    it('picks up the sign-in and the detected address when the window regains focus', async () => {
      const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
      api.remoteControlDirectGetTailscaleStatus.mockResolvedValue(signedOut);
      render(<RemoteTab />);
      await screen.findByText(/Tailscale isn't connected on this computer/);

      api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
        installed: true,
        command: 'tailscale serve --bg --https=443 localhost:52864',
        needsSignIn: false,
        suggestedOrigin: 'https://mac.tailnet.ts.net',
      });
      window.dispatchEvent(new Event('focus'));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Publish with Tailscale Serve' })).toBeEnabled()
      );
      expect(
        screen.queryByText(/Tailscale isn't connected on this computer/)
      ).not.toBeInTheDocument();
    });
  });

  it('says the connection port can be chosen while the network options are folded', async () => {
    const api = installApi({ server: null, pairingOffer: null, portChange: null });
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: true,
      command: 'tailscale serve --bg --https=443 localhost:52864',
      suggestedOrigin: 'https://mac.tailnet.ts.net',
    });

    render(<RemoteTab />);

    expect(await screen.findByText(/Tailscale address and port/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Tailscale HTTPS origin')).not.toBeInTheDocument();
  });

  it('keeps a typed HTTPS port and saves the detected origin it is swapped for', async () => {
    const api = installApi({ server: null, pairingOffer: null, portChange: null });
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: true,
      command: 'tailscale serve --bg --https=443 localhost:52864',
      suggestedOrigin: 'https://mac.tailnet.ts.net',
    });
    const user = userEvent.setup();
    render(<RemoteTab />);

    await user.click(await screen.findByRole('button', { name: 'Network options' }));
    const input = screen.getByLabelText('Tailscale HTTPS origin');
    await waitFor(() => expect(input).toHaveValue('https://mac.tailnet.ts.net'));
    await user.clear(input);
    await user.type(input, 'mac.tailnet.ts.net:8444');
    await user.tab();

    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        directRemotePublicOrigin: 'https://mac.tailnet.ts.net:8444',
      })
    );
    expect(input).toHaveValue('https://mac.tailnet.ts.net:8444');

    await user.click(screen.getByRole('button', { name: 'Use detected' }));

    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
      })
    );
    expect(input).toHaveValue('https://mac.tailnet.ts.net');
  });

  it('shows Tailscale Serve as ready instead of offering to start it again', async () => {
    const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: true,
      command: 'tailscale serve --bg localhost:52864',
      hostname: 'mac.tailnet.ts.net',
      suggestedOrigin: 'https://mac.tailnet.ts.net',
      serveConfigured: true,
    });

    render(<RemoteTab />);

    expect(await screen.findByText('mac.tailnet.ts.net')).toBeInTheDocument();
    expect(screen.getByText(/Devices pair at/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Publish with Tailscale Serve' })
    ).not.toBeInTheDocument();
    expect(api.remoteControlDirectStartTailscaleServe).not.toHaveBeenCalled();
  });

  it('shows the connected phone on its device row', async () => {
    const api = installApi({
      server: directServer,
      pairingOffer: null,
      portChange: null,
      connectedDevice: { credentialId: 'credential-1', label: 'My phone', connectedAt: Date.now() },
    });
    api.pairedDevicesList.mockResolvedValue([pairedDevice('credential-1', 'My phone')]);
    const user = userEvent.setup();
    render(<RemoteTab />);

    expect(await screen.findByText('Connected now')).toBeInTheDocument();
    expect(screen.queryByText('My phone is connected')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair a device' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.remoteControlDisconnectActive).toHaveBeenCalledOnce());
  });

  it('renames and removes a paired device', async () => {
    const api = installApi({ server: null, pairingOffer: null, portChange: null });
    api.pairedDevicesList.mockResolvedValue([pairedDevice('credential-1', 'Safari on iOS')]);
    const user = userEvent.setup();
    render(<RemoteTab />);

    await user.click(await screen.findByRole('button', { name: 'Rename device' }));
    const input = screen.getByLabelText('Device name');
    await user.clear(input);
    await user.type(input, 'Work phone{Enter}');
    await waitFor(() =>
      expect(api.pairedDevicesRename).toHaveBeenCalledWith('credential-1', 'Work phone')
    );
    expect(screen.queryByLabelText('Device name')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove device' }));
    await waitFor(() => expect(api.pairedDevicesRemove).toHaveBeenCalledWith('credential-1'));
  });

  it('warns that turning it on may ask for the keychain, except on Windows', async () => {
    expect(secureStoragePromptNote('darwin')).toMatch(
      /macOS may ask for your password.*Always Allow/
    );
    expect(secureStoragePromptNote('linux')).toMatch(/unlock its keyring/);
    expect(secureStoragePromptNote('win32')).toBeNull();

    installApi({ server: null, pairingOffer: null, portChange: null });
    render(<RemoteTab />);
    expect(await screen.findByText(/where Komla keeps its keys/)).toBeInTheDocument();
    expect(screen.getByText(/end-to-end encrypted between your own devices/)).toBeInTheDocument();
  });

  it('says Tailscale is needed before remote control is turned on', async () => {
    const api = installApi({ server: null, pairingOffer: null, portChange: null });
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: false,
      command: 'tailscale serve --bg localhost:52864',
    });
    const user = userEvent.setup();
    render(<RemoteTab />);

    expect(
      await screen.findByText(/Tailscale isn't installed on this computer/)
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Get Tailscale/ }));
    expect(api.openExternal).toHaveBeenCalledWith('https://tailscale.com/download');
    expect(api.remoteControlDirectStart).not.toHaveBeenCalled();
  });

  it('offers a Tailscale download when Tailscale is missing', async () => {
    const api = installApi({ server: directServer, pairingOffer: null, portChange: null });
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: false,
      command: 'tailscale serve --bg localhost:52864',
    });
    const user = userEvent.setup();
    render(<RemoteTab />);

    await user.click(await screen.findByRole('button', { name: /Get Tailscale/ }));
    expect(api.openExternal).toHaveBeenCalledWith('https://tailscale.com/download');
    expect(screen.queryByRole('button', { name: /Network options/ })).not.toBeInTheDocument();
  });

  it('folds the network options away when Tailscale detects the origin', async () => {
    const api = installApi({ server: null, pairingOffer: null, portChange: null });
    api.remoteControlDirectGetTailscaleStatus.mockResolvedValue({
      installed: true,
      command: 'tailscale serve --bg localhost:52864',
      suggestedOrigin: 'https://mac.tailnet.ts.net',
      suggestedRootOrigin: 'https://mac.tailnet.ts.net',
      rootAvailable: true,
    });
    const user = userEvent.setup();
    render(<RemoteTab />);

    const toggle = await screen.findByRole('button', { name: /Network options/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByLabelText('Tailscale HTTPS origin')).toHaveValue(
      'https://mac.tailnet.ts.net'
    );
  });

  it('asks for nothing but the switch while remote control is off', async () => {
    installApi({ server: null, pairingOffer: null, portChange: null });
    render(<RemoteTab />);

    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(screen.getByText('No devices yet')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Network options/ })).toBeInTheDocument()
    );
    expect(
      screen.queryByRole('button', { name: 'Publish with Tailscale Serve' })
    ).not.toBeInTheDocument();
  });

  it('leaves keep-awake off until it is turned on', async () => {
    const saved = mockConfig.directRemoteKeepAwake;
    delete (mockConfig as { directRemoteKeepAwake?: boolean }).directRemoteKeepAwake;
    installApi({ server: null, pairingOffer: null, portChange: null });
    render(<RemoteTab />);

    expect(
      await screen.findByRole('switch', {
        name: 'Keep computer awake while remote access is enabled',
      })
    ).toHaveAttribute('aria-checked', 'false');
    mockConfig.directRemoteKeepAwake = saved;
  });

  it('lets this computer be kept from devices once there is an SSH host', async () => {
    const api = installApi({ server: null, pairingOffer: null, portChange: null });
    api.remoteControlHostAccessList.mockResolvedValue([
      { hostId: 'h1', hostName: 'devbox', enabled: false, state: 'off' },
    ]);
    const user = userEvent.setup();
    render(<RemoteTab />);

    const localAccess = await screen.findByRole('switch', {
      name: 'Allow access to this computer',
    });
    expect(localAccess).toHaveAttribute('aria-checked', 'true');
    await user.click(localAccess);
    expect(mockUpdateConfig).toHaveBeenCalledWith({ directRemoteLocalAccess: false });
  });

  it('hides access to this computer without an SSH host, unless it is off', async () => {
    installApi({ server: null, pairingOffer: null, portChange: null });
    const { unmount } = render(<RemoteTab />);
    await screen.findByRole('switch', { name: 'Remote control' });
    await waitFor(() => expect(window.api.remoteControlHostAccessList).toHaveBeenCalled());
    expect(
      screen.queryByRole('switch', { name: 'Allow access to this computer' })
    ).not.toBeInTheDocument();
    unmount();

    Object.assign(mockConfig, { directRemoteLocalAccess: false });
    try {
      render(<RemoteTab />);
      expect(
        await screen.findByRole('switch', { name: 'Allow access to this computer' })
      ).toHaveAttribute('aria-checked', 'false');
    } finally {
      delete (mockConfig as { directRemoteLocalAccess?: boolean }).directRemoteLocalAccess;
    }
  });

  it('persists the keep-awake toggle', async () => {
    installApi({ server: null, pairingOffer: null, portChange: null });
    const user = userEvent.setup();
    render(<RemoteTab />);

    await user.click(
      await screen.findByRole('switch', {
        name: 'Keep computer awake while remote access is enabled',
      })
    );
    expect(mockUpdateConfig).toHaveBeenCalledWith({ directRemoteKeepAwake: false });
  });

  it('asks for the passkey again after 15 minutes unless changed', async () => {
    installApi({ server: null, pairingOffer: null, portChange: null });
    const user = userEvent.setup();
    render(<RemoteTab />);

    const window = await screen.findByRole('combobox', { name: 'Ask for passkey again after' });
    expect(window).toHaveValue('15');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(
      expect.arrayContaining(['5 minutes', '15 minutes', '1 hour', '8 hours'])
    );
    await user.selectOptions(window, '60');
    expect(mockUpdateConfig).toHaveBeenCalledWith({ directRemotePasskeyWindowMinutes: 60 });
  });
});
