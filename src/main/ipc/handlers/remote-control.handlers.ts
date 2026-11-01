import { execFile } from 'child_process';
import { promisify } from 'util';

import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import {
  pairedDevicesRemoveArgsSchema,
  pairedDevicesRenameArgsSchema,
  remoteControlDirectStartArgsSchema,
  remoteControlDisconnectActiveArgsSchema,
  remoteControlHostAccessSetArgsSchema,
} from '../../../shared/ipc/schemas/remote-control-ipc.schemas';
import { tailscaleCommand, type TailscaleCommand } from '../../lib/tailscale-command';
import { configService } from '../../services/config.service';
import { pairedDeviceRegistryService } from '../../services/paired-device-registry.service';
import { startPersistedDirectRemoteServer } from '../../services/remote-control-direct-autostart.service';
import { remoteControlHostAccessService } from '../../services/remote-control-host-access.service';
import { remoteControlKeepAwakeService } from '../../services/remote-control-keep-awake.service';
import {
  DEFAULT_HTTPS_PORT,
  getHttpsPort,
  hasHttpsRoute,
  isHttpsPortTaken,
  readServeStatus,
  remoteControlTailscaleService,
} from '../../services/remote-control-tailscale.service';
import { windowService } from '../../services/window.service';
import { handleValidated } from '../validation/ipc-validators';

import type { PairedDeviceRecord } from '../../../shared/types/paired-device';
import type {
  RemoteControlDirectPairingOffer,
  RemoteControlDirectServerInfo,
  RemoteControlDirectState,
  RemoteControlDirectTailscaleStatus,
  RemoteControlDirectTailscaleServeResult,
  RemoteControlHostAccessStatus,
} from '../../../shared/types/remote-control';

const CONNECTED_BACKEND_STATES = new Set(['Running', 'Starting']);

const execFileAsync = promisify(execFile);

export function registerRemoteControlHandlers(): void {
  ipcMain.handle(
    IPC.REMOTE_CONTROL_DISCONNECT_ACTIVE,
    handleValidated(
      IPC.REMOTE_CONTROL_DISCONNECT_ACTIVE,
      remoteControlDisconnectActiveArgsSchema,
      async (): Promise<void> => {
        const { remoteControlDirectService } =
          await import('../../services/remote-control-direct.service');
        remoteControlDirectService.disconnectActiveClient();
      }
    )
  );

  ipcMain.handle(
    IPC.REMOTE_CONTROL_DIRECT_START,
    handleValidated(
      IPC.REMOTE_CONTROL_DIRECT_START,
      remoteControlDirectStartArgsSchema,
      async (_evt, [options]): Promise<RemoteControlDirectServerInfo> => {
        const { remoteControlDirectService } =
          await import('../../services/remote-control-direct.service');
        const config = configService.get();
        const publicOrigin = options?.publicOrigin ?? config.directRemotePublicOrigin;
        const server = await remoteControlDirectService.start({
          ...options,
          port: config.directRemotePort,
          publicOrigin,
        });
        persistDirectServerConfig(server, publicOrigin);
        return server;
      }
    )
  );

  ipcMain.handle(IPC.REMOTE_CONTROL_DIRECT_STOP, async (): Promise<void> => {
    const { remoteControlDirectService } =
      await import('../../services/remote-control-direct.service');
    const config = configService.get();
    await remoteControlDirectService.stop();
    let tailscaleCleanupError: unknown;
    if (config.directRemoteManagedTailscaleOrigin) {
      try {
        await remoteControlTailscaleService.stop(config.directRemoteManagedTailscaleOrigin);
      } catch (err) {
        tailscaleCleanupError = err;
      }
    }
    syncKeepAwake(
      configService.update({
        directRemoteEnabled: false,
        directRemoteManagedTailscaleOrigin: tailscaleCleanupError
          ? config.directRemoteManagedTailscaleOrigin
          : undefined,
      })
    );
    // Hosts Komla can't reach now stop their phone servers when it next connects.
    await remoteControlHostAccessService.remoteControlTurnedOff();
    if (tailscaleCleanupError) {
      throw new Error(formatTailscaleServeError(tailscaleCleanupError));
    }
  });

  ipcMain.handle(
    IPC.REMOTE_CONTROL_DIRECT_START_PAIRING,
    handleValidated(
      IPC.REMOTE_CONTROL_DIRECT_START_PAIRING,
      remoteControlDirectStartArgsSchema,
      async (_evt, [options]): Promise<RemoteControlDirectPairingOffer> => {
        const { remoteControlDirectService } =
          await import('../../services/remote-control-direct.service');
        const config = configService.get();
        const publicOrigin = options?.publicOrigin ?? config.directRemotePublicOrigin;
        const offer = await remoteControlDirectService.startPairing({
          ...options,
          port: config.directRemotePort,
          publicOrigin,
        });
        const server = remoteControlDirectService.getInfo();
        if (server) persistDirectServerConfig(server, publicOrigin);
        return offer;
      }
    )
  );

  ipcMain.handle(
    IPC.REMOTE_CONTROL_DIRECT_START_TAILSCALE_SERVE,
    handleValidated(
      IPC.REMOTE_CONTROL_DIRECT_START_TAILSCALE_SERVE,
      remoteControlDirectStartArgsSchema,
      async (_evt, [options]): Promise<RemoteControlDirectTailscaleServeResult> => {
        if (!options?.publicOrigin) {
          throw new Error('Enter a Tailscale HTTPS origin before starting Tailscale Serve');
        }
        const { remoteControlDirectService } =
          await import('../../services/remote-control-direct.service');
        const config = configService.get();
        const preferredPort = config.directRemotePort ?? 52864;
        const existingServer = remoteControlDirectService.getInfo();
        const initialPublicOrigin = normalizeTailscaleServeOrigin(options.publicOrigin);
        const server = await remoteControlDirectService.start({
          port: preferredPort,
          publicOrigin: initialPublicOrigin,
        });
        const publicOrigin = initialPublicOrigin;
        const managedOrigin = config.directRemoteManagedTailscaleOrigin;
        let commandArgs: string[];
        try {
          commandArgs = await remoteControlTailscaleService.configure(
            publicOrigin,
            server.port,
            managedOrigin
          );
        } catch (err) {
          if (existingServer) {
            remoteControlDirectService.setPublicOrigin(
              existingServer.httpOrigin === existingServer.localOrigin
                ? undefined
                : existingServer.httpOrigin
            );
          } else {
            await remoteControlDirectService.stop();
            syncKeepAwake(configService.get());
          }
          throw new Error(formatTailscaleServeError(err));
        }
        persistDirectServerConfig(server, publicOrigin, publicOrigin);
        return { server, command: formatCommand(tailscaleCommand().display, commandArgs) };
      }
    )
  );

  ipcMain.handle(
    IPC.REMOTE_CONTROL_DIRECT_GET_TAILSCALE_STATUS,
    async (): Promise<RemoteControlDirectTailscaleStatus> => {
      const { remoteControlDirectService } =
        await import('../../services/remote-control-direct.service');
      const config = configService.get();
      const localPort =
        remoteControlDirectService.getInfo()?.port ?? config.directRemotePort ?? 52864;
      const managedHttpsPort = readHttpsPort(config.directRemoteManagedTailscaleOrigin);
      const savedHttpsPort = readHttpsPort(config.directRemotePublicOrigin);
      const tailscale = tailscaleCommand();
      const target = `localhost:${localPort}`;
      const serveCommand = (httpsPort: string) =>
        formatCommand(tailscale.display, ['serve', '--bg', `--https=${httpsPort}`, target]);
      try {
        await execFileAsync(tailscale.file, ['version'], {
          timeout: 5_000,
          windowsHide: true,
          env: tailscale.env,
        });
        const { hostname, needsSignIn } = await readTailscaleSelf(tailscale);
        const serveStatus = await readServeStatus(tailscale).catch(() => ({}));
        const suggestedHttpsPort =
          managedHttpsPort ??
          (isHttpsPortTaken(serveStatus, DEFAULT_HTTPS_PORT, target)
            ? String(localPort)
            : DEFAULT_HTTPS_PORT);
        const httpsPort = savedHttpsPort ?? suggestedHttpsPort;
        return {
          installed: true,
          command: serveCommand(httpsPort),
          hostname,
          needsSignIn,
          suggestedOrigin: hostname ? formatHttpsOrigin(hostname, suggestedHttpsPort) : undefined,
          httpsPortTaken: isHttpsPortTaken(serveStatus, httpsPort, target),
          serveConfigured: hasHttpsRoute(serveStatus, httpsPort, target),
        };
      } catch (err) {
        return {
          installed: false,
          command: serveCommand(savedHttpsPort ?? managedHttpsPort ?? DEFAULT_HTTPS_PORT),
          error: formatTailscaleServeError(err),
        };
      }
    }
  );

  ipcMain.handle(IPC.REMOTE_CONTROL_DIRECT_CANCEL_PAIRING, async (): Promise<void> => {
    const { remoteControlDirectService } =
      await import('../../services/remote-control-direct.service');
    remoteControlDirectService.cancelPairing();
  });

  ipcMain.handle(
    IPC.REMOTE_CONTROL_DIRECT_GET_STATE,
    async (): Promise<RemoteControlDirectState> => {
      await startPersistedDirectRemoteServer('state-read');
      const { remoteControlDirectService } =
        await import('../../services/remote-control-direct.service');
      return remoteControlDirectService.getState();
    }
  );

  // Paired-device registry surface. The list is empty until a successful
  // pairing lands.
  ipcMain.handle(IPC.PAIRED_DEVICES_LIST, async (): Promise<PairedDeviceRecord[]> => {
    return pairedDeviceRegistryService.list();
  });

  ipcMain.handle(
    IPC.REMOTE_CONTROL_HOST_ACCESS_LIST,
    async (): Promise<RemoteControlHostAccessStatus[]> => remoteControlHostAccessService.list()
  );

  ipcMain.handle(
    IPC.REMOTE_CONTROL_HOST_ACCESS_SET,
    handleValidated(
      IPC.REMOTE_CONTROL_HOST_ACCESS_SET,
      remoteControlHostAccessSetArgsSchema,
      async (_evt, [{ hostId, enabled }]): Promise<RemoteControlHostAccessStatus> =>
        remoteControlHostAccessService.setEnabled(hostId, enabled)
    )
  );

  remoteControlHostAccessService.onChange(() => {
    windowService.broadcastWhenReady(
      IPC.REMOTE_CONTROL_HOST_ACCESS_CHANGED,
      remoteControlHostAccessService.list()
    );
  });

  ipcMain.handle(
    IPC.PAIRED_DEVICES_RENAME,
    handleValidated(
      IPC.PAIRED_DEVICES_RENAME,
      pairedDevicesRenameArgsSchema,
      async (_evt, [{ credentialId, label }]): Promise<PairedDeviceRecord> =>
        pairedDeviceRegistryService.rename(credentialId, label)
    )
  );

  ipcMain.handle(
    IPC.PAIRED_DEVICES_REMOVE,
    handleValidated(
      IPC.PAIRED_DEVICES_REMOVE,
      pairedDevicesRemoveArgsSchema,
      async (_evt, [{ credentialId }]): Promise<void> => {
        const [{ remoteControlDirectService }, { remoteControlSessionService }] = await Promise.all(
          [
            import('../../services/remote-control-direct.service'),
            import('../../services/remote-control-session.service'),
          ]
        );
        remoteControlDirectService.disconnectCredential(credentialId);
        remoteControlSessionService.releaseDeviceLeases(credentialId);
        pairedDeviceRegistryService.remove(credentialId);
      }
    )
  );

  // Broadcast list changes to every window so the Settings panel updates
  // live on add / rename / remove / recordAuthSuccess.
  pairedDeviceRegistryService.onChange((devices) => {
    windowService.broadcastWhenReady(IPC.PAIRED_DEVICES_CHANGED, devices);
  });
}

function persistDirectServerConfig(
  server: RemoteControlDirectServerInfo,
  publicOrigin: string | undefined,
  managedTailscaleOrigin?: string
): void {
  syncKeepAwake(
    configService.update({
      directRemoteEnabled: true,
      directRemotePort: server.port,
      directRemotePublicOrigin: publicOrigin,
      ...(managedTailscaleOrigin !== undefined
        ? { directRemoteManagedTailscaleOrigin: managedTailscaleOrigin }
        : {}),
    })
  );
}

function syncKeepAwake(config: ReturnType<typeof configService.get>): void {
  remoteControlKeepAwakeService.sync(
    Boolean(config.directRemoteEnabled),
    config.directRemoteKeepAwake
  );
}

function readHttpsPort(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    return getHttpsPort(origin);
  } catch {
    return undefined;
  }
}

function formatHttpsOrigin(hostname: string, httpsPort: string): string {
  return httpsPort === DEFAULT_HTTPS_PORT
    ? `https://${hostname}`
    : `https://${hostname}:${httpsPort}`;
}

function normalizeTailscaleServeOrigin(rawOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error('Tailscale origin must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Tailscale origin must start with https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Tailscale origin must not include credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Tailscale origin must be an origin only, without a path, query, or fragment');
  }
  return parsed.origin;
}

function formatTailscaleServeError(err: unknown): string {
  const nodeErr = err as NodeJS.ErrnoException & { stderr?: string };
  if (nodeErr.code === 'ENOENT') {
    return 'Could not find the tailscale command. Install Tailscale, then try again.';
  }
  const stderr = typeof nodeErr.stderr === 'string' ? nodeErr.stderr.trim() : '';
  if (stderr) return stderr;
  return nodeErr.message || 'Failed to start Tailscale Serve';
}

async function readTailscaleSelf(
  tailscale: TailscaleCommand
): Promise<{ hostname?: string; needsSignIn: boolean }> {
  try {
    const { stdout } = await execFileText(tailscale.file, ['status', '--json'], {
      timeout: 5_000,
      windowsHide: true,
      env: tailscale.env,
    });
    const parsed = JSON.parse(stdout) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    const dnsName = parsed.Self?.DNSName;
    const state = parsed.BackendState;
    return {
      hostname:
        typeof dnsName === 'string' && dnsName.trim().length > 0
          ? dnsName.trim().replace(/\.$/, '')
          : undefined,
      needsSignIn: typeof state === 'string' && !CONNECTED_BACKEND_STATES.has(state),
    };
  } catch {
    // On a Mac with the app closed, or anywhere the service is down, status can't answer at all.
    return { needsSignIn: true };
  }
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

async function execFileText(
  command: string,
  args: string[],
  options: Parameters<typeof execFile>[2]
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, options);
  if (typeof result === 'string') return { stdout: result, stderr: '' };
  return result as { stdout: string; stderr: string };
}
