import { app, net } from 'electron';

import { getTelemetryLevel } from '../../shared/lib/telemetry-level';
import { activePeriodFlags } from '../lib/active-periods';
import { API_BASE_URL } from '../lib/api-urls';
import { getBuildDistribution } from '../lib/build-info';
import { createLogger } from '../lib/logger';
import { telemetryDisabledByEnv } from '../lib/telemetry-env';

const logger = createLogger('TelemetryService');

import { agentPresetService } from './agent-preset.service';
import { configService } from './config.service';
import { licenseService } from './license.service';
import { metricsCollectorService } from './metrics-collector.service';
import { getTelemetryCohortDimensions, telemetryAgentName } from './telemetry-dimensions';

import type { MonetizationTelemetryEvent } from './license.service';
import type { UsageSummaryPayload } from './metrics-collector.service';
import type { TelemetryLevel } from '../../shared/lib/telemetry-level';
import type { SshHostAddedSource } from '../../shared/types/ssh';

function isDev(): boolean {
  return !app.isPackaged;
}

const TELEMETRY_URL = `${API_BASE_URL}/api/v1/telemetry/install`;
const HEARTBEAT_URL = `${API_BASE_URL}/api/v1/telemetry/heartbeat`;
const USAGE_URL = `${API_BASE_URL}/api/v1/telemetry/usage-v2`;
const MONETIZATION_URL = `${API_BASE_URL}/api/v1/telemetry/monetization`;
const AGENT_SELECTED_URL = `${API_BASE_URL}/api/v1/telemetry/agent-selected`;
const MILESTONE_URL = `${API_BASE_URL}/api/v1/telemetry/milestone`;
const SSH_HOST_ADDED_URL = `${API_BASE_URL}/api/v1/telemetry/ssh-host-added`;

const ONE_HOUR_MS = 60 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 60 * 1000;

// Without opting in to usage analytics, Komla sends only the anonymous install
// ping and daily heartbeat, with no telemetry ID; those can be turned off too.
function telemetryLevel(): TelemetryLevel {
  return telemetryDisabledByEnv() ? 'off' : getTelemetryLevel(configService.get());
}

function usageTelemetryOptedIn(): boolean {
  return telemetryLevel() === 'usage';
}

function optedInDistinctId(): { distinctId?: string } {
  return usageTelemetryOptedIn() ? { distinctId: configService.getTelemetryDistinctId() } : {};
}

interface TelemetryRequest {
  setHeader(name: string, value: string): void;
}

function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

function telemetryPlatformToken(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7';
    case 'win32':
      return 'Windows NT 10.0; Win64; x64';
    default:
      return 'X11; Linux x86_64';
  }
}

function telemetryUserAgent(): string {
  const chromeVersion = process.versions.chrome ?? '131.0.0.0';
  const electronVersion = process.versions.electron ?? '0.0.0';
  return `Mozilla/5.0 (${telemetryPlatformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Electron/${electronVersion} Safari/537.36 Komla/${app.getVersion()}`;
}

function setTelemetryHeaders(request: TelemetryRequest): void {
  request.setHeader('Content-Type', 'application/json');
  request.setHeader('User-Agent', telemetryUserAgent());

  const locale = app.getLocale?.();
  if (locale) {
    request.setHeader('Accept-Language', locale);
  }
}

interface IntegrationMilestoneProps {
  notificationKind?: string;
  tool?: string;
  // Agent that sent the notification, taken from the payload `source`. Used for
  // agent attribution instead of the active preset; consumed, not forwarded.
  source?: string;
}

class TelemetryService {
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  // A second send for the same day would count the install twice, as heartbeats carry no ID.
  private heartbeatInFlight = false;
  // Milestones whose ping is currently in flight — guards against concurrent
  // first-occurrences double-sending before the config dedup list is updated.
  private inFlightMilestones = new Set<string>();

  /** The install ID, only while usage analytics are on; it links checkout to in-app activity. */
  getDistinctId(): string | null {
    return usageTelemetryOptedIn() ? configService.getTelemetryDistinctId() : null;
  }

  async sendInstallPing(): Promise<void> {
    if (isDev()) {
      logger.debug('Skipping install ping in dev mode');
      return;
    }

    if (telemetryLevel() === 'off') {
      logger.debug('Skipping install ping (telemetry off)');
      return;
    }

    const config = configService.get();

    // Only send once per installation
    if (config.telemetryPingSent) {
      logger.debug('Install ping already sent, skipping');
      return;
    }

    logger.info('Sending install ping');
    try {
      await this.postInstallPing();
      configService.update({ telemetryPingSent: true });
      logger.info('Install ping sent successfully');
    } catch (error) {
      // Silently fail - telemetry should never interrupt the user
      logger.debug('Failed to send install ping:', error);
    }
  }

  private postInstallPing(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: TELEMETRY_URL,
        });

        setTelemetryHeaders(request);

        request.on('response', (response) => {
          // Drain the response body
          response.on('data', () => {});
          response.on('end', () => {
            if (response.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`Server returned ${response.statusCode}`));
            }
          });
        });

        request.on('error', (error) => {
          reject(error);
        });

        request.write(
          JSON.stringify({
            appVersion: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            distribution: getBuildDistribution(),
            ...optedInDistinctId(),
          })
        );
        request.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Records the agent the user picked on the setup wizard's agent step. Unlike
   * the install ping this can fire more than once per install (the renderer
   * guards it to once per wizard run), so it is not persisted as sent.
   */
  sendAgentSelected(agent: string): void {
    if (isDev()) {
      logger.debug('Skipping agent-selected ping in dev mode');
      return;
    }
    if (!usageTelemetryOptedIn()) {
      logger.debug('Skipping agent-selected ping (usage telemetry disabled)');
      return;
    }

    logger.info(`Sending agent-selected ping: ${agent}`);
    void this.postAgentSelected(agent).catch((error) => {
      // Silently fail - telemetry should never interrupt the user
      logger.debug('Failed to send agent-selected ping:', error);
    });
  }

  private postAgentSelected(agent: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: AGENT_SELECTED_URL,
        });

        setTelemetryHeaders(request);

        request.on('response', (response) => {
          response.on('data', () => {});
          response.on('end', () => {
            if (response.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`Server returned ${response.statusCode}`));
            }
          });
        });

        request.on('error', (error) => {
          reject(error);
        });

        request.write(
          JSON.stringify({
            appVersion: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            distribution: getBuildDistribution(),
            agent,
            distinctId: configService.getTelemetryDistinctId(),
          })
        );
        request.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Records an SSH host added in Settings, with where Settings was opened from,
   * to see which entry points lead people to SSH workspaces.
   */
  sendSshHostAdded(source: SshHostAddedSource): void {
    if (isDev()) {
      logger.debug('Skipping ssh-host-added ping in dev mode');
      return;
    }
    if (!usageTelemetryOptedIn()) {
      logger.debug('Skipping ssh-host-added ping (usage telemetry disabled)');
      return;
    }

    logger.info(`Sending ssh-host-added ping: ${source}`);
    void this.postSshHostAdded(source).catch((error) => {
      // Silently fail - telemetry should never interrupt the user
      logger.debug('Failed to send ssh-host-added ping:', error);
    });
  }

  private postSshHostAdded(source: SshHostAddedSource): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: SSH_HOST_ADDED_URL,
        });

        setTelemetryHeaders(request);

        request.on('response', (response) => {
          response.on('data', () => {});
          response.on('end', () => {
            if (response.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`Server returned ${response.statusCode}`));
            }
          });
        });

        request.on('error', (error) => {
          reject(error);
        });

        request.write(
          JSON.stringify({
            appVersion: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            distribution: getBuildDistribution(),
            source,
            distinctId: configService.getTelemetryDistinctId(),
          })
        );
        request.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Reports a one-time integration milestone — the first notification of a
   * given kind, or the first MCP tool call. Deduped per install via config so
   * each milestone is reported at most once ever. Honors the usage-telemetry
   * opt-out: these are activation signals, not basic install pings.
   */
  sendIntegrationMilestone(milestone: string, props: IntegrationMilestoneProps = {}): void {
    if (isDev()) {
      logger.debug(`Skipping integration milestone in dev mode: ${milestone}`);
      return;
    }
    if (!usageTelemetryOptedIn()) {
      logger.debug(`Skipping integration milestone (usage telemetry disabled): ${milestone}`);
      return;
    }

    const reported = configService.get().reportedTelemetryMilestones ?? [];
    if (reported.includes(milestone) || this.inFlightMilestones.has(milestone)) {
      return;
    }
    this.inFlightMilestones.add(milestone);

    logger.info(`Sending integration milestone: ${milestone}`);
    this.postIntegrationMilestone(milestone, props)
      .then(() => {
        const current = configService.get().reportedTelemetryMilestones ?? [];
        if (!current.includes(milestone)) {
          configService.update({ reportedTelemetryMilestones: [...current, milestone] });
        }
      })
      .catch((error) => {
        // Drop the in-flight guard so a later occurrence can retry.
        this.inFlightMilestones.delete(milestone);
        logger.debug(`Failed to send integration milestone (${milestone}):`, error);
      });
  }

  private postIntegrationMilestone(
    milestone: string,
    props: IntegrationMilestoneProps
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: MILESTONE_URL,
        });

        setTelemetryHeaders(request);

        request.on('response', (response) => {
          response.on('data', () => {});
          response.on('end', () => {
            if (response.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`Server returned ${response.statusCode}`));
            }
          });
        });

        request.on('error', (error) => {
          reject(error);
        });

        // Prefer the notification's own `source` over the active preset — it
        // names the agent that actually sent the notification, which is more
        // accurate when a user runs multiple agents.
        const { source, ...forwardedProps } = props;
        request.write(
          JSON.stringify({
            appVersion: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            distribution: getBuildDistribution(),
            milestone,
            agent: source ?? telemetryAgentName(agentPresetService.getActive()),
            distinctId: configService.getTelemetryDistinctId(),
            ...forwardedProps,
          })
        );
        request.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  async sendDailyHeartbeat(): Promise<void> {
    if (isDev()) {
      logger.debug('Skipping heartbeat in dev mode');
      return;
    }

    // Start periodic check for long-running instances
    this.startHeartbeatInterval();

    await this.checkAndSendHeartbeat();
  }

  private startHeartbeatInterval(): void {
    if (this.heartbeatInterval) return;

    // Re-check every hour so we catch the day rollover for long-running instances
    this.heartbeatInterval = setInterval(() => {
      void this.checkAndSendHeartbeat();
    }, ONE_HOUR_MS);
  }

  private async checkAndSendHeartbeat(): Promise<void> {
    if (telemetryLevel() === 'off') {
      logger.debug('Skipping daily heartbeat (telemetry off)');
      return;
    }

    const config = configService.get();
    const today = todayDateString();

    // Already sent today — skip
    if (config.lastHeartbeatDate === today) {
      logger.debug('Daily heartbeat already sent today, skipping');
      return;
    }

    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;

    logger.info('Sending daily heartbeat');
    try {
      await this.postHeartbeat(activePeriodFlags(config.lastHeartbeatDate, today));
      configService.update({ lastHeartbeatDate: today });
      logger.info('Daily heartbeat sent successfully');

      // Flush usage metrics only after a successful heartbeat to avoid
      // splitting/double-counting usage across retries. Fire-and-forget;
      // disk file is only deleted after a successful upload.
      if (!usageTelemetryOptedIn()) {
        metricsCollectorService.discard();
        logger.debug('Skipping usage summary because usage telemetry is disabled');
        return;
      }

      try {
        const usagePayload = await metricsCollectorService.flush();
        this.postUsageSummary(usagePayload)
          .then(() => {
            metricsCollectorService.confirmFlush();
            logger.info('Usage summary sent successfully');
          })
          .catch((error) => logger.debug('Failed to send usage summary:', error));
      } catch (error) {
        logger.debug('Failed to flush usage metrics:', error);
      }
    } catch (error) {
      // Silently fail - telemetry should never interrupt the user
      logger.debug('Failed to send daily heartbeat:', error);
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private postHeartbeat(periods: ReturnType<typeof activePeriodFlags>): Promise<void> {
    return new Promise((resolve, reject) => {
      let request: ReturnType<typeof net.request> | undefined;
      // A stalled request would otherwise hold off every later check.
      const timer = setTimeout(() => {
        request?.abort();
        reject(new Error('Heartbeat timed out'));
      }, HEARTBEAT_TIMEOUT_MS);
      const fail = (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      };

      try {
        request = net.request({
          method: 'POST',
          url: HEARTBEAT_URL,
        });

        setTelemetryHeaders(request);

        request.on('response', (response) => {
          // Drain the response body
          response.on('data', () => {});
          response.on('end', () => {
            if (response.statusCode === 200) {
              clearTimeout(timer);
              resolve();
            } else {
              fail(new Error(`Server returned ${response.statusCode}`));
            }
          });
        });

        request.on('error', fail);

        const agentName = telemetryAgentName(agentPresetService.getActive());
        const isLicensed = licenseService.getStatus().isLicensed;
        const cohortDimensions = getTelemetryCohortDimensions();

        request.write(
          JSON.stringify({
            appVersion: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            distribution: getBuildDistribution(),
            agent: agentName,
            isLicensed,
            ...periods,
            ...optedInDistinctId(),
            ...cohortDimensions,
          })
        );
        request.end();
      } catch (error) {
        fail(error);
      }
    });
  }

  private postUsageSummary(payload: UsageSummaryPayload): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: USAGE_URL,
        });

        setTelemetryHeaders(request);

        request.on('response', (response) => {
          response.on('data', () => {});
          response.on('end', () => {
            if (response.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`Server returned ${response.statusCode}`));
            }
          });
        });

        request.on('error', (error) => {
          reject(error);
        });

        request.write(JSON.stringify(payload));
        request.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  sendMonetizationEvent(
    name: MonetizationTelemetryEvent,
    props: {
      source?: 'create_workspace' | 'start_workspace' | 'free_limit_wall';
      limit?: number;
      runningCount?: number;
    } = {}
  ): void {
    if (!usageTelemetryOptedIn()) return;

    const payload = {
      event: name,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      distribution: getBuildDistribution(),
      isLicensed: licenseService.getStatus().isLicensed,
      distinctId: configService.getTelemetryDistinctId(),
      ...getTelemetryCohortDimensions(),
      ...props,
    };

    void this.postMonetizationEvent(payload).catch((error) => {
      logger.debug(`Failed to send monetization telemetry (${name}):`, error);
    });
  }

  private postMonetizationEvent(payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: MONETIZATION_URL,
        });

        setTelemetryHeaders(request);

        request.on('response', (response) => {
          response.on('data', () => {});
          response.on('end', () => {
            if (response.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`Server returned ${response.statusCode}`));
            }
          });
        });

        request.on('error', (error) => {
          reject(error);
        });

        request.write(JSON.stringify(payload));
        request.end();
      } catch (error) {
        reject(error);
      }
    });
  }
}

export const telemetryService = new TelemetryService();
