import React, { Suspense, useEffect, useState, type PropsWithChildren } from 'react';

/**
 * Load on first open, then retain dialog state and close effects between uses.
 *
 * With `preload`, the dialog instead loads and mounts closed once the app is idle. A lazy
 * component suspends on its first render even when its chunk has loaded, and React holds a
 * suspended boundary's content back for up to 300 ms, so a dialog that must open at once is
 * mounted before it's asked for. `preload` must keep its identity across renders, such as a
 * module-level loader, or each render restarts the wait for idle.
 */
export function DeferredDialog({
  open,
  preload,
  children,
}: PropsWithChildren<{ open: boolean; preload?: () => Promise<unknown> }>) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (!preload || mounted) return;
    let cancelled = false;
    const id = requestIdleCallback(
      () =>
        void preload().then(
          () => !cancelled && setMounted(true),
          // Opening the dialog loads it again, as without a preload.
          (err: unknown) => !cancelled && console.warn('Failed to preload dialog:', err)
        ),
      { timeout: 10_000 }
    );
    return () => {
      cancelled = true;
      cancelIdleCallback(id);
    };
  }, [preload, mounted]);

  if (!mounted) return null;

  return <Suspense fallback={null}>{children}</Suspense>;
}
