import { Plugs } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { BANNER_PRIORITY, useBannerSlot } from '@/components/layout/BannerHost';
import { Banner, BannerAction } from '@/components/ui/banner';

interface PortChangedBannerProps {
  onOpenSettings: () => void;
}

export function PortChangedBanner({ onOpenSettings }: PortChangedBannerProps) {
  const [portChange, setPortChange] = useState<{ oldPort: number; newPort: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Query on mount in case the event fired before renderer was ready
    void window.api.getPortChange().then((event) => {
      if (event) {
        setPortChange(event);
      }
    });

    const cleanup = window.api.onPortChanged((event) => {
      setPortChange(event);
      setDismissed(false);
    });
    return cleanup;
  }, []);

  const slot = useBannerSlot(
    'port-changed',
    BANNER_PRIORITY.portChanged,
    portChange !== null && !dismissed
  );
  if (!portChange || !slot.visible) {
    return null;
  }

  return (
    <Banner
      tone="warning"
      title={`Komla's MCP port changed from ${portChange.oldPort} to ${portChange.newPort} because ${portChange.oldPort} was in use.`}
      actions={
        <BannerAction onClick={onOpenSettings}>
          <Plugs className="size-3" />
          Update MCP config
        </BannerAction>
      }
      pager={slot.pager}
      onDismiss={() => setDismissed(true)}
      dismissLabel="Dismiss port change notice"
    >
      Agents set up with the old port can&apos;t reach Komla until you update their MCP config.
    </Banner>
  );
}
