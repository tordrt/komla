import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { useConfigStore } from '@/stores/config.store';
import { useSshHostDialogStore } from '@/stores/ssh-host-dialog.store';

import { useAnyBannerShowing } from '../BannerHost';
import { GettingStartedMenu, type TipsActions } from '../GettingStartedMenu';

import type { RefObject } from 'react';

// Long enough for banners that check something first, such as hook updates, to appear.
const INTRO_DELAY_MS = 1500;

/**
 * Where Tips stays once hidden here: the settings menu, in the sidebar or, without one, the title
 * bar. A collapsed sidebar keeps its own, hidden, settings menu, so take the one on screen.
 */
function findTipsHome(): HTMLElement | null {
  const homes = [...document.querySelectorAll<HTMLElement>('[data-tips-home]')];
  return homes.find((home) => home.getClientRects().length > 0) ?? homes[0] ?? null;
}

function subscribeModal(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-scroll-locked'] });
  return () => observer.disconnect();
}

/** Whether a modal dialog or menu is open: Radix locks the page's scrolling while one is. */
function useModalOpen(): boolean {
  return useSyncExternalStore(subscribeModal, () =>
    document.body.hasAttribute('data-scroll-locked')
  );
}

/**
 * Tips, opening above the bar. Its hide link turns the item off and moves focus to where Tips stays.
 * On the first screen after setup a pointer says what Tips holds, a moment after any dialog has
 * closed and no banner asks for attention. It stays until dismissed or Tips opens.
 */
export function TipsStatusSegment(actions: TipsActions) {
  const [open, setOpen] = useState(false);
  const [pointerDue, setPointerDue] = useState(false);
  const [home, setHome] = useState('settings menu');
  const anchorRef = useRef<HTMLSpanElement>(null);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const introPending = useConfigStore((s) => s.config?.tipsIntroPending === true);
  const sshHostDialogOpen = useSshHostDialogStore((s) => s.open);
  const bannerShowing = useAnyBannerShowing();
  const modalOpen = useModalOpen();
  const waiting = sshHostDialogOpen || bannerShowing || modalOpen;

  useEffect(() => {
    if (!introPending) return;
    // Each wait starts the delay over, so a banner that shows late still goes first.
    if (waiting) {
      setPointerDue(false);
      return;
    }
    // A moment after the window settles, so the pointer doesn't show while setup's screen gives way.
    const timer = setTimeout(() => setPointerDue(true), INTRO_DELAY_MS);
    return () => clearTimeout(timer);
  }, [introPending, waiting]);

  const finishIntro = () => {
    setPointerDue(false);
    void updateConfig({ tipsIntroPending: false });
  };
  // Opening Tips, from here or elsewhere, finishes the intro (see GettingStartedMenu).
  const openTips = (next: boolean) => {
    if (next) setHome(findTipsHome()?.dataset.tipsHome ?? 'settings menu');
    setOpen(next);
  };

  return (
    <span ref={anchorRef} className="flex shrink-0">
      <GettingStartedMenu
        {...actions}
        open={open}
        onOpenChange={openTips}
        side="top"
        hideHint={`Tips stays in the ${home}`}
        onHideButton={() => {
          void updateConfig({ showTipsInToolbar: false });
          findTipsHome()?.focus();
        }}
      />
      {pointerDue && introPending && !waiting && !open && (
        <TipsPointer
          anchorRef={anchorRef}
          onDismiss={finishIntro}
          onShowTips={() => openTips(true)}
        />
      )}
    </span>
  );
}

/**
 * A card above Tips that points down at it. Not a popover: those close on Escape pressed anywhere,
 * which would dismiss it for good while the user only meant their terminal. Escape closes it only
 * from inside, and clicks elsewhere leave it be.
 */
function TipsPointer({
  anchorRef,
  onDismiss,
  onShowTips,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  onShowTips: () => void;
}) {
  const [position, setPosition] = useState<{ bottom: number; right: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        bottom: window.innerHeight - rect.top + 8,
        right: window.innerWidth - rect.right,
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef]);

  if (!position) return null;
  return createPortal(
    <div
      role="dialog"
      aria-label="Tips"
      style={position}
      className="floating-surface fixed z-50 w-64 space-y-3 rounded-[calc(var(--radius)+2px)] border p-3 text-popover-foreground shadow-xl animate-in fade-in-0 slide-in-from-bottom-2"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }}
    >
      <div className="space-y-1">
        <p className="text-sm font-semibold tracking-tight">Tips live here</p>
        <p className="text-ui text-muted-foreground">
          Setup steps, demos and shortcuts for getting the most out of Komla.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Got it
        </Button>
        <Button size="sm" onClick={onShowTips}>
          Show tips
        </Button>
      </div>
      {/* Points down at the bulb, which sits under the pointer's right end. */}
      <span
        aria-hidden="true"
        className="absolute right-[7px] -bottom-[5px] size-2.5 rotate-45 border-r border-b border-inherit bg-inherit"
      />
    </div>,
    document.body
  );
}
