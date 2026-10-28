import {
  AGENT_CAPABILITIES,
  getAgentCapabilityForMcpTool,
  isAgentCapabilityEnabled,
  type AgentCapabilityMcpTool,
} from './agent-capabilities';

export const MCP_BUILT_IN_TOOLS = AGENT_CAPABILITIES.flatMap((capability) =>
  'mcpTool' in capability
    ? [
        {
          name: capability.mcpTool,
          description: capability.description,
        },
      ]
    : []
);

export type McpBuiltInToolName = AgentCapabilityMcpTool;

export const MCP_BUILT_IN_TOOL_NAMES: readonly McpBuiltInToolName[] = MCP_BUILT_IN_TOOLS.map(
  (t) => t.name
);

export interface McpToolEnabledConfig {
  agentDisabledCapabilities?: readonly string[];
}

export function isMcpToolEnabled(name: McpBuiltInToolName, config: McpToolEnabledConfig): boolean {
  const capability = getAgentCapabilityForMcpTool(name);
  return capability ? isAgentCapabilityEnabled(capability.id, config) : false;
}
