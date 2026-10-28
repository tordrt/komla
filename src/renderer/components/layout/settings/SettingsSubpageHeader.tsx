import { CaretLeft } from '@phosphor-icons/react';

import type { ReactNode } from 'react';

interface SettingsSubpageHeaderProps {
  /** The list this view was opened from, e.g. "Projects". */
  backLabel: string;
  onBack: () => void;
  title: string;
  description?: ReactNode;
}

/** Heads a view opened from a list on a Settings page, such as an editor or a picker. */
export function SettingsSubpageHeader({
  backLabel,
  onBack,
  title,
  description,
}: SettingsSubpageHeaderProps) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        <CaretLeft className="size-3.5" />
        {backLabel}
      </button>
      <div>
        <h2 className="truncate text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </div>
        )}
      </div>
    </div>
  );
}
