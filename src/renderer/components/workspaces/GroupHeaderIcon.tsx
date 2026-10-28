import { Folder } from '@phosphor-icons/react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import { cn } from '@/lib/utils';

interface GroupHeaderIconProps {
  isDirectory: boolean;
  expanded: boolean;
  color: string;
  icon?: string;
}

/**
 * What starts a sidebar group header: the project's icon, a folder for a directory project,
 * otherwise its color dot, which flattens to a dash while the group is collapsed.
 */
export function GroupHeaderIcon({ isDirectory, expanded, color, icon }: GroupHeaderIconProps) {
  if (icon) {
    return (
      <ProjectMark
        project={{ icon }}
        iconClassName={cn('size-5 transition-opacity', !expanded && 'opacity-60')}
      />
    );
  }
  if (isDirectory) {
    return <Folder className="light-darken size-5 shrink-0" style={{ color }} />;
  }
  // The dot sits in an icon-sized box, so group names line up whatever the group shows.
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <span
        className={cn(
          'light-darken rounded-full transition-all',
          expanded ? 'size-2.5' : 'h-0.5 w-2.5'
        )}
        style={{ backgroundColor: color }}
      />
    </span>
  );
}
