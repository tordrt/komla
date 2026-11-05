import { Check } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

/**
 * A pickable option on a setup step, as a card or chip: picked ones take the accent's edge and a
 * faint wash of it, so the choice reads at a glance without a heavy ring.
 */
export function choiceClass(selected: boolean): string {
  return cn(
    'border transition-[background-color,border-color,box-shadow] duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
    selected
      ? 'border-komla/80 bg-komla/[0.08] shadow-[0_0_0_1px_var(--color-komla)]'
      : 'border-border bg-background/40 hover:border-foreground/25 hover:bg-muted/40'
  );
}

/** The round check a picked card shows at its end. */
export function ChoiceCheck() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-komla">
      <Check className="size-3 text-white" weight="bold" />
    </span>
  );
}

/** A setup step's title and what it's for, at the top of the card. */
export function OnboardingStepHeader({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <h2 className="text-lg leading-tight font-semibold tracking-tight">{title}</h2>
      {description && (
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

/** A small, uppercase label over a group on a setup step. */
export function OnboardingSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
      {children}
    </p>
  );
}

/**
 * Where setup is: each step numbered, done ones ticked, joined by a line that fills in as setup
 * moves on.
 */
export function OnboardingStepper({ labels, step }: { labels: string[]; step: number }) {
  return (
    <ol aria-label="Setup steps" className="flex items-center justify-center">
      {labels.map((label, i) => {
        const s = i + 1;
        const done = s < step;
        const current = s === step;
        return (
          <li key={label} className="flex items-center">
            {i > 0 && (
              <span
                aria-hidden="true"
                className={cn(
                  'mx-2 h-px w-6 transition-colors',
                  s <= step ? 'bg-komla/70' : 'bg-border'
                )}
              />
            )}
            <span
              aria-current={current ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 text-xs font-medium transition-colors',
                current
                  ? 'text-foreground'
                  : done
                    ? 'text-muted-foreground'
                    : 'text-muted-foreground-60'
              )}
            >
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full text-2xs tabular-nums transition-colors',
                  done && 'bg-komla/25 text-komla',
                  current &&
                    'bg-komla text-white shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-komla)_25%,transparent)]',
                  !done && !current && 'ring-1 ring-border ring-inset'
                )}
              >
                {done ? <Check className="size-2.5" weight="bold" /> : s}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
