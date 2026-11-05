import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface SettingsSaveBarProps {
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  saveLabel?: string;
  savingLabel?: string;
}

export function SettingsSaveBar({
  isDirty,
  isSaving,
  onSave,
  onDiscard,
  saveLabel = 'Save changes',
  savingLabel = 'Saving...',
}: SettingsSaveBarProps) {
  if (!isDirty && !isSaving) return null;

  return (
    <div className="sticky bottom-0 z-10 -mb-6 flex items-center justify-end gap-2 border-t border-border/50 bg-[oklch(var(--chrome)/0.95)] py-3 backdrop-blur-sm supports-[backdrop-filter]:bg-[oklch(var(--chrome)/0.8)] reduce-effects:bg-[oklch(var(--chrome))]">
      {onDiscard && (
        <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={isSaving}>
          Discard
        </Button>
      )}
      <Button type="button" onClick={onSave} disabled={isSaving} size="sm">
        {isSaving ? (
          <>
            <Spinner className="mr-2" />
            {savingLabel}
          </>
        ) : (
          saveLabel
        )}
      </Button>
    </div>
  );
}
