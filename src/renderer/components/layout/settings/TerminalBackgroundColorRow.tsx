import { useEffect, useState } from 'react';

import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import { Input } from '@/components/ui/input';
import {
  isValidTerminalBackgroundColor,
  paletteOverridesTerminalBackground,
} from '@/lib/terminal-background-settings';
import { useCustomizationStore } from '@/stores/customization.store';

interface TerminalBackgroundColorRowProps {
  activePaletteId: string;
}

function backgroundDescription(shown: boolean, darkTheme: boolean, followSystem: boolean): string {
  if (shown) return 'Terminal canvas color. Applies to open terminals immediately.';
  if (darkTheme) {
    return 'Terminal canvas color for Komla Dark, which shows while your system is dark.';
  }
  if (followSystem) {
    return 'Your themes set the terminal background. Choose Komla Dark as your dark theme to pick your own.';
  }
  return 'The theme above sets the terminal background. Choose Komla Dark to pick your own.';
}

export function TerminalBackgroundColorRow({ activePaletteId }: TerminalBackgroundColorRowProps) {
  const { theme, terminalConfig, updateTerminalConfig } = useCustomizationStore();
  const [terminalBackgroundInput, setTerminalBackgroundInput] = useState('#13171b');
  const shownThemeUsesColor = !paletteOverridesTerminalBackground(activePaletteId);
  // Following the system, Komla Dark as the dark theme uses the color while the system is dark.
  const followSystem = theme?.followSystem === true;
  const darkThemeUsesColor =
    followSystem && theme !== null && !paletteOverridesTerminalBackground(theme.palette);
  const isPaletteControlled = !shownThemeUsesColor && !darkThemeUsesColor;

  useEffect(() => {
    setTerminalBackgroundInput(terminalConfig?.colors.background ?? '#13171b');
  }, [terminalConfig?.colors.background]);

  const updateTerminalBackground = (background: string) => {
    if (!terminalConfig || !isValidTerminalBackgroundColor(background)) return;
    void updateTerminalConfig({
      colors: {
        ...terminalConfig.colors,
        background,
      },
    });
  };

  return (
    <SettingsRow
      label="Background color"
      description={backgroundDescription(shownThemeUsesColor, darkThemeUsesColor, followSystem)}
      disabled={isPaletteControlled}
    >
      {({ controlId, descriptionId }) => (
        <div className="flex items-center gap-2">
          <Input
            type="color"
            aria-label="Pick background color"
            disabled={isPaletteControlled}
            value={
              isValidTerminalBackgroundColor(terminalConfig?.colors.background ?? '')
                ? terminalConfig!.colors.background
                : '#13171b'
            }
            onChange={(e) => {
              const color = e.target.value;
              setTerminalBackgroundInput(color);
              updateTerminalBackground(color);
            }}
            className="h-9 w-12 cursor-pointer p-1"
          />
          <Input
            id={controlId}
            aria-describedby={descriptionId}
            disabled={isPaletteControlled}
            value={terminalBackgroundInput}
            onChange={(e) => {
              const color = e.target.value;
              setTerminalBackgroundInput(color);
              updateTerminalBackground(color);
            }}
            className="w-28 font-mono text-xs"
            spellCheck={false}
          />
        </div>
      )}
    </SettingsRow>
  );
}
