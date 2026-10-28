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
    <div className="sticky bottom-0 z-10 -mx-8 -mb-6 flex items-center justify-end gap-2 border-t border-border/50 bg-background/95 px-8 py-3 backdrop-blur-sm supports-[backdrop-filter]:bg-background/80 reduce-effects:bg-background">
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
