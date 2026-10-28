import { useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useConfigStore } from '@/stores/config.store';
import { useToastStore } from '@/stores/toast.store';

import { MAX_UTILITY_PROMPT_CHARS } from '../../../../shared/constants/utility-prompts';

interface UtilityPromptEditorProps {
  label: string;
  description: string;
  configKey: 'workspaceNamingPrompt' | 'commitMessagePrompt';
  defaultPrompt: string;
}

/**
 * A custom endpoint's system prompt, showing Komla's default until the user edits it.
 * Saved on blur. Only an edited prompt is saved, so an untouched one follows Komla's updates.
 */
export function UtilityPromptEditor({
  label,
  description,
  configKey,
  defaultPrompt,
}: UtilityPromptEditorProps) {
  const saved = useConfigStore((s) => s.config?.[configKey] ?? '');
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const addToast = useToastStore((s) => s.addToast);
  const shown = saved || defaultPrompt;
  const [draft, setDraft] = useState(shown);
  const id = useId();

  useEffect(() => {
    setDraft(shown);
  }, [shown]);

  const save = async (text: string) => {
    const trimmed = text.trim();
    const next = trimmed === defaultPrompt.trim() ? '' : trimmed;
    if (next === saved) {
      setDraft(shown);
      return;
    }
    const { ok } = await updateConfig({ [configKey]: next });
    if (!ok) {
      setDraft(shown);
      addToast(`Failed to save the ${label.toLowerCase()}`, 'error');
    }
  };

  const isDefault = !saved && draft.trim() === defaultPrompt.trim();

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label id={`${id}-label`} htmlFor={id} className="text-sm leading-tight font-medium">
            {label}
          </label>
          <p
            id={`${id}-description`}
            className="mt-0.5 text-[13px] leading-normal text-muted-foreground"
          >
            {description}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={isDefault}
          onClick={() => {
            setDraft(defaultPrompt);
            void save(defaultPrompt);
          }}
        >
          Reset to default
        </Button>
      </div>
      <Textarea
        id={id}
        aria-describedby={`${id}-description`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save(draft)}
        maxLength={MAX_UTILITY_PROMPT_CHARS}
        spellCheck={false}
        rows={10}
        className="font-mono text-xs leading-5"
      />
    </div>
  );
}
