import { execFile } from 'child_process';
import { promisify } from 'util';

import { ipcMain } from 'electron';
import { z } from 'zod';

import { IPC } from '../../../shared/constants/ipc-channels';
import { configService } from '../../services/config.service';
import { pairedDeviceRegistryService } from '../../services/paired-device-registry.service';
import { startPersistedDirectRemoteServer } from '../../services/remote-control-direct-autostart.service';
import { remoteControlHostAccessService } from '../../services/remote-control-host-access.service';
import { remoteControlKeepAwakeService } from '../../services/remote-control-keep-awake.service';
import { remoteControlTailscaleService } from '../../services/remote-control-tailscale.service';
import { windowService } from '../../services/window.service';

import type { PairedDeviceRecord } from '../../../shared/types/paired-device';
import type {
  RemoteControlDirectPairingOffer,
  RemoteControlDirectServerInfo,
  RemoteControlDirectStartOptions,
  RemoteControlDirectState,
  RemoteControlDirectTailscaleStatus,
  RemoteControlDirectTailscaleServeResult,
  RemoteControlHostAccessStatus,
} from '../../../shared/types/remote-control';

const RenamePayloadSchema = z
  .object({
    credentialId: z.string().min(1).max(1024),
    label: z.string().min(1).max(120),
  })
  .strict();

const RemovePayloadSchema = z
  .object({
    credentialId: z.string().min(1).max(1024),
  })
  .strict();

const HostAccessPayloadSchema = z
  .object({
    hostId: z.string().min(1).max(128),
    enabled: z.boolean(),
  })
  .strict();

const DirectStartOptionsSchema = z
  .object({
    publicOrigin: z.string().trim().min(1).max(2048).optional(),
    tailscaleServeMode: z.enum(['root', 'port']).optional(),
  })
  .strict()
  .optional();

const DisconnectRouteSchema = z.literal('direct');

const execFileAsync = promisify(execFile);

export function registerRemoteControlHandlers(): void {
  ipcMain.handle(IPC.REMOTE_CONTROL_DISCONNECT_ACTIVE, async (_evt, rawRoute): Promise<void> => {
    DisconnectRouteSchema.parse(rawRoute);
    const { remoteControlDirectService } =
      await import('../../services/remote-control-direct.service');
    remoteControlDirectService.disconnectActiveClient();
  });

  ipcMain.handle(
    IPC.REMOTE_CONTROL_DIRECT_START,
    async (_evt, rawOptions): Promise<RemoteControlDirectServerInfo> => {
      const options = DirectStartOptionsSchema.parse(rawOptions) as
        | RemoteControlDirectStartOptions
        | undefined;
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
    async (_evt, rawOptions): Promise<RemoteControlDirectPairingOffer> => {
      const options = DirectStartOptionsSchema.parse(rawOptions) as
        | RemoteControlDirectStartOptions
        | undefined;
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
  );

  ipcMain.handle(
    IPC.REMOTE_CONTROL_DIRECT_START_TAILSCALE_SERVE,
    async (_evt, rawOptions): Promise<RemoteControlDirectTailscaleServeResult> => {
      const options = DirectStartOptionsSchema.parse(rawOptions) as
        | RemoteControlDirectStartOptions
        | undefined;
      if (!options?.publicOrigin) {
        throw new Error('Enter a Tailscale HTTPS origin before starting Tailscale Serve');
      }
      const { remoteControlDirectService } =
        await import('../../services/remote-control-direct.service');
      const config = configService.get();
      const preferredPort = config.directRemotePort ?? 52864;
      const serveMode = options.tailscaleServeMode ?? 'root';
      const publicPort =
        serveMode === 'port' ? (getExplicitHttpsPort(options.publicOrigin) ?? preferredPort) : 443;
      const existingServer = remoteControlDirectService.getInfo();
      const initialPublicOrigin = normalizeTailscaleServeOrigin(
        options.publicOrigin,
        publicPort,
        serveMode
      );
      const server = await remoteControlDirectService.start({
        port: preferredPort,
        publicOrigin: initialPublicOrigin,
      });
      const publicOrigin = initialPublicOrigin;
      let commandArgs: string[];
      try {
        commandArgs = await remoteControlTailscaleService.configure(publicOrigin, server.port);
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
      return { server, command: formatCommand('tailscale', commandArgs) };
    }
  );

  ipcMain.handle(
    IPC.REMOTE_CONTROL_DIRECT_GET_TAILSCALE_STATUS,
    async (): Promise<RemoteControlDirectTailscaleStatus> => {
      const { remoteControlDirectService } =
        await import('../../services/remote-control-direct.service');
      const config = configService.get();
      const localPort =
        remoteControlDirectService.getInfo()?.port ?? config.directRemotePort ?? 52864;
      const managedHttpsPort = config.directRemoteManagedTailscaleOrigin
        ? Number(new URL(config.directRemoteManagedTailscaleOrigin).port || '443')
        : undefined;
      const publicPort = managedHttpsPort ?? localPort;
      const rootCommand = formatCommand('tailscale', ['serve', '--bg', `localhost:${localPort}`]);
      const portCommand = formatCommand('tailscale', [
        'serve',
        '--bg',
        `--https=${publicPort}`,
        `localhost:${localPort}`,
      ]);
      try {
        await execFileAsync('tailscale', ['version'], { timeout: 5_000, windowsHide: true });
        const hostname = await getTailscaleHostname();
        const serve = await getTailscaleServeStatus(localPort);
        const suggestedRootOrigin =
          hostname && serve.rootAvailable ? `https://${hostname}` : undefined;
        const suggestedPortOrigin = hostname ? `https://${hostname}:${publicPort}` : undefined;
        return {
          installed: true,
          command: serve.rootAvailable ? rootCommand : portCommand,
          rootCommand,
          portCommand,
          hostname,
          suggestedOrigin: suggestedRootOrigin ?? suggestedPortOrigin,
          suggestedRootOrigin,
          suggestedPortOrigin,
          ...serve,
        };
      } catch (err) {
        return {
          installed: false,
          command: rootCommand,
          rootCommand,
          portCommand,
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
    async (_evt, raw): Promise<RemoteControlHostAccessStatus> => {
      const { hostId, enabled } = HostAccessPayloadSchema.parse(raw);
      return remoteControlHostAccessService.setEnabled(hostId, enabled);
    }
  );

  remoteControlHostAccessService.onChange(() => {
    windowService.broadcastWhenReady(
      IPC.REMOTE_CONTROL_HOST_ACCESS_CHANGED,
      remoteControlHostAccessService.list()
    );
  });

  ipcMain.handle(IPC.PAIRED_DEVICES_RENAME, async (_evt, raw): Promise<PairedDeviceRecord> => {
    const { credentialId, label } = RenamePayloadSchema.parse(raw);
    return pairedDeviceRegistryService.rename(credentialId, label);
  });

  ipcMain.handle(IPC.PAIRED_DEVICES_REMOVE, async (_evt, raw): Promise<void> => {
    const { credentialId } = RemovePayloadSchema.parse(raw);
    const [{ remoteControlDirectService }, { remoteControlSessionService }] = await Promise.all([
      import('../../services/remote-control-direct.service'),
      import('../../services/remote-control-session.service'),
    ]);
    remoteControlDirectService.disconnectCredential(credentialId);
    remoteControlSessionService.releaseDeviceLeases(credentialId);
    pairedDeviceRegistryService.remove(credentialId);
  });

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

function getExplicitHttpsPort(rawOrigin: string): number | undefined {
  try {
    const port = new URL(rawOrigin).port;
    return port ? Number(port) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTailscaleServeOrigin(
  rawOrigin: string,
  port: number,
  mode: 'root' | 'port'
): string {
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
  parsed.port = mode === 'port' ? String(port) : '';
  return parsed.origin;
}

function formatTailscaleServeError(err: unknown): string {
  const nodeErr = err as NodeJS.ErrnoException & { stderr?: string };
  if (nodeErr.code === 'ENOENT') {
    return 'Could not find the tailscale command. Install Tailscale and make sure tailscale is on PATH.';
  }
  const stderr = typeof nodeErr.stderr === 'string' ? nodeErr.stderr.trim() : '';
  if (stderr) return stderr;
  return nodeErr.message || 'Failed to start Tailscale Serve';
}

async function getTailscaleHostname(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileText('tailscale', ['status', '--json'], {
      timeout: 5_000,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout) as { Self?: { DNSName?: unknown } };
    const dnsName = parsed.Self?.DNSName;
    if (typeof dnsName !== 'string' || dnsName.trim().length === 0) return undefined;
    return dnsName.trim().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

async function getTailscaleServeStatus(
  port: number
): Promise<
  Pick<
    RemoteControlDirectTailscaleStatus,
    'rootAvailable' | 'serveConfigured' | 'serveConflict' | 'existingServeSummary'
  >
> {
  try {
    const { stdout } = await execFileText('tailscale', ['serve', 'status', '--json'], {
      timeout: 5_000,
      windowsHide: true,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return { rootAvailable: true };
    const status = JSON.parse(trimmed) as unknown;
    const strings = collectStrings(status);
    const target = `localhost:${port}`;
    const serveConfigured = strings.some((value) => value.includes(target));
    const hasServeConfig = hasMeaningfulServeConfig(status);
    const portMentioned = strings.some((value) => value.includes(String(port)));
    const rootAvailable = !hasServePortConfig(status, 443);
    const serveConflict = hasServeConfig && !serveConfigured && portMentioned;
    return {
      rootAvailable,
      serveConfigured,
      serveConflict,
      existingServeSummary:
        hasServeConfig && !serveConfigured ? summarizeServeStatus(status) : undefined,
    };
  } catch {
    return { rootAvailable: true };
  }
}

function hasServePortConfig(value: unknown, port: number): boolean {
  const portKey = String(port);
  if (typeof value === 'string') return value.includes(`:${portKey}`);
  if (Array.isArray(value)) return value.some((item) => hasServePortConfig(item, port));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) => key === portKey || hasServePortConfig(item, port)
  );
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item));
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap((item) => collectStrings(item));
}

function hasMeaningfulServeConfig(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulServeConfig(item));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((item) => hasMeaningfulServeConfig(item));
}

function summarizeServeStatus(value: unknown): string | undefined {
  const strings = collectStrings(value).filter((entry) => entry.trim().length > 0);
  const summary = strings.slice(0, 3).join(', ');
  if (summary) return summary;
  try {
    return JSON.stringify(value).slice(0, 160);
  } catch {
    return undefined;
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
