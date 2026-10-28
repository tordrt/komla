import { ChartBar, EyeSlash } from '@phosphor-icons/react';

import { Checkbox } from '@/components/ui/checkbox';

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
      <div>
        <h2 className="text-lg font-semibold">Help improve Komla?</h2>
        <p className="text-sm text-muted-foreground">
          Usage analytics show which features get used, so Komla gets better where it counts.
        </p>
      </div>

      <div className="grid gap-3">
        <ChoiceCard
          icon={ChartBar}
          title="Share usage analytics"
          description="Feature usage counts tied to a random install ID. Never code, prompts, file paths or project names."
          selected={share === true}
          onSelect={() => onShareChange(true)}
        />
        <ChoiceCard
          icon={EyeSlash}
          title="Don’t share"
          description="Komla still sends an anonymous daily ping, and crash reports if ticked below. Settings → General → Privacy turns the ping off."
          selected={share === false}
          onSelect={() => onShareChange(false)}
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={crashReports}
          onChange={(event) => onCrashReportsChange(event.target.checked)}
        />
        Send crash reports
      </label>

      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        onClick={() => window.api.openExternal(`${window.api.websiteUrl}/privacy`)}
      >
        What Komla collects ↗
      </button>
    </div>
  );
}
