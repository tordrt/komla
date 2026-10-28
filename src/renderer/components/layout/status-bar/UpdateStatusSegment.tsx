import { ArrowCircleUp } from '@phosphor-icons/react';

import { useUpdateStore } from '@/stores/update.store';

import { StatusBarButton } from './StatusBarButton';

// Stays while an update waits, so the notice is one click away after its banner was dismissed.
export function UpdateStatusSegment() {
  const status = useUpdateStore((s) => s.status);
  const version = useUpdateStore((s) => s.version);
  const showNotice = useUpdateStore((s) => s.showNotice);
  if (status !== 'ready' && status !== 'manual') return null;
  const label =
    status === 'manual'
      ? `Komla v${version} is available to download`
      : `Komla v${version} is ready to install`;

  return (
    <StatusBarButton
      aria-label={label}
      tooltip={label}
      className="text-info hover:text-info"
      onClick={showNotice}
    >
      <ArrowCircleUp aria-hidden="true" className="size-3.5" />
      <span className="@max-3xl:hidden">
        {status === 'manual' ? 'Update available' : 'Update ready'}
      </span>
    </StatusBarButton>
  );
}
