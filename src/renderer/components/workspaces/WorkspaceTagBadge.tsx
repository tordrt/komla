import { Tag } from '@phosphor-icons/react';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';

import {
  DEFAULT_WORKSPACE_TAGS,
  findWorkspaceTag,
  type WorkspaceTagDefinition,
} from '../../../shared/lib/workspace-tags';

import { ActivitySpinner } from './activity-spinners';

/** A tag in its color, led by its glyph, as its pill and the workspace's hover card show it. */
export const WorkspaceTagBadge = forwardRef<
  HTMLSpanElement,
  { tag: string } & Omit<ComponentPropsWithoutRef<typeof Badge>, 'tone' | 'variant'>
>(function WorkspaceTagBadge({ tag, className, ...props }, ref) {
  // From the config store itself: lib/workspace-tags brings in the workspaces store, which
  // imports the hover card that shows this badge.
  const tags = useConfigStore((s) => s.config?.workspaceTags) ?? DEFAULT_WORKSPACE_TAGS;
  const definition = findWorkspaceTag(tags, tag);
  return (
    <Badge
      ref={ref}
      tone={definition?.tone ?? 'neutral'}
      variant="outline"
      className={className}
      {...props}
    >
      <TagGlyph tag={definition} className="size-2.5" />
      <span className="truncate">{tag}</span>
    </Badge>
  );
});

/** What leads a tag's name: a spinner, its icon's shape in the tag's color, or the tag glyph. */
export function TagGlyph({
  tag,
  className,
}: {
  tag: Pick<WorkspaceTagDefinition, 'icon' | 'spinner'> | undefined;
  className?: string;
}) {
  if (tag?.spinner) return <ActivitySpinner className={cn('shrink-0', className)} />;
  if (tag?.icon) {
    const mask = `url("${tag.icon}") center / contain no-repeat`;
    return (
      <span
        aria-hidden="true"
        data-tag-icon
        className={cn('inline-block shrink-0 bg-current', className)}
        style={{ mask, WebkitMask: mask }}
      />
    );
  }
  return <Tag aria-hidden="true" weight="bold" className={cn('shrink-0', className)} />;
}
