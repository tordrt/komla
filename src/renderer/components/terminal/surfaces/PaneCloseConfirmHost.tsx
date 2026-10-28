import { useEffect } from 'react';

import { registerPaneCloseConfirm } from '@/lib/pane-surfaces';

import { useConfirmDialog } from '../useConfirmDialog';

/**
 * The dialog that asks before a pane's unsaved edits are thrown away, or before closing a
 * workspace's last pane stops it. Render it once.
 */
export function PaneCloseConfirmHost() {
  const { confirm, confirmDialog } = useConfirmDialog();
  useEffect(() => registerPaneCloseConfirm(confirm), [confirm]);
  return confirmDialog;
}
