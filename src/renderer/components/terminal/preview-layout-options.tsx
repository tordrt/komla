import { cn } from '@/lib/utils';
import { getWorkspaceAttentionAppearance } from '@/lib/workspace-attention';
import { isWorkspaceAttentionActionable, type Terminal } from '@/types';

import type { SegmentedControlOption } from '@/components/ui/segmented-control';
import type { InlinePreviewLayout } from '@/stores/file-viewer.store';

/** A terminal that needs the user while a full-screen preview hides the tab strip. */
export interface PreviewLayoutAttention {
  tooltip: string;
  dotClassName: string;
}

const PREVIEW_LAYOUT_OPTIONS: readonly SegmentedControlOption<InlinePreviewLayout>[] = [
  { value: 'side-by-side', label: 'Split' },
  { value: 'full', label: 'Full' },
];

/** Input requests first, then errors: the attention that needs the user to act. */
export function getPreviewLayoutAttention(terminals: Terminal[]): PreviewLayoutAttention | null {
  const attention =
    terminals.find((terminal) => terminal.attention?.kind === 'input-required')?.attention ??
    terminals.find((terminal) => isWorkspaceAttentionActionable(terminal.attention))?.attention;
  const appearance = getWorkspaceAttentionAppearance(attention);
  return appearance ? { tooltip: appearance.tooltip, dotClassName: appearance.dotClassName } : null;
}

/** Split/Full options; Split carries a status dot while a hidden tab needs the user. */
export function getPreviewLayoutOptions(
  attention: PreviewLayoutAttention | null | undefined
): readonly SegmentedControlOption<InlinePreviewLayout>[] {
  if (!attention) return PREVIEW_LAYOUT_OPTIONS;
  return [
    {
      value: 'side-by-side',
      label: (
        <>
          Split
          <span
            aria-hidden
            className={cn('size-1.5 shrink-0 rounded-full', attention.dotClassName)}
          />
        </>
      ),
      ariaLabel: `Split — ${attention.tooltip}`,
      title: `Show terminals — ${attention.tooltip}`,
    },
    PREVIEW_LAYOUT_OPTIONS[1],
  ];
}
