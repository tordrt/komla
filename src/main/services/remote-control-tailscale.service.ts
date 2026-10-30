import { execFile } from 'child_process';
import { promisify } from 'util';

import { createLogger } from '../lib/logger';
import { tailscaleCommand } from '../lib/tailscale-command';

const logger = createLogger('RemoteControlTailscaleService');
const execFileAsync = promisify(execFile);

export const DEFAULT_HTTPS_PORT = '443';

/** Tailscale Funnel would put the remote shell's login page on the public internet. */
export class TailscaleFunnelEnabledError extends Error {
  constructor(httpsPort: string) {
    super(
      `Tailscale Funnel is on for HTTPS port ${httpsPort}, which would put remote control on the public internet. Turn it off with "tailscale funnel --https=${httpsPort} off" and try again.`
    );
    this.name = 'TailscaleFunnelEnabledError';
  }
}

/** Publishing here would replace another program's route, and turning off would remove it. */
export class TailscaleHttpsPortTakenError extends Error {
  constructor(httpsPort: string) {
    super(
      `Another Tailscale Serve route uses HTTPS port ${httpsPort}. Turn remote control off to pick another port, or remove that route with "tailscale serve --https=${httpsPort} off" and try again.`
    );
    this.name = 'TailscaleHttpsPortTakenError';
  }
}

class RemoteControlTailscaleService {
  /**
   * `managedOrigin` is the route Komla last published. Once the new route is up, Komla's route on
   * any other port comes off, so it isn't left on the tailnet untracked. If that fails the new
   * route comes back off, which leaves `managedOrigin` true for a later retry.
   */
  async configure(
    publicOrigin: string,
    localPort: number,
    managedOrigin?: string
  ): Promise<string[]> {
    const httpsPort = getHttpsPort(publicOrigin);
    const target = `localhost:${localPort}`;
    const status = await readServeStatus();
    assertNoFunnel(status, httpsPort);
    if (isHttpsPortTaken(status, httpsPort, target)) {
      throw new TailscaleHttpsPortTakenError(httpsPort);
    }
    const args = await applyServe(publicOrigin, localPort);
    if (managedOrigin) {
      const managedPort = getHttpsPort(managedOrigin);
      if (managedPort !== httpsPort && hasHttpsRoute(status, managedPort, target)) {
        try {
          await this.stop(managedOrigin);
        } catch (err) {
          await this.stop(publicOrigin).catch((undoErr: unknown) => {
            logger.warn('could not remove the new Tailscale Serve listener', { undoErr });
          });
          throw err;
        }
      }
    }
    return args;
  }

  async assertFunnelOff(publicOrigin: string): Promise<void> {
    assertNoFunnel(await readServeStatus(), getHttpsPort(publicOrigin));
  }

  async reconcile(publicOrigin: string, localPort: number): Promise<void> {
    const httpsPort = getHttpsPort(publicOrigin);
    const target = `localhost:${localPort}`;
    const status = await readServeStatus();
    assertNoFunnel(status, httpsPort);
    if (hasHttpsRoute(status, httpsPort, target)) {
      logger.debug('kept existing Tailscale Serve listener', { httpsPort, target });
      return;
    }

    await applyServe(publicOrigin, localPort);
    logger.info('reconciled Tailscale Serve listener', { httpsPort, target });
  }

  async stop(publicOrigin: string, timeoutMs = 15_000): Promise<void> {
    const httpsPort = getHttpsPort(publicOrigin);
    const tailscale = tailscaleCommand();
    await execFileAsync(tailscale.file, ['serve', `--https=${httpsPort}`, 'off'], {
      timeout: timeoutMs,
      windowsHide: true,
      env: tailscale.env,
    });
  }
}

async function applyServe(publicOrigin: string, localPort: number): Promise<string[]> {
  const httpsPort = getHttpsPort(publicOrigin);
  const args = ['serve', '--bg', `--https=${httpsPort}`, `localhost:${localPort}`];
  const tailscale = tailscaleCommand();
  await execFileAsync(tailscale.file, args, {
    timeout: 15_000,
    windowsHide: true,
    env: tailscale.env,
  });
  return args;
}

export async function readServeStatus(tailscale = tailscaleCommand()): Promise<unknown> {
  const { stdout } = await execFileText(tailscale.file, ['serve', 'status', '--json'], {
    timeout: 5_000,
    windowsHide: true,
    env: tailscale.env,
  });
  const trimmed = stdout.trim();
  return trimmed ? (JSON.parse(trimmed) as unknown) : {};
}

function assertNoFunnel(status: unknown, httpsPort: string): void {
  if (hasFunnel(status, httpsPort)) throw new TailscaleFunnelEnabledError(httpsPort);
}

// `AllowFunnel` maps "host:port" to true. A foreground `tailscale funnel`
// session keeps its own serve config under `Foreground`.
export function hasFunnel(value: unknown, httpsPort: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const { AllowFunnel, Foreground } = value as { AllowFunnel?: unknown; Foreground?: unknown };
  if (
    AllowFunnel &&
    typeof AllowFunnel === 'object' &&
    Object.entries(AllowFunnel).some(
      ([hostPort, allowed]) => allowed === true && hostPort.endsWith(`:${httpsPort}`)
    )
  ) {
    return true;
  }
  return (
    !!Foreground &&
    typeof Foreground === 'object' &&
    Object.values(Foreground).some((config) => hasFunnel(config, httpsPort))
  );
}

export function getHttpsPort(publicOrigin: string): string {
  return new URL(publicOrigin).port || DEFAULT_HTTPS_PORT;
}

/** Another route holds the port: one that isn't already pointing at `target`. */
export function isHttpsPortTaken(status: unknown, httpsPort: string, target: string): boolean {
  return holdsHttpsPort(status, httpsPort) && !hasHttpsRoute(status, httpsPort, target);
}

// `TCP` is keyed by port and `Web` by "host:port". A foreground `tailscale serve` session keeps its
// own serve config under `Foreground`. Tailscale Services have addresses of their own, so their
// routes don't hold this computer's port.
function holdsHttpsPort(value: unknown, httpsPort: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const { TCP, Web, Foreground } = value as { TCP?: unknown; Web?: unknown; Foreground?: unknown };
  return (
    (!!TCP && typeof TCP === 'object' && httpsPort in TCP) ||
    (!!Web &&
      typeof Web === 'object' &&
      Object.keys(Web).some((hostPort) => hostPort.endsWith(`:${httpsPort}`))) ||
    (!!Foreground &&
      typeof Foreground === 'object' &&
      Object.values(Foreground).some((config) => holdsHttpsPort(config, httpsPort)))
  );
}

export function hasHttpsRoute(value: unknown, httpsPort: string, target: string): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => {
    const identifiesPort = key === httpsPort || key.endsWith(`:${httpsPort}`);
    if (identifiesPort && collectStrings(item).some((entry) => entry.includes(target))) {
      return true;
    }
    return hasHttpsRoute(item, httpsPort, target);
  });
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item));
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap((item) => collectStrings(item));
}

function execFileText(
  command: string,
  args: string[],
  options: Parameters<typeof execFile>[2]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr: stderr.toString() }));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export const remoteControlTailscaleService = new RemoteControlTailscaleService();
