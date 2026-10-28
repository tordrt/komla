import { useEffect, useMemo, useState } from 'react';

import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { ACCENT_COLORS, ColorPicker, isOklchMatch } from '@/components/ui/color-picker';
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
import { ACTIVITY_SPINNERS } from '@/components/workspaces/activity-spinners';
import { agentStatusReportsWork } from '@/lib/agent-status-reports';
import {
  CUSTOM_PALETTE_ID,
  DEFAULT_PALETTE_ID,
  PALETTES,
  type Palette,
} from '@/lib/palette-presets';
import {
  applyPalette,
  getActivePalette,
  getActivePaletteId,
  paletteTerminalTheme,
  subscribePalette,
  systemIsDark,
} from '@/lib/palette-runtime';
import { accentPrimary } from '@/lib/primary-color';
import { buildCustomPalette } from '@/lib/theme-palette';
import { useConfigStore } from '@/stores/config.store';
import { useCustomizationStore } from '@/stores/customization.store';
import { useToastStore } from '@/stores/toast.store';

import { DEFAULT_TERMINAL_CONFIG } from '../../../../shared/constants/terminal';
import { ZOOM_LEVELS, zoomPercent } from '../../../../shared/constants/zoom';
import { DEFAULT_ACTIVITY_SPINNER } from '../../../../shared/lib/activity-spinner';
import {
  DEFAULT_ACCENT,
  shownTheme,
  themeAccent,
  themeChoice,
  themeMode,
  themeSlot,
} from '../../../../shared/lib/appearance';

import { ResetToDefaultsButton } from './ResetToDefaultsButton';
import { StatusBarSettingsCard } from './StatusBarSettingsCard';
import { TerminalAppearanceCard } from './TerminalAppearanceCard';
import { ThemeAgentCallout } from './ThemeAgentCallout';
import { ThemeTile } from './ThemeTile';

import type { AppConfig, ThemeConfig } from '@/types';

const THEME_GROUPS: Array<{ mode: Palette['mode']; label: string }> = [
  { mode: 'dark', label: 'Dark' },
  { mode: 'light', label: 'Light' },
];

// theme.json can name a theme Komla doesn't have. Komla then shows Komla Dark, or Komla Light in
// place of a light theme.
function findUnknownTheme(theme: ThemeConfig) {
  if (
    theme.palette !== CUSTOM_PALETTE_ID &&
    !PALETTES.some((palette) => palette.id === theme.palette)
  ) {
    return { key: 'palette', id: theme.palette, kind: 'themes', shown: 'Komla Dark' };
  }
  if (theme.followSystem && themeMode(theme.lightPalette, theme.customPalette) !== 'light') {
    return {
      key: 'lightPalette',
      id: theme.lightPalette,
      kind: 'light themes',
      shown: 'Komla Light',
    };
  }
  return undefined;
}

function ReduceEffectsRow() {
  const reduceEffects = useConfigStore((s) => s.config?.reduceEffects === true);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  return (
    <SettingsRow
      label="Reduce effects"
      description="For slower computers: spinners hold still, nothing blurs what is behind it, and fewer hidden terminals stay ready to draw on the GPU"
    >
      <Switch
        checked={reduceEffects}
        onCheckedChange={(checked) => void updateConfig({ reduceEffects: checked })}
      />
    </SettingsRow>
  );
}

// The spinner is switched on in Integrations, and needs the hooks endpoint where agents' own
// status reports don't reach Komla.
function isSpinnerShown(config: AppConfig | null): boolean {
  if (config?.showAgentSpinner === false) return false;
  return config?.disableNotificationEndpoint !== true || agentStatusReportsWork();
}

export function AppearanceTab() {
  const [activeId, setActiveId] = useState(getActivePaletteId);
  const theme = useCustomizationStore((s) => s.theme);
  const terminalConfig = useCustomizationStore((s) => s.terminalConfig);
  const updateTheme = useCustomizationStore((s) => s.updateTheme);
  const resetTheme = useCustomizationStore((s) => s.resetTheme);
  const updateTerminalConfig = useCustomizationStore((s) => s.updateTerminalConfig);
  const { config, updateConfig } = useConfigStore();
  const addToast = useToastStore((s) => s.addToast);
  const spinnerShown = isSpinnerShown(config);

  const [isResetting, setIsResetting] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  useEffect(() => {
    return subscribePalette(setActiveId);
  }, []);

  const customPalette = theme?.customPalette;
  const custom = useMemo(
    () => (customPalette === undefined ? null : buildCustomPalette(customPalette)),
    [customPalette]
  );
  // After an edit with problems, the last custom theme that worked stays applied.
  const customCard =
    custom?.palette ?? (activeId === CUSTOM_PALETTE_ID ? getActivePalette() : null);
  const groups = useMemo(
    () =>
      THEME_GROUPS.map(({ mode, label }) => ({
        label,
        palettes: [customCard, ...PALETTES].filter(
          (palette): palette is Palette => palette?.mode === mode
        ),
      })),
    [customCard]
  );
  // The previews' terminals change only with the Terminal settings or the custom theme.
  const tileTerminals = useMemo(
    () =>
      new Map(
        groups
          .flatMap((group) => group.palettes)
          .map((palette) => [palette.id, paletteTerminalTheme(palette, terminalConfig)])
      ),
    [groups, terminalConfig]
  );
  const followSystem = theme?.followSystem === true;
  // Following the system, the light theme and its accent show while the system is light.
  const showsLight = followSystem && !systemIsDark();
  const unknownPalette = theme ? findUnknownTheme(theme) : undefined;

  // Following the system, each group has its own choice; otherwise the one showing is the choice.
  const isChosen = (palette: Palette) =>
    followSystem
      ? palette.id === (palette.mode === 'light' ? theme?.lightPalette : theme?.palette)
      : palette.id === activeId;

  // A chosen theme shows its accent; the others show the accent choosing them brings.
  const tileAccent = (palette: Palette) => {
    const accent =
      (isChosen(palette) && theme
        ? themeSlot(theme, palette.mode).accent
        : themeAccent(palette.id, customPalette)) ?? DEFAULT_ACCENT;
    return `oklch(${accentPrimary(accent, palette.mode)})`;
  };

  const selectPalette = (palette: Palette) => {
    // Choosing the active theme again would discard an accent picked since.
    if (!theme || isChosen(palette)) return;
    // A custom theme saved without an accent keeps the accent of the theme it replaces.
    const accent = themeAccent(palette.id, customPalette) ?? themeSlot(theme, palette.mode).accent;
    const choice = themeChoice(theme, palette.id, palette.mode, accent);
    const shown = shownTheme({ ...theme, ...choice }, systemIsDark()).palette;
    if (shown !== activeId) applyPalette(shown);
    void updateTheme(choice);
  };

  const changeFollowSystem = (follow: boolean) => {
    if (!theme) return;
    if (!follow) {
      // The theme showing stays, with its accent.
      const shown = shownTheme(theme, systemIsDark());
      void updateTheme({ followSystem: false, palette: shown.palette, colors: shown.colors });
      return;
    }
    // A light theme chosen before becomes the light theme, with its accent, beside Komla Dark.
    const lightChosen = themeMode(theme.palette, customPalette) === 'light';
    void updateTheme(
      lightChosen
        ? {
            followSystem: true,
            palette: DEFAULT_PALETTE_ID,
            lightPalette: theme.palette,
            colors: { ...theme.colors, accent: DEFAULT_ACCENT, lightAccent: theme.colors.accent },
          }
        : { followSystem: true }
    );
  };

  const handleReset = async () => {
    setIsResetting(true);
    try {
      // Scrollback and pane settings have their own reset on the Terminal page.
      const { font, cursor, colors } = DEFAULT_TERMINAL_CONFIG;
      await resetTheme();
      await updateConfig({ zoomLevel: 0 });
      await updateTerminalConfig({ font, cursor, colors });
      applyPalette('default');
      addToast('Appearance reset to defaults', 'success');
    } finally {
      setIsResetting(false);
      setResetDialogOpen(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Theme"
        description="Colors for the interface, terminals and editor. Terminals stay dark in light themes, and choosing a theme also sets its accent color."
      >
        {unknownPalette && (
          <div>
            <Callout tone="warning" title="Unknown theme">
              theme.json sets {unknownPalette.key} to {JSON.stringify(unknownPalette.id)}, which
              isn't one of Komla's {unknownPalette.kind}, so Komla is using {unknownPalette.shown}.
            </Callout>
          </div>
        )}
        {custom && custom.problems.length > 0 && (
          <div>
            <Callout tone="warning" title="Custom theme not applied">
              <p>Komla skipped the latest changes to customPalette in theme.json:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {custom.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Callout>
          </div>
        )}
        <SettingsRow
          label="Match system appearance"
          description="Show your dark theme while your system is dark and your light theme while it's light."
        >
          <Switch checked={followSystem} onCheckedChange={changeFollowSystem} />
        </SettingsRow>
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="space-y-1.5">
              <h4 className="px-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.label}
              </h4>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1">
                {group.palettes.map((palette) => (
                  <ThemeTile
                    key={palette.id}
                    palette={palette}
                    accent={tileAccent(palette)}
                    terminal={tileTerminals.get(palette.id)!}
                    isActive={isChosen(palette)}
                    onSelect={() => selectPalette(palette)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div>
          <ThemeAgentCallout />
        </div>
      </SettingsCard>

      <SettingsCard title="Interface">
        {theme && (
          <SettingsRow
            label="Accent color"
            description="Buttons, selections and focus rings. Each theme brings its own."
          >
            <ColorPicker
              value={showsLight ? theme.colors.lightAccent : theme.colors.accent}
              onChange={(accent: string) =>
                updateTheme({
                  colors: { ...theme.colors, [showsLight ? 'lightAccent' : 'accent']: accent },
                })
              }
              colors={ACCENT_COLORS}
              isSelected={isOklchMatch}
            />
          </SettingsRow>
        )}

        <SettingsRow label="Zoom level" description="Controls the overall UI size">
          <Select
            value={String(config?.zoomLevel ?? 0)}
            onChange={(e) => void updateConfig({ zoomLevel: Number(e.target.value) })}
            className="w-40"
          >
            {ZOOM_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level === 0 ? 'Default (100%)' : `${zoomPercent(level)}%`}
              </option>
            ))}
          </Select>
        </SettingsRow>

        <SettingsRow
          label="Hide branch names on workspace cards"
          description="Show branch names in the card tooltip instead of directly in the left workspace list"
        >
          <Switch
            checked={config?.hideBranchNameInWorkspaceCards === true}
            onCheckedChange={(checked) =>
              void updateConfig({ hideBranchNameInWorkspaceCards: checked })
            }
          />
        </SettingsRow>

        <SettingsRow
          label="Compact workspace list"
          description="Fit more workspaces in the left workspace list with tighter cards"
        >
          <Switch
            checked={config?.compactWorkspaceList === true}
            onCheckedChange={(checked) => void updateConfig({ compactWorkspaceList: checked })}
          />
        </SettingsRow>

        <SettingsRow
          label="Activity spinner style"
          description={
            spinnerShown
              ? 'How a working agent shows on workspace cards, in the Overview and in the Command Center'
              : 'Turn on the activity spinner in Integrations > Notifications to choose how it looks'
          }
        >
          <SegmentedControl
            aria-label="Activity spinner style"
            iconOnly
            size="md"
            disabled={!spinnerShown}
            value={config?.activitySpinner ?? DEFAULT_ACTIVITY_SPINNER}
            onValueChange={(style) => void updateConfig({ activitySpinner: style })}
            options={ACTIVITY_SPINNERS.map(({ style, name, glyph: Glyph }) => ({
              value: style,
              label: name,
              icon: <Glyph className="size-3.5" />,
            }))}
          />
        </SettingsRow>

        <ReduceEffectsRow />
      </SettingsCard>

      <TerminalAppearanceCard activePaletteId={activeId} />

      <StatusBarSettingsCard />

      <ResetToDefaultsButton
        label="Reset theme, fonts and zoom"
        isResetting={isResetting}
        onClick={() => setResetDialogOpen(true)}
      />

      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset appearance</DialogTitle>
            <DialogDescription>
              This will reset the theme palette, accent color, zoom level, and terminal colors,
              font, and cursor to their defaults.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResetDialogOpen(false)}
              disabled={isResetting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReset} disabled={isResetting}>
              {isResetting ? (
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
