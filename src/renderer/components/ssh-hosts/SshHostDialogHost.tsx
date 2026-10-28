import { useEffect } from 'react';

import { useSshHostDialogStore } from '@/stores/ssh-host-dialog.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';

import { SshHostDialog } from './SshHostDialog';

/** The one SSH host dialog, opened through useSshHostDialogStore from anywhere in the app. */
export function SshHostDialogHost() {
  const open = useSshHostDialogStore((s) => s.open);
  const request = useSshHostDialogStore((s) => s.request);
  const requestId = useSshHostDialogStore((s) => s.requestId);
  const close = useSshHostDialogStore((s) => s.close);
  const hosts = useSshHostsStore((s) => s.hosts);
  // A host deleted while its dialog is open has nothing left to show.
  const hostMissing =
    request !== null && request.kind !== 'add' && !hosts.some((host) => host.id === request.hostId);

  useEffect(() => {
    if (open && hostMissing) close();
  }, [open, hostMissing, close]);

  if (!request) return null;
  return (
    <SshHostDialog
      key={requestId}
      request={request}
      open={open && !hostMissing}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    />
  );
}
