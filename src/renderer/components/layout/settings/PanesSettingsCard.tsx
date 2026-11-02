import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { markPaneMenuHintSeen } from '@/lib/pane-menu-hint';
import { useCustomizationStore } from '@/stores/customization.store';

/** How terminal panes look: their headers, dimming and borders. */
export function PanesSettingsCard() {
  const terminalConfig = useCustomizationStore((s) => s.terminalConfig);
  const updateTerminalConfig = useCustomizationStore((s) => s.updateTerminalConfig);
  const showPaneHeaders = terminalConfig?.showPaneHeaders === true;

  return (
    <SettingsCard title="Panes">
      <SettingsRow
        label="Show pane headers"
        description="Show a title bar on split panes to drag, split and close them. When off, split and close from the right-click menu."
      >
        <Switch
          checked={showPaneHeaders}
          onCheckedChange={(checked) => {
            markPaneMenuHintSeen();
            void updateTerminalConfig({ showPaneHeaders: checked });
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="Show pane buttons on focus"
        description="Show split and close buttons in the terminal header when a pane is focused, not just on hover"
        disabled={!showPaneHeaders}
      >
        <Switch
          disabled={!showPaneHeaders}
          checked={terminalConfig?.showButtonsOnFocus ?? true}
          onCheckedChange={(checked) => {
            void updateTerminalConfig({ showButtonsOnFocus: checked });
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="Focused pane border"
        description="Outline the focused pane in the accent color"
      >
        <Switch
          checked={terminalConfig?.focusedPaneBorder === true}
          onCheckedChange={(checked) => {
            void updateTerminalConfig({ focusedPaneBorder: checked });
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="Dim unfocused panes"
        description="Reduce brightness of panes that don't have focus"
      >
        <Select
          value={String(terminalConfig?.unfocusedPaneDimOpacity ?? 0.85)}
          onChange={(e) => {
            void updateTerminalConfig({
              unfocusedPaneDimOpacity: Number(e.target.value),
            });
          }}
          className="w-28"
        >
          <option value="1">None</option>
          <option value="0.9">10%</option>
          <option value="0.85">15%</option>
          <option value="0.8">20%</option>
          <option value="0.7">30%</option>
          <option value="0.6">40%</option>
          <option value="0.5">50%</option>
          <option value="0.4">60%</option>
          <option value="0.3">70%</option>
        </Select>
      </SettingsRow>

      <SettingsRow
        label="Notification pane border"
        description="Show a subtle colored border around unfocused terminal panes with notifications"
      >
        <Switch
          checked={terminalConfig?.notificationPaneBorder ?? true}
          onCheckedChange={(checked) => {
            void updateTerminalConfig({ notificationPaneBorder: checked });
          }}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
