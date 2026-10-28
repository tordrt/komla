import { ChatCircle, Command, GearSix, Lightbulb, Sparkle } from '@phosphor-icons/react';
import { useRef, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useLicenseStore } from '@/stores/license.store';

import { GettingStartedMenu } from './GettingStartedMenu';
import { tipsInStatusBar } from './status-bar/status-bar-items';

import type { SettingsDialogTarget } from '@/stores/settings-dialog.store';

interface AppMenuProps {
  /** In the sidebar's bottom-right corner, or at the left of the tab row while it's collapsed. */
  placement?: 'sidebar' | 'top-row';
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenFeedback: () => void;
  onOpenUpgrade: () => void;
  onOpenSettingsTab: (tab: string, target?: Omit<SettingsDialogTarget, 'tab'>) => void;
  onOpenNewWorkspace: () => void;
}

/**
 * The sidebar's settings menu, behind a gear in the sidebar's bottom-right corner: Settings,
 * Shortcuts, Feedback and Upgrade. While the status bar doesn't show Tips, Tips is here too and
 * opens beside the gear. While the sidebar is collapsed, the tab row shows it.
 */
export function AppMenu({
  placement = 'sidebar',
  onOpenSettings,
  onOpenShortcuts,
  onOpenFeedback,
  onOpenUpgrade,
  onOpenSettingsTab,
  onOpenNewWorkspace,
}: AppMenuProps) {
  const quota = useLicenseStore((s) => s.quota);
  const tipsInMenu = useConfigStore((s) => !tipsInStatusBar(s.config));
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [tipsOpen, setTipsOpen] = useState(false);
  const openTipsOnClose = useRef(false);
  const inTopRow = placement === 'top-row';
  const side = inTopRow ? 'bottom' : 'top';
  const align = inTopRow ? 'start' : 'end';

  return (
    <>
      {tipsInMenu && (
        <GettingStartedMenu
          open={tipsOpen}
          onOpenChange={setTipsOpen}
          anchorRef={buttonRef}
          side={side}
          align={align}
          onOpenShortcuts={onOpenShortcuts}
          onOpenFeedback={onOpenFeedback}
          onOpenSettingsTab={onOpenSettingsTab}
          onOpenNewWorkspace={onOpenNewWorkspace}
        />
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton
            ref={buttonRef}
            label="Settings"
            size={inTopRow ? 'sm' : 'xs'}
            data-tips-home="settings menu"
            className={cn(inTopRow && 'no-drag text-muted-foreground hover:text-foreground')}
          >
            <GearSix className={inTopRow ? 'size-4' : 'size-3.5'} />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          side={side}
          className="w-40 min-w-0"
          // Focus goes back to the gear before Tips opens. Arriving there after Tips has opened,
          // it would count as leaving Tips and close it at once.
          onCloseAutoFocus={(event) => {
            if (!openTipsOnClose.current) return;
            openTipsOnClose.current = false;
            event.preventDefault();
            buttonRef.current?.focus();
            setTipsOpen(true);
          }}
        >
          <DropdownMenuItem onClick={onOpenSettings}>
            <GearSix />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenShortcuts}>
            <Command />
            Shortcuts
          </DropdownMenuItem>
          {tipsInMenu && (
            <DropdownMenuItem
              onClick={() => {
                openTipsOnClose.current = true;
              }}
            >
              <Lightbulb />
              Tips
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenFeedback}>
            <ChatCircle />
            Feedback
          </DropdownMenuItem>
          {quota?.isLicensed === false && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onOpenUpgrade}>
                <Sparkle />
                Upgrade
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
