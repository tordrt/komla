import { ArrowSquareOut } from '@phosphor-icons/react';

import { useProjectWebUrl, webUrlLabel } from '@/hooks/useProjectWebUrl';
import { cn } from '@/lib/utils';

import type { Project } from '@/types';

/**
 * The line under a project's name in Settings: its repository's web page when it has a remote,
 * since Komla works in its own clone of most repositories, and otherwise the folder it was added
 * from. Directory projects show their folder, which is the project.
 */
export function ProjectPageSubtitle({ project }: { project: Project }) {
  const webUrl = useProjectWebUrl(project);

  if (webUrl) {
    const label = webUrlLabel(webUrl);
    return (
      <button
        type="button"
        onClick={() => void window.api.openExternal(webUrl)}
        title={`Open ${label} in your browser`}
        className="inline-flex max-w-full items-center gap-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
      >
        <span className="truncate">{label}</span>
        <ArrowSquareOut className="size-3 shrink-0" />
      </button>
    );
  }
  return <ProjectFolder project={project} pending={webUrl === undefined} />;
}

/** The text form, for places that are already a button, such as a row in the project list. */
export function ProjectLocation({ project, className }: { project: Project; className?: string }) {
  const webUrl = useProjectWebUrl(project);
  if (webUrl) {
    const label = webUrlLabel(webUrl);
    return (
      <span className={cn('block truncate font-mono text-xs', className)} title={label}>
        {label}
      </span>
    );
  }
  return <ProjectFolder project={project} pending={webUrl === undefined} className={className} />;
}

function ProjectFolder({
  project,
  pending,
  className,
}: {
  project: Project;
  /** Holds the line while the remote is looked up, so the page doesn't shift. */
  pending: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn('block truncate font-mono text-xs', pending && 'invisible', className)}
      title={project.repositoryPath}
    >
      {project.repositoryPath}
    </span>
  );
}
