import { Sparkle } from '@phosphor-icons/react';

import { BANNER_PRIORITY, useBannerSlot } from '@/components/layout/BannerHost';
import { AI_UTILITIES_CARD } from '@/components/layout/settings/settings-search';
import { Banner, BannerAction } from '@/components/ui/banner';
import { useConfigStore } from '@/stores/config.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';

// Not window.api.websiteUrl: `npm run dev` points that at the login-gated staging site.
const DOWNLOAD_URL = 'https://komla.dev/download';

/**
 * One-time notice for a build without the managed AI helpers, as most builds from source
 * are, where naming workspaces otherwise just skips without saying why.
 */
export function AiHelpersOffBanner() {
  const pending = useConfigStore(
    (s) => s.config?.aiHelpersOffDismissed === false && s.config.utilityProvider === 'komla-managed'
  );
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  const slot = useBannerSlot(
    'ai-helpers-off',
    BANNER_PRIORITY.aiHelpersOff,
    pending && window.api.managedAiHelpers === false
  );

  if (!slot.visible) return null;

  return (
    <Banner
      tone="neutral"
      icon={<Sparkle className="size-4" />}
      title="AI helpers are off in this build."
      actions={
        <>
          <BannerAction variant="ghost" onClick={() => window.api.openExternal(DOWNLOAD_URL)}>
            Download Komla
          </BannerAction>
          <BannerAction onClick={() => openSettings({ tab: 'general', card: AI_UTILITIES_CARD })}>
            Choose endpoint
          </BannerAction>
        </>
      }
      pager={slot.pager}
      onDismiss={() => void updateConfig({ aiHelpersOffDismissed: true })}
      dismissLabel="Dismiss AI helpers notice"
    >
      Choose a custom endpoint for AI workspace names and commit messages, or download Komla to use
      them with no setup.
    </Banner>
  );
}
