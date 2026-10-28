import { CaretRight, Folder, Play, Plus } from '@phosphor-icons/react';

import { ProjectCreationForm } from '@/components/projects/ProjectCreationForm';
import { ProjectMark } from '@/components/projects/ProjectMark';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';

import { ProjectLocation } from './ProjectPageSubtitle';
import { SettingsCard } from './SettingsCard';

interface ProjectsTabProps {
  /** Shows the form for adding a project instead of the list. */
  adding: boolean;
  onAddProject: () => void;
  onShowList: () => void;
  onOpenProject: (projectId: string) => void;
}

/** The project list, which opens each project's settings page, and the form for adding one. */
export function ProjectsTab({ adding, onAddProject, onShowList, onOpenProject }: ProjectsTabProps) {
  const projects = useProjectsStore((s) => s.projects);
  const addToast = useToastStore((s) => s.addToast);

  if (adding) {
    return (
      <ProjectCreationForm
        onSuccess={() => {
          onShowList();
          addToast('Project created', 'success');
        }}
        onCancel={onShowList}
      />
    );
  }

  if (projects.length === 0) {
    return (
      <EmptyState
        className="rounded-lg border-2 border-dashed border-border/60"
        icon={<Folder weight="duotone" />}
        title="No projects yet"
        description="Add a project to start managing workspaces"
        action={
          <Button size="sm" onClick={onAddProject}>
            <Plus className="mr-1.5 size-3.5" />
            Add project
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-medium text-muted-foreground">
          {projects.length} project{projects.length !== 1 ? 's' : ''}
        </h3>
        <Button variant="outline" size="sm" onClick={onAddProject}>
          <Plus className="mr-1.5 size-3.5" />
          Add project
        </Button>
      </div>

      <SettingsCard>
        {projects.map((project) => {
          const stepCount = project.setupSteps?.length || 0;
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => onOpenProject(project.id)}
              className="group flex w-full items-center gap-3 !py-3 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-hidden"
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                <ProjectMark project={project} iconClassName="size-4" dotClassName="size-2.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{project.name}</span>
                  {project.kind !== 'directory' && stepCount > 0 && (
                    <Badge tone="primary">
                      <Play className="size-2.5" />
                      {stepCount} setup step{stepCount !== 1 ? 's' : ''}
                    </Badge>
                  )}
                </span>
                <ProjectLocation project={project} className="text-muted-foreground" />
              </span>
              <CaretRight className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
            </button>
          );
        })}
      </SettingsCard>
    </div>
  );
}
