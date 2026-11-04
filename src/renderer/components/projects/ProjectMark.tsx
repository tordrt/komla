import { FolderOpen } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

import type { Project } from '@/types';

/**
 * A project's icon, otherwise its color dot in a box of the icon's size, or a folder icon for
 * directory projects.
 */
export function ProjectMark({
  project,
  iconClassName = 'size-3.5',
  dotClassName = 'size-2',
}: {
  project: Pick<Project, 'color' | 'kind' | 'icon'> | undefined;
  /** Sizes the project's icon or folder icon. */
  iconClassName?: string;
  dotClassName?: string;
}) {
  if (project?.icon) {
    return (
      <img
        src={project.icon}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn('shrink-0 rounded-[3px] object-contain', iconClassName)}
      />
    );
  }
  const color = project?.color || 'oklch(var(--muted-foreground))';
  return project?.kind === 'directory' ? (
    <FolderOpen className={cn('shrink-0', iconClassName)} style={{ color }} />
  ) : (
    // The dot sits in an icon-sized box, so names line up beside projects that have icons.
    <span className={cn('flex shrink-0 items-center justify-center', iconClassName)}>
      <span
        className={cn('shrink-0 rounded-full', dotClassName)}
        style={{ backgroundColor: color }}
      />
    </span>
  );
}
