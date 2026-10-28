import { useEffect, useState } from 'react';

import { useConfigStore } from '@/stores/config.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';

import { agentCapabilitiesUpdate } from '../../../../shared/constants/agent-capabilities';
import { KomlaCliIntegration } from '../KomlaCliIntegration';

import { AgentCapabilitiesBlock } from './AgentCapabilitiesBlock';
import { AgentIntegrationsPanel } from './AgentIntegrations';
import { AgentLaunchDefaultsCard } from './AgentLaunchDefaultsCard';
import { AgentNotificationsCard } from './AgentNotificationsCard';
import { SettingsCard } from './SettingsCard';

export function IntegrationsTab() {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const integrationSection = useSettingsDialogStore((s) => s.target.integrationSection);
  const selfSetupPresetId = useSettingsDialogStore((s) => s.target.selfSetupPresetId);
  const [komlaBasePath, setKomlaBasePath] = useState<string | null>(null);

  useEffect(() => {
    void window.api.getBasePath().then(setKomlaBasePath);
  }, []);

  return (
    <div className="space-y-6">
      <AgentIntegrationsPanel
        openSection={integrationSection}
        selfSetupPresetId={selfSetupPresetId}
      />

      <AgentNotificationsCard />

      <SettingsCard
        title="MCP and CLI access"
        description="Agents control Komla through the komla CLI, built into every Komla terminal, which gets new features first. The MCP server stays for agents that only work through MCP."
      >
        <KomlaCliIntegration komlaBasePath={komlaBasePath} />
        <AgentCapabilitiesBlock
          config={config}
          onToggle={(capabilityId, enabled) => {
            void updateConfig(agentCapabilitiesUpdate(config ?? {}, [capabilityId], enabled));
          }}
          onSetServerDisabled={(disabled) => {
            void updateConfig({ disableMcpServer: disabled });
          }}
        />
      </SettingsCard>

      <AgentLaunchDefaultsCard />
    </div>
  );
}
