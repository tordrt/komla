import { ChartBar, EyeSlash } from '@phosphor-icons/react';

import { Checkbox } from '@/components/ui/checkbox';

import { OnboardingStepHeader } from './OnboardingChrome';
import { ChoiceCard } from './OnboardingMachineStep';

interface OnboardingAnalyticsStepProps {
  /** The user's answer; null until they pick one, as neither is picked for them. */
  share: boolean | null;
  onShareChange: (share: boolean) => void;
  crashReports: boolean;
  onCrashReportsChange: (enabled: boolean) => void;
}

/** Asks once whether to share usage analytics. The answer is saved when setup finishes. */
export function OnboardingAnalyticsStep({
  share,
  onShareChange,
  crashReports,
  onCrashReportsChange,
}: OnboardingAnalyticsStepProps) {
  return (
    <div className="space-y-5">
      <OnboardingStepHeader
        title="Help improve Komla?"
        description="Usage analytics show which features get used, so Komla improves where it counts."
      />

      <div className="grid gap-3">
        <ChoiceCard
          icon={ChartBar}
          title="Share usage analytics"
          description="Feature counts tied to a random install ID. Never code, prompts, paths or project names."
          selected={share === true}
          onSelect={() => onShareChange(true)}
        />
        <ChoiceCard
          icon={EyeSlash}
          title="Don’t share"
          description="An anonymous daily ping still goes out, and crash reports if ticked below. Settings → General → Privacy turns the ping off."
          selected={share === false}
          onSelect={() => onShareChange(false)}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={crashReports}
            onChange={(event) => onCrashReportsChange(event.target.checked)}
          />
          Send crash reports
        </label>
        <button
          type="button"
          className="text-xs font-medium text-foreground/85 underline decoration-foreground/25 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60"
          onClick={() => window.api.openExternal(`${window.api.websiteUrl}/privacy`)}
        >
          What Komla collects ↗
        </button>
      </div>
    </div>
  );
}
