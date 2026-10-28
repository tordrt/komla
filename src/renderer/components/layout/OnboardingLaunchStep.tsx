import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface OnboardingLaunchStepProps {
  isCreating: boolean;
  error: string | null;
  onBack: () => void;
  onFinish: () => void;
  /** Holds Start working back, say until a question on the step is answered. */
  finishDisabled?: boolean;
}

export function OnboardingLaunchStep({
  isCreating,
  error,
  onBack,
  onFinish,
  finishDisabled = false,
}: OnboardingLaunchStepProps) {
  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-error">{error}</p>}
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack} disabled={isCreating}>
          Back
        </Button>
        <Button onClick={onFinish} disabled={isCreating || finishDisabled} className="min-w-36">
          {isCreating && <Spinner size="xs" className="mr-1" />}
          Start working
        </Button>
      </div>
    </div>
  );
}
