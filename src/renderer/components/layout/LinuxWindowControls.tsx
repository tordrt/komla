import { CornersIn, CornersOut, Minus, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { IconButton } from '@/components/ui/icon-button';

const WINDOW_CONTROL_CLASS = 'text-foreground hover:bg-muted-foreground/10';

/** Minimize, maximize and close, which Komla draws itself on Linux. */
export function LinuxWindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  useEffect(() => {
    // Get initial maximized state
    void window.api.isWindowMaximized().then(setIsMaximized);

    // Listen for maximize state changes
    const unsubscribe = window.api.onWindowMaximizedChange(setIsMaximized);
    return unsubscribe;
  }, []);

  return (
    <div className="flex items-center gap-0.5" style={noDrag}>
      <IconButton
        label="Minimize"
        className={WINDOW_CONTROL_CLASS}
        onClick={() => window.api.minimizeWindow()}
      >
        <Minus className="size-3.5" />
      </IconButton>
      <IconButton
        label={isMaximized ? 'Restore' : 'Maximize'}
        className={WINDOW_CONTROL_CLASS}
        onClick={() => window.api.maximizeWindow()}
      >
        {isMaximized ? <CornersIn className="size-3.5" /> : <CornersOut className="size-3.5" />}
      </IconButton>
      <IconButton
        label="Close"
        className="text-foreground hover:bg-destructive/80 hover:text-destructive-foreground"
        onClick={() => window.api.closeWindow()}
      >
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}

/** At the right end of a top row: on Linux a divider and the window controls, elsewhere nothing. */
export function LinuxWindowControlsEnd() {
  if (window.api.platform !== 'linux') return null;
  return (
    <>
      <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
      <LinuxWindowControls />
    </>
  );
}
