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

/** "Connected", "Unreachable", "Not checked" or "Disconnected", for a status pill. */
export function sshHostStateLabel(status: SshHostStatus | undefined, disconnected = false): string {
  if (disconnected) return 'Disconnected';
  if (!status) return 'Not checked';
  return status.state === 'connected' ? 'Connected' : 'Unreachable';
}

/**
 * When Komla last reached the host, why it couldn't, that it hasn't tried, or that the user
 * disconnected from it.
 */
export function sshHostStatusDetail(
  status: SshHostStatus | undefined,
  disconnected = false
): string {
  if (disconnected) return 'Disconnected. Its tmux sessions keep running there.';
  if (!status) return 'Not checked since Komla started';
  if (status.state === 'unreachable') return status.message ?? 'Unreachable';
  const ago = formatRelativeTime(status.checkedAt);
  return ago === 'now' ? 'Connected just now' : `Connected ${ago} ago`;
}

export function SshHostStatusDot({
  status,
  disconnected = false,
  className,
}: {
  status: SshHostStatus | undefined;
  /** Shown as a ring: nothing Komla last saw there is current. */
  disconnected?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        disconnected
          ? 'border border-muted-foreground'
          : [
              status?.state === 'connected' && 'bg-success',
              status?.state === 'unreachable' && 'bg-error',
              !status && 'bg-muted-foreground/50',
            ],
        className
      )}
    />
  );
}
