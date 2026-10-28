import { SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react';

import { agentStatusReportsWork } from '@/lib/agent-status-reports';
import { DEFAULT_NOTIFICATION_SOUNDS } from '@/lib/notification-sounds';
import { useConfigStore } from '@/stores/config.store';

import { StatusBarButton } from './StatusBarButton';

/** Mutes or unmutes notification sounds in one click, keeping the sounds chosen in Settings. */
export function NotificationSoundsStatusSegment() {
  const sounds = useConfigStore((s) => s.config?.notificationSounds ?? DEFAULT_NOTIFICATION_SOUNDS);
  const endpointOff = useConfigStore((s) => s.config?.disableNotificationEndpoint === true);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  // With neither hooks nor status reports reaching Komla, no sound can play.
  if (endpointOff && !agentStatusReportsWork()) return null;
  const Icon = sounds.enabled ? SpeakerHigh : SpeakerSlash;

  return (
    <StatusBarButton
      aria-label="Notification sounds"
      aria-pressed={sounds.enabled}
      tooltip={sounds.enabled ? 'Mute notification sounds' : 'Unmute notification sounds'}
      onClick={() =>
        void updateConfig({ notificationSounds: { ...sounds, enabled: !sounds.enabled } })
      }
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </StatusBarButton>
  );
}
