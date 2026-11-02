import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

import type {
  PluginInfo,
  PluginSettingInfo,
  PluginSettingValue,
} from '../../../../shared/types/plugins';

/** What the user changed and hasn't saved, by setting: a value, or null to clear it. */
type Draft = Record<string, PluginSettingValue | null>;

/** What the form shows for a setting: the draft, the saved value, or its default. */
function shown(setting: PluginSettingInfo, draft: Draft): PluginSettingValue | null | undefined {
  return Object.hasOwn(draft, setting.id) ? draft[setting.id] : setting.value;
}

/**
 * A plugin's settings, as its komla-plugin.json declares them. A secret is only ever sent from
 * here, never shown: Settings gets whether it's set, and the user types a new one to replace it.
 */
export function PluginSettingsForm({
  plugin,
  onSave,
}: {
  plugin: PluginInfo;
  onSave: (changes: Draft) => Promise<boolean>;
}) {
  // `cleared`: settings the user cleared, which erasing a secret typed in after clears again.
  const [{ draft }, setForm] = useState<{ draft: Draft; cleared: ReadonlySet<string> }>({
    draft: {},
    cleared: new Set(),
  });
  const [saving, setSaving] = useState(false);
  const settings = plugin.settings ?? [];
  const dirty = Object.keys(draft).length > 0;

  // Undefined drops the change, as for a secret whose typed text the user erased.
  const change = (id: string, value: PluginSettingValue | null | undefined) =>
    setForm((current) => {
      const { [id]: _, ...rest } = current.draft;
      const next = value === undefined && current.cleared.has(id) ? null : value;
      return {
        draft: next === undefined ? rest : { ...rest, [id]: next },
        cleared: value === null ? new Set(current.cleared).add(id) : current.cleared,
      };
    });

  const discard = () => setForm({ draft: {}, cleared: new Set() });

  const save = async () => {
    if (saving) return;
    const sent = draft;
    setSaving(true);
    try {
      if (!(await onSave(sent))) return;
      // What the user changed while it saved stays to save.
      setForm((current) => {
        const kept = Object.fromEntries(
          Object.entries(current.draft).filter(
            ([id, value]) => !Object.hasOwn(sent, id) || sent[id] !== value
          )
        );
        return {
          draft: kept,
          cleared: new Set(
            [...current.cleared].filter((id) => Object.hasOwn(kept, id) || !Object.hasOwn(sent, id))
          ),
        };
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-2 rounded-md border border-foreground/10 p-3"
      aria-label={`${plugin.name} settings`}
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) void save();
      }}
    >
      <p className="text-xs font-medium text-foreground/80">Settings</p>
      {settings.map((setting) => (
        <SettingField
          key={setting.id}
          setting={setting}
          value={shown(setting, draft)}
          cleared={draft[setting.id] === null}
          onChange={(value) => change(setting.id, value)}
        />
      ))}
      {plugin.secretStorage === 'file' && (
        <p className="text-[11px] text-muted-foreground">
          This computer has no keychain Komla can use, so secrets are kept unencrypted in a file
          only you can read.
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        {dirty && (
          <Button type="button" variant="ghost" size="sm" onClick={discard}>
            Discard
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!dirty || saving}>
          Save
        </Button>
      </div>
    </form>
  );
}

function SettingField({
  setting,
  value,
  cleared,
  onChange,
}: {
  setting: PluginSettingInfo;
  value: PluginSettingValue | null | undefined;
  cleared: boolean;
  onChange: (value: PluginSettingValue | null | undefined) => void;
}) {
  const id = `plugin-setting-${setting.id}`;
  const label = (
    <label htmlFor={id} className="block text-xs text-foreground/80">
      {setting.title}
    </label>
  );
  const description = setting.description && (
    <p className="text-[11px] text-muted-foreground">{setting.description}</p>
  );

  if (setting.type === 'boolean') {
    const checked = typeof value === 'boolean' ? value : setting.default === true;
    return (
      <div className="flex items-start gap-2">
        <Switch
          id={id}
          className="mt-0.5 scale-75"
          checked={checked}
          onCheckedChange={(next) => onChange(next)}
        />
        <div className="min-w-0">
          {label}
          {description}
        </div>
      </div>
    );
  }

  let control;
  if (setting.type === 'choice') {
    control = (
      <Select
        id={id}
        className="h-7 w-full text-xs"
        value={String(value ?? setting.default ?? '')}
        onChange={(event) => onChange(event.target.value || null)}
      >
        {setting.default === undefined && <option value="">Not set</option>}
        {setting.options?.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  } else if (setting.type === 'secret') {
    const typed = typeof value === 'string' ? value : '';
    control = (
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          className="h-7 flex-1 text-xs"
          value={typed}
          placeholder={
            cleared
              ? 'Cleared once you save'
              : setting.isSet
                ? 'Set. Type a new one to replace it'
                : (setting.placeholder ?? 'Not set')
          }
          // Erasing the text keeps the secret as it was; Clear removes it.
          onChange={(event) => onChange(event.target.value || undefined)}
        />
        {setting.isSet && !cleared && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            Clear
          </Button>
        )}
      </div>
    );
  } else {
    const isNumber = setting.type === 'number';
    control = (
      <Input
        id={id}
        type={isNumber ? 'number' : 'text'}
        className="h-7 w-full text-xs"
        value={value === null || value === undefined ? '' : String(value)}
        placeholder={
          setting.placeholder ?? (setting.default !== undefined ? String(setting.default) : '')
        }
        onChange={(event) => {
          const text = event.target.value;
          if (text === '') onChange(null);
          else if (!isNumber) onChange(text);
          else if (Number.isFinite(Number(text))) onChange(Number(text));
        }}
      />
    );
  }

  return (
    <div className="space-y-1">
      {label}
      {control}
      {description}
    </div>
  );
}
