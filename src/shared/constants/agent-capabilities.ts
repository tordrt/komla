import { TRASH_RETENTION_DAYS } from '../types/workspace';

export const AGENT_CAPABILITIES = [
  {
    id: 'agent.launch.workspace',
    command: 'komla launch',
    mcpTool: 'spawn_agent_in_new_workspace',
    description: 'Launch an AI coding agent in a new isolated Komla workspace.',
  },
  {
    id: 'agent.launch.tab',
    command: 'komla launch --here',
    mcpTool: 'spawn_agent_new_tab',
    description: 'Launch an AI coding agent in a new tab in the current workspace.',
  },
  {
    id: 'workspace.title',
    command: 'komla title',
    mcpTool: 'set_workspace_title',
    description: 'Set the title and description shown for the current workspace.',
  },
  {
    id: 'workspace.snooze',
    command: 'komla snooze',
    description:
      'Snooze the current workspace until a time or its next notification. Waking it stays allowed.',
  },
  {
    id: 'workspace.tag',
    command: 'komla tag',
    description:
      'Tag the current workspace to say what it waits on, such as "Waiting for review", or take its tag off.',
  },
  {
    id: 'workspace.trash',
    command: 'komla trash',
    description: `Move the current workspace to the Trash once the agent’s turn ends, stopping its terminals. The user can restore it for ${TRASH_RETENTION_DAYS} days.`,
  },
  {
    id: 'folder.open',
    command: 'komla open',
    description: 'Open a folder on this computer in Komla, as its own workspace.',
  },
  {
    id: 'status.set',
    command: 'komla status set',
    mcpTool: 'set_status_item',
    description:
      'Show a short status, such as test results or a pull request link, in the status bar while the current workspace is open.',
  },
  {
    id: 'preview.open',
    command: 'komla preview',
    mcpTool: 'open_browser_preview',
    description: 'Open the embedded browser preview for the current workspace.',
  },
] as const;

export type AgentCapabilityId = (typeof AGENT_CAPABILITIES)[number]['id'];
/** Capabilities the CLI alone offers have no MCP tool. */
export type AgentCapabilityMcpTool = Extract<
  (typeof AGENT_CAPABILITIES)[number],
  { mcpTool: string }
>['mcpTool'];

export interface AgentCapabilityConfig {
  agentDisabledCapabilities?: readonly string[];
}

export function getAgentCapability(id: AgentCapabilityId) {
  return AGENT_CAPABILITIES.find((capability) => capability.id === id);
}

function capabilityMcpTool(
  capability: (typeof AGENT_CAPABILITIES)[number]
): AgentCapabilityMcpTool | undefined {
  return 'mcpTool' in capability ? capability.mcpTool : undefined;
}

export function getAgentCapabilityForMcpTool(tool: AgentCapabilityMcpTool) {
  return AGENT_CAPABILITIES.find((capability) => capabilityMcpTool(capability) === tool);
}

export function isAgentCapabilityEnabled(
  id: AgentCapabilityId,
  config: AgentCapabilityConfig
): boolean {
  if (!getAgentCapability(id)) return false;
  return !(config.agentDisabledCapabilities ?? []).includes(id);
}

/** Why a command the user turned off didn't run, naming it as its Settings toggle does. */
export function turnedOffCapabilityMessage(id: AgentCapabilityId): string {
  return `\`${getAgentCapability(id)?.command ?? id}\` is turned off in Komla. Ask the user to turn it on in Settings → Integrations & MCP → MCP and CLI access.`;
}

/** Capabilities of the commands an SSH host queues while Komla is away (ADR 0006). */
const QUEUED_COMMAND_CAPABILITIES = [
  'workspace.title',
  'workspace.snooze',
  'workspace.tag',
  'workspace.trash',
] as const satisfies readonly AgentCapabilityId[];

/**
 * The queued commands the user turned off, by operation type, with what the CLI answers in
 * their place. Their capability ids are their operation types.
 */
export function turnedOffQueuedCommands(config: AgentCapabilityConfig): Record<string, string> {
  return Object.fromEntries(
    QUEUED_COMMAND_CAPABILITIES.filter((id) => !isAgentCapabilityEnabled(id, config)).map((id) => [
      id,
      turnedOffCapabilityMessage(id),
    ])
  );
}

/** The config change that turns these capabilities on or off, for the CLI and MCP alike. */
export function agentCapabilitiesUpdate(
  config: AgentCapabilityConfig,
  ids: readonly AgentCapabilityId[],
  enabled: boolean
): { agentDisabledCapabilities: string[] } {
  const changed = new Set<string>(ids);
  const others = (config.agentDisabledCapabilities ?? []).filter((id) => !changed.has(id));
  return { agentDisabledCapabilities: enabled ? others : [...others, ...changed] };
}
