import * as React from 'react';

import { cn } from '@/lib/utils';

export type BadgeTone =
  | 'neutral'
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'attention';
export type BadgeVariant = 'soft' | 'outline' | 'solid';

// Literal class strings so Tailwind can see them.
const TONE_CLASSES: Record<BadgeTone, Record<BadgeVariant, string>> = {
  neutral: {
    soft: 'bg-muted text-muted-foreground',
    outline: 'ring-1 ring-inset ring-border text-muted-foreground',
    solid: 'bg-foreground text-background',
  },
  primary: {
    soft: 'bg-primary/15 text-primary',
    outline: 'ring-1 ring-inset ring-primary/40 text-primary',
    solid: 'bg-primary text-primary-foreground',
  },
  success: {
    soft: 'bg-success/15 text-success',
    outline: 'ring-1 ring-inset ring-success/40 text-success',
    solid: 'bg-success text-success-foreground',
  },
  warning: {
    soft: 'bg-warning/15 text-warning',
    outline: 'ring-1 ring-inset ring-warning/40 text-warning',
    solid: 'bg-warning text-warning-foreground',
  },
  error: {
    soft: 'bg-error/15 text-error',
    outline: 'ring-1 ring-inset ring-error/40 text-error',
    solid: 'bg-error text-error-foreground',
  },
  info: {
    soft: 'bg-info/15 text-info',
    outline: 'ring-1 ring-inset ring-info/40 text-info',
    solid: 'bg-info text-info-foreground',
  },
  attention: {
    soft: 'bg-attention/15 text-attention',
    outline: 'ring-1 ring-inset ring-attention/40 text-attention',
    solid: 'bg-attention text-attention-foreground',
  },
};

const SIZE_CLASSES = {
  sm: 'h-4 gap-1 px-1.5 text-2xs',
  md: 'h-5 gap-1 px-2 text-ui',
} as const;

const SHAPE_CLASSES = {
  pill: 'rounded-full',
  square: 'rounded',
} as const;

export interface BadgeStyleProps {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: keyof typeof SIZE_CLASSES;
  shape?: keyof typeof SHAPE_CLASSES;
}

/** Badge classes, for elements that can't be a `<Badge>` (e.g. a button styled as a pill). */
export function badgeVariants({
  tone = 'neutral',
  variant = 'soft',
  size = 'sm',
  shape = 'pill',
}: BadgeStyleProps = {}): string {
  return cn(
    'inline-flex shrink-0 items-center whitespace-nowrap font-medium',
    SIZE_CLASSES[size],
    SHAPE_CLASSES[shape],
    TONE_CLASSES[tone][variant]
  );
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, BadgeStyleProps {}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, tone, variant, size, shape, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ tone, variant, size, shape }), className)}
      {...props}
    />
  )
);
Badge.displayName = 'Badge';

/** Marks a feature still in alpha, wherever it is offered. */
export function AlphaBadge() {
  return (
    <Badge tone="warning" className="px-1.5 text-[10px] font-semibold tracking-wide uppercase">
      Alpha
    </Badge>
  );
}
