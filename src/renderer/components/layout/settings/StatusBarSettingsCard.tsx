import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import { StatusBarSizeControl } from '@/components/layout/status-bar/StatusBarSizeControl';
import { Switch } from '@/components/ui/switch';
import { useConfigStore } from '@/stores/config.store';

/** Turns the status bar back on once its own menu has hidden it; the bar's menu picks its items. */
export function StatusBarSettingsCard() {
  const showStatusBar = useConfigStore((s) => s.config?.showStatusBar !== false);
  const showAgentsInMenuBar = useConfigStore((s) => s.config?.showAgentsInMenuBar === true);
  const inBackgroundOnly = useConfigStore((s) => s.config?.agentsMenuBarInBackgroundOnly !== false);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  return (
    <SettingsCard title="Status bar">
      <SettingsRow
        label="Show status bar"
        description="Show agent activity and more along the bottom of the window. Right-click the bar to choose what it shows."
      >
        <Switch
          checked={showStatusBar}
          onCheckedChange={(checked) => void updateConfig({ showStatusBar: checked })}
        />
      </SettingsRow>
      <SettingsRow label="Status bar size" description="How tall the bar along the bottom is">
        <StatusBarSizeControl disabled={!showStatusBar} />
      </SettingsRow>
      {window.api.platform === 'darwin' && (
        <SettingsRow
          label="Show agents in the menu bar"
          description="Count the agents that need input, failed, finished or are working at the top of the screen, while there are any. Click it to jump to a workspace or an agent's pane."
        >
          <Switch
            checked={showAgentsInMenuBar}
            onCheckedChange={(checked) => void updateConfig({ showAgentsInMenuBar: checked })}
          />
        </SettingsRow>
      )}
      {window.api.platform === 'darwin' && (
        <SettingsRow
          label="Only while Komla is in the background"
          description="Hide the menu bar item while a Komla window is in front, where the status bar already shows the agents."
        >
          <Switch
            checked={inBackgroundOnly}
            disabled={!showAgentsInMenuBar}
            onCheckedChange={(checked) =>
              void updateConfig({ agentsMenuBarInBackgroundOnly: checked })
            }
          />
        </SettingsRow>
      )}
    </SettingsCard>
  );
}
