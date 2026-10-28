import type { Project } from '@/types';

/**
 * The index to pass to reorderProject to put one project before or after another, or null when
 * either is unknown or the project is already there. reorderProject indexes every project in
 * order, including ones without a group in the sidebar (hidden, or with no workspace in this
 * window).
 */
export function getProjectMoveIndex(
  projects: Project[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after'
): number | null {
  const projectIds = [...projects]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((project) => project.id);
  const sourceIndex = projectIds.indexOf(sourceId);
  const targetIndex = projectIds.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) return null;

  const insertionIndex = position === 'before' ? targetIndex : targetIndex + 1;
  const index = sourceIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
  return index === sourceIndex ? null : index;
}
