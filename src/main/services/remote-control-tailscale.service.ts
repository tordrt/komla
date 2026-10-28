import { execFile } from 'child_process';
import { promisify } from 'util';

import { createLogger } from '../lib/logger';

const logger = createLogger('RemoteControlTailscaleService');
const execFileAsync = promisify(execFile);

/** Tailscale Funnel would put the remote shell's login page on the public internet. */
export class TailscaleFunnelEnabledError extends Error {
  constructor(httpsPort: string) {
    super(
      `Tailscale Funnel is on for HTTPS port ${httpsPort}, which would put remote control on the public internet. Turn it off with "tailscale funnel --https=${httpsPort} off" and try again.`
    );
    this.name = 'TailscaleFunnelEnabledError';
  }
}

class RemoteControlTailscaleService {
  async configure(publicOrigin: string, localPort: number): Promise<string[]> {
    await this.assertFunnelOff(publicOrigin);
    return applyServe(publicOrigin, localPort);
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
    await execFileAsync('tailscale', ['serve', `--https=${httpsPort}`, 'off'], {
      timeout: timeoutMs,
      windowsHide: true,
    });
  }
}

async function applyServe(publicOrigin: string, localPort: number): Promise<string[]> {
  const httpsPort = getHttpsPort(publicOrigin);
  const args = ['serve', '--bg', `--https=${httpsPort}`, `localhost:${localPort}`];
  await execFileAsync('tailscale', args, { timeout: 15_000, windowsHide: true });
  return args;
}

async function readServeStatus(): Promise<unknown> {
  const { stdout } = await execFileText('tailscale', ['serve', 'status', '--json'], {
    timeout: 5_000,
    windowsHide: true,
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

function getHttpsPort(publicOrigin: string): string {
  return new URL(publicOrigin).port || '443';
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
