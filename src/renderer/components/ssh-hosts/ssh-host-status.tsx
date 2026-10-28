import { useEffect, useState } from 'react';

import { formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';

import type { SshHostStatus } from '@/types';

/** What Komla last saw on each SSH host, kept current while mounted. */
export function useSshHostStatuses(): Map<string, SshHostStatus> {
  const [statuses, setStatuses] = useState<SshHostStatus[]>([]);
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.api.onSshHostStatusesChange(setStatuses);
    window.api
      .getSshHostStatuses()
      .then((initial) => {
        if (!cancelled) setStatuses(initial);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return new Map(statuses.map((status) => [status.hostId, status]));
}

/** "Connected", "Unreachable" or "Not checked", for a status pill. */
export function sshHostStateLabel(status: SshHostStatus | undefined): string {
  if (!status) return 'Not checked';
  return status.state === 'connected' ? 'Connected' : 'Unreachable';
}

/** When Komla last reached the host, why it couldn't, or that it hasn't tried. */
export function sshHostStatusDetail(status: SshHostStatus | undefined): string {
  if (!status) return 'Not checked since Komla started';
  if (status.state === 'unreachable') return status.message ?? 'Unreachable';
  const ago = formatRelativeTime(status.checkedAt);
  return ago === 'now' ? 'Connected just now' : `Connected ${ago} ago`;
}

export function SshHostStatusDot({
  status,
  className,
}: {
  status: SshHostStatus | undefined;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status?.state === 'connected' && 'bg-success',
        status?.state === 'unreachable' && 'bg-error',
        !status && 'bg-muted-foreground/50',
        className
      )}
    />
  );
}
