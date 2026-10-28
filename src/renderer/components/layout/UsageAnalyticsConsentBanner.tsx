import { ChartBar } from '@phosphor-icons/react';

import { BANNER_PRIORITY, useBannerSlot } from '@/components/layout/BannerHost';
import { Banner, BannerAction } from '@/components/ui/banner';
import { useConfigStore } from '@/stores/config.store';

/**
 * One-time opt-in prompt for usage analytics. Shown until the user picks
 * either option here or flips the toggle in Settings → Privacy.
 */
export function UsageAnalyticsConsentBanner() {
  const answered = useConfigStore((s) => s.config?.usageTelemetryConsentAnswered !== false);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const slot = useBannerSlot('usage-consent', BANNER_PRIORITY.usageConsent, !answered);

  if (!slot.visible) return null;

  return (
    <Banner
      tone="neutral"
      icon={<ChartBar className="size-4" />}
      title="Share usage analytics?"
      actions={
        <>
          <BannerAction
            variant="ghost"
            onClick={() => window.api.openExternal(`${window.api.websiteUrl}/privacy`)}
          >
            Details
          </BannerAction>
          <BannerAction
            variant="ghost"
            onClick={() => void updateConfig({ usageTelemetryEnabled: false })}
          >
            No thanks
          </BannerAction>
          <BannerAction onClick={() => void updateConfig({ usageTelemetryEnabled: true })}>
            Share
          </BannerAction>
        </>
      }
      pager={slot.pager}
    >
      — Feature usage counts tied to a random install ID. Never code, prompts, file paths, or
      project names.
    </Banner>
  );
}
