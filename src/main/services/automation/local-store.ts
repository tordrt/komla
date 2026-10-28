import { existsSync, readFileSync } from 'fs';

import { z } from 'zod';

import { MAX_AUTOMATION_RUNS } from '../../../shared/types/automation';
import { writeFileAtomic } from '../../lib/atomic-write';
import { createLogger } from '../../lib/logger';

import { automationRunSchema, automationScheduleSchema } from './schemas';

import type { Automation, AutomationRun } from '../../../shared/types/automation';

const logger = createLogger('AutomationLocalStore');

const localAutomationSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  prompt: z.string(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  target: z.object({ kind: z.literal('local') }),
  presetId: z.string().optional(),
  launchModeId: z.string().optional(),
  agentName: z.string().optional(),
  schedule: automationScheduleSchema,
  enabled: z.boolean(),
  missedRunGraceMinutes: z.number().finite().nonnegative(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

const FILE_VERSION = 1;

const fileSchema = z.object({
  version: z.literal(FILE_VERSION),
  automations: z.array(z.unknown()),
  runs: z.record(z.string(), z.array(z.unknown())),
});

export interface LocalAutomationState {
  automations: Automation[];
  /** Newest first, per automation id. */
  runs: Record<string, AutomationRun[]>;
  /** Why the file couldn't be read. It isn't written over while this is set. */
  error?: string;
}

/** The automations this computer runs while Komla is open, in one JSON file. */
export class LocalAutomationStore {
  private state: LocalAutomationState | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  read(): LocalAutomationState {
    this.state ??= this.load();
    return this.state;
  }

  async saveAutomation(automation: Automation): Promise<void> {
    const state = this.writable();
    const others = state.automations.filter((candidate) => candidate.id !== automation.id);
    this.state = { ...state, automations: [...others, automation] };
    await this.persist();
  }

  async deleteAutomation(id: string): Promise<void> {
    const state = this.writable();
    const runs = { ...state.runs };
    delete runs[id];
    this.state = {
      automations: state.automations.filter((automation) => automation.id !== id),
      runs,
    };
    await this.persist();
  }

  /**
   * Adds a run, dropping the oldest beyond `MAX_AUTOMATION_RUNS` but never the
   * newest scheduled one, which tells the next tick which time it handled last.
   * A run of an automation deleted meanwhile is dropped.
   */
  async addRun(run: AutomationRun): Promise<void> {
    const state = this.writable();
    if (!state.automations.some((automation) => automation.id === run.automationId)) return;
    const all = [run, ...(state.runs[run.automationId] ?? [])];
    const runs = all.slice(0, MAX_AUTOMATION_RUNS);
    const newestScheduled = all.find(
      (candidate) => candidate.trigger === 'schedule' && candidate.scheduledFor !== undefined
    );
    if (newestScheduled && !runs.includes(newestScheduled)) runs.push(newestScheduled);
    this.state = { ...state, runs: { ...state.runs, [run.automationId]: runs } };
    await this.persist();
  }

  private writable(): LocalAutomationState {
    const state = this.read();
    if (state.error) throw new Error(state.error);
    return state;
  }

  private load(): LocalAutomationState {
    if (!existsSync(this.path)) return { automations: [], runs: {} };
    try {
      const content: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      const version =
        typeof content === 'object' && content !== null && 'version' in content
          ? content.version
          : undefined;
      if (typeof version === 'number' && version > FILE_VERSION) {
        return {
          automations: [],
          runs: {},
          error:
            'A newer version of Komla saved the automations on this computer. Update Komla to run or change them.',
        };
      }
      const file = fileSchema.parse(content);
      const automations = file.automations.flatMap((candidate) => {
        const parsed = localAutomationSchema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
      });
      const runs: Record<string, AutomationRun[]> = {};
      for (const [id, candidates] of Object.entries(file.runs)) {
        runs[id] = candidates.flatMap((candidate) => {
          const parsed = automationRunSchema.safeParse(candidate);
          return parsed.success ? [parsed.data] : [];
        });
      }
      return { automations, runs };
    } catch (error) {
      logger.warn('Could not read automations; leaving the file as it is', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        automations: [],
        runs: {},
        error: `Couldn't read ${this.path}. Fix or remove that file to save automations on this computer.`,
      };
    }
  }

  private persist(): Promise<void> {
    const content = `${JSON.stringify({ version: FILE_VERSION, ...this.state }, null, 2)}\n`;
    // A failed write must not stop later ones.
    const write = this.writes
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.path, content));
    this.writes = write;
    return write;
  }
}
