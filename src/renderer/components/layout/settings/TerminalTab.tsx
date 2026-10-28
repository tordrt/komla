import { useEffect, useState } from 'react';

import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { markPaneMenuHintSeen } from '@/lib/pane-menu-hint';
import { useConfigStore } from '@/stores/config.store';
import { useCustomizationStore } from '@/stores/customization.store';
import { useToastStore } from '@/stores/toast.store';

import { DEFAULT_TERMINAL_CONFIG } from '../../../../shared/constants/terminal';

import { ResetToDefaultsButton } from './ResetToDefaultsButton';

export function TerminalTab() {
  const { terminalConfig, updateTerminalConfig } = useCustomizationStore();
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const addToast = useToastStore((s) => s.addToast);
  const showPaneHeaders = terminalConfig?.showPaneHeaders === true;

  const [isResettingTerminal, setIsResettingTerminal] = useState(false);
  const [resetTerminalDialogOpen, setResetTerminalDialogOpen] = useState(false);

  // WSL support (Windows only)
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const isWindows = window.api.platform === 'win32';
  const wslAvailable = wslDistros.length > 0;

  useEffect(() => {
    if (isWindows) {
      window.api
        .getWslDistros()
        .then(setWslDistros)
        .catch(() => {});
    }
  }, [isWindows]);

  const handleResetTerminal = async () => {
    setIsResettingTerminal(true);
    try {
      // Colors, font and cursor are on the Appearance page, and its reset covers them.
      const {
        font: _font,
        cursor: _cursor,
        colors: _colors,
        ...behavior
      } = DEFAULT_TERMINAL_CONFIG;
      await updateTerminalConfig(behavior);
      addToast('Terminal settings reset to defaults', 'success');
    } finally {
      setIsResettingTerminal(false);
      setResetTerminalDialogOpen(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsCard title="Scrollback">
        <SettingsRow
          label="Scrollback lines"
          description="Number of lines kept in terminal history"
        >
          <Select
            value={String(terminalConfig?.scrollback ?? 5000)}
            onChange={(e) => {
              void updateTerminalConfig({ scrollback: Number(e.target.value) });
            }}
            className="w-28"
          >
            <option value="1000">1,000</option>
            <option value="5000">5,000</option>
            <option value="10000">10,000</option>
            <option value="25000">25,000</option>
            <option value="50000">50,000</option>
            <option value="100000">100,000</option>
          </Select>
        </SettingsRow>
      </SettingsCard>

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
          label="Focused pane border"
          description="Show a colored accent on the focused pane header using the project color"
          disabled={!showPaneHeaders}
        >
          <Switch
            disabled={!showPaneHeaders}
            checked={terminalConfig?.focusedPaneBorder === true}
            onCheckedChange={(checked) => {
              void updateTerminalConfig({ focusedPaneBorder: checked });
            }}
          />
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

      <SettingsCard title="Links">
        <SettingsRow
          label="Open links in"
          description="Where a click on a link to a web page opens. Automatic opens localhost pages in Komla and other sites in your default browser, where you're signed in. Sign-in pages open in your default browser either way. Shift+click opens a link the other way."
        >
          <SegmentedControl
            aria-label="Open links in"
            size="md"
            value={config?.webLinkOpenTarget ?? 'auto'}
            onValueChange={(target) => updateConfig({ webLinkOpenTarget: target })}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'komla', label: 'Komla browser' },
              { value: 'external', label: 'Default browser' },
            ]}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Mouse">
        <SettingsRow
          label="Send right-clicks to programs"
          description="Programs that use the mouse, such as Neovim or Claude Code, get the right-click instead of the terminal menu; Shift+right-click opens the menu. In SSH workspaces Komla's tmux uses the mouse, so a right-click at a shell prompt there does nothing."
        >
          <Switch
            checked={terminalConfig?.sendRightClickToPrograms === true}
            onCheckedChange={(checked) => {
              void updateTerminalConfig({ sendRightClickToPrograms: checked });
            }}
          />
        </SettingsRow>
      </SettingsCard>

      {isWindows && (
        <WindowsShellSection
          shellMode={config?.shellMode ?? 'powershell'}
          wslDistro={config?.wslDistro ?? ''}
          wslDistros={wslDistros}
          wslAvailable={wslAvailable}
          useConptyDll={config?.windowsUseConptyDll !== false}
          onShellModeChange={(mode) => void updateConfig({ shellMode: mode })}
          onWslDistroChange={(distro) => void updateConfig({ wslDistro: distro || undefined })}
          onUseConptyDllChange={(checked) => void updateConfig({ windowsUseConptyDll: checked })}
        />
      )}

      <ResetToDefaultsButton
        label="Reset scrollback and panes"
        isResetting={isResettingTerminal}
        onClick={() => setResetTerminalDialogOpen(true)}
      />

      {/* Reset Terminal Confirmation */}
      <Dialog open={resetTerminalDialogOpen} onOpenChange={setResetTerminalDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset terminal settings</DialogTitle>
            <DialogDescription>
              This will reset scrollback and pane settings to their defaults.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResetTerminalDialogOpen(false)}
              disabled={isResettingTerminal}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleResetTerminal}
              disabled={isResettingTerminal}
            >
              {isResettingTerminal ? (
                <>
                  <Spinner className="mr-2" />
                  Resetting...
                </>
              ) : (
                'Reset'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface WindowsShellSectionProps {
  shellMode: 'powershell' | 'wsl';
  wslDistro: string;
  wslDistros: string[];
  wslAvailable: boolean;
  useConptyDll: boolean;
  onShellModeChange: (mode: 'powershell' | 'wsl') => void;
  onWslDistroChange: (distro: string) => void;
  onUseConptyDllChange: (checked: boolean) => void;
}

function WindowsShellSection({
  shellMode,
  wslDistro,
  wslDistros,
  wslAvailable,
  useConptyDll,
  onShellModeChange,
  onWslDistroChange,
  onUseConptyDllChange,
}: WindowsShellSectionProps) {
  const isWsl = shellMode === 'wsl';
  return (
    <SettingsCard title="Shell">
      <SettingsRow
        label="Terminal shell"
        description="Choose which shell to use for terminal sessions. WSL is not well supported yet."
      >
        <Select
          value={shellMode}
          onChange={(e) => onShellModeChange(e.target.value as 'powershell' | 'wsl')}
          className="w-40"
        >
          <option value="powershell">PowerShell</option>
          <option value="wsl" disabled={!wslAvailable}>
            WSL (limited){!wslAvailable ? ', not installed' : ''}
          </option>
        </Select>
      </SettingsRow>

      {isWsl && wslDistros.length > 0 && (
        <SettingsRow label="WSL distribution" description="Select which Linux distribution to use">
          <Select
            value={wslDistro}
            onChange={(e) => onWslDistroChange(e.target.value)}
            className="w-40"
          >
            <option value="">(Default)</option>
            {wslDistros.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </SettingsRow>
      )}

      <SettingsRow
        label="Use Komla's ConPTY"
        description="Runs terminals through the newer ConPTY that comes with Komla instead of the one built into Windows, so long output from programs such as Codex stays in the scrollback and agents such as Claude Code can report what they're doing. Applies to new terminals."
      >
        <Switch checked={useConptyDll} onCheckedChange={onUseConptyDllChange} />
      </SettingsRow>

      {isWsl && (
        <p className="text-xs text-muted-foreground">
          WSL is not well supported yet. Terminals open in the workspace folder (e.g., C:\project
          &rarr; /mnt/c/project), but agents running in WSL don&apos;t report their status or send
          notifications, and the komla command and Windows programs aren&apos;t on the PATH. Changes
          take effect for new terminals.
        </p>
      )}
    </SettingsCard>
  );
}
