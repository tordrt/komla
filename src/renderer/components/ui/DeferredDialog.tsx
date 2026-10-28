import React, { Suspense, useState, type PropsWithChildren } from 'react';

/** Load on first open, then retain dialog state and close effects between uses. */
export function DeferredDialog({ open, children }: PropsWithChildren<{ open: boolean }>) {
  const [hasOpened, setHasOpened] = useState(open);
  if (open && !hasOpened) setHasOpened(true);
  if (!open && !hasOpened) return null;

  return <Suspense fallback={null}>{children}</Suspense>;
}
