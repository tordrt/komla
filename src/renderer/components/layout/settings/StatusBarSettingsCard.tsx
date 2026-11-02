import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import {
  RESOURCE_USAGE_BAR_CHOICES,
  RESOURCE_USAGE_HOST_CHOICES,
  hostChoice,
  resourceUsageBarChoice,
  resourceUsageBarChoiceUpdate,
  useResourceUsageBarSource,
} from '@/components/layout/status-bar/ResourceUsageSegment';
import {
  isStatusBarItemShown,
  statusBarItemVisibilityUpdate,
} from '@/components/layout/status-bar/status-bar-items';
import { StatusBarSizeControl } from '@/components/layout/status-bar/StatusBarSizeControl';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useConfigStore } from '@/stores/config.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';

/**
 * Turns the status bar back on once its own menu has hidden it. The bar's menu picks its items;
 * Resource usage shows here too, as it is off by default and has a choice of its own.
 */
export function StatusBarSettingsCard() {
  const showStatusBar = useConfigStore((s) => s.config?.showStatusBar !== false);
  const showAgentsInMenuBar = useConfigStore((s) => s.config?.showAgentsInMenuBar === true);
  const inBackgroundOnly = useConfigStore((s) => s.config?.agentsMenuBarInBackgroundOnly !== false);
  const config = useConfigStore((s) => s.config);
  const showsResourceUsage = isStatusBarItemShown(config, 'system-metrics');
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const sshHosts = useSshHostsStore((s) => s.hosts);
  const resourceUsageBarSource = useResourceUsageBarSource();
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
      <SettingsRow
        label="Resource usage"
        description="Show CPU and memory use in the status bar. Click it for what each workspace's terminals use, here and on SSH hosts."
        disabled={!showStatusBar}
      >
        <Switch
          checked={showsResourceUsage}
          disabled={!showStatusBar}
          onCheckedChange={(checked) =>
            void updateConfig(statusBarItemVisibilityUpdate(config, 'system-metrics', checked))
          }
        />
      </SettingsRow>
      {showsResourceUsage && (
        <SettingsRow
          label="Status bar shows"
          description="Whose CPU and memory the status bar counts."
          disabled={!showStatusBar}
        >
          <Select
            aria-label="Status bar shows"
            disabled={!showStatusBar}
            value={resourceUsageBarChoice(resourceUsageBarSource)}
            onChange={(e) => void updateConfig(resourceUsageBarChoiceUpdate(e.target.value))}
            className="w-56"
          >
            {RESOURCE_USAGE_BAR_CHOICES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {sshHosts.map((host) => (
              <optgroup key={host.id} label={host.name}>
                {RESOURCE_USAGE_HOST_CHOICES.map((option) => (
                  // A closed select shows only the option, so it names the host.
                  <option key={option.value} value={hostChoice(option.value, host)}>
                    {host.name}: {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </SettingsRow>
      )}
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
