import { createLogger } from '../lib/logger';

import { configService } from './config.service';
import { remoteControlKeepAwakeService } from './remote-control-keep-awake.service';
import {
  remoteControlTailscaleService,
  TailscaleFunnelEnabledError,
} from './remote-control-tailscale.service';

import type { RemoteControlDirectServerInfo } from '../../shared/types/remote-control';

const logger = createLogger('RemoteControlDirectAutostart');

// Tailscale can still be starting when Komla launches at login.
const TAILSCALE_RECONCILE_RETRY_MS = [5_000, 15_000, 30_000, 60_000];
const TAILSCALE_SHUTDOWN_TIMEOUT_MS = 5_000;

let startInFlight: Promise<RemoteControlDirectServerInfo | null> | null = null;
let tailscaleRetryTimer: ReturnType<typeof setTimeout> | null = null;

export async function startPersistedDirectRemoteServer(
  reason: 'boot' | 'state-read' = 'boot'
): Promise<RemoteControlDirectServerInfo | null> {
  const config = configService.get();
  if (!config.directRemoteEnabled) {
    // Only at launch: Settings reads state often, and a stuck tailscale would hold each read.
    if (reason === 'boot') await removeLeftoverTailscaleRoute();
    return null;
  }

  if (startInFlight) return startInFlight;

  startInFlight = (async () => {
    try {
      const { remoteControlDirectService } = await import('./remote-control-direct.service');
      const existing = remoteControlDirectService.getInfo();
      if (existing) {
        remoteControlKeepAwakeService.sync(
          Boolean(config.directRemoteEnabled),
          config.directRemoteKeepAwake
        );
        return existing;
      }

      const managedOrigin = config.directRemoteManagedTailscaleOrigin;
      if (managedOrigin) {
        try {
          await remoteControlTailscaleService.assertFunnelOff(managedOrigin);
        } catch (err) {
          if (err instanceof TailscaleFunnelEnabledError) {
            logger.error('not starting remote control', { error: err.message });
            return null;
          }
          // Tailscale can't be inspected yet; reconciling below retries.
        }
      }

      const server = await remoteControlDirectService.start({
        port: config.directRemotePort,
        publicOrigin: config.directRemotePublicOrigin,
      });
      if (server.port !== config.directRemotePort) {
        configService.update({ directRemotePort: server.port });
      }
      if (managedOrigin && !(await reconcileTailscaleRoute(managedOrigin, server.port))) {
        return null;
      }
      logger.info('started persisted direct remote-control server', {
        reason,
        port: server.port,
        preferredPort: server.preferredPort,
      });
      remoteControlKeepAwakeService.sync(
        Boolean(config.directRemoteEnabled),
        config.directRemoteKeepAwake
      );
      return server;
    } catch (err) {
      logger.warn('failed to start persisted direct remote-control server', {
        reason,
        error: String(err),
      });
      return null;
    } finally {
      startInFlight = null;
    }
  })();

  return startInFlight;
}

/** Points the managed Tailscale route at the server; false when Funnel made it stop the server. */
async function reconcileTailscaleRoute(
  origin: string,
  port: number,
  attempt = 0
): Promise<boolean> {
  const { remoteControlDirectService } = await import('./remote-control-direct.service');
  try {
    await remoteControlTailscaleService.reconcile(origin, port);
    return true;
  } catch (err) {
    if (err instanceof TailscaleFunnelEnabledError) {
      logger.error('stopped remote control', { error: err.message });
      await remoteControlDirectService.stop();
      return false;
    }
    const retryInMs = TAILSCALE_RECONCILE_RETRY_MS[attempt];
    logger.warn('failed to reconcile persisted Tailscale Serve listener', {
      error: String(err),
      retryInMs,
    });
    if (retryInMs !== undefined) {
      tailscaleRetryTimer = setTimeout(() => {
        tailscaleRetryTimer = null;
        if (remoteControlDirectService.getInfo()?.port !== port) return;
        void reconcileTailscaleRoute(origin, port, attempt + 1);
      }, retryInMs);
    }
    return true;
  }
}

/**
 * Retries taking down a route Komla set up when turning remote control off couldn't, since a
 * program that took the port would otherwise be on the tailnet with no Komla behind it.
 */
async function removeLeftoverTailscaleRoute(): Promise<void> {
  const origin = configService.get().directRemoteManagedTailscaleOrigin;
  if (!origin) return;
  try {
    await remoteControlTailscaleService.stop(origin, TAILSCALE_SHUTDOWN_TIMEOUT_MS);
  } catch (err) {
    logger.warn('failed to remove the Tailscale Serve listener left after turning off', {
      error: String(err),
    });
    return;
  }
  const config = configService.get();
  if (!config.directRemoteEnabled && config.directRemoteManagedTailscaleOrigin === origin) {
    configService.update({ directRemoteManagedTailscaleOrigin: undefined });
  }
}

export async function stopPersistedDirectRemoteServer(): Promise<void> {
  const config = configService.get();
  if (!config.directRemoteEnabled) {
    await removeLeftoverTailscaleRoute();
    return;
  }

  await startInFlight;
  if (tailscaleRetryTimer) {
    clearTimeout(tailscaleRetryTimer);
    tailscaleRetryTimer = null;
  }
  // While Komla is closed, any program that took the port would be on the
  // tailnet. The route stays in the config, and the next launch restores it.
  if (config.directRemoteManagedTailscaleOrigin) {
    try {
      await remoteControlTailscaleService.stop(
        config.directRemoteManagedTailscaleOrigin,
        TAILSCALE_SHUTDOWN_TIMEOUT_MS
      );
    } catch (err) {
      logger.warn('failed to remove the Tailscale Serve listener at shutdown', {
        error: String(err),
      });
    }
  }
  const { remoteControlDirectService } = await import('./remote-control-direct.service');
  await remoteControlDirectService.stop();
}
