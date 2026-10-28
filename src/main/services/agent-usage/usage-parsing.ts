import { z } from 'zod';

import type { AgentUsageWindow } from '../../../shared/types/agent-usage';

export interface ParsedUsage {
  windows: AgentUsageWindow[];
  plan: string | null;
  account: string | null;
}

const percentSchema = z.number().transform((value) => Math.min(100, Math.max(0, value)));

function epochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** "5-hour limit" / "5h" from a window's length. */
export function namesForDuration(minutes: number): Pick<AgentUsageWindow, 'name' | 'short'> {
  if (minutes === 7 * 24 * 60) return { name: 'Weekly limit', short: '7d' };
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return { name: `${days}-day limit`, short: `${days}d` };
  }
  if (minutes % 60 === 0) return { name: `${minutes / 60}-hour limit`, short: `${minutes / 60}h` };
  return { name: `${minutes}-minute limit`, short: `${minutes}m` };
}

const claudeLimitSchema = z.object({
  kind: z.string(),
  percent: percentSchema,
  resets_at: z.string().nullish(),
  scope: z.object({ model: z.object({ display_name: z.string().nullish() }).nullish() }).nullish(),
});

const claudeWindowSchema = z.object({
  utilization: percentSchema,
  resets_at: z.string().nullish(),
});

// Each window is read on its own, so one the parser doesn't know drops only itself.
const claudeUsageSchema = z.object({
  limits: z.array(z.unknown()).nullish().catch(null),
  five_hour: z.unknown().optional(),
  seven_day: z.unknown().optional(),
  seven_day_opus: z.unknown().optional(),
  seven_day_sonnet: z.unknown().optional(),
});

const WEEK_MINUTES = 7 * 24 * 60;

/** A limit with its length, for putting the shortest first. */
type TimedWindow = AgentUsageWindow & { minutes: number };

/** Shortest first, each named once: a repeated name, such as two unnamed models', gets a number. */
function shortestFirst(windows: TimedWindow[]): AgentUsageWindow[] {
  const seen = new Map<string, number>();
  return [...windows]
    .sort((a, b) => a.minutes - b.minutes)
    .map(({ minutes: _, ...window }) => {
      const count = (seen.get(window.name) ?? 0) + 1;
      seen.set(window.name, count);
      return count > 1 ? { ...window, name: `${window.name} ${count}` } : window;
    });
}

function claudeLimitWindow(entry: unknown): TimedWindow | null {
  const parsed = claudeLimitSchema.safeParse(entry);
  if (!parsed.success) return null;
  const limit = parsed.data;
  const base = { usedPercent: limit.percent, resetsAt: epochMs(limit.resets_at) };
  if (limit.kind === 'session') return { name: '5-hour limit', short: '5h', minutes: 300, ...base };
  if (limit.kind === 'weekly_all') {
    return { name: 'Weekly limit', short: '7d', minutes: WEEK_MINUTES, ...base };
  }
  if (limit.kind === 'weekly_scoped') {
    const model = limit.scope?.model?.display_name;
    const name = model ? `Weekly ${model} limit` : 'Weekly model limit';
    return { name, short: null, minutes: WEEK_MINUTES, ...base };
  }
  return null;
}

function claudeNamedWindow(
  window: unknown,
  names: Pick<TimedWindow, 'name' | 'short' | 'minutes'>
): TimedWindow | null {
  const parsed = claudeWindowSchema.safeParse(window);
  if (!parsed.success) return null;
  return {
    ...names,
    usedPercent: parsed.data.utilization,
    resetsAt: epochMs(parsed.data.resets_at),
  };
}

/**
 * Claude's `GET /api/oauth/usage`. Newer responses list every limit under `limits`; older ones,
 * or a `limits` with none Komla knows, only name the five-hour and seven-day windows. Limits come
 * out shortest first.
 */
export function parseClaudeUsage(body: unknown): ParsedUsage | null {
  const parsed = claudeUsageSchema.safeParse(body);
  if (!parsed.success) return null;
  const usage = parsed.data;
  const listed = (usage.limits ?? []).flatMap((entry) => claudeLimitWindow(entry) ?? []);
  const windows =
    listed.length > 0
      ? listed
      : [
          claudeNamedWindow(usage.five_hour, { name: '5-hour limit', short: '5h', minutes: 300 }),
          claudeNamedWindow(usage.seven_day, {
            name: 'Weekly limit',
            short: '7d',
            minutes: WEEK_MINUTES,
          }),
          claudeNamedWindow(usage.seven_day_opus, {
            name: 'Weekly Opus limit',
            short: null,
            minutes: WEEK_MINUTES,
          }),
          claudeNamedWindow(usage.seven_day_sonnet, {
            name: 'Weekly Sonnet limit',
            short: null,
            minutes: WEEK_MINUTES,
          }),
        ].flatMap((window) => window ?? []);
  // Every Claude plan has limits, so a response without one Komla can read is one it doesn't know.
  if (windows.length === 0) return null;
  return { windows: shortestFirst(windows), plan: null, account: null };
}

const codexWindowSchema = z.object({
  used_percent: percentSchema,
  limit_window_seconds: z.number().positive(),
  reset_at: z.number().nullish(),
});

const codexUsageSchema = z.object({
  email: z.string().nullish().catch(null),
  plan_type: z.string().nullish().catch(null),
  rate_limit: z
    .object({ primary_window: z.unknown().optional(), secondary_window: z.unknown().optional() })
    .nullish()
    .catch(null),
});

function codexWindow(window: unknown): TimedWindow | null {
  const parsed = codexWindowSchema.safeParse(window);
  if (!parsed.success) return null;
  const minutes = Math.round(parsed.data.limit_window_seconds / 60);
  return {
    ...namesForDuration(minutes),
    minutes,
    usedPercent: parsed.data.used_percent,
    resetsAt: parsed.data.reset_at ? parsed.data.reset_at * 1000 : null,
  };
}

/** ChatGPT's `GET /backend-api/wham/usage`, which Codex's `/status` shows. Shortest first. */
export function parseCodexUsage(body: unknown): ParsedUsage | null {
  const parsed = codexUsageSchema.safeParse(body);
  if (!parsed.success) return null;
  const usage = parsed.data;
  const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window].flatMap(
    (window) => codexWindow(window) ?? []
  );
  return {
    windows: shortestFirst(windows),
    plan: usage.plan_type ?? null,
    account: usage.email ?? null,
  };
}
