import { Switch } from '@/components/ui/switch';
import { agentStatusReportsWork } from '@/lib/agent-status-reports';
import { useConfigStore } from '@/stores/config.store';

import { NotificationSoundsBlock } from './NotificationSoundsBlock';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import { SpinnerSettingsBlock } from './SpinnerSettingsBlock';

export function AgentNotificationsCard() {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const endpointOn = config?.disableNotificationEndpoint !== true;
  // Agents that report their own status drive the spinner and sounds without the endpoint.
  const statusReports = agentStatusReportsWork();

  return (
    <SettingsCard title="Notifications">
      <SettingsRow
        label="Hooks endpoint"
        description={
          statusReports
            ? 'Receives agents’ hooks. Required for workspace titles that follow the chat, and for the spinner and sounds of agents that don’t report their own status.'
            : 'Receives agents’ hooks. Required for the spinner, sounds and workspace titles that follow the chat.'
        }
      >
        <Switch
          checked={endpointOn}
          onCheckedChange={(checked) =>
            void updateConfig({ disableNotificationEndpoint: !checked })
          }
        />
      </SettingsRow>
      {/* A disabled fieldset turns off every control inside these blocks while leaving their
          text readable. */}
      <fieldset disabled={!endpointOn && !statusReports} className="min-w-0">
        <SpinnerSettingsBlock
          config={config}
          onToggle={(checked) => void updateConfig({ showAgentSpinner: checked })}
        />
      </fieldset>
      <fieldset disabled={!endpointOn && !statusReports} className="min-w-0">
        <NotificationSoundsBlock
          config={config}
          onUpdate={(sounds) => void updateConfig({ notificationSounds: sounds })}
        />
      </fieldset>
    </SettingsCard>
  );
}
