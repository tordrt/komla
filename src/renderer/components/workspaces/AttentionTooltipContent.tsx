import {
  Alarm,
  Bell,
  Moon,
  Question,
  Warning,
  type Icon as PhosphorIcon,
  type IconProps,
} from '@phosphor-icons/react';

import { CheckedIcon } from '@/components/ui/checked-icon';
import { TooltipContent } from '@/components/ui/tooltip';
import { formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { SNOOZE_ATTENTION_SOURCE } from '@/lib/workspace-attention';

import { DoneCheck } from './DoneCheck';

import type { WorkspaceAttentionAppearance } from '@/lib/workspace-attention';
import type { WorkspaceAttention } from '@/types';

// A leading glyph keeps status pills from reading like the diff stats beside them.
export const ATTENTION_GLYPHS: Record<WorkspaceAttention['kind'], PhosphorIcon> = {
  'input-required': Question,
  error: Warning,
  'turn-complete': DoneCheck,
  idle: Moon,
  generic: Bell,
};

/**
 * The glyph that leads a notification: the icon `komla notify --icon` gave it, its kind's, or an
 * alarm for a woken snooze.
 */
export function AttentionGlyph({
  attention,
  ...props
}: { attention: WorkspaceAttention } & IconProps) {
  if (attention.icon?.startsWith('data:image/')) {
    return (
      <CheckedIcon
        src={attention.icon}
        color={attention.iconColor}
        className={cn('object-contain', props.className)}
      />
    );
  }
  const Glyph =
    attention.source === SNOOZE_ATTENTION_SOURCE
      ? Alarm
      : (ATTENTION_GLYPHS[attention.kind] ?? Bell);
  return <Glyph {...props} />;
}

interface AttentionCardProps {
  attention: WorkspaceAttention;
  appearance: WorkspaceAttentionAppearance;
}

// Wide enough that a long message reads as a paragraph rather than a column.
export const ATTENTION_CARD_CLASS_NAME = 'w-max max-w-sm px-3 py-2';

/** What happened, when, and the whole message, wrapped over as many lines as it needs. */
export function AttentionCard({ attention, appearance }: AttentionCardProps) {
  return (
    <>
      <div className="flex items-start gap-1.5">
        <AttentionGlyph
          attention={attention}
          aria-hidden="true"
          weight="bold"
          className="mt-0.5 size-3 shrink-0"
          style={{ color: appearance.borderColor }}
        />
        <span className="min-w-0 font-medium text-foreground">{appearance.heading}</span>
        <span className="ml-auto shrink-0 pl-3 text-2xs text-muted-foreground tabular-nums">
          {formatRelativeTime(attention.updatedAt)}
        </span>
      </div>
      {appearance.detail && (
        <p className="mt-1.5 max-h-60 overflow-y-auto break-words whitespace-pre-wrap text-foreground/80">
          {appearance.detail}
        </p>
      )}
    </>
  );
}

/** The card a notification badge shows on hover. */
export function AttentionTooltipContent(props: AttentionCardProps) {
  return (
    <TooltipContent side="top" className={ATTENTION_CARD_CLASS_NAME}>
      <AttentionCard {...props} />
    </TooltipContent>
  );
}
