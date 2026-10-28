import { createLogger } from '../../lib/logger';

import {
  automationRunSchema,
  automationSchedulerStatusSchema,
  hostAutomationListSchema,
  hostAutomationSchema,
} from './schemas';

import type {
  AutomationRun,
  AutomationSchedulerStatus,
  HostAutomation,
} from '../../../shared/types/automation';

const logger = createLogger('AutomationHostClient');

export interface AutomationHostListing {
  automations: HostAutomation[];
  /** Newest first, per automation id. */
  runs: Record<string, AutomationRun[]>;
  scheduler: AutomationSchedulerStatus;
}

/** The `komla automation` commands on an SSH host, which keep its automations and its crontab line. */
export interface AutomationHostClient {
  list(hostId: string): Promise<AutomationHostListing>;
  save(hostId: string, automation: HostAutomation): Promise<AutomationSchedulerStatus>;
  /** Turns an automation on or off as the host has it, and returns it from there. */
  setEnabled(
    hostId: string,
    automationId: string,
    enabled: boolean
  ): Promise<{ automation: HostAutomation; scheduler: AutomationSchedulerStatus }>;
  delete(hostId: string, automationId: string): Promise<AutomationSchedulerStatus>;
  run(hostId: string, automationId: string): Promise<AutomationRun>;
}

/** Runs `komla automation …` on a host through the CLI this installation put there. */
export interface AutomationHostCommands {
  run(
    hostId: string,
    args: string[],
    options: { input?: string; timeoutMs: number }
  ): Promise<string>;
}

/** How long reading a host's automations may take before the list shows it as unreachable. */
const LIST_TIMEOUT_MS = 20_000;
/** A change waits up to a minute for the host's store lock. */
const CHANGE_TIMEOUT_MS = 120_000;
/** A run waits up to a minute for a tick in progress, then fetches before it starts the agent. */
const RUN_TIMEOUT_MS = 180_000;

/** The JSON line the host CLI printed, after anything the login shell's profile printed first. */
function parseReply(output: string): unknown {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  return JSON.parse(lines.at(-1) ?? '');
}

/** Reads what a host printed, dropping automations and runs this version can't read. */
export function parseHostListing(output: string): AutomationHostListing {
  const listing = hostAutomationListSchema.parse(parseReply(output));
  const automations = listing.automations.flatMap((candidate) => {
    const parsed = hostAutomationSchema.safeParse(candidate);
    if (!parsed.success) {
      logger.warn('Skipping an automation an SSH host returned in an unknown shape');
      return [];
    }
    return [parsed.data];
  });
  const runs: Record<string, AutomationRun[]> = {};
  for (const [automationId, candidates] of Object.entries(listing.runs)) {
    runs[automationId] = candidates
      .flatMap((candidate) => {
        const parsed = automationRunSchema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  }
  return { automations, runs, scheduler: listing.scheduler };
}

function parseSchedulerReply(output: string): AutomationSchedulerStatus {
  const reply = parseReply(output) as { scheduler?: unknown };
  return automationSchedulerStatusSchema.parse(reply.scheduler);
}

/**
 * The host CLI's own explanation of a failure, which is written for people.
 * `afterTimeout` says what a command that timed out may still have done.
 */
export function hostCommandError(error: unknown, action: string, afterTimeout?: string): Error {
  if (typeof error === 'object' && error !== null && 'killed' in error && error.killed === true) {
    return new Error(
      [`The SSH host took too long to ${action}.`, afterTimeout].filter(Boolean).join(' ')
    );
  }
  const stderr =
    typeof error === 'object' &&
    error !== null &&
    'stderr' in error &&
    typeof error.stderr === 'string'
      ? error.stderr
      : '';
  const message = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (message) return new Error(message);
  const fallback = error instanceof Error ? error.message : String(error);
  return new Error(`Could not ${action} on the SSH host: ${fallback}`);
}

export function createAutomationHostClient(commands: AutomationHostCommands): AutomationHostClient {
  const call = async (
    hostId: string,
    action: string,
    args: string[],
    { afterTimeout, ...options }: { input?: string; timeoutMs: number; afterTimeout?: string }
  ) => {
    try {
      return await commands.run(hostId, ['automation', ...args], options);
    } catch (error) {
      throw hostCommandError(error, action, afterTimeout);
    }
  };
  return {
    async list(hostId) {
      return parseHostListing(
        await call(hostId, 'read automations', ['list', '--json'], { timeoutMs: LIST_TIMEOUT_MS })
      );
    },
    async save(hostId, automation) {
      return parseSchedulerReply(
        await call(hostId, 'save the automation', ['save'], {
          input: JSON.stringify(automation),
          timeoutMs: CHANGE_TIMEOUT_MS,
        })
      );
    },
    async setEnabled(hostId, automationId, enabled) {
      const reply = parseReply(
        await call(
          hostId,
          `turn the automation ${enabled ? 'on' : 'off'}`,
          [enabled ? 'enable' : 'disable', automationId],
          { timeoutMs: CHANGE_TIMEOUT_MS }
        )
      ) as { automation?: unknown; scheduler?: unknown };
      return {
        automation: hostAutomationSchema.parse(reply.automation),
        scheduler: automationSchedulerStatusSchema.parse(reply.scheduler),
      };
    },
    async delete(hostId, automationId) {
      return parseSchedulerReply(
        await call(hostId, 'delete the automation', ['delete', automationId], {
          timeoutMs: CHANGE_TIMEOUT_MS,
        })
      );
    },
    async run(hostId, automationId) {
      const output = await call(hostId, 'start the automation', ['run', automationId, '--json'], {
        timeoutMs: RUN_TIMEOUT_MS,
        // The host keeps going after ssh gives up, so running it again would start a second agent.
        afterTimeout:
          'The run may still start there, so check its last run before running it again.',
      });
      return automationRunSchema.parse(parseReply(output));
    },
  };
}
