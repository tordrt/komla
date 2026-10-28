import { CaretDown, FolderOpen, SpeakerHigh } from '@phosphor-icons/react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import {
  CUSTOM_PREFIX,
  DEFAULT_NOTIFICATION_SOUNDS,
  SOUND_PRESETS,
  cacheCustomSound,
  previewNotificationSound,
} from '@/lib/notification-sounds';

import type { AppConfig } from '@/types';

// Group built-in presets for optgroup display. Stable module-level value —
// SOUND_PRESETS never changes at runtime, so we compute this once.
const PRESET_GROUPS: Record<string, typeof SOUND_PRESETS> = SOUND_PRESETS.reduce(
  (acc, p) => {
    (acc[p.group] ??= []).push(p);
    return acc;
  },
  {} as Record<string, typeof SOUND_PRESETS>
);

interface NotificationSoundsBlockProps {
  config: AppConfig | null;
  onUpdate: (sounds: NonNullable<AppConfig['notificationSounds']>) => void;
}

export function NotificationSoundsBlock({ config, onUpdate }: NotificationSoundsBlockProps) {
  const sounds = config?.notificationSounds ?? DEFAULT_NOTIFICATION_SOUNDS;
  const [customFiles, setCustomFiles] = useState<string[]>([]);

  const update = (patch: Partial<typeof sounds>) => {
    onUpdate({ ...sounds, ...patch });
  };

  const loadCustomSounds = useCallback(() => {
    void window.api.listCustomSounds().then((files) => {
      setCustomFiles(files);
      // Pre-cache all custom sounds so preview/playback works instantly
      for (const f of files) void cacheCustomSound(f);
    });
  }, []);

  // Load custom sounds when section opens
  useEffect(() => {
    if (sounds.enabled) loadCustomSounds();
  }, [sounds.enabled, loadCustomSounds]);

  const handleOpenSoundsFolder = () => {
    void window.api.openSoundsDirectory().then(() => {
      // Re-scan after a short delay to pick up newly added files
      setTimeout(loadCustomSounds, 1000);
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Notification sounds</div>
          <p className="mt-0.5 text-[13px] leading-normal text-muted-foreground">
            Play a sound when agents finish or need input.
          </p>
        </div>
        <Switch
          aria-label="Notification sounds"
          checked={sounds.enabled}
          onCheckedChange={(checked) => update({ enabled: checked })}
        />
      </div>

      {sounds.enabled && (
        <div className="space-y-2.5 border-t border-border/40 pt-2">
          {/* Volume slider */}
          <div className="flex items-center gap-2">
            <SpeakerHigh className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              aria-label="Notification volume"
              value={sounds.volume}
              onChange={(e) => update({ volume: parseFloat(e.target.value) })}
              className="h-1 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
            />
            <span className="w-8 text-right text-ui text-muted-foreground tabular-nums">
              {Math.round(sounds.volume * 100)}%
            </span>
          </div>

          {/* Per-event sound rows */}
          <div className="space-y-1.5">
            <SoundRow
              label="Done"
              description="Agent finished processing"
              checked={sounds.turnComplete}
              soundId={sounds.turnCompleteSound}
              volume={sounds.volume}
              customFiles={customFiles}
              onToggle={(checked) => update({ turnComplete: checked })}
              onSoundChange={(id) => update({ turnCompleteSound: id })}
            />
            <SoundRow
              label="Input required"
              description="Agent needs your attention"
              checked={sounds.inputRequired}
              soundId={sounds.inputRequiredSound}
              volume={sounds.volume}
              customFiles={customFiles}
              onToggle={(checked) => update({ inputRequired: checked })}
              onSoundChange={(id) => update({ inputRequiredSound: id })}
            />
          </div>

          {/* Custom sounds folder */}
          <button
            type="button"
            onClick={handleOpenSoundsFolder}
            className="flex items-center gap-1.5 text-ui text-muted-foreground transition-colors hover:text-foreground"
          >
            <FolderOpen className="size-3" />
            {customFiles.length > 0
              ? `${customFiles.length} custom sound${customFiles.length === 1 ? '' : 's'} — open folder`
              : 'Add custom sounds — open folder'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Strip file extension for display name. */
function displayName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

function SoundRow({
  label,
  description,
  checked,
  soundId,
  volume,
  customFiles,
  onToggle,
  onSoundChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  soundId: string;
  volume: number;
  customFiles: string[];
  onToggle: (checked: boolean) => void;
  onSoundChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium">{label}</span>
          <button
            type="button"
            className="text-ui text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground"
            aria-label={`Preview ${label} sound`}
            onClick={() => previewNotificationSound(soundId, volume)}
          >
            preview
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <SoundSelector
        label={label}
        value={soundId}
        volume={volume}
        customFiles={customFiles}
        disabled={!checked}
        onChange={onSoundChange}
      />
      <Switch aria-label={`${label} sound`} checked={checked} onCheckedChange={onToggle} />
    </div>
  );
}

function SoundSelector({
  label,
  value,
  volume,
  customFiles,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  volume: number;
  customFiles: string[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  // Match the playback fallback (`presets[id] ?? presets.gentle`) so the
  // dropdown's checked state and trigger label stay in sync with what plays.
  const isKnown = useMemo(() => {
    if (value.startsWith(CUSTOM_PREFIX)) {
      return customFiles.includes(value.slice(CUSTOM_PREFIX.length));
    }
    return SOUND_PRESETS.some((p) => p.id === value);
  }, [value, customFiles]);
  const effectiveValue = isKnown ? value : 'gentle';

  const currentLabel = useMemo(() => {
    if (effectiveValue.startsWith(CUSTOM_PREFIX)) {
      return displayName(effectiveValue.slice(CUSTOM_PREFIX.length));
    }
    const found = SOUND_PRESETS.find((p) => p.id === effectiveValue);
    return found?.label ?? 'Gentle';
  }, [effectiveValue]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`${label} notification sound`}
        className="flex h-7 w-[7.5rem] items-center justify-between rounded-md border border-input bg-card px-2.5 text-xs ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="truncate">{currentLabel}</span>
        <CaretDown className="ml-1 size-3 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        collisionPadding={8}
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[10rem] overflow-y-auto"
      >
        <DropdownMenuRadioGroup value={effectiveValue} onValueChange={onChange}>
          {Object.entries(PRESET_GROUPS).map(([group, items], groupIdx) => (
            <Fragment key={group}>
              {groupIdx > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{group}</DropdownMenuLabel>
              {items.map((p) => (
                <SoundOption key={p.id} id={p.id} label={p.label} volume={volume} />
              ))}
            </Fragment>
          ))}
          {customFiles.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Custom</DropdownMenuLabel>
              {customFiles.map((f) => {
                const id = `${CUSTOM_PREFIX}${f}`;
                return <SoundOption key={f} id={id} label={displayName(f)} volume={volume} />;
              })}
            </>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SoundOption({ id, label, volume }: { id: string; label: string; volume: number }) {
  return (
    <DropdownMenuRadioItem
      value={id}
      onFocus={() => previewNotificationSound(id, volume)}
      className="cursor-pointer pr-2 text-xs"
    >
      <span className="flex-1 truncate">{label}</span>
    </DropdownMenuRadioItem>
  );
}
