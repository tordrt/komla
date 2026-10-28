import { useState, type InputHTMLAttributes } from 'react';

import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import { TerminalBackgroundColorRow } from '@/components/layout/settings/TerminalBackgroundColorRow';
import { FontFamilyPicker } from '@/components/ui/font-family-picker';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useCustomizationStore } from '@/stores/customization.store';

import { buildTerminalFontFamily } from '../../../../shared/constants/terminal';

import type { TerminalConfig } from '@/types';

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;

const CURSOR_STYLE_OPTIONS = [
  { value: 'block', label: 'Block' },
  { value: 'bar', label: 'Bar' },
  { value: 'underline', label: 'Underline' },
] as const satisfies readonly { value: TerminalConfig['cursor']['style']; label: string }[];

interface TerminalAppearanceCardProps {
  activePaletteId: string;
}

/** How every terminal looks: its colors, font and cursor. */
export function TerminalAppearanceCard({ activePaletteId }: TerminalAppearanceCardProps) {
  const { terminalConfig, updateTerminalConfig } = useCustomizationStore();

  return (
    <SettingsCard title="Terminal">
      <TerminalBackgroundColorRow activePaletteId={activePaletteId} />

      <SettingsRow
        label="Font family"
        description="Use a Nerd Font for icon support (e.g. FiraCode Nerd Font Mono)"
      >
        <div className="flex flex-col items-end gap-1.5">
          <FontFamilyPicker
            value={terminalConfig?.font.family ?? ''}
            onChange={(family) => {
              void updateTerminalConfig({
                font: { ...terminalConfig!.font, family },
              });
            }}
          />
          <div
            className="rounded border border-border/50 bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
            style={{
              fontFamily: buildTerminalFontFamily(terminalConfig?.font.family ?? ''),
            }}
          >
            {'ABCabc123     '}
          </div>
        </div>
      </SettingsRow>

      <SettingsRow
        label="Font size"
        description="Terminal text size in pixels. The file editor follows it, a pixel smaller"
      >
        {({ controlId, descriptionId }) => (
          <FontSizeField
            id={controlId}
            aria-describedby={descriptionId}
            size={terminalConfig?.font.size ?? 14}
            onSizeChange={(size) =>
              void updateTerminalConfig({ font: { ...terminalConfig!.font, size } })
            }
          />
        )}
      </SettingsRow>

      <SettingsRow label="Line height" description="Spacing between terminal lines">
        <Select
          value={String(terminalConfig?.font.lineHeight ?? 1.2)}
          onChange={(e) => {
            void updateTerminalConfig({
              font: {
                ...terminalConfig!.font,
                lineHeight: Number(e.target.value),
              },
            });
          }}
          className="w-40"
        >
          <option value="1">Tight (1.0)</option>
          <option value="1.1">Snug (1.1)</option>
          <option value="1.2">Normal (1.2)</option>
          <option value="1.3">Relaxed (1.3)</option>
          <option value="1.5">Loose (1.5)</option>
        </Select>
      </SettingsRow>

      <SettingsRow label="Cursor style">
        {({ labelId }) => (
          <SegmentedControl
            aria-labelledby={labelId}
            size="md"
            value={terminalConfig?.cursor.style ?? 'block'}
            options={CURSOR_STYLE_OPTIONS}
            onValueChange={(style) => {
              if (style === terminalConfig?.cursor.style) return;
              void updateTerminalConfig({ cursor: { ...terminalConfig!.cursor, style } });
            }}
          />
        )}
      </SettingsRow>

      <SettingsRow label="Cursor blink">
        <Switch
          checked={terminalConfig?.cursor.blink ?? false}
          onCheckedChange={(checked) => {
            void updateTerminalConfig({
              cursor: { ...terminalConfig!.cursor, blink: checked },
            });
          }}
        />
      </SettingsRow>
    </SettingsCard>
  );
}

interface FontSizeFieldProps extends Pick<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'aria-describedby'
> {
  size: number;
  onSizeChange: (size: number) => void;
}

/**
 * Number field that accepts any typing (so "16" can be typed over "14") and
 * applies in-range sizes as you type. Out-of-range or empty input is clamped or
 * reverted when the field loses focus or you press Enter.
 */
function FontSizeField({ size, onSizeChange, ...inputProps }: FontSizeFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [shownSize, setShownSize] = useState(size);
  // A saved size from elsewhere (a reset, or this field's own commit) replaces the draft.
  if (size !== shownSize) {
    setShownSize(size);
    setDraft(null);
  }

  const isInRange = (value: number) =>
    Number.isInteger(value) && value >= FONT_SIZE_MIN && value <= FONT_SIZE_MAX;

  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(null);
      return;
    }
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(parsed)));
    setDraft(next === size ? null : String(next));
    if (next !== size) onSizeChange(next);
  };

  return (
    <Input
      {...inputProps}
      type="number"
      min={FONT_SIZE_MIN}
      max={FONT_SIZE_MAX}
      step={1}
      value={draft ?? size}
      onChange={(e) => {
        setDraft(e.target.value);
        const value = Number(e.target.value);
        if (e.target.value.trim() !== '' && isInRange(value) && value !== size) {
          onSizeChange(value);
        }
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      className="w-20 text-center"
    />
  );
}
