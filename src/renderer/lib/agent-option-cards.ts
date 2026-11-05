/** The element ids of an agent's launch mode, models and effort sections in Settings → Agents, to scroll to. */
export type AgentOption = keyof typeof AGENT_OPTION_CARD_IDS;

export const AGENT_OPTION_CARD_IDS = {
  launchModes: 'agent-launch-modes',
  models: 'agent-models',
  effort: 'agent-effort',
} as const;
