import { Minus, Plus } from '@phosphor-icons/react';
import { useState } from 'react';

import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';

import {
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  stepZoomLevel,
  zoomPercent,
} from '../../../shared/constants/zoom';

// Shown under every setup step, so someone who finds the text too small or too
// large can fix it before reading on. The tooltips teach the View menu shortcuts.
export function OnboardingZoomControl({ className }: { className?: string }) {
  const savedLevel = useConfigStore((s) => s.config?.zoomLevel ?? 0);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  // The store only updates once a save returns, so quick clicks step from the
  // level last asked for rather than repeating the same one.
  const [pendingLevel, setPendingLevel] = useState<number | null>(null);
  const level = pendingLevel ?? savedLevel;

  const zoom = (direction: 1 | -1) => {
    const next = stepZoomLevel(level, direction);
    setPendingLevel(next);
    void updateConfig({ zoomLevel: next }).finally(() =>
      setPendingLevel((pending) => (pending === next ? null : pending))
    );
  };

  return (
    <div
      role="group"
      aria-label="Text size"
      className={cn(
        'flex items-center gap-1 rounded-lg border border-border bg-card p-0.5 text-sm text-muted-foreground',
        className
      )}
    >
      <span className="pr-1 pl-2.5">Text size</span>
      <IconButton
        label="Zoom out"
        shortcut={formatShortcutForDisplay('Cmd+-')}
        size="sm"
        disabled={level <= MIN_ZOOM_LEVEL}
        onClick={() => zoom(-1)}
      >
        <Minus className="size-3.5" />
      </IconButton>
      <span className="w-11 text-center text-foreground tabular-nums" aria-live="polite">
        {zoomPercent(level)}%
      </span>
      <IconButton
        label="Zoom in"
        shortcut={formatShortcutForDisplay('Cmd+=')}
        size="sm"
        disabled={level >= MAX_ZOOM_LEVEL}
        onClick={() => zoom(1)}
      >
        <Plus className="size-3.5" />
      </IconButton>
    </div>
  );
}
