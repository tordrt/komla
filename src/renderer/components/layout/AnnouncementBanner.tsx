import { Info, Lightbulb, Megaphone, Warning } from '@phosphor-icons/react';

import { BANNER_PRIORITY, useBannerSlot } from '@/components/layout/BannerHost';
import { Banner, BannerAction, type BannerTone } from '@/components/ui/banner';
import { useAnnouncementStore, type Announcement } from '@/stores/announcement.store';

const TYPE_CONFIG: Record<Announcement['type'], { icon: React.ElementType; tone: BannerTone }> = {
  info: { icon: Info, tone: 'info' },
  tip: { icon: Lightbulb, tone: 'neutral' },
  'whats-new': { icon: Megaphone, tone: 'info' },
  warning: { icon: Warning, tone: 'warning' },
};

function AnnouncementItem({ announcement, order }: { announcement: Announcement; order: number }) {
  const dismiss = useAnnouncementStore((s) => s.dismiss);
  const openDialog = useAnnouncementStore((s) => s.openDialog);
  const slot = useBannerSlot(
    `announcement:${announcement.id}`,
    BANNER_PRIORITY.announcement,
    true,
    order
  );
  if (!slot.visible) return null;

  const config = TYPE_CONFIG[announcement.type] ?? TYPE_CONFIG.info;
  const Icon = config.icon;
  const showDialogLink = announcement.displayMode === 'both';

  const handleAction = () => {
    if (showDialogLink) {
      openDialog();
    } else if (announcement.action) {
      void window.api.openExternal(announcement.action.url);
    }
  };

  return (
    <Banner
      tone={config.tone}
      icon={<Icon className="size-4" />}
      title={announcement.title}
      actions={
        (announcement.action || showDialogLink) && (
          <BannerAction variant="ghost" onClick={handleAction}>
            {announcement.action?.label ?? 'Learn more'}
          </BannerAction>
        )
      }
      pager={slot.pager}
      onDismiss={announcement.dismissible !== false ? () => dismiss(announcement.id) : undefined}
      dismissLabel="Dismiss announcement"
    >
      {announcement.body && <>— {announcement.body}</>}
    </Banner>
  );
}

export function AnnouncementBanner() {
  const announcements = useAnnouncementStore((s) => s.announcements);

  const bannerAnnouncements = announcements.filter(
    (a) => a.displayMode === 'banner' || a.displayMode === 'both'
  );

  if (bannerAnnouncements.length === 0) return null;

  return (
    <>
      {bannerAnnouncements.map((a, index) => (
        <AnnouncementItem key={a.id} announcement={a} order={index} />
      ))}
    </>
  );
}
