import { ArrowCounterClockwise } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface ResetToDefaultsButtonProps {
  /** Names what the reset covers, which can be less than the whole page. */
  label: string;
  isResetting: boolean;
  onClick: () => void;
}

/** Sits at the foot of a Settings page and resets its settings, after a confirmation. */
export function ResetToDefaultsButton({ label, isResetting, onClick }: ResetToDefaultsButtonProps) {
  return (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-destructive"
        onClick={onClick}
        disabled={isResetting}
      >
        {isResetting ? (
          <Spinner size="sm" className="mr-1.5" />
        ) : (
          <ArrowCounterClockwise className="mr-1.5 size-3.5" />
        )}
        {label}
      </Button>
    </div>
  );
}
