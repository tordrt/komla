import { Switch } from '@/components/ui/switch';

import {
  AGENT_CAPABILITIES,
  isAgentCapabilityEnabled,
  type AgentCapabilityId,
} from '../../../../shared/constants/agent-capabilities';

import { SettingsRow } from './SettingsRow';

import type { AppConfig } from '@/types';

interface AgentCapabilitiesBlockProps {
  config: AppConfig | null;
  onToggle: (capabilityId: AgentCapabilityId, enabled: boolean) => void;
  onSetServerDisabled: (disabled: boolean) => void;
}

export function AgentCapabilitiesBlock({
  config,
  onToggle,
  onSetServerDisabled,
}: AgentCapabilitiesBlockProps) {
  const mcpServerDisabled = config?.disableMcpServer === true;

  return (
    <>
      <SettingsRow
        label="MCP server"
        description="Let agents connect to Komla over MCP. Turning it off leaves the komla CLI working."
      >
        <Switch
          checked={!mcpServerDisabled}
          onCheckedChange={(checked) => onSetServerDisabled(!checked)}
        />
      </SettingsRow>
      <div className="space-y-1">
        <div className="pb-1">
          <div className="text-sm font-medium">Agent actions</div>
          <p className="mt-0.5 text-[13px] leading-normal text-muted-foreground">
            Turning an action off blocks it in both the CLI and MCP.
          </p>
        </div>
        {AGENT_CAPABILITIES.map((capability) => {
          const isEnabled = isAgentCapabilityEnabled(capability.id, config ?? {});
          return (
            <div key={capability.id} className="flex items-start justify-between gap-3 py-1">
              <div className="min-w-0">
                <div className="font-mono text-xs">{capability.command}</div>
                <p className="text-xs text-muted-foreground">{capability.description}</p>
              </div>
              <Switch
                aria-label={capability.command}
                checked={isEnabled}
                onCheckedChange={(checked) => {
                  onToggle(capability.id, checked);
                }}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
