/** Agents whose plan usage limits Komla reads and shows. */
export type AgentUsageSource = 'claude-code' | 'codex';

/** One limit of an agent's plan, such as Claude's five-hour or weekly limit. */
export interface AgentUsageWindow {
  /** As the popover names it: "5-hour limit", "Weekly limit", "Weekly Opus limit". Unique. */
  name: string;
  /** As the bar names it: "5h", "wk". Null for a limit only the popover lists. */
  short: string | null;
  /** Share of the limit used, from 0 to 100. */
  usedPercent: number;
  /** When the limit resets, in epoch milliseconds, when the provider said. */
  resetsAt: number | null;
}

/**
 * Why the latest read failed: the agent isn't signed in with a plan on this computer, its sign-in
 * expired and it renews it on its next run, or the provider couldn't be reached or refused for now.
 */
export type AgentUsageProblem = 'signed-out' | 'expired' | 'unavailable';

/** An agent's plan usage, as of the latest read that worked. */
export interface AgentUsageReading {
  source: AgentUsageSource;
  /** Shortest first, so the five-hour limit comes before the weekly. */
  windows: AgentUsageWindow[];
  /** The plan, such as "max" or "plus", when the provider said. */
  plan: string | null;
  /** The signed-in account's email, when known. */
  account: string | null;
  /** When the windows were read, in epoch milliseconds; 0 when no read has worked yet. */
  readAt: number;
  /** Set while reads fail; the windows are then the last ones that worked. */
  problem: AgentUsageProblem | null;
}

/** Each agent read so far. */
export type AgentUsage = Partial<Record<AgentUsageSource, AgentUsageReading>>;
