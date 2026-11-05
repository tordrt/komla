import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface OnboardingLaunchStepProps {
  isCreating: boolean;
  error: string | null;
  onBack: () => void;
  onFinish: () => void;
  /** Holds Start working back, say until a question on the step is answered. */
  finishDisabled?: boolean;
  className?: string;
}

export function OnboardingLaunchStep({
  isCreating,
  error,
  onBack,
  onFinish,
  finishDisabled = false,
  className,
}: OnboardingLaunchStepProps) {
  return (
    <div className={cn('flex-wrap', className)}>
      {error && <p className="w-full text-sm text-error">{error}</p>}
      <Button variant="ghost" onClick={onBack} disabled={isCreating}>
        Back
      </Button>
      <span className="ml-auto text-xs text-muted-foreground">
        {finishDisabled && !isCreating && 'Choose an option to continue'}
      </span>
      <Button onClick={onFinish} disabled={isCreating || finishDisabled} className="min-w-36">
        {isCreating && <Spinner size="xs" className="mr-1" />}
        Start working
      </Button>
    </div>
  );
}
