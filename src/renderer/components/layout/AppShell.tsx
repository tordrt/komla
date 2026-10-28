import { TooltipProvider } from '@/components/ui/tooltip';

import { OutsidePointerShield } from './OutsidePointerShield';
import { SettingsApprovalDialog } from './SettingsApprovalDialog';

import type { PropsWithChildren } from 'react';

export function AppShell({ children }: PropsWithChildren) {
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={300}>
      {/* First, so app elements that share its z-index (the voice pill) stay on top of it. */}
      <OutsidePointerShield />
      {children}
      <SettingsApprovalDialog />
    </TooltipProvider>
  );
}
