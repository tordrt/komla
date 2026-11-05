import { CaretLeft } from '@phosphor-icons/react';

import type { ReactNode } from 'react';

interface SettingsSubpageHeaderProps {
  /** The list this view was opened from, e.g. "Projects". */
  backLabel: string;
  onBack: () => void;
  title: string;
  description?: ReactNode;
}

/**
 * Heads a view opened from a list on a Settings page, such as an editor or a picker. It takes the
 * page header's place, so it matches it, with the way back above the title.
 */
export function SettingsSubpageHeader({
  backLabel,
  onBack,
  title,
  description,
}: SettingsSubpageHeaderProps) {
  return (
    <header className="border-b border-border/60 pb-5">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 -ml-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        <CaretLeft className="size-3.5" />
        {backLabel}
      </button>
      <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description && (
        <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </div>
      )}
    </header>
  );
}
